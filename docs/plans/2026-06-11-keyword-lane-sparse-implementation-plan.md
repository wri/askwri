# Keyword Lane → BM25-as-sparsevec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory bm25s keyword lane with a Postgres-resident sparse-vector lane behind `KEYWORD_BACKEND=memory|sparse`, score-identical to today, with per-query `status='searchable'` filtering — then delete the reindex choreography it obsoletes.

**Architecture:** bm25s already precomputes per-(token, chunk) impact weights; we persist those weights as `sparsevec` in the existing (empty) `document_chunks.sparse` column, with a `keyword_vocab` table mapping tokens → stable 1-based ids and a `keyword_corpus_stats` row freezing corpus statistics (N, avgdl, k1, b). Query path: tokenize with the identical bm25s tokenizer → query-token count vector → `ORDER BY sparse <#> qvec` with the same status join as the dense lane. New docs get vectors at embed time under frozen stats; a rebuild script refreshes stats/weights (lifecycle correctness never depends on it). Evidence basis: `docs/plans/2026-06-11-keyword-lane-replacement-design-note.md` (§4.6: 26/26 score-identical offline; vocab 184,395; nnz ≤194).

**Tech Stack:** Python 3.12+ (FastAPI service + worker), bm25s 0.3.0 / PyStemmer, pgvector 0.8.2 `sparsevec` via `pgvector.psycopg`, TypeORM raw-SQL migration (app tier owns DDL), Jest (app tier), pytest (search-service).

**Hard constraints (from the design note — re-read it first):**
- `QueryRequest`/`QueryResponse` in `search-service/app/main.py` must not change. No task below touches them.
- Never push `qa` or this branch. Branch: `keyword-lane-replacement` (already exists, off local `qa`).
- The eval gate (Task 10) decides adoption. Tasks 11–12 (choreography removal, default flip) run ONLY after the gate passes.
- One command per Bash call (no `&&`/`;`/pipes/env-prefixes) when executing via Claude.

**Conventions that bite:**
- pgvector `sparsevec` text format uses **1-based** indices (`'{1:0.5}/1000000'`); the `pgvector.psycopg` `SparseVector(dict, dim)` Python class takes **0-based** dict keys and serializes to 1-based. We store 1-based `token_id` in the DB and subtract 1 when building `SparseVector` dicts. The DB-gated test in Task 5 numerically verifies this convention — do not skip it.
- `<#>` returns the **negative** inner product; ascending order = best match first; score = `-(sparse <#> q)`.
- The BM25 corpus string is `node.get_content(metadata_mode=MetadataMode.EMBED)` (chunk text + metadata header), NOT `node.text`.
- bm25s defaults in play: `method='lucene'`, `k1=1.5`, `b=0.75`, English stopwords, English Snowball stemmer, token pattern `(?u)\b\w\w+\b`. Lucene method has no nonoccurrence array.
- Python tests: DB-gated suites follow `tests/test_worker_stages.py` (scratch DB + TypeORM migrations via subprocess; never touch the `qa` database). Module-level `_check_db_required()` + `pytestmark` skip guard.

**File map (whole plan):**

| File | Action | Role |
|---|---|---|
| `src/db/migrations/1781310000000-Migration.ts` | create | `keyword_vocab` + `keyword_corpus_stats` DDL |
| `search-service/app/sparse_keyword.py` | create | tokenizer + weight math shared by script/worker/retriever |
| `search-service/tests/test_sparse_keyword.py` | create | parity unit test vs real bm25s (no DB) |
| `search-service/scripts/build_sparse_keyword.py` | create | backfill/refresh: vocab + stats + chunk vectors |
| `search-service/app/pg_store.py` | modify | add `SparseKeywordRetriever` |
| `search-service/tests/test_sparse_retriever.py` | create | DB-gated scoring/filter/tie-break test |
| `search-service/app/config.py` | modify | `keyword_backend` setting |
| `search-service/app/main.py` | modify | boot branch + `/reindex` build-then-swap |
| `search-service/worker/stages/embed.py` | modify | write `sparse` for new docs (frozen stats) |
| `search-service/tests/test_worker_stages.py` | modify | embed-stage sparse assertions |
| `search-service/scripts/sparse_parity_check.py` | modify | add `--db` mode (SQL lane vs bm25s, end-to-end) |
| `evaluation/run-baseline-suite.sh` | modify | label arg so candidate runs don't collide with baseline state |
| `src/lib/search-reindex.ts`, `src/__tests__/admin-reindex.test.ts` | delete (Task 11) | obsolete choreography |
| `src/app/api/admin/documents/[id]/status/route.ts`, `src/app/admin/review/page.tsx`, `src/app/admin/documents/[id]/page.tsx` | modify (Task 11) | drop reindex call/field/notices |
| `search-service/worker/stages/publish.py` | modify (Task 11) | comment only — POST kept for `document_texts` freshness (deviation, see Task 11) |
| `docs/document-management.md`, `.env.example` | modify (Task 12) | as-built docs + env |

---

### Task 1: Migration — `keyword_vocab` + `keyword_corpus_stats`

**Files:**
- Create: `src/db/migrations/1781310000000-Migration.ts`

- [ ] **Step 1: Write the migration**

```ts
import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781310000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Vocabulary for the Postgres-resident BM25 lane (KEYWORD_BACKEND=sparse).
    // token_id is a stable 1-based id = sparsevec dimension index; rows are
    // never re-numbered by refreshes (data writes owned by the Python side).
    await queryRunner.query(`
      CREATE TABLE "keyword_vocab" (
        "token" text NOT NULL,
        "token_id" integer GENERATED ALWAYS AS IDENTITY,
        "df" integer NOT NULL,
        "idf" double precision NOT NULL,
        CONSTRAINT "PK_keyword_vocab" PRIMARY KEY ("token"),
        CONSTRAINT "UQ_keyword_vocab_token_id" UNIQUE ("token_id")
      )`)
    // Frozen corpus statistics the BM25 weights were computed under.
    // n_chunks = bm25s num_docs (chunks, not documents).
    await queryRunner.query(`
      CREATE TABLE "keyword_corpus_stats" (
        "id" integer NOT NULL DEFAULT 1 CHECK (id = 1),
        "n_chunks" integer NOT NULL,
        "avgdl" double precision NOT NULL,
        "k1" real NOT NULL,
        "b" real NOT NULL,
        "sparse_dim" integer NOT NULL,
        "method" text NOT NULL DEFAULT 'lucene',
        "built_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_keyword_corpus_stats" PRIMARY KEY ("id")
      )`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "keyword_corpus_stats"`)
    await queryRunner.query(`DROP TABLE "keyword_vocab"`)
  }
}
```

- [ ] **Step 2: Run the migration against the local docker db**

Run: `npm run migration:run`
Expected: `Migration1781310000000 has been executed successfully.`

- [ ] **Step 3: Verify the tables exist**

Run: `docker exec askwri-pg psql -U askwri -d qa -c "\d keyword_vocab"`
Expected: columns `token | token_id | df | idf`, PK on token, unique on token_id.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/1781310000000-Migration.ts
git commit -m "feat: keyword_vocab + keyword_corpus_stats tables for sparse keyword lane"
```

---

### Task 2: `app/sparse_keyword.py` — shared tokenizer + weight math (TDD)

**Files:**
- Create: `search-service/app/sparse_keyword.py`
- Test: `search-service/tests/test_sparse_keyword.py`

- [ ] **Step 1: Write the failing test** — parity against a REAL bm25s index on a tiny corpus. This is the linchpin test: if `chunk_weights` matches bm25s exactly, the embed-stage path for new docs is correct by the same math the backfill gets from bm25s directly.

```python
"""Parity tests for app.sparse_keyword against real bm25s behavior.

No DB required. Builds a small bm25s index exactly the way BM25Retriever
does, then checks that our tokenizer and weight math reproduce the stored
impact matrix and query scoring.
"""
import math

import bm25s
import numpy as np
import pytest
import Stemmer

from app.sparse_keyword import (
    B, K1, SPARSE_DIM, TOKEN_PATTERN, chunk_weights, lucene_idf, tokenize,
)

CORPUS = [
    "Urban land value capture in São Paulo and Addis Ababa",
    "Electric buses reduce emissions. Electric buses are quieter than diesel buses.",
    "Walkable streets make cities safer for children and pedestrians",
    "完整街道设计导则，提升城市道路安全。",   # zh: whole-run tokens, like production
    "value capture value capture value",      # repeated terms exercise tf math
]


def _reference_index():
    stemmer = Stemmer.Stemmer("english")
    corpus_tokens = bm25s.tokenize(
        CORPUS, stopwords="en", stemmer=stemmer,
        token_pattern=TOKEN_PATTERN, show_progress=False,
    )
    bm25 = bm25s.BM25()  # defaults: method='lucene', k1=1.5, b=0.75
    bm25.index(corpus_tokens, show_progress=False)
    return bm25, corpus_tokens


def test_tokenize_matches_bm25s_corpus_tokenization():
    bm25, corpus_tokens = _reference_index()
    id_to_token = {v: k for k, v in corpus_tokens.vocab.items()}
    for doc_idx, ids in enumerate(corpus_tokens.ids):
        assert tokenize(CORPUS[doc_idx]) == [id_to_token[i] for i in ids]


def test_chunk_weights_reproduce_bm25s_impact_matrix():
    bm25, corpus_tokens = _reference_index()
    import scipy.sparse as sp
    n_docs = int(bm25.scores["num_docs"])
    n_tokens = len(bm25.scores["indptr"]) - 1
    mat = sp.csc_matrix(
        (bm25.scores["data"], bm25.scores["indices"], bm25.scores["indptr"]),
        shape=(n_docs, n_tokens),
    ).tocsr()
    id_to_token = {v: k for k, v in corpus_tokens.vocab.items()}

    dls = [len(ids) for ids in corpus_tokens.ids]
    avgdl = sum(dls) / len(dls)
    # df over the tokenized corpus, idf via the lucene formula
    df = {}
    for ids in corpus_tokens.ids:
        for tid in set(ids):
            df[tid] = df.get(tid, 0) + 1
    idf_by_token = {id_to_token[tid]: lucene_idf(d, n_docs) for tid, d in df.items()}

    for doc_idx in range(n_docs):
        ours = chunk_weights(tokenize(CORPUS[doc_idx]), idf_by_token, avgdl)
        row = mat.getrow(doc_idx)
        theirs = {id_to_token[tid]: w for tid, w in zip(row.indices, row.data)}
        assert set(ours) == set(theirs)
        for token, w in ours.items():
            assert w == pytest.approx(theirs[token], abs=1e-5), token


def test_lucene_idf_formula():
    assert lucene_idf(1, 5) == pytest.approx(math.log(1 + (5 - 1 + 0.5) / 1.5))


def test_zh_query_tokens_are_whole_runs():
    toks = tokenize("完整街道设计导则，提升城市道路安全。")
    assert toks == ["完整街道设计导则", "提升城市道路安全"]


def test_sparse_dim_headroom():
    # Design note §4.6: corpus vocab is ~184k; dimension must dominate it.
    assert SPARSE_DIM == 1_000_000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sparse_keyword.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.sparse_keyword'`

- [ ] **Step 3: Write the implementation**

```python
"""Shared helpers for the Postgres-resident BM25 keyword lane (KEYWORD_BACKEND=sparse).

Replicates bm25s 0.3.0 exactly (method='lucene', k1=1.5, b=0.75, English
stopwords, English Snowball stemmer, token pattern (?u)\\b\\w\\w+\\b):

- tokenize() is the index- AND query-side tokenization BM25Retriever uses
- chunk_weights() is the per-chunk impact weight bm25s precomputes:
      weight(t, d) = idf(t) * tf / (tf + k1*((1-b) + b*dl/avgdl))
  (lucene tf component, scoring.py:_score_tfc_lucene)
- lucene_idf() is scoring.py:_score_idf_lucene

sparsevec convention: DB token_id is 1-based (= sparsevec text index);
pgvector.psycopg's SparseVector takes 0-based dict keys, so subtract 1 there.
Fixed dimension SPARSE_DIM gives vocab growth headroom without per-row
re-dimensioning (pgvector requires equal dims for <#>).
"""
import math
from collections import Counter
from typing import Dict, List

import bm25s
import Stemmer

SPARSE_DIM = 1_000_000
K1 = 1.5
B = 0.75
TOKEN_PATTERN = r"(?u)\b\w\w+\b"

_stemmer = Stemmer.Stemmer("english")


def tokenize(text: str) -> List[str]:
    """Tokenize one string exactly like BM25Retriever (both sides)."""
    return bm25s.tokenize(
        text,
        stemmer=_stemmer,
        token_pattern=TOKEN_PATTERN,
        return_ids=False,
        show_progress=False,
    )[0]


def lucene_idf(df: int, n_chunks: int) -> float:
    return math.log(1 + (n_chunks - df + 0.5) / (df + 0.5))


def chunk_weights(
    tokens: List[str], idf_by_token: Dict[str, float], avgdl: float
) -> Dict[str, float]:
    """{token: impact weight} for one chunk under frozen corpus stats.

    Tokens missing from idf_by_token are skipped — callers upsert vocab rows
    first and pass a complete map, so a miss means deliberate exclusion.
    """
    dl = len(tokens)
    weights = {}
    for token, tf in Counter(tokens).items():
        idf = idf_by_token.get(token)
        if idf is None:
            continue
        weights[token] = idf * (tf / (tf + K1 * ((1 - B) + B * dl / avgdl)))
    return weights
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sparse_keyword.py -v`
Expected: 5 passed. If `test_chunk_weights_reproduce_bm25s_impact_matrix` fails on values, the tf/idf formula diverged from `bm25s/scoring.py` — fix the math, never loosen the tolerance.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/sparse_keyword.py search-service/tests/test_sparse_keyword.py
git commit -m "feat: sparse keyword lane weight math, parity-tested against bm25s"
```

---

### Task 3: Backfill/refresh script

**Files:**
- Create: `search-service/scripts/build_sparse_keyword.py`

No isolated test — Task 2 proves the math and Task 7 verifies this script end-to-end against the real corpus (26-query SQL-vs-bm25s parity). Keep the script faithful to the validated construction in `scripts/sparse_parity_check.py`.

- [ ] **Step 1: Write the script**

```python
"""Build/refresh the Postgres-resident BM25 keyword lane.

Builds the exact boot-time bm25s index over current searchable chunks, then
persists it: keyword_vocab (df/idf; token_ids stable across refreshes),
keyword_corpus_stats (frozen N/avgdl/k1/b), and per-chunk impact vectors in
document_chunks.sparse.

Run for the initial backfill and to refresh frozen stats after bulk corpus
changes. Lifecycle consistency (withdraw/promote) NEVER depends on this —
only IDF/avgdl freshness does. Idempotent; single transaction; ~1-2 min on
30k chunks.

Run: cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
"""
import sys
import time

import bm25s
import numpy as np
import scipy.sparse as sp
import Stemmer
from llama_index.core.schema import MetadataMode
from pgvector import SparseVector

from app import pg_store
from app.db import get_pool
from app.sparse_keyword import B, K1, SPARSE_DIM, TOKEN_PATTERN, lucene_idf

BATCH = 1000


def main():
    t0 = time.time()
    nodes = pg_store.load_nodes()
    print(f"loaded {len(nodes)} searchable chunks in {time.time() - t0:.1f}s")

    # Exactly what BM25Retriever.from_defaults does at boot (base.py:99-112)
    stemmer = Stemmer.Stemmer("english")
    contents = [n.get_content(metadata_mode=MetadataMode.EMBED) for n in nodes]
    corpus_tokens = bm25s.tokenize(
        contents, stopwords="en", stemmer=stemmer,
        token_pattern=TOKEN_PATTERN, show_progress=False,
    )
    bm25 = bm25s.BM25()  # method='lucene', k1=1.5, b=0.75
    bm25.index(corpus_tokens, show_progress=False)
    print(f"indexed in {time.time() - t0:.1f}s")

    n_chunks = int(bm25.scores["num_docs"])
    n_tokens = len(bm25.scores["indptr"]) - 1
    assert n_chunks == len(nodes)
    # token-major CSC -> chunk-major CSR (construction validated 26/26 in
    # scripts/sparse_parity_check.py)
    rows = sp.csc_matrix(
        (bm25.scores["data"], bm25.scores["indices"], bm25.scores["indptr"]),
        shape=(n_chunks, n_tokens),
    ).tocsr()

    id_to_token = {v: k for k, v in corpus_tokens.vocab.items()}
    dls = [len(ids) for ids in corpus_tokens.ids]
    avgdl = float(np.mean(dls))
    df = np.zeros(n_tokens, dtype=np.int64)
    for ids in corpus_tokens.ids:
        for tid in set(ids):
            df[tid] += 1

    with get_pool().connection() as conn:
        # 1. vocab upsert — existing tokens keep their token_id (stable dims)
        vocab_rows = [
            (id_to_token[tid], int(df[tid]), lucene_idf(int(df[tid]), n_chunks))
            for tid in range(n_tokens)
        ]
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO keyword_vocab (token, df, idf) VALUES (%s, %s, %s)
                   ON CONFLICT (token) DO UPDATE SET df = EXCLUDED.df, idf = EXCLUDED.idf""",
                vocab_rows,
            )
        max_id = conn.execute("SELECT max(token_id) FROM keyword_vocab").fetchone()[0]
        if max_id >= SPARSE_DIM:
            print(f"FATAL: vocab token_id {max_id} >= SPARSE_DIM {SPARSE_DIM}")
            sys.exit(1)

        db_id = dict(conn.execute("SELECT token, token_id FROM keyword_vocab").fetchall())

        # 2. stats
        conn.execute(
            """INSERT INTO keyword_corpus_stats
                 (id, n_chunks, avgdl, k1, b, sparse_dim, method, built_at)
               VALUES (1, %s, %s, %s, %s, %s, 'lucene', now())
               ON CONFLICT (id) DO UPDATE SET n_chunks = EXCLUDED.n_chunks,
                 avgdl = EXCLUDED.avgdl, k1 = EXCLUDED.k1, b = EXCLUDED.b,
                 sparse_dim = EXCLUDED.sparse_dim, built_at = now()""",
            (n_chunks, avgdl, K1, B, SPARSE_DIM),
        )

        # 3. chunk vectors — bm25s column ids remapped to stable DB token_ids
        t0 = time.time()
        updates = []
        for i, node in enumerate(nodes):
            row = rows.getrow(i)
            vec = {
                db_id[id_to_token[tid]] - 1: float(w)   # 0-based for SparseVector
                for tid, w in zip(row.indices, row.data)
            }
            updates.append((SparseVector(vec, SPARSE_DIM), node.id_))
            if len(updates) >= BATCH:
                with conn.cursor() as cur:
                    cur.executemany(
                        "UPDATE document_chunks SET sparse = %s WHERE legacy_chunk_id = %s",
                        updates,
                    )
                updates = []
        if updates:
            with conn.cursor() as cur:
                cur.executemany(
                    "UPDATE document_chunks SET sparse = %s WHERE legacy_chunk_id = %s",
                    updates,
                )
        n = conn.execute(
            """SELECT count(*) FROM document_chunks dc
               JOIN documents d ON d.id = dc.document_id
               WHERE d.status = 'searchable' AND dc.sparse IS NOT NULL"""
        ).fetchone()[0]
    print(f"wrote {len(nodes)} vectors in {time.time() - t0:.1f}s; "
          f"searchable chunks with sparse: {n}; vocab {len(db_id)}; avgdl {avgdl:.1f}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Syntax check only** (the real run is Task 7, after the retriever exists)

Run: `cd search-service && ./venv/bin/python -c "import scripts.build_sparse_keyword"`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add search-service/scripts/build_sparse_keyword.py
git commit -m "feat: backfill/refresh script for sparse keyword lane"
```

---

### Task 4: `SparseKeywordRetriever` in `pg_store.py`

**Files:**
- Modify: `search-service/app/pg_store.py` (append after `PgVectorRetriever`)

- [ ] **Step 1: Add the SQL constant and retriever class**

```python
_SPARSE_KEYWORD_SQL = """
    SELECT dc.legacy_chunk_id, dc.text, dc.node_metadata,
           -(dc.sparse <#> %(q)s) AS score
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE d.status = 'searchable'
      AND dc.sparse IS NOT NULL
    ORDER BY dc.sparse <#> %(q)s, dc.corpus_order NULLS LAST, dc.legacy_chunk_id
    LIMIT %(k)s
"""
# <#> is the NEGATIVE inner product (ascending = best first). corpus_order
# tie-break mirrors bm25s, which resolves equal scores by corpus position.
# Exact scan by design: 30k rows, nnz<=~200 — no ANN index, zero recall loss.


class SparseKeywordRetriever(BaseRetriever):
    """Postgres-resident BM25 lane (KEYWORD_BACKEND=sparse).

    Per-chunk bm25s impact weights live in document_chunks.sparse; a query is
    scored as the inner product with its token-count vector — score-identical
    to the in-memory BM25Retriever (scripts/sparse_parity_check.py, 26/26).
    status='searchable' filters per query, like the dense lane: withdraw and
    promote are consistent on the next query, no reindex.
    """

    def __init__(self, similarity_top_k: int = 1000, **kwargs):
        super().__init__(**kwargs)
        self._similarity_top_k = similarity_top_k

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        from pgvector import SparseVector

        from app.sparse_keyword import SPARSE_DIM, tokenize

        tokens = tokenize(query_bundle.query_str)
        counts: dict = {}
        if tokens:
            with get_pool().connection() as conn:
                rows = conn.execute(
                    "SELECT token, token_id FROM keyword_vocab WHERE token = ANY(%s)",
                    (sorted(set(tokens)),),
                ).fetchall()
            token_id = {t: i for t, i in rows}
            for t in tokens:
                i = token_id.get(t)
                if i is not None:  # OOV query tokens score 0, same as bm25s
                    counts[i - 1] = counts.get(i - 1, 0.0) + 1.0
        qvec = SparseVector(counts, SPARSE_DIM)

        results = []
        with get_pool().connection() as conn:
            rows = conn.execute(
                _SPARSE_KEYWORD_SQL, {"q": qvec, "k": self._similarity_top_k}
            ).fetchall()
        for legacy_id, text, meta, score in rows:
            results.append(
                NodeWithScore(
                    node=TextNode(id_=legacy_id, text=text, metadata=meta),
                    score=float(score),
                )
            )
        return results
```

- [ ] **Step 2: Syntax check**

Run: `cd search-service && ./venv/bin/python -c "from app.pg_store import SparseKeywordRetriever"`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add search-service/app/pg_store.py
git commit -m "feat: SparseKeywordRetriever — Postgres-resident BM25 lane"
```

---

### Task 5: DB-gated retriever test (scratch DB, hand-computed expectations)

**Files:**
- Create: `search-service/tests/test_sparse_retriever.py`

Model the scratch-DB fixture on `tests/test_worker_stages.py` (read it first): create `askwri_sparse_test`, apply TypeORM migrations via subprocess, point `app.db` at it, drop on teardown.

- [ ] **Step 1: Write the failing test**

```python
"""DB-gated tests for SparseKeywordRetriever against a scratch database.

Hermetic pattern from test_worker_stages.py: scratch DB askwri_sparse_test,
TypeORM migrations via subprocess, app.db pool reset. Never touches qa.

Verifies numerically: inner-product scoring (and thus the 1-based sparsevec /
0-based SparseVector convention), status filtering, NULL-sparse exclusion,
and corpus_order tie-breaking.
"""
import os
import subprocess

import psycopg
import pytest
from llama_index.core.schema import QueryBundle

from tests.conftest import _check_db_required

_check_db_required()
pytestmark = pytest.mark.skipif(
    not os.getenv("DATABASE_URL"),
    reason="DATABASE_URL not set — skipping sparse retriever tests",
)

_SUPERDB_URL = "postgresql://askwri:password@localhost:5432/postgres"
_TEST_DB = "askwri_sparse_test"
_TEST_DB_URL = f"postgresql://askwri:password@localhost:5432/{_TEST_DB}"
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _reset_app_state(db_url):
    os.environ["DATABASE_URL"] = db_url
    from app.config import get_settings
    get_settings.cache_clear()
    import app.db as _db
    if _db._pool is not None:
        try:
            _db._pool.close()
        except Exception:
            pass
    _db._pool = None


@pytest.fixture(scope="module")
def sparse_test_db():
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB}")
        conn.execute(f"CREATE DATABASE {_TEST_DB}")
    env = {**os.environ, "DATABASE_URL": _TEST_DB_URL}
    subprocess.run(
        ["npm", "run", "migration:run"], cwd=_REPO_ROOT, env=env,
        check=True, capture_output=True,
    )
    _reset_app_state(_TEST_DB_URL)
    yield _TEST_DB_URL
    _reset_app_state(_TEST_DB_URL)
    import app.db as _db
    if _db._pool is not None:
        _db._pool.close()
        _db._pool = None
    with psycopg.connect(_SUPERDB_URL, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {_TEST_DB} WITH (FORCE)")


@pytest.fixture(scope="module")
def seeded(sparse_test_db):
    """Two docs (one searchable, one withdrawn), four chunks.

    Vocab: 'transport'→id 1 (idf 1.0), 'bogota'→id 2 (idf 2.0).
    sparsevec text uses 1-BASED indices.
    Expected inner products for query 'transport bogota' (counts {1:1, 2:1}):
      chunk A: 0.5*1 + 1.5*1 = 2.0
      chunk B: 0.5*1          = 0.5
      chunk C: equal score to B (0.5) but later corpus_order — tie-break check
      chunk W: withdrawn doc — excluded
      chunk N: sparse IS NULL — excluded
    """
    from app.db import get_pool
    with get_pool().connection() as conn:
        conn.execute(
            """INSERT INTO documents (id, external_id, title, status, language)
               VALUES ('00000000-0000-0000-0000-000000000001', 'doc_a', 'A', 'searchable', 'en'),
                      ('00000000-0000-0000-0000-000000000002', 'doc_w', 'W', 'withdrawn', 'en')"""
        )
        # token_id is GENERATED ALWAYS — use OVERRIDING SYSTEM VALUE for fixed ids
        conn.execute(
            """INSERT INTO keyword_vocab (token, token_id, df, idf)
               OVERRIDING SYSTEM VALUE
               VALUES ('transport', 1, 3, 1.0), ('bogota', 2, 1, 2.0)"""
        )
        conn.execute(
            """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
               VALUES (1, 4, 10.0, 1.5, 0.75, 1000000)"""
        )
        conn.execute(
            """INSERT INTO document_chunks
                 (document_id, legacy_chunk_id, chunk_index, text, node_metadata, corpus_order, sparse)
               VALUES
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_0', 0, 'A0', '{}', 0,
                  '{1:0.5,2:1.5}/1000000'),
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_1', 1, 'A1', '{}', 1,
                  '{1:0.5}/1000000'),
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_2', 2, 'A2', '{}', 2,
                  '{1:0.5}/1000000'),
                 ('00000000-0000-0000-0000-000000000001', 'doc_a_chunk_3', 3, 'A3', '{}', 3, NULL),
                 ('00000000-0000-0000-0000-000000000002', 'doc_w_chunk_0', 0, 'W0', '{}', 4,
                  '{1:9.0,2:9.0}/1000000')"""
        )
    yield


def test_scoring_filtering_and_tiebreak(seeded):
    from app.pg_store import SparseKeywordRetriever
    r = SparseKeywordRetriever(similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="transport bogota"))
    ids = [n.node.node_id for n in out]
    scores = {n.node.node_id: n.score for n in out}

    assert "doc_w_chunk_0" not in ids          # withdrawn excluded per query
    assert "doc_a_chunk_3" not in ids          # NULL sparse excluded
    assert ids[0] == "doc_a_chunk_0"
    assert scores["doc_a_chunk_0"] == pytest.approx(2.0)
    assert scores["doc_a_chunk_1"] == pytest.approx(0.5)
    # equal scores resolve by corpus_order
    assert ids[1] == "doc_a_chunk_1" and ids[2] == "doc_a_chunk_2"


def test_oov_query_returns_zero_scores_not_error(seeded):
    from app.pg_store import SparseKeywordRetriever
    r = SparseKeywordRetriever(similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="zzznotavocabword"))
    assert all(n.score == pytest.approx(0.0) for n in out)


def test_stemmed_query_matches_vocab(seeded):
    # 'transports' stems to 'transport' — query-side stemming must hit vocab
    from app.pg_store import SparseKeywordRetriever
    r = SparseKeywordRetriever(similarity_top_k=10)
    out = r._retrieve(QueryBundle(query_str="transports"))
    assert out[0].node.node_id == "doc_a_chunk_0"
    assert out[0].score == pytest.approx(0.5)
```

Note: check the `documents` INSERT against the actual schema in migration `1781280000000-Migration.ts` before running — if `documents` has more NOT NULL columns (e.g. `source_metadata`), add them to the INSERT with sensible defaults rather than weakening the schema.

- [ ] **Step 2: Run test to verify current state**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sparse_retriever.py -v`
Expected: PASS if Tasks 1–4 are correct. If `test_scoring_filtering_and_tiebreak` fails on score values (e.g. everything 0), the 1-based/0-based sparsevec convention is wrong — fix `SparseKeywordRetriever`/docs, not the test.

- [ ] **Step 3: Run the full python suite for regressions**

Run: `npm run test:python`
Expected: all prior tests still pass (86 + new ones).

- [ ] **Step 4: Commit**

```bash
git add search-service/tests/test_sparse_retriever.py
git commit -m "test: DB-gated sparse keyword retriever scoring/filter/tie-break"
```

---

### Task 6: `KEYWORD_BACKEND` flag + boot wiring + `/reindex` build-then-swap

**Files:**
- Modify: `search-service/app/config.py`
- Modify: `search-service/app/main.py` (`load_from_postgres`, `trigger_reindex`)

- [ ] **Step 1: Add the setting** — in `config.py`, directly under `retrieval_backend`:

```python
    # Keyword lane residency (postgres retrieval backend only):
    # "memory" = in-memory bm25s built at boot//reindex (legacy behavior)
    # "sparse" = Postgres-resident impact vectors in document_chunks.sparse
    #            (requires scripts/build_sparse_keyword.py backfill)
    keyword_backend: str = "memory"  # "memory" | "sparse"
```

- [ ] **Step 2: Branch the boot path** — in `main.py` `load_from_postgres()`, replace:

```python
    nodes = pg_store.load_nodes()
    if not nodes:
        raise RuntimeError("No searchable chunks in Postgres — run the migration script first")

    logger.info("📊 Building BM25 sparse index from Postgres chunks...")
    bm25_retriever = BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=1000)
```

with:

```python
    if settings.keyword_backend == "sparse":
        from app.db import get_pool
        from app.pg_store import SparseKeywordRetriever

        with get_pool().connection() as conn:
            populated = conn.execute(
                """SELECT count(*) FROM document_chunks dc
                   JOIN documents d ON d.id = dc.document_id
                   WHERE d.status = 'searchable' AND dc.sparse IS NOT NULL"""
            ).fetchone()[0]
        if not populated:
            raise RuntimeError(
                "KEYWORD_BACKEND=sparse but document_chunks.sparse is unpopulated — "
                "run scripts/build_sparse_keyword.py first"
            )
        bm25_retriever = SparseKeywordRetriever(similarity_top_k=1000)
        logger.info(f"📊 Keyword lane: Postgres sparse ({populated} chunks; no in-memory build)")
    else:
        nodes = pg_store.load_nodes()
        if not nodes:
            raise RuntimeError("No searchable chunks in Postgres — run the migration script first")
        logger.info("📊 Building BM25 sparse index from Postgres chunks...")
        bm25_retriever = BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=1000)
```

(The log line for ready-state at the end references `len(nodes)` — change it to not depend on `nodes` existing in the sparse branch, e.g. log `len(service_state['document_texts'])` documents instead.)

- [ ] **Step 3: Make `/reindex` build-then-swap** — in `trigger_reindex()`, delete the state-clearing block:

```python
            # Clear existing state
            service_state["vector_index"] = None
            service_state["bm25_retriever"] = None
            service_state["documents_metadata"] = {}
            service_state["document_texts"] = {}
            service_state["pg_dense_ready"] = False
```

and update the stale comment above `_reindex_lock` (`state is still cleared during rebuild (known limitation...)`) to say the rebuild now swaps state at the end (`load_from_postgres`/`load_documents_and_build_indexes` assign `service_state` keys only on completion), so queries keep serving the old state during a rebuild.

- [ ] **Step 4: Boot smoke check (memory mode unchanged)**

Run: `cd search-service && ./venv/bin/python -c "from app.main import app"`
Expected: imports clean.

- [ ] **Step 5: Run python tests**

Run: `npm run test:python`
Expected: all pass (no behavior change while `KEYWORD_BACKEND` defaults to `memory`).

- [ ] **Step 6: Commit**

```bash
git add search-service/app/config.py search-service/app/main.py
git commit -m "feat: KEYWORD_BACKEND flag — sparse boot path + /reindex build-then-swap"
```

---

### Task 7: Backfill the local corpus + end-to-end SQL parity (`--db` mode)

**Files:**
- Modify: `search-service/scripts/sparse_parity_check.py`

- [ ] **Step 1: Run the migration + backfill against the local qa db**

Run: `cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword`
Expected output shape: `wrote 30526 vectors in ~60s; searchable chunks with sparse: 30526; vocab ~184395; avgdl ~...`

- [ ] **Step 2: Verify population**

Run: `docker exec askwri-pg psql -U askwri -d qa -c "SELECT count(*) FILTER (WHERE sparse IS NOT NULL) AS populated, count(*) AS total FROM document_chunks"`
Expected: `populated = total = 30526`.

- [ ] **Step 3: Add `--db` mode to the parity script.** After the existing in-memory comparison loop in `main()`, add a DB comparison for each query (guarded by `"--db" in sys.argv`): retrieve top-1000 via `SparseKeywordRetriever`, retrieve top-1000 via `retriever` (the in-memory `BM25Retriever`), and assert that for every chunk with a **positive** score the (chunk_id → score) pairs match within 1e-3 and the positive-score rank order is identical. Zero-score tails are excluded — bm25s pads its top-k with arbitrary zero-score docs while SQL orders them by `corpus_order`; both are "no match" noise below RRF.

```python
        if "--db" in sys.argv:
            from llama_index.core.schema import QueryBundle
            from app.pg_store import SparseKeywordRetriever

            sql_lane = SparseKeywordRetriever(similarity_top_k=1000)
            sql_out = sql_lane._retrieve(QueryBundle(query_str=q))
            mem_out = retriever._retrieve(QueryBundle(query_str=q))
            sql_pos = [(n.node.node_id, n.score) for n in sql_out if n.score > 1e-9]
            mem_pos = [(n.node.node_id, n.score) for n in mem_out if n.score > 1e-9]
            ids_match = [i for i, _ in sql_pos] == [i for i, _ in mem_pos]
            scores_match = all(
                abs(a - b) < 1e-3 for (_, a), (_, b) in zip(sql_pos, mem_pos)
            )
            if not (ids_match and scores_match):
                failures += 1
                print(f"DB-FAIL {q[:50]!r} sql={len(sql_pos)} mem={len(mem_pos)}")
            else:
                print(f"DB-OK  {q[:50]!r} positive={len(sql_pos)}")
```

(Integrate into the loop so `failures` aggregates both checks; `retriever` and `sql_lane` are available in scope. Note `BM25Retriever._retrieve` applies no query expansion — neither does `SparseKeywordRetriever`; expansion happens upstream in `HybridFusionRetriever` for both, so this comparison is lane-pure.)

- [ ] **Step 4: Run end-to-end parity**

Run: `cd search-service && ./venv/bin/python -m scripts.sparse_parity_check --db`
Expected: `26/26 queries score-identical` AND 26 `DB-OK` lines. A DB-FAIL here while in-memory parity passes means the backfill (id remap, SparseVector convention) is wrong — debug the script, not the check.

- [ ] **Step 5: Commit**

```bash
git add search-service/scripts/sparse_parity_check.py
git commit -m "test: --db mode — SQL sparse lane vs in-memory bm25s on real corpus"
```

---

### Task 8: Worker embed stage writes `sparse` for new docs

**Files:**
- Modify: `search-service/worker/stages/embed.py`
- Modify: `search-service/tests/test_worker_stages.py` (extend the existing embed-stage test)

- [ ] **Step 1: Extend the failing test.** In the existing embed-stage test in `test_worker_stages.py`, after the chunk-row assertions, add (the scratch fixture must also seed `keyword_corpus_stats` and any vocab — add to the fixture):

```python
    # sparse keyword lane: every chunk row gets an impact vector computed
    # under frozen corpus stats; new tokens are upserted into keyword_vocab
    sparse_rows = conn.execute(
        "SELECT legacy_chunk_id, sparse FROM document_chunks WHERE document_id = %s",
        (doc_id,),
    ).fetchall()
    assert all(s is not None for _, s in sparse_rows)
    vocab_n = conn.execute("SELECT count(*) FROM keyword_vocab").fetchone()[0]
    assert vocab_n > 0
```

And seed stats in the fixture (before the stage runs):

```python
    conn.execute(
        """INSERT INTO keyword_corpus_stats (id, n_chunks, avgdl, k1, b, sparse_dim)
           VALUES (1, 100, 250.0, 1.5, 0.75, 1000000)
           ON CONFLICT (id) DO NOTHING"""
    )
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k embed`
Expected: FAIL — `sparse` is NULL.

- [ ] **Step 3: Implement.** In `embed.py` `run()`, after `vectors = _embed_texts(...)` and before the insert loop, compute sparse vectors; if stats are absent (backfill never run), write NULLs and log once:

```python
        from pgvector import SparseVector

        from app.sparse_keyword import SPARSE_DIM, chunk_weights, lucene_idf, tokenize

        stats = conn.execute(
            "SELECT n_chunks, avgdl FROM keyword_corpus_stats WHERE id = 1"
        ).fetchone()
        if stats:
            n_chunks, avgdl = stats
            token_lists = [
                tokenize(n.get_content(metadata_mode=MetadataMode.EMBED)) for n in nodes
            ]
            new_tokens = sorted({t for toks in token_lists for t in toks})
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO keyword_vocab (token, df, idf) VALUES (%s, 1, %s)
                       ON CONFLICT (token) DO NOTHING""",
                    [(t, lucene_idf(1, n_chunks)) for t in new_tokens],
                )
            rows = conn.execute(
                "SELECT token, token_id, idf FROM keyword_vocab WHERE token = ANY(%s)",
                (new_tokens,),
            ).fetchall()
            id_by_token = {t: i for t, i, _ in rows}
            idf_by_token = {t: idf for t, _, idf in rows}
            sparse_vecs = [
                SparseVector(
                    {id_by_token[t] - 1: w
                     for t, w in chunk_weights(toks, idf_by_token, avgdl).items()},
                    SPARSE_DIM,
                )
                for toks in token_lists
            ]
        else:
            logger.warning("keyword_corpus_stats missing — sparse lane not backfilled; writing NULL sparse")
            sparse_vecs = [None] * len(nodes)
```

Then add `sparse` to the INSERT column list and `sparse_vecs[offset]` to the VALUES tuple (12 → 13 columns):

```python
            conn.execute(
                """INSERT INTO document_chunks
                   (document_id, legacy_chunk_id, chunk_index, unit_type, page, text,
                    language, node_metadata, embedding, embedding_model, dimension,
                    corpus_order, sparse)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (document_id, node.metadata["chunk_id"], node.metadata.get("chunk_index", 0),
                 "summary" if is_summary else "text", node.metadata.get("page"),
                 node.text, doc["language"], Jsonb(dict(node.metadata)),
                 np.array(vec, dtype=np.float32), EMBEDDING_MODEL, DIMENSION,
                 next_order + offset, sparse_vecs[offset]),
            )
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v`
Expected: all pass, including the new sparse assertions.

- [ ] **Step 5: Commit**

```bash
git add search-service/worker/stages/embed.py search-service/tests/test_worker_stages.py
git commit -m "feat: embed stage writes sparse keyword vectors under frozen corpus stats"
```

---

### Task 9: Suite label support (candidate runs must not collide with baseline state)

**Files:**
- Modify: `evaluation/run-baseline-suite.sh`

- [ ] **Step 1: Parameterize the label.** Accept an optional label argument (default `baseline`); use it for the state file and the smoke `--label`, so `bash evaluation/run-baseline-suite.sh --daemon sparse` produces `baseline-suite-sparse.state` / smoke label `sparse` without touching baseline artifacts. Changes:

```bash
LABEL="${2:-baseline}"
STATE="$REPO/evaluation/results/baseline-suite-$LABEL.state"
```

(in the `--daemon` branch, forward the label: `( nohup bash "$0" run "$LABEL" >> evaluation/results/baseline-suite-$LABEL.log 2>&1 < /dev/null & )` and adjust the non-daemon invocation to `bash evaluation/run-baseline-suite.sh run <label>`; keep backward compatibility: first arg `--daemon` or `run`, second arg label). Replace the hardcoded `--label baseline` in the smoke step with `--label "$LABEL"`. Migrate the existing `baseline-suite.state` by renaming the references — the original baseline artifacts stay untouched.

Also: the cite/answer checkpoints (`cite-eval-checkpoint.json`) are label-blind — the suite must clear stale checkpoints when starting a NON-baseline label run on a fresh state file (add before the cite step, only when the state file did not previously exist):

```bash
if [ "$LABEL" != "baseline" ] && [ ! -s "$STATE" ]; then
  rm -f "$REPO/evaluation/results/cite-eval-checkpoint.json" \
        "$REPO/evaluation/results/answer-retrieval-checkpoint.json"
fi
```

- [ ] **Step 2: Verify it parses**

Run: `bash -n evaluation/run-baseline-suite.sh`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add evaluation/run-baseline-suite.sh
git commit -m "eval: label arg for candidate suite runs (state/log/smoke separation)"
```

---

### Task 10: EVAL GATE — candidate suite with `KEYWORD_BACKEND=sparse`

**This task decides adoption. Do not proceed to Task 11 unless the gate passes.**

**Files:** none (measurement only). Baseline references (design note §4):
- cite: P .1943 / R .8701 / F1 .3039 (`eval-report-1781206354004.json`)
- answer: chunk F1 .357 / chunk-adj F1 .465 / doc F1 .871 (`answer-retrieval-1781207582701.json`)
- smoke: BM25 lane 0/7 zh, 9/9 es+pt rank 1 (`non-english-smoke-baseline-1781207606045.json`)

- [ ] **Step 1: Switch the service to sparse.** Append `KEYWORD_BACKEND=sparse` to `search-service/.env` (this file is gitignored local config). Stop any running service: `npm run search-service:stop`.

- [ ] **Step 2: Boot and verify the sparse lane is active**

Run: `cd search-service && ./venv/bin/python -m app.main` (background)
Then: `curl -s http://127.0.0.1:8000/health` until `"ready":true` — boot log must show `Keyword lane: Postgres sparse` and boot should be markedly faster (no node load/BM25 build).

- [ ] **Step 3: Consistency demonstration (the point of the whole change)**

1. `docker exec askwri-pg psql -U askwri -d qa -c "UPDATE documents SET status='withdrawn' WHERE external_id='2022_guia-de-entornos-caminables-seguros_2940'"`
2. `curl -s --max-time 60 -X POST http://127.0.0.1:8000/query -H "Content-Type: application/json" -d '{"query": "entornos caminables seguros", "mode": "cite", "rerank": false, "return_intermediate_results": true, "max_results": 20}'` → assert the doc appears in **neither** `bm25_results` nor `docs` (baseline showed it leaking at BM25 rank 1 — design note §4.5).
3. Restore: `... SET status='searchable' ...`, re-query → doc back at BM25 rank 1 immediately.
4. Record both observations for the design-note addendum.

- [ ] **Step 4: Run the candidate suite detached**

Run: `npm run eval:baseline-suite -- sparse` — if npm arg forwarding to the script is awkward, run `bash evaluation/run-baseline-suite.sh --daemon sparse` directly.
Monitor: `tail -f evaluation/results/baseline-suite-sparse.log` until `BASELINE SUITE COMPLETE`. (The suite reuses the already-running sparse-mode service; the `/reindex` timing step now measures the sparse-mode reload.)

- [ ] **Step 5: Compare against baseline.** Gate criteria (design note §6/§9):
- cite P/R/F1 ≥ baseline minus noise (expected: **identical or near-identical** — the lane is score-exact; divergence beyond reranker-floor noise means a bug, not a tradeoff. Investigate any per-query diff via `return_intermediate_results`.)
- answer chunk/doc metrics: same standard.
- smoke: es/pt 9/9 at rank 1 in BM25 lane; zh unchanged (0/7, dense still carries); **latencies same order of magnitude** (compare smoke `latency_ms` distributions — the sparse SQL scan replaces an in-memory matmul; smoke p50 baseline was ~850ms including embedding API).
- `/reindex` sparse-mode duration recorded.

- [ ] **Step 6: Write the gate verdict into the design note** — add a `## 10. Candidate results (KEYWORD_BACKEND=sparse)` section to `docs/plans/2026-06-11-keyword-lane-replacement-design-note.md` with the measured table (cite, answer, smoke, latency, consistency demo) and PASS/FAIL per criterion.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/2026-06-11-keyword-lane-replacement-design-note.md
git commit -m "docs: sparse keyword lane eval gate results"
```

**If the gate fails:** stop, leave `KEYWORD_BACKEND=memory` everywhere, report findings. Tasks 11–12 do not run.

---

### Task 11: Simplification — delete the reindex choreography (gate-passed only)

**Files:**
- Delete: `src/lib/search-reindex.ts`
- Delete: `src/__tests__/admin-reindex.test.ts`
- Modify: `src/app/api/admin/documents/[id]/status/route.ts` (drop import line 6, call line 33, `reindex` response field line 38, stale comment line 32)
- Modify: `src/app/admin/review/page.tsx` (lines ~56–59: success notice no longer branches on `body.reindex`)
- Modify: `src/app/admin/documents/[id]/page.tsx` (lines ~140–151: same)
- Modify: `search-service/worker/stages/publish.py` (comment only)

- [ ] **Step 1: Status route.** Remove the `triggerReindex` import and call; the response loses the `reindex` field. Replace the comment explaining BM25 staleness with one line: `// Keyword + dense lanes both filter status='searchable' per query (KEYWORD_BACKEND=sparse) — no reindex choreography.`

- [ ] **Step 2: Review page + document page.** Simplify the post-mutation notices to unconditional success messages (e.g. `Promoted to searchable.` / `Status set to ${status}.`), deleting the `body.reindex?.ok` ternaries and the stale-keyword warning copy. Remove the now-unused `reindex` field from the `adminFetch<...>` response type parameter in `documents/[id]/page.tsx:140`.

- [ ] **Step 3: Worker publish stage — keep the POST, fix the comment.** **Deviation from design note §7, deliberate:** `/reindex` is retained in `publish.py` because it also refreshes the in-memory `document_texts`/`documents_metadata` used for passage context — a newly published doc's passages degrade until the service reloads them. Update the comment at `publish.py:8` and the warning at line 59 to say the POST refreshes *document texts/metadata for passage context* (keyword consistency no longer depends on it; in sparse mode the reload is seconds and swaps state without clearing).

- [ ] **Step 4: Delete dead code and its test**

```bash
git rm src/lib/search-reindex.ts src/__tests__/admin-reindex.test.ts
```

- [ ] **Step 5: Find any remaining references**

Run: `grep -rn "search-reindex\|triggerReindex" src/`
Expected: no matches.

- [ ] **Step 6: Run JS tests + build**

Run: `npm test` → expected: all suites pass (count drops by the deleted suite).
Run: `npm run test:db` → expected: 33 pass (status-route DB tests may assert the response shape — if any expects `reindex`, update the assertion to expect its absence).
Run: `npx next build --webpack` → expected: green (Turbopack panics on the venv symlink locally — known).

- [ ] **Step 7: Commit**

```bash
git add -A src search-service/worker/stages/publish.py
git commit -m "refactor: delete BM25 reindex choreography — sparse lane is consistent per query"
```

---

### Task 12: Docs + default flip + final verification

**Files:**
- Modify: `docs/document-management.md` (§4 gotcha, §5 backends table, §11 lifecycle notes)
- Modify: `.env.example`
- Modify: `search-service/app/config.py` (default flip)

- [ ] **Step 1: Flip the default** in `config.py`: `keyword_backend: str = "sparse"`. Rollback story stays one env var (`KEYWORD_BACKEND=memory`) + the still-intact memory code path. (Production deploy picks this up on next image build; no terraform change needed unless an explicit env override exists — check `terraform/infrastructure/ecs.tf` search-service environment block and add nothing if absent.)

- [ ] **Step 2: Update `docs/document-management.md`:**
- §4 "Retrieval filtering — operational gotcha": rewrite to state both lanes now filter `status='searchable'` per query under `KEYWORD_BACKEND=sparse` (the default); the stale-BM25 paragraph moves to a "legacy memory backend" note. Document the frozen-stats refresh (`scripts/build_sparse_keyword.py`) and when to run it (bulk corpus changes; never required for lifecycle correctness).
- §5 backends table: add a Keyword lane column/row for `KEYWORD_BACKEND` and the sparse description.
- §11: remove/replace the "manual `/reindex` for direct psql mutations" note — direct psql status changes are now consistent on the next query; `/reindex` only refreshes passage-context texts.

- [ ] **Step 3: Update `.env.example`** — add under the search-service section:

```
# Keyword lane: "sparse" (Postgres-resident, default) | "memory" (legacy in-memory BM25)
KEYWORD_BACKEND=sparse
```

- [ ] **Step 4: Full verification sweep**

Run each (expect green): `npm run test:python` · `npm test` · `npm run test:db` · `npm run lint` · `npx next build --webpack`

- [ ] **Step 5: Commit**

```bash
git add docs/document-management.md .env.example search-service/app/config.py
git commit -m "docs: sparse keyword lane as-built; flip KEYWORD_BACKEND default to sparse"
```

---

### Task 13: Merge to local `qa` (no push)

- [ ] **Step 1:** `git checkout qa`
- [ ] **Step 2:** `git merge --no-ff keyword-lane-replacement -m "Merge keyword-lane-replacement: Postgres-resident BM25 lane (KEYWORD_BACKEND=sparse)"`
- [ ] **Step 3:** Re-run the quick suites on `qa` (`npm test`, `npm run test:python`) — expected green.
- [ ] **Step 4:** Do NOT push. Report diffstat and the gate-results summary.

---

## Self-review notes

- Spec coverage: flag (Task 6), backfill (3, 7), worker writes (8), query path (4, 5), eval gate (10), consistency demo (10.3), simplification payoff (11, 12), reversibility (flag + memory path intact), merge protocol (13). The design note §7 item "remove the publish.py POST" is deliberately deviated from (Task 11 Step 3) with the rationale recorded — `document_texts` freshness still needs it; flagged for a future stateless-passage-context workstream.
- Type/name consistency: `keyword_vocab.token_id` 1-based everywhere; `SparseVector` dicts 0-based with `- 1` at all three construction sites (backfill, embed, retriever); `n_chunks`/`avgdl` names match migration ↔ script ↔ embed stage.
- Out of scope honored: no RRF/reranker/threshold changes; `QueryRequest`/`QueryResponse` untouched; query expansion untouched (upstream of both lanes).
