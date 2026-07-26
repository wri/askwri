# Sparse-Lane English Handles Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give English queries sparse-lane reach into non-English documents by injecting English handles (title_en + curated English long summary) into sparse BM25 weights only, plus the instrument/hygiene/presentation foundation to measure it honestly.

**Architecture:** Layer 0 fixes the diagnostic path, adds a probe runner over `evaluation/cross-lingual-en.json`, repairs known data defects, and renders a language badge (frontend-only). Layer 1 adds a default-off `sparse_en_handles` flag; when on, both sparse write sites (`scripts/build_sparse_keyword.py` backfill and `worker/stages/embed.py` incremental) append English handle text to the **sparse tokenization string only** — dense embeddings, chunk text, and the `/query` contract are untouched. No new chunks.

**Tech Stack:** Python 3.12 (FastAPI, psycopg3, pgvector, bm25s), tsx eval scripts, Next.js 16 (badge only), pytest (DB-gated scratch-DB pattern), Jest.

**Spec:** `docs/plans/2026-07-26-sparse-lane-english-handles-design.md` (approved 2026-07-26). Read its §1 fact table first — every mechanism decision traces to it.

**Ground rules for executors (from repo + session rules):**
- Work in worktree `.worktrees/multilingual-v3`, branch `design/cross-lingual-retrieval`. Confirm with `git branch --show-current` before any edit.
- Never edit `.env` / `search-service/.env`; local values go in `.env.local` files.
- Do NOT add Co-Authored-By trailers to commits.
- Python tests: `cd search-service && ./venv/bin/python -m pytest tests/<file> -v`. DB-gated tests self-skip without `DATABASE_URL` (local docker Postgres from `./scripts/local-bootstrap.sh` provides it).
- The `/query` request/response contract (`QueryRequest`/`QueryResponse` in `search-service/app/main.py`) is frozen — no field changes.
- Tasks 1–5 are independent of each other; Tasks 6–8 depend on Task 5; Task 9 depends on 6–8; Task 10 is last.

---

### Task 1: L0.1 — Diagnostic sparse-lane parity

The `return_intermediate_results` diagnostic must run the sparse lane with the SAME expanded query and `bm25_top_k` the fusion path uses (spec F7). Extract one shared helper so fusion and diagnostic cannot drift again.

**Files:**
- Modify: `search-service/app/query_expansion.py` (add `sparse_query_for`)
- Modify: `search-service/app/main.py:223-232` (fusion path uses helper) and `search-service/app/main.py:939-943` (diagnostic uses helper + top_k slice)
- Test: `search-service/tests/test_diagnostic_parity.py` (new)

- [ ] **Step 1: Write the failing test**

```python
"""Diagnostic sparse lane must mirror the fusion sparse lane (spec F7).

The fusion path expands the query via build_sparse_query and slices to
bm25_top_k (main.py HybridFusionRetriever._retrieve). The diagnostic path
historically passed the RAW query and ignored bm25_top_k, making cross-lane
attribution invalid (findings 2026-07-24 §5). These tests pin the parity.
"""
from unittest.mock import patch

from app.query_expansion import sparse_query_for


def test_sparse_query_for_matches_fusion_expansion():
    # Same function the fusion path uses; translation disabled by default so
    # this reduces to expand_query_conservative (byte-identical guarantee).
    from app.query_expansion import expand_query_conservative
    q = "What have we published on urban finance since 2020?"
    assert sparse_query_for(q) == expand_query_conservative(q, max_expansions=3)


def test_diagnostic_uses_expanded_query_and_top_k():
    """The /query diagnostic path must retrieve with the expanded query and
    slice to bm25_top_k. Uses the FastAPI TestClient with a recording stub
    retriever — model the service_state setup on tests/test_query_e2e.py."""
    from fastapi.testclient import TestClient

    from app import main as app_main

    class RecordingRetriever:
        def __init__(self):
            self.seen_queries = []

        def retrieve(self, bundle):
            self.seen_queries.append(bundle.query_str)
            from llama_index.core.schema import NodeWithScore, TextNode
            return [
                NodeWithScore(node=TextNode(id_=f"c{i}", text="t",
                                            metadata={"doc_id": f"d{i}"}), score=1.0 - i * 0.01)
                for i in range(10)
            ]

    stub = RecordingRetriever()
    # Follow test_query_e2e.py's service_state fixture pattern for the other
    # keys (pg_dense_ready, reranker_cite=None, documents_metadata, etc.).
    with patch.dict(app_main.service_state, {"bm25_retriever": stub}, clear=False):
        client = TestClient(app_main.app)
        resp = client.post("/query", json={
            "query": "urban finance mechanisms",
            "mode": "cite",
            "rerank": False,
            "bm25_top_k": 3,
            "return_intermediate_results": True,
        })
    assert resp.status_code == 200
    expected = sparse_query_for("urban finance mechanisms")
    # Diagnostic call (first) and fusion call must BOTH use the expanded query.
    assert all(q == expected for q in stub.seen_queries)
    assert len(resp.json()["bm25_results"]) == 3  # bm25_top_k applied
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_diagnostic_parity.py -v`
Expected: FAIL — `sparse_query_for` does not exist yet.

- [ ] **Step 3: Add `sparse_query_for` to `query_expansion.py`**

Append after `build_sparse_query`:

```python
def sparse_query_for(query: str) -> str:
    """THE sparse-lane query string — single source of truth.

    Both the fusion path (HybridFusionRetriever._retrieve) and the
    return_intermediate_results diagnostic must call this, so per-lane
    attribution from the diagnostic stays valid (findings 2026-07-24 §5:
    the diagnostic historically passed the raw query and was unusable for
    cross-lane comparison).
    """
    from app.config import get_settings
    from app.query_translate import get_translator

    languages = tuple(
        x.strip()
        for x in (get_settings().query_translation_languages or "").split(",")
        if x.strip()
    )
    return build_sparse_query(
        query, translate=get_translator(), languages=languages, max_expansions=3
    )
```

- [ ] **Step 4: Use it in the fusion path**

In `main.py` `HybridFusionRetriever._retrieve` (currently lines 220–232), replace the inline `build_sparse_query(...)` block with:

```python
        from app.query_expansion import sparse_query_for

        expanded_query = sparse_query_for(query_bundle.query_str)
```

(The existing comment block above it stays — it documents WHY sparse-only.)

- [ ] **Step 5: Fix the diagnostic path**

In `main.py` (currently lines 939–943), replace the BM25 diagnostic call with:

```python
            # Stage 1b: BM25 search only — MUST mirror the fusion lane:
            # same expanded query, same bm25_top_k (spec F7; findings §5).
            from app.query_expansion import sparse_query_for as _sqf
            bm25_only_results = await asyncio.to_thread(
                service_state["bm25_retriever"].retrieve,
                QueryBundle(query_str=_sqf(request.query)),
            )
            if request.bm25_top_k is not None:
                bm25_only_results = bm25_only_results[:request.bm25_top_k]
```

Check `QueryBundle` is imported at module top (it is — used at line 925's `query_bundle`).

- [ ] **Step 6: Run the new test + the full suite**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_diagnostic_parity.py tests/test_query_translation.py tests/test_query_e2e.py -v`
Expected: all PASS. Then full suite: `./venv/bin/python -m pytest tests/ -v` — expect the pre-existing pass/skip counts (226 pass / 2 skip as of findings §3, plus new tests).

- [ ] **Step 7: Commit**

```bash
git add search-service/app/query_expansion.py search-service/app/main.py search-service/tests/test_diagnostic_parity.py
git commit -m "fix(search): diagnostic sparse lane mirrors fusion — shared sparse_query_for, bm25_top_k applied"
```

---

### Task 2: L0.3a — Annotate known-defective smoke queries

**Files:**
- Modify: `evaluation/non-english-smoke.json` (queries `nq-pt-02`, `nq-es-01`)

- [ ] **Step 1: Add a `defect` field to the two entries**

In `evaluation/non-english-smoke.json`, find `nq-pt-02` and `nq-es-01`. Add to `nq-pt-02` (whose sole target `_6821` is `language='en'` on qa) and to `nq-es-01` (whose target `_2705` is `language='en'`):

```json
"defect": "target is language='en' on qa (English-edition PDF, non-English title) — findings 2026-07-24 §6; authored in the pypdf era. Excluded by run-cross-lingual-probe.ts; kept for history."
```

Exact target-to-query mapping must be verified against the file content before editing — findings §6 names `nq-pt-02`→`_6821` and `nq-es-01`→`_2705`; if `_2705` appears in a different query id, annotate THAT entry and note the correction in the commit message.

- [ ] **Step 2: Validate JSON**

Run: `npx tsx -e "JSON.parse(require('fs').readFileSync('evaluation/non-english-smoke.json','utf-8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add evaluation/non-english-smoke.json
git commit -m "chore(eval): annotate nq-pt-02/nq-es-01 targets as language='en' defects"
```

---

### Task 3: L0.2 — Cross-lingual probe runner

A BEFORE/AFTER delta instrument over `evaluation/cross-lingual-en.json`. Model closely on `evaluation/run-non-english-smoke.ts` (same lane-rank mechanics, same CLI shape). Depends on Task 1 for valid `bm25_results` attribution.

**Files:**
- Create: `evaluation/run-cross-lingual-probe.ts`
- Output dir: `evaluation/results/` (exists — check; else create)

- [ ] **Step 1: Write the runner**

```typescript
/**
 * Cross-lingual probe runner (spec 2026-07-26 L0.2).
 *
 * Reads evaluation/cross-lingual-en.json and, per query, records where each
 * target doc (and each english_competitor, for en-topical) lands: bm25 lane,
 * dense lane, fused list (rerank=false default), or the final reranked list
 * (--rerank). Writes evaluation/results/cross-lingual-probe-<label>.json.
 *
 * This is a DIRECTIONAL instrument: n=39, agent-authored, unreviewed
 * (the file's own caveats). It reports BEFORE/AFTER deltas via --compare;
 * it has NO pass/fail thresholds by design. Do not add any.
 *
 * Pinned parameters (single-harness rule — postmortem 2026-07-24 rule 7):
 * vector_top_k=800, bm25_top_k=800, rerank_top_n=500, max_results=100 —
 * the run-cite-eval.ts parameter set, so probe numbers and cite-eval numbers
 * come from the same retrieval configuration.
 *
 * Usage:
 *   npx tsx evaluation/run-cross-lingual-probe.ts --label before [--rerank]
 *   npx tsx evaluation/run-cross-lingual-probe.ts --compare before after
 * (search-service must be running; see CLAUDE.md)
 */
import * as fs from 'fs';
import * as path from 'path';
import { PYTHON_SERVICE_URL } from './lib/service-client';

const PINNED = { vector_top_k: 800, bm25_top_k: 800, rerank_top_n: 500, max_results: 100 };

interface ProbeQuery {
  id: string;
  class: 'en-tr' | 'en-body' | 'en-topical';
  query: string;
  target_doc_ids: string[];
  english_competitors?: string[];
  defect?: string;
}

interface DocRanks {
  bm25: number | null;
  dense: number | null;
  final: number | null;
}

interface ProbeResult {
  class: string;
  query: string;
  targets: Record<string, DocRanks>;
  competitors?: Record<string, DocRanks>;
  final_doc_count: number;
  latency_ms: number;
}

function rankOf(results: { doc_id: string }[] | undefined, docId: string): number | null {
  if (!results) return null;
  const seen = new Set<string>();
  let rank = 0;
  for (const r of results) {
    if (seen.has(r.doc_id)) continue;
    seen.add(r.doc_id);
    rank += 1;
    if (r.doc_id === docId) return rank;
  }
  return null;
}

async function runProbe(label: string, rerank: boolean) {
  const probePath = path.join(__dirname, 'cross-lingual-en.json');
  const probeSet = JSON.parse(fs.readFileSync(probePath, 'utf-8'));
  const queries: ProbeQuery[] = probeSet.queries.filter((q: ProbeQuery) => {
    if (q.defect) console.log(`skip ${q.id}: ${q.defect.slice(0, 60)}…`);
    return !q.defect;
  });

  const results: Record<string, ProbeResult> = {};
  for (const q of queries) {
    const started = Date.now();
    const res = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q.query,
        mode: 'cite',
        rerank,
        return_intermediate_results: true,
        ...PINNED,
      }),
    });
    if (!res.ok) throw new Error(`${q.id}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const finalDocs: { doc_id: string }[] = (data.docs || []).map((d: any) => ({ doc_id: d.doc_id }));
    const bm25 = (data.bm25_results || []).map((r: any) => ({ doc_id: r.metadata?.doc_id ?? r.doc_id }));
    const dense = (data.vector_results || []).map((r: any) => ({ doc_id: r.metadata?.doc_id ?? r.doc_id }));

    const ranks = (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, {
        bm25: rankOf(bm25, id), dense: rankOf(dense, id), final: rankOf(finalDocs, id),
      }]));

    results[q.id] = {
      class: q.class,
      query: q.query,
      targets: ranks(q.target_doc_ids),
      ...(q.english_competitors ? { competitors: ranks(q.english_competitors) } : {}),
      final_doc_count: finalDocs.length,
      latency_ms: Date.now() - started,
    };
    const t = Object.entries(results[q.id].targets)
      .map(([id, r]) => `${id.slice(-4)}: bm25=${r.bm25 ?? '—'} dense=${r.dense ?? '—'} final=${r.final ?? '—'}`)
      .join('  ');
    console.log(`${q.id} [${q.class}] ${t}`);
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `cross-lingual-probe-${label}.json`);
  fs.writeFileSync(out, JSON.stringify({
    label, rerank, pinned: PINNED, generated_at: new Date().toISOString(),
    service_url: PYTHON_SERVICE_URL, results,
  }, null, 2));
  console.log(`\nwrote ${out}  (${Object.keys(results).length} queries)`);
}

function compare(a: string, b: string) {
  const load = (l: string) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `cross-lingual-probe-${l}.json`), 'utf-8'));
  const A = load(a), B = load(b);
  console.log(`Δ ${a} → ${b}   (negative Δ = improved rank; '—' = absent)`);
  for (const id of Object.keys(A.results)) {
    if (!B.results[id]) continue;
    for (const kind of ['targets', 'competitors'] as const) {
      const ra = A.results[id][kind], rb = B.results[id][kind];
      if (!ra || !rb) continue;
      for (const doc of Object.keys(ra)) {
        const fa = ra[doc].final, fb = rb[doc]?.final;
        if (fa === fb) continue;
        const tag = kind === 'competitors' ? ' [competitor]' : '';
        console.log(`${id}${tag} ${doc}: final ${fa ?? '—'} → ${fb ?? '—'}`);
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--compare');
  if (ci >= 0) return compare(argv[ci + 1], argv[ci + 2]);
  const li = argv.indexOf('--label');
  await runProbe(li >= 0 ? argv[li + 1] : 'run', argv.includes('--rerank'));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Note: field names for the intermediate lists must be verified against `QueryResponse` (`main.py:172-175`: `vector_results`, `bm25_results`) and the dict shape the service serializes them with — check how `run-non-english-smoke.ts` reads them and mirror that exactly; adjust the `doc_id` extraction above to match.

- [ ] **Step 2: Smoke-run against the local service**

Start the service if not running (per `reference_search_service_startup` memory / CLAUDE.md). Then:

Run: `npx tsx evaluation/run-cross-lingual-probe.ts --label smoke`
Expected: 39 minus skipped-defect queries print lane ranks; JSON written under `evaluation/results/`. (`cross-lingual-en.json` has no `defect` fields — the skip path is exercised only if Task 2's annotations are later mirrored there; the filter is still correct to have.)

- [ ] **Step 3: Commit**

```bash
git add evaluation/run-cross-lingual-probe.ts
git commit -m "feat(eval): cross-lingual probe runner — per-lane target/competitor ranks, BEFORE/AFTER deltas"
```

---

### Task 4: L0.4 — Language badge (frontend-only, independent)

Render the document's language on result rows, from data the client already has (`CatalogRow.raw` keeps every CSV metadata key — spec F9). No retrieval-side change, `/query` untouched.

**Files:**
- Modify: `src/app/utils/utils.tsx` (add `languageLabel` helper)
- Modify: `src/app/results/CitePanel.tsx` (map language into rowData, ~line 89 block)
- Modify: `src/app/components/results/SelectableResultRow.tsx` (render badge)
- Modify: `src/app/components/results/types.ts` (rowData type — verify exact interface name)
- Test: `src/app/utils/utils.test.tsx` (or the repo's existing utils test file — check for one with Glob before creating)

- [ ] **Step 1: Write the failing Jest test**

```tsx
import { languageLabel } from './utils'

describe('languageLabel', () => {
  it('returns empty for English or missing', () => {
    expect(languageLabel(undefined)).toBe('')
    expect(languageLabel({})).toBe('')
    expect(languageLabel({ languages: 'English' })).toBe('')
  })
  it('returns the label for non-English documents', () => {
    expect(languageLabel({ languages: 'Spanish' })).toBe('Spanish')
    expect(languageLabel({ languages: 'Chinese' })).toBe('Chinese')
  })
  it('keeps multi-language values that include English', () => {
    expect(languageLabel({ languages: 'English, Portuguese' })).toBe('English, Portuguese')
  })
})
```

Run: `npm test -- utils` → FAIL (`languageLabel` not exported).

- [ ] **Step 2: Implement `languageLabel` in `utils.tsx`**

```tsx
/** Language label for a result row, from the client-side catalog's raw CSV
 *  metadata ('languages' key survives parseMetaJSON's norm()). Empty for
 *  English-only or unknown — the badge renders only when it informs. */
export function languageLabel(raw?: Record<string, any>): string {
  const v = String(raw?.['languages'] ?? '').trim()
  if (!v || v.toLowerCase() === 'english') return ''
  return v
}
```

Verify the exact raw key first: `parseMetaJSON` lowercases keys via `norm(k)` (`utils.tsx:80`) — confirm `norm` is plain lowercase and that the CSV column is named `languages` (check one row of the documents CSV; findings §5.6 records values like `'Spanish'`, `'English, Portuguese'`). If the normalized key differs, adjust the lookup and the test.

- [ ] **Step 3: Run test, verify pass**

Run: `npm test -- utils` → PASS.

- [ ] **Step 4: Plumb into the row data and render**

In `CitePanel.tsx` where `rowData` is built (the block at ~lines 85–98 that sets `publication_title`, `short_summary`): add `language: languageLabel(row?.raw)`. Add the field to the rowData interface in `src/app/components/results/types.ts`. In `SelectableResultRow.tsx`, next to the year cell (after `{rowData.publication_title}` heading block, ~line 126), render:

```tsx
{rowData.language ? (
  <div style={{ width: 'fit-content' }}>
    <Tag label={rowData.language} variant='info-grey' />
  </div>
) : null}
```

Reuse the already-imported `Tag` component (it renders the relevance tier at ~line 147) and match its existing props/variants — check the import and allowed variants before using `info-grey`.

- [ ] **Step 5: Verify**

Run: `npm test` (full Jest) and `npm run lint`.
Expected: PASS / no new lint errors. Visual check optional: `npm run dev` against the local stack, search anything, confirm a Spanish doc row shows the badge.

- [ ] **Step 6: Commit**

```bash
git add src/app/utils src/app/results/CitePanel.tsx src/app/components/results
git commit -m "feat(ui): language badge on result rows from client-side catalog metadata"
```

---

### Task 5: Config flag + `sparse_handles` helper module

**Files:**
- Modify: `search-service/app/config.py` (one new setting)
- Create: `search-service/app/sparse_handles.py`
- Test: `search-service/tests/test_sparse_handles.py` (new, pure-unit — no DB)

- [ ] **Step 1: Write the failing unit tests**

```python
"""Unit tests for the English-handle injection helpers (spec §3.1).

Pure functions — the DB-shaped input is a plain dict. DB-gated coverage of
the two write sites lives in test_build_sparse_script.py / test_worker_stages.py.
"""
from app.sparse_handles import handle_text


def _h(title_en="", en_summary=""):
    return {"title_en": title_en, "en_summary": en_summary}


def test_no_handle_for_missing_title_en():
    assert handle_text("Título nativo", _h(), is_summary_chunk=False) == ""


def test_title_en_appended_when_different():
    out = handle_text("Índice de Desigualdad Urbana",
                      _h(title_en="Urban Inequality Index - UII"),
                      is_summary_chunk=False)
    assert out == "Urban Inequality Index - UII"


def test_title_en_skipped_when_equal_after_normalization():
    # casefold + whitespace normalization (spec §3.1) — most zh docs, whose
    # indexed catalog title IS the English title.
    out = handle_text("Zhuzhou  Complete Street Design Manual",
                      _h(title_en="zhuzhou complete street design manual"),
                      is_summary_chunk=False)
    assert out == ""


def test_summary_chunk_gets_english_summary_too():
    out = handle_text("Título", _h(title_en="Title EN", en_summary="An English abstract."),
                      is_summary_chunk=True)
    assert out == "Title EN\nAn English abstract."


def test_text_chunk_never_gets_summary():
    out = handle_text("Título", _h(title_en="Title EN", en_summary="An English abstract."),
                      is_summary_chunk=False)
    assert out == "Title EN"
```

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sparse_handles.py -v` → FAIL (module missing).

- [ ] **Step 2: Add the setting**

In `app/config.py`, after the `keyword_backend` block (~line 51):

```python
    # English handles into SPARSE weights only (spec 2026-07-26 §3): when
    # true, build_sparse_keyword.py and the worker embed stage append
    # title_en (+ the curated English long summary, summary chunk only) to
    # the text that feeds sparse tokenization for language != 'en' docs.
    # Dense embeddings, chunk text and /query are untouched. Default OFF:
    # flag-off rebuild restores byte-identical current weights (rollback).
    sparse_en_handles: bool = False
```

- [ ] **Step 3: Create `app/sparse_handles.py`**

```python
"""English handles for the sparse BM25 lane (spec 2026-07-26 §3).

Generalizes the mechanism the corpus already proves: zh docs are reachable by
English queries because every zh chunk carries an English title in its indexed
metadata header (findings 2026-07-24 §2.2); es/pt/id docs carry none. When
SPARSE_EN_HANDLES is on, the two sparse write sites append, per chunk of a
language != 'en' document:

- title_en (skipped when it equals the indexed title after casefold +
  whitespace normalization — zh docs), and
- for the summary chunk only, the curated English long summary
  (document_summaries language='en', kind='long').

SPARSE ONLY. The handle text must never reach the dense-embedding content
string or the stored chunk text — injecting into the shared
get_content(MetadataMode.EMBED) string would silently change dense embeddings
and force a re-embed (spec §3.2 implementation callout).
"""
from typing import Dict

# Mirrors the indexer's title choice (worker/stages/embed.py:76,
# app.indexing load_csv_metadata) so the equality skip compares like to like.
_HANDLES_SQL = """
    SELECT d.external_id,
           COALESCE(NULLIF(d.source_metadata->'metadata'->>'Publication Title', ''),
                    NULLIF(d.source_metadata->'metadata'->>'Article Title', ''),
                    d.title) AS indexed_title,
           d.title_en,
           s.text AS en_summary
    FROM documents d
    LEFT JOIN document_summaries s
      ON s.document_id = d.id AND s.language = 'en' AND s.kind = 'long'
    WHERE d.language != 'en'
"""


def _norm(s: str) -> str:
    return " ".join((s or "").casefold().split())


def load_english_handles(conn) -> Dict[str, dict]:
    """{external_id: {indexed_title, title_en, en_summary}} for non-EN docs."""
    out = {}
    for ext, indexed_title, title_en, en_summary in conn.execute(_HANDLES_SQL):
        out[ext] = {
            "indexed_title": indexed_title or "",
            "title_en": title_en or "",
            "en_summary": en_summary or "",
        }
    return out


def handle_text(indexed_title: str, handle: dict, is_summary_chunk: bool) -> str:
    """The English text to append to ONE chunk's sparse tokenization string."""
    parts = []
    title_en = handle.get("title_en") or ""
    if title_en and _norm(title_en) != _norm(indexed_title):
        parts.append(title_en)
    if is_summary_chunk and (handle.get("en_summary") or ""):
        parts.append(handle["en_summary"])
    return "\n".join(parts)
```

- [ ] **Step 4: Run tests**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sparse_handles.py tests/test_config.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/config.py search-service/app/sparse_handles.py search-service/tests/test_sparse_handles.py
git commit -m "feat(search): sparse_en_handles flag + English-handle helpers (default off)"
```

---

### Task 6: Backfill-site injection — `build_sparse_keyword.py`

**Files:**
- Modify: `search-service/scripts/build_sparse_keyword.py` (contents build, ~lines 50–61)
- Test: extend `search-service/tests/test_build_sparse_script.py` (reuse its scratch-DB module fixtures)

- [ ] **Step 1: Write the failing DB-gated test**

Append to `test_build_sparse_script.py` (reusing `build_test_db`; seed data mirrors the existing `seeded` fixture's INSERT shapes — copy its column lists exactly):

```python
def test_en_handles_injected_flag_on(build_test_db, monkeypatch):
    """Flag on: a non-EN doc's chunk gains title_en tokens in sparse; flag off:
    weights are unchanged vs a clean rebuild (rollback guarantee, spec §3.4)."""
    import psycopg

    with psycopg.connect(build_test_db) as conn:
        conn.execute(
            """INSERT INTO documents (id, external_id, s3_key, title, status, language, title_en)
               VALUES ('00000000-0000-0000-0000-000000000003', 'doc_es',
                       'documents/doc_es.pdf', 'Índice de Desigualdad', 'searchable', 'es',
                       'Urban Inequality Index')"""
        )
        conn.execute(
            """INSERT INTO document_summaries (document_id, language, kind, text, source)
               VALUES ('00000000-0000-0000-0000-000000000003', 'en', 'long',
                       'Measures unequal access to services.', 'external')"""
        )
        # One text chunk + one summary chunk, node_metadata like the worker writes
        # (doc_id, title, chunk_index) — copy the existing fixture's INSERT shape.
        ...

    from scripts.build_sparse_keyword import main as build_main

    # Baseline: flag off (default) — record the doc's sparse vectors.
    build_main()
    with psycopg.connect(build_test_db) as conn:
        base = dict(conn.execute(
            "SELECT legacy_chunk_id, sparse::text FROM document_chunks WHERE document_id = %s",
            ("00000000-0000-0000-0000-000000000003",)).fetchall())
        assert conn.execute(
            "SELECT count(*) FROM keyword_vocab WHERE token = %s", ("inequ",)
        ).fetchone()[0] == 0  # stemmed 'inequality' absent before injection

    monkeypatch.setenv("SPARSE_EN_HANDLES", "true")
    from app.config import get_settings
    get_settings.cache_clear()
    build_main()
    with psycopg.connect(build_test_db) as conn:
        # title_en vocabulary now exists and the chunk vector changed
        tid = conn.execute("SELECT token_id FROM keyword_vocab WHERE token = %s",
                           ("inequ",)).fetchone()
        assert tid is not None
        after = dict(conn.execute(
            "SELECT legacy_chunk_id, sparse::text FROM document_chunks WHERE document_id = %s",
            ("00000000-0000-0000-0000-000000000003",)).fetchall())
        assert after != base

    # Rollback: flag off again — byte-identical to the first baseline.
    monkeypatch.delenv("SPARSE_EN_HANDLES")
    get_settings.cache_clear()
    build_main()
    with psycopg.connect(build_test_db) as conn:
        rolled = dict(conn.execute(
            "SELECT legacy_chunk_id, sparse::text FROM document_chunks WHERE document_id = %s",
            ("00000000-0000-0000-0000-000000000003",)).fetchall())
    assert rolled == base
```

Fill the `...` chunk INSERTs by copying the existing fixture's `document_chunks` INSERT columns (`legacy_chunk_id`, `chunk_index`, `unit_type`, `text`, `node_metadata`, `corpus_order`, …). **The crux of the test lives in `node_metadata`** — the injection looks up handles by `node_metadata->>'doc_id'` and detects the summary chunk by `node_metadata->>'chunk_index' == -1`, so seed exactly:
- text chunk: `chunk_index=0`, `unit_type='text'`, `node_metadata = {"doc_id": "doc_es", "title": "Índice de Desigualdad", "chunk_index": 0}`
- summary chunk: `chunk_index=-1`, `unit_type='summary'`, `node_metadata = {"doc_id": "doc_es", "title": "Índice de Desigualdad", "chunk_index": -1}`

If the metadata lacks `doc_id`, injection silently no-ops and the flag-on assertion fails for the wrong reason.

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_build_sparse_script.py -v -k en_handles`
Expected: FAIL (flag has no effect yet). (Self-skips without `DATABASE_URL` — run against the local docker DB.)

- [ ] **Step 2: Implement injection in the build script**

In `scripts/build_sparse_keyword.py` `main()`, after `nodes = _load_all_nodes()` and before tokenization (~line 57), replace:

```python
    contents = [n.get_content(metadata_mode=MetadataMode.EMBED) for n in nodes]
```

with:

```python
    # English handles (spec 2026-07-26 §3): appended to the SPARSE tokenization
    # string only — dense embeddings and stored chunk text are untouched.
    from app.config import get_settings
    from app.sparse_handles import handle_text, load_english_handles

    handles = {}
    if get_settings().sparse_en_handles:
        with get_pool().connection() as conn:
            handles = load_english_handles(conn)
        print(f"sparse_en_handles ON — {len(handles)} non-EN docs with handles")

    def _sparse_content(n):
        base = n.get_content(metadata_mode=MetadataMode.EMBED)
        h = handles.get(n.metadata.get("doc_id"))
        if not h:
            return base
        extra = handle_text(h["indexed_title"], h,
                            is_summary_chunk=n.metadata.get("chunk_index") == -1)
        return f"{base}\n{extra}" if extra else base

    contents = [_sparse_content(n) for n in nodes]
```

- [ ] **Step 3: Run the test**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_build_sparse_script.py -v`
Expected: all PASS (existing cases prove flag-off is unchanged; new case proves injection + rollback).

- [ ] **Step 4: Commit**

```bash
git add search-service/scripts/build_sparse_keyword.py search-service/tests/test_build_sparse_script.py
git commit -m "feat(search): backfill-site English-handle injection behind sparse_en_handles"
```

---

### Task 7: Worker-site injection — `worker/stages/embed.py`

The incremental sparse write must match Task 6 or the next re-ingest strips the handles (spec §3.2 drift warning). The critical assertion: dense content strings DIVERGE from sparse tokenization strings — handles must never reach `_embed_texts*`.

**Files:**
- Modify: `search-service/worker/stages/embed.py` (token_lists build, ~line 203-205; handle fetch near the summary query, ~line 160)
- Test: extend `search-service/tests/test_worker_stages.py` (follow its existing embed-stage DB-gated pattern)

- [ ] **Step 1: Write the failing test**

Model on the existing embed-stage test in `test_worker_stages.py` (scratch DB, seeded doc + `document_texts`, monkeypatched embedding call). New case, seeding a `language='es'` doc with `title_en` and an en/long summary row:

```python
def test_embed_injects_en_handles_sparse_only(worker_db, monkeypatch):
    """Flag on: sparse vectors carry title_en tokens; the DENSE content strings
    and stored chunk text do NOT (spec §3.2 divergence callout)."""
    captured = {}

    def fake_embed(texts):
        captured["dense_contents"] = list(texts)
        return [[0.0] * 1536 for _ in texts]

    monkeypatch.setattr("worker.stages.embed._embed_texts_bedrock", fake_embed)
    monkeypatch.setenv("SPARSE_EN_HANDLES", "true")
    from app.config import get_settings
    get_settings.cache_clear()

    # ... seed es doc (title 'Índice de Desigualdad', title_en 'Urban Inequality
    # Index'), document_texts row, en/long summary row, keyword_corpus_stats row
    # (copy the module's existing seeding helpers), then run the stage:
    from worker.stages import embed as embed_stage
    embed_stage.run(DOC_ID)

    # Dense NEVER sees the handle:
    assert all("Urban Inequality Index" not in t for t in captured["dense_contents"])
    with psycopg.connect(worker_db) as conn:
        # Stored chunk text unchanged:
        n = conn.execute(
            "SELECT count(*) FROM document_chunks WHERE document_id=%s AND text ILIKE %s",
            (DOC_ID, "%urban inequality%")).fetchone()[0]
        assert n == 0
        # Sparse DOES carry the handle: the stemmed token exists in vocab and
        # the chunk's sparse vector has a nonzero weight at its index.
        tid = conn.execute("SELECT token_id FROM keyword_vocab WHERE token='inequ'").fetchone()
        assert tid is not None
        vec = conn.execute(
            "SELECT sparse::text FROM document_chunks WHERE document_id=%s AND chunk_index=0",
            (DOC_ID,)).fetchone()[0]
        assert f"{tid[0]}:" in vec  # sparsevec text format '{id:weight,…}/dim'
```

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k en_handles`
Expected: FAIL.

- [ ] **Step 2: Implement**

In `worker/stages/embed.py` `run()`:

(a) Where the native summary is fetched (~line 160), also fetch the handle when the flag is on:

```python
        en_handle = None
        if get_settings().sparse_en_handles and doc["language"] != "en":
            en_row = conn.execute(
                """SELECT text FROM document_summaries
                   WHERE document_id=%s AND language='en' AND kind='long'""",
                (document_id,),
            ).fetchone()
            en_handle = {
                "indexed_title": title_for_doc,  # see (b)
                "title_en": doc.get("title_en") or "",
                "en_summary": en_row[0] if en_row else "",
            }
```

`title_for_doc` must be the SAME title `_build_nodes_for_doc` indexes (`Publication Title` → `Article Title` → `doc["title"]`, line 76). Either hoist that three-way COALESCE into a tiny helper used by both, or recompute it here identically — do not let them drift. Also verify `fetch_document` (in `worker/stages/__init__.py`) selects `title_en`; if not, add it to that SELECT.

(b) Where `token_lists` is built (~line 203):

```python
            from app.sparse_handles import handle_text

            def _sparse_content(n):
                base = n.get_content(metadata_mode=MetadataMode.EMBED)
                if not en_handle:
                    return base
                extra = handle_text(
                    en_handle["indexed_title"], en_handle,
                    is_summary_chunk=bool(n.metadata.get("is_summary_node")),
                )
                return f"{base}\n{extra}" if extra else base

            token_lists = [tokenize(_sparse_content(n)) for n in nodes]
```

`contents` (line 186, feeds dense) is NOT touched — that is the divergence the test pins.

- [ ] **Step 3: Run tests**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py tests/test_worker_pipeline.py -v`
Expected: PASS (existing flag-off cases unchanged; new case passes).

- [ ] **Step 4: Commit**

```bash
git add search-service/worker/stages/embed.py search-service/worker/stages/__init__.py search-service/tests/test_worker_stages.py
git commit -m "feat(worker): embed-stage English-handle injection, sparse tokenization only"
```

---

### Task 8: Parity-check guard

`scripts/sparse_parity_check.py` asserts sparse ≡ in-memory BM25 over raw text; with handles on it diverges BY DESIGN (spec §3.3). Guard it so a parity run is never misread as a regression.

**Files:**
- Modify: `search-service/scripts/sparse_parity_check.py` (top of `main`)

- [ ] **Step 1: Add the guard**

Read the script first (it has not been read this session — locate its entrypoint). At the start of its main flow add:

```python
    from app.config import get_settings

    if get_settings().sparse_en_handles:
        print("sparse_en_handles is ON: stored sparse vectors intentionally "
              "diverge from raw-text BM25 (English handles injected — spec "
              "2026-07-26 §3.3). Run parity with SPARSE_EN_HANDLES=false "
              "against a flag-off rebuild.")
        raise SystemExit(2)
```

- [ ] **Step 2: Verify + commit**

Run: `cd search-service && ./venv/bin/python -m pytest tests/ -v` (nothing should break — the guard is script-only).

```bash
git add search-service/scripts/sparse_parity_check.py
git commit -m "chore(scripts): parity check refuses to run with sparse_en_handles on"
```

---

### Task 9: L0.3b — title_en repairs (GATED: needs user confirmation + qa DB access)

The 3 es docs with Spanish `title_en` (`_3254`, `_2276`, `_9425` — spec F10; provenance `'llm'`, overwrite permitted). **Do not execute the UPDATE without the user's explicit confirmation of the replacement titles and of writing to qa.**

- [ ] **Step 1: Fetch current values (read-only)**

Against the qa DB (or local mirror), for external_ids ending `_3254`, `_2276`, `_9425`:

```sql
SELECT external_id, title, title_en, metadata_source->>'title_en' AS provenance
FROM documents
WHERE external_id LIKE '%_3254' OR external_id LIKE '%_2276' OR external_id LIKE '%_9425';
```

Confirm provenance is `llm` for all three (spec F10). If any is `human`/`external`, STOP and surface.

- [ ] **Step 2: Draft English titles and present to the user**

Draft a faithful English translation of each `title` (the docs: women & transport in Bogotá `_3254`; adjusted origin-destination survey database `_2276`; clean air in vital neighborhoods `_9425`). Present all three old→new pairs to the user and WAIT for approval.

- [ ] **Step 3: Apply (after approval), with provenance**

```sql
UPDATE documents
SET title_en = :approved_title,
    metadata_source = jsonb_set(COALESCE(metadata_source, '{}'::jsonb),
                                '{title_en}', '"human"')
WHERE external_id = :ext_id;
```

One statement per doc; verify with the Step 1 SELECT afterwards. Note: chunks index these via handles only after the next flag-on rebuild (Task 10) — no separate action needed.

---

### Task 10: Gates — BEFORE/AFTER measurement and no-regression evals

Operational sequence; run locally against the standard rig (local search-service; DB per the 2026-07-24 probe setup — qa-read-only or the local docker corpus, state which in the report). **All comparisons single-harness (postmortem rule 7).**

- [ ] **Step 1: BEFORE capture (flag off)**

With the service running, flag off:

```bash
npx tsx evaluation/run-cross-lingual-probe.ts --label before
npx tsx evaluation/run-cross-lingual-probe.ts --label before-rerank --rerank
npx tsx evaluation/run-non-english-smoke.ts --label before
npm run eval:cite
npm run eval:answer-retrieval
```

Archive the cite/answer reports alongside the probe JSON (they are the baseline arm).

- [ ] **Step 2: Flag-on rebuild**

In `search-service/.env.local` set `SPARSE_EN_HANDLES=true` (never `.env`). Worker must be idle (existing frozen-stats rule). Rebuild:

```bash
cd search-service && ./venv/bin/python -m scripts.build_sparse_keyword
```

Expected: `sparse_en_handles ON — ~29 non-EN docs; N inject a title handle, M an English summary` and the usual vector-count summary. No service restart needed — nothing on the query path reads the flag; it must be set in the rebuild process's env only (and the worker's, for subsequent re-ingests).

- [ ] **Step 3: AFTER capture + deltas**

```bash
npx tsx evaluation/run-cross-lingual-probe.ts --label after
npx tsx evaluation/run-cross-lingual-probe.ts --label after-rerank --rerank
npx tsx evaluation/run-cross-lingual-probe.ts --compare before after
npx tsx evaluation/run-cross-lingual-probe.ts --compare before-rerank after-rerank
npx tsx evaluation/run-non-english-smoke.ts --label after
npm run eval:cite
npm run eval:answer-retrieval
```

Read against spec §3.4 expectations: `en-topical`/`en-tr` targets should improve in the bm25 and final columns; `en-body` is expected NOT to move (immune by construction); `en-topical` competitors must not systematically lose top-10.

- [ ] **Step 4: Gate decision**

- Cite/answer evals: no regression vs Step 1 (same harness, same corpus, same day).
- If cite metrics moved at all: floor re-derivation per existing policy (`scripts/capture_cite_scores.py` + `analyze_cite_scores.py`, `config.py:137-143`), then re-run `npm run eval:cite` at the derived floor.
- Non-English smoke set: no systematic target-rank degradation (the summary-dl inflation cost — final review I4 — is only visible here).
- Write the BEFORE/AFTER summary into a short results note under `docs/plans/` (date-stamped), including which DB the probes ran against.
- STOP: qa deploy (secrets/env flip + qa rebuild + floor config change) is a separate runbook exercise with its own user approval — not part of this plan.

- [ ] **Step 5: Final commit**

```bash
git add docs/plans evaluation/results
git commit -m "docs(eval): sparse_en_handles BEFORE/AFTER probe + eval gate results"
```

---

## Execution notes

- Task order: 1 → (2, 3, 4 in any order, parallelizable) → 5 → 6 → 7 → 8 → 9 (gated) → 10. Task 4 (frontend) is fully independent — good parallel lane.
- Any test file referenced as a "model" (e.g. `test_query_e2e.py`, `test_worker_stages.py`) must be read in full before writing the new test — fixtures and seeding helpers are reused, not reinvented.
- If a cited line number has drifted, find the anchor by content (function name / comment), not by counting — and say so in the commit message.
