# Query Expansion & Understanding — P0+P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship P0 (per-lane rank instrument + baselines) and P1 (deterministic query-understanding tier: facet parsing + single pre-rerank filter point + trigram did-you-mean + topic sensing + chips UX) of the query-expansion design, dark behind `QUERY_UNDERSTANDING_ENABLED=false`.

**Architecture:** A new `understanding` module in the Python search service produces one schema-validated `QueryUnderstanding` object per query (deterministic signals only in P1). When the flag is on, hard facets filter once, post-fusion / pre-rerank; suggestions and chips flow to the Next.js UI through additive response fields. Flag off = byte-identical to today.

**Tech Stack:** FastAPI + pydantic (search-service), psycopg + pgvector + pg_trgm (Postgres), TypeORM raw-SQL migration (Next.js app tier), React + Chakra/WRI design system + Jest/RTL (UI).

**Spec:** `docs/plans/2026-08-19-query-expansion-design.md` — read it first; every task below argues from it.

## Global Constraints

- Invariant 1 (spec §2): anything that **excludes** documents must be visible & reversible; anything that only reorders may be silent.
- Invariant 2 (spec §2): hard filters ONLY on human-verifiable metadata (year, language, program, doc type). Topic tags and intent may only boost/suggest.
- `QueryRequest`/`QueryResponse` existing fields untouched; new fields additive only (spec §4.6). The `/query` contract note in `CLAUDE.md` applies.
- Flag off (`query_understanding_enabled=False`, the default) must be **byte-identical** to current behavior. All new query-path code sits behind `understanding is not None`.
- No retry loops in the query path; every signal is one attempt, failure-soft, recorded in `understanding.degraded` (spec §5).
- Python deps are PINNED — this plan needs **no new Python deps** (pg_trgm is a Postgres extension, psycopg + pgvector already present). Do not touch `requirements.txt`.
- Migrations: raw SQL via `queryRunner.query`, `synchronize` false, file `src/db/migrations/<epoch_ms>-<Name>.ts`.
- Two-writer rule: `search_vocab` rows are python-owned (like `keyword_vocab`); the app migration owns only the DDL.
- Commit style: conventional commits, `git add <explicit paths>`, no Co-Authored-By trailer.
- Run Python tests: `cd search-service && ./venv/bin/python -m pytest tests/<file> -v`. Run JS tests: `npm test -- <pattern>`.
- The `requires_db` pytest marker (`tests/conftest.py:34-37`) guards DB tests; copy that idiom, never hard-require a DB in unit tests.

---

### Task 1 (P0): Per-lane rank attribution in `debug`

The instrument the cross-lingual design §5.2 demanded: the ranks that actually fed RRF, readable per returned node. Without it, no lane-level claim in P2+ is evidenced.

**Files:**
- Modify: `search-service/app/main.py:273-307` (`HybridFusionRetriever._retrieve`), `search-service/app/main.py:1301-1313` (debug block)
- Test: `search-service/tests/test_lane_attribution.py` (create)

**Interfaces:**
- Produces: `HybridFusionRetriever.lane_ranks: dict[str, dict[str, int | None]]` — `{node_id: {"dense": 1-based rank or None, "sparse": rank or None}}` for every fused node, set during `_retrieve`. Response `debug["lane_ranks"]` present **only when** `request.return_intermediate_results` is true.

- [ ] **Step 1: Write the failing test**

```python
# search-service/tests/test_lane_attribution.py
"""Per-lane rank attribution (design 2026-08-19 P0; cross-lingual design §5.2).

The ranks recorded must be the rankings that FED RRF — the fusion path's own
dense/sparse lists — not the separate diagnostic lanes (the 2026-07-24 findings
retraction happened because those differ)."""
from types import SimpleNamespace
from unittest.mock import MagicMock

from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app.main import HybridFusionRetriever


def _nws(node_id: str, score: float) -> NodeWithScore:
    return NodeWithScore(node=TextNode(id_=node_id, text=f"text {node_id}"), score=score)


class _StubRetriever:
    def __init__(self, results):
        self._results = results

    def retrieve(self, bundle):
        return list(self._results)


def _make_retriever(dense, sparse):
    return HybridFusionRetriever(
        vector_retriever=_StubRetriever(dense),
        bm25_retriever=_StubRetriever(sparse),
        mode="cite",
        fusion_top_k=10,
    )


def test_lane_ranks_recorded_for_all_fused_nodes():
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    r = _make_retriever(dense, sparse)
    r._retrieve(QueryBundle(query_str="anything"))

    assert r.lane_ranks["a"] == {"dense": 1, "sparse": None}
    assert r.lane_ranks["b"] == {"dense": 2, "sparse": 1}
    assert r.lane_ranks["c"] == {"dense": None, "sparse": 2}


def test_lane_ranks_cover_exactly_the_fused_set():
    dense = [_nws(f"d{i}", 1.0 - i / 100) for i in range(15)]
    sparse = [_nws(f"s{i}", 10.0 - i) for i in range(15)]
    r = _make_retriever(dense, sparse)
    out = r._retrieve(QueryBundle(query_str="q"))
    assert set(r.lane_ranks.keys()) == {n.node.node_id for n in out}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_lane_attribution.py -v`
Expected: FAIL with `AttributeError: 'HybridFusionRetriever' object has no attribute 'lane_ranks'`

- [ ] **Step 3: Implement lane_ranks in `_retrieve`**

In `HybridFusionRetriever._retrieve`, immediately after the two `for i, node_with_score in enumerate(...)` RRF loops (after `main.py:286`), add:

```python
        # Per-lane rank attribution (design 2026-08-19 P0). These are the
        # rankings that FED RRF — the only valid basis for lane-level claims
        # (cross-lingual design §5.2: the diagnostic lanes are NOT this).
        dense_rank = {n.node.node_id: i + 1 for i, n in enumerate(dense_results)}
        sparse_rank = {n.node.node_id: i + 1 for i, n in enumerate(sparse_results)}
```

Then, after `sorted_nodes` is computed (after `main.py:296`), add:

```python
        self.lane_ranks = {
            node_id: {"dense": dense_rank.get(node_id), "sparse": sparse_rank.get(node_id)}
            for node_id, _ in sorted_nodes
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_lane_attribution.py -v`
Expected: 2 PASS

- [ ] **Step 5: Expose in debug payload (diagnostic mode only)**

In the `response_data["debug"]` dict (`main.py:1291-1321`), after the `"passage_ms"` entry, add:

```python
                "lane_ranks": (getattr(hybrid_retriever, "lane_ranks", None)
                               if request.return_intermediate_results else None),
```

(Payload discipline: ~500 entries; only diagnostic/eval callers set the flag.)

- [ ] **Step 6: Run the full python suite**

Run: `cd search-service && ./venv/bin/python -m pytest tests/ -v`
Expected: no new failures (DB-marked tests skip without `DATABASE_URL`).

- [ ] **Step 7: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_lane_attribution.py
git commit -m "feat(retrieval): per-lane rank attribution in debug (P0 instrument)"
```

---

### Task 2 (P0): Baseline capture

Same-instrument BEFORE numbers for every later gate. Operational: needs the search service running on the measurement rig (the local service pointed at qa RDS via `./scripts/with-remote-env.sh qa`, the same rig as the 2026-07-23 floor work). If credentials are unavailable in this session, STOP and hand this task to the operator — do not substitute a different rig; numbers from different harnesses must never be compared (global rules).

**Files:**
- Create: `evaluation/results/2026-08-19-p0-baseline-cite.json`, `evaluation/results/2026-08-19-p0-baseline-answer.json`, `evaluation/results/2026-08-19-p0-baseline-nonen-smoke.txt` (paths/names follow what each runner emits; record actual filenames in the commit message)

**Interfaces:**
- Produces: committed baseline JSONs that Task 14's gate compares against, captured at explicit preset parity.

- [ ] **Step 1: Start the search service against qa** (operator rig)

```bash
./scripts/with-remote-env.sh qa bash -c 'cd search-service && ./venv/bin/python -m app.main'
```

- [ ] **Step 2: Run the three suites** (separate shell)

```bash
npm run eval:cite
npm run eval:answer-retrieval
npx tsx evaluation/run-non-english-smoke.ts
```

Expected: each completes and writes/prints results. Non-EN smoke must report 16/16 present, 16/16 rank-1 (its current recorded state) — if it does not, STOP and report; the baseline is already broken and gating on it would be meaningless.

- [ ] **Step 3: Copy result artifacts into `evaluation/results/` with the `2026-08-19-p0-baseline-` prefix, commit**

```bash
git add evaluation/results/2026-08-19-p0-baseline-*
git commit -m "chore(eval): P0 baseline capture for query-understanding gates"
```

---

### Task 3: Config flags + `QueryUnderstanding` schema

**Files:**
- Modify: `search-service/app/config.py` (after the `query_translation_timeout_s` block, ~line 97)
- Create: `search-service/app/understanding.py`
- Test: `search-service/tests/test_understanding.py` (create)

**Interfaces:**
- Produces (imported by Tasks 4, 6, 7, 9, 10):
  - `understanding.Facet(facet: str, value: str, confidence: float, source: str, action: str)` — `facet ∈ {"year_min","year_max","language","program","excluded_keyword"}`, `source ∈ {"parser","llm","user"}`, `action ∈ {"hard","soft","suggest"}`
  - `understanding.Suggestion(type: str, text: str)` — `type ∈ {"spelling","disambiguation","nearby_topic"}`
  - `understanding.QueryUnderstanding(version:int=1, intent:str="topical", facets:list[Facet], variants:list[str], suggestions:list[Suggestion], timings:dict, degraded:list[str])`
  - `understanding.understanding_active(settings, request) -> bool`
  - Settings: `query_understanding_enabled: bool = False`, `spell_suggest_similarity: float = 0.45`, `topic_sense_top_k: int = 3`, `topic_sense_min_cosine: float = 0.30`

- [ ] **Step 1: Write the failing test**

```python
# search-service/tests/test_understanding.py
"""QueryUnderstanding schema + activation guard (design 2026-08-19 §4.1, §5).

Strict validation: a malformed object must be rejected WHOLE — half-applied
understanding is the brittleness the design bans."""
import pytest
from pydantic import ValidationError

from app.understanding import (
    Facet,
    QueryUnderstanding,
    Suggestion,
    understanding_active,
)


def test_defaults_are_empty_and_versioned():
    u = QueryUnderstanding()
    assert u.version == 1
    assert u.intent == "topical"
    assert u.facets == [] and u.variants == [] and u.suggestions == []
    assert u.degraded == []


def test_unknown_facet_name_rejected_whole():
    with pytest.raises(ValidationError):
        Facet(facet="vibe", value="good", confidence=0.9, source="parser", action="hard")


def test_out_of_range_confidence_rejected():
    with pytest.raises(ValidationError):
        Facet(facet="language", value="es", confidence=1.7, source="parser", action="hard")


def test_unknown_suggestion_type_rejected():
    with pytest.raises(ValidationError):
        Suggestion(type="telepathy", text="x")


def test_activation_guard():
    class S:  # duck-typed settings/request
        query_understanding_enabled = True

    class R:
        expansion = True

    assert understanding_active(S(), R()) is True
    R.expansion = False
    assert understanding_active(S(), R()) is False
    R.expansion = True
    S.query_understanding_enabled = False
    assert understanding_active(S(), R()) is False


def test_flag_defaults_off():
    from app.config import Settings
    assert Settings.model_fields["query_understanding_enabled"].default is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_understanding.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.understanding'`

- [ ] **Step 3: Add settings**

In `search-service/app/config.py`, after the `query_translation_timeout_s: float = 3.0` line, add:

```python
    # Query understanding (design 2026-08-19). Dark by default: flag-off is
    # byte-identical to the pre-feature pipeline (guarded by
    # tests/test_understanding.py + the P1 gate's flag-off eval run).
    # P1 ships the deterministic tier only (facet parsers, trigram
    # did-you-mean, tag-embedding topic sensing). Cost of enabling (P1): two
    # small SQL lookups + one cached embed reuse per query; no LLM call.
    query_understanding_enabled: bool = False
    # Initial conservative thresholds — MUST be re-derived from the labeled
    # fixture sets (tests/fixtures/didyoumean_queries.json,
    # facet_queries.json) before any flag-on deploy; never hand-tuned.
    spell_suggest_similarity: float = 0.45
    topic_sense_top_k: int = 3
    topic_sense_min_cosine: float = 0.30
```

- [ ] **Step 4: Create the schema module**

```python
# search-service/app/understanding.py
"""Query understanding — one schema-validated object per query.

Design: docs/plans/2026-08-19-query-expansion-design.md §4.1, §5.
P1 = deterministic tier only. Strict enums + confidence bounds: an invalid
object is rejected WHOLE (never half-applied). Every signal is one attempt,
failure-soft, recorded in `degraded`.
"""
from typing import Literal

from pydantic import BaseModel, Field

UNDERSTANDING_VERSION = 1

FACET_NAMES = ("year_min", "year_max", "language", "program", "excluded_keyword")


class Facet(BaseModel):
    facet: Literal["year_min", "year_max", "language", "program", "excluded_keyword"]
    value: str
    confidence: float = Field(ge=0.0, le=1.0)
    source: Literal["parser", "llm", "user"]
    action: Literal["hard", "soft", "suggest"]


class Suggestion(BaseModel):
    type: Literal["spelling", "disambiguation", "nearby_topic"]
    text: str


class QueryUnderstanding(BaseModel):
    version: int = UNDERSTANDING_VERSION
    intent: Literal["topical", "known_item", "catalog"] = "topical"
    facets: list[Facet] = Field(default_factory=list)
    variants: list[str] = Field(default_factory=list)
    suggestions: list[Suggestion] = Field(default_factory=list)
    timings: dict = Field(default_factory=dict)
    degraded: list[str] = Field(default_factory=list)


def understanding_active(settings, request) -> bool:
    """THE flag-off guard. All query-path understanding code must sit behind
    this returning True — that is what makes flag-off byte-identical."""
    return bool(
        getattr(settings, "query_understanding_enabled", False)
        and getattr(request, "expansion", True)
    )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_understanding.py -v`
Expected: 6 PASS

- [ ] **Step 6: Commit**

```bash
git add search-service/app/config.py search-service/app/understanding.py search-service/tests/test_understanding.py
git commit -m "feat(understanding): QueryUnderstanding schema + dark flag"
```

---

### Task 4: Deterministic facet parsers (year, language)

Conservative by design. The corpus is full of target years ("net zero by 2050") that are NOT publication-year constraints — the trap fixtures encode that.

**Files:**
- Create: `search-service/app/facet_parsers.py`
- Create: `search-service/tests/fixtures/facet_queries.json`
- Test: `search-service/tests/test_facet_parsers.py` (create)

**Interfaces:**
- Consumes: `understanding.Facet` (Task 3)
- Produces: `facet_parsers.parse_facets(query: str, today_year: int) -> list[Facet]` (parser facets have `source="parser"`, `action="hard"`, `confidence=0.9`)

- [ ] **Step 1: Write the labeled fixture set** (~30 queries; the threshold-derivation artifact named in the spec §7)

```json
// search-service/tests/fixtures/facet_queries.json
{
  "_comment": "Labeled facet-extraction set (design 2026-08-19 §7). Direction-only n. today_year is pinned so tests are stable.",
  "today_year": 2026,
  "queries": [
    {"q": "what have we published on hydrogen since 2020", "facets": [{"facet": "year_min", "value": "2020"}]},
    {"q": "bus electrification reports after 2021", "facets": [{"facet": "year_min", "value": "2021"}]},
    {"q": "freight decarbonization since 2022 in portuguese", "facets": [{"facet": "year_min", "value": "2022"}, {"facet": "language", "value": "pt"}]},
    {"q": "urban planning papers before 2019", "facets": [{"facet": "year_max", "value": "2019"}]},
    {"q": "studies until 2018 on air quality", "facets": [{"facet": "year_max", "value": "2018"}]},
    {"q": "TOD research between 2019 and 2023", "facets": [{"facet": "year_min", "value": "2019"}, {"facet": "year_max", "value": "2023"}]},
    {"q": "coastal resilience from 2020 to 2024", "facets": [{"facet": "year_min", "value": "2020"}, {"facet": "year_max", "value": "2024"}]},
    {"q": "electric mobility 2021-2024", "facets": [{"facet": "year_min", "value": "2021"}, {"facet": "year_max", "value": "2024"}]},
    {"q": "anything published in 2023 about land value capture", "facets": [{"facet": "year_min", "value": "2023"}, {"facet": "year_max", "value": "2023"}]},
    {"q": "reports from the last 3 years on charging infrastructure", "facets": [{"facet": "year_min", "value": "2023"}]},
    {"q": "papers from the past 5 years on BRT", "facets": [{"facet": "year_min", "value": "2021"}]},
    {"q": "documents in spanish about street safety", "facets": [{"facet": "language", "value": "es"}]},
    {"q": "spanish-language guides on walkability", "facets": [{"facet": "language", "value": "es"}]},
    {"q": "portuguese language publications on complete streets", "facets": [{"facet": "language", "value": "pt"}]},
    {"q": "reports in chinese on freight", "facets": [{"facet": "language", "value": "zh"}]},
    {"q": "materials in mandarin about street design", "facets": [{"facet": "language", "value": "zh"}]},
    {"q": "publications in english on flooding", "facets": [{"facet": "language", "value": "en"}]},
    {"q": "in indonesian, transport safety work", "facets": [{"facet": "language", "value": "id"}]},

    {"q": "net zero by 2050 pathways", "facets": []},
    {"q": "2030 emission reduction targets for cities", "facets": []},
    {"q": "what must cities do before 2030 to decarbonize", "facets": []},
    {"q": "scenarios until 2050 for freight", "facets": []},
    {"q": "SDG 11 progress since the Paris Agreement", "facets": []},
    {"q": "population growth after 2050 projections", "facets": []},
    {"q": "spanish cities and cycling infrastructure", "facets": []},
    {"q": "the portuguese experience with road pricing", "facets": []},
    {"q": "china's electric bus fleet", "facets": []},
    {"q": "how did covid change transit ridership in 2020 compared to 2019", "facets": []},
    {"q": "bus rapid transit", "facets": []},
    {"q": "cost of 100 km of bike lanes", "facets": []}
  ]
}
```

Notes baked into the labels: bare "in YYYY" does NOT trigger (only "published in YYYY" does — see "covid ... in 2020" trap); "before/until YYYY" triggers only for YYYY ≤ today_year ("before 2030" is a target, not a filter); nationality adjectives ("spanish cities") never trigger language.

- [ ] **Step 2: Write the failing test**

```python
# search-service/tests/test_facet_parsers.py
"""Deterministic facet parsers vs the labeled fixture set.

The fixture is the derivation artifact for parser behavior (spec §7): if a
pattern change breaks a trap case, the change is wrong, not the fixture."""
import json
from pathlib import Path

import pytest

from app.facet_parsers import parse_facets

_FIX = json.loads(
    (Path(__file__).parent / "fixtures" / "facet_queries.json").read_text()
)


@pytest.mark.parametrize(
    "case", _FIX["queries"], ids=[c["q"][:40] for c in _FIX["queries"]]
)
def test_labeled_facet_extraction(case):
    got = parse_facets(case["q"], today_year=_FIX["today_year"])
    got_pairs = sorted((f.facet, f.value) for f in got)
    want_pairs = sorted((f["facet"], f["value"]) for f in case["facets"])
    assert got_pairs == want_pairs


def test_parser_facets_are_hard_parser_sourced():
    for f in parse_facets("hydrogen since 2020 in spanish", today_year=2026):
        assert f.source == "parser"
        assert f.action == "hard"
        assert f.confidence == 0.9
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_parsers.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.facet_parsers'`

- [ ] **Step 4: Implement the parsers**

```python
# search-service/app/facet_parsers.py
"""Deterministic facet parsers — year ranges and language (design §4.1).

CONSERVATIVE BY CONSTRUCTION. This corpus is full of target years ("net zero
by 2050", "2030 targets") that are not publication-year constraints, and of
nationality adjectives ("spanish cities") that are not language constraints.
Every pattern here requires an explicit constraint word, and every matched
year must be <= today_year. The trap cases in
tests/fixtures/facet_queries.json are load-bearing: a pattern change that
breaks one is wrong.
"""
import re

from app.understanding import Facet

_Y = r"(19[5-9]\d|20\d\d)"

_RANGE_RE = re.compile(
    rf"\b(?:between\s+|from\s+)?{_Y}\s*(?:-|–|\bto\b|\band\b)\s*{_Y}\b", re.I
)
_SINCE_RE = re.compile(rf"\b(?:since|after)\s+{_Y}\b", re.I)
_BEFORE_RE = re.compile(rf"\b(?:before|until|up to|prior to)\s+{_Y}\b", re.I)
_PUBLISHED_IN_RE = re.compile(rf"\bpublished\s+in\s+{_Y}\b", re.I)
_LAST_N_RE = re.compile(r"\b(?:last|past)\s+(\d{1,2})\s+years?\b", re.I)

_LANGUAGES = {
    "spanish": "es",
    "portuguese": "pt",
    "chinese": "zh",
    "mandarin": "zh",
    "english": "en",
    "indonesian": "id",
}
# Constraint phrasings only — a bare adjective ("spanish cities") never fires.
_LANG_RE = re.compile(
    r"(?:\bin\s+(spanish|portuguese|chinese|mandarin|english|indonesian)\b"
    r"|\b(spanish|portuguese|chinese|mandarin|english|indonesian)[-\s]language\b)",
    re.I,
)


def _facet(name: str, value: str) -> Facet:
    return Facet(facet=name, value=value, confidence=0.9, source="parser", action="hard")


def parse_facets(query: str, today_year: int) -> list[Facet]:
    facets: list[Facet] = []
    remaining = query

    m = _RANGE_RE.search(remaining)
    if m:
        lo, hi = sorted((int(m.group(1)), int(m.group(2))))
        if hi <= today_year:
            facets.append(_facet("year_min", str(lo)))
            facets.append(_facet("year_max", str(hi)))
            remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet == "year_min" for f in facets):
        m = _SINCE_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_min", m.group(1)))
            remaining = remaining[: m.start()] + remaining[m.end():]
        else:
            m = _LAST_N_RE.search(remaining)
            if m:
                facets.append(_facet("year_min", str(today_year - int(m.group(1)))))
                remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet == "year_max" for f in facets):
        m = _BEFORE_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_max", m.group(1)))
            remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet in ("year_min", "year_max") for f in facets):
        m = _PUBLISHED_IN_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_min", m.group(1)))
            facets.append(_facet("year_max", m.group(1)))

    m = _LANG_RE.search(query)
    if m:
        lang_word = (m.group(1) or m.group(2)).lower()
        facets.append(_facet("language", _LANGUAGES[lang_word]))

    return facets
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_parsers.py -v`
Expected: all PASS (30 fixture cases + 1). If a fixture case fails, fix the PATTERN, not the fixture — unless you can argue the label itself is wrong, in which case stop and flag it in the task report.

- [ ] **Step 6: Commit**

```bash
git add search-service/app/facet_parsers.py search-service/tests/test_facet_parsers.py search-service/tests/fixtures/facet_queries.json
git commit -m "feat(understanding): deterministic year/language facet parsers + labeled fixture set"
```

---

### Task 5: `search_vocab` migration + offline vocab builder

**Files:**
- Create: `src/db/migrations/1787480000000-SearchVocab.ts`
- Create: `search-service/scripts/build_search_vocab.py`
- Test: `search-service/tests/test_build_search_vocab.py` (create)

**Interfaces:**
- Produces: table `search_vocab(term text PK, source text, df int)` with GIN trigram index `idx_search_vocab_trgm`; `build_search_vocab.collect_terms(rows_titles, rows_tags, rows_aliases) -> dict[str, tuple[str, int]]` (pure, term → (source, df)); `build_search_vocab.run()` (DB rebuild, idempotent delete-then-insert). Python owns rows; app migration owns DDL (two-writer rule).

- [ ] **Step 1: Write the migration**

```typescript
// src/db/migrations/1787480000000-SearchVocab.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

// Query-understanding P1 (docs/plans/2026-08-19-query-expansion-design.md):
// trigram did-you-mean vocabulary. Rows are PYTHON-OWNED (rebuilt by
// search-service/scripts/build_search_vocab.py, like keyword_vocab); this
// migration owns only the DDL. No TypeORM entity, matching document_chunks.
export class Migration1787480000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`CREATE TABLE "search_vocab" (
      "term" text NOT NULL,
      "source" text NOT NULL,
      "df" integer NOT NULL DEFAULT 0,
      CONSTRAINT "PK_search_vocab" PRIMARY KEY ("term")
    )`);
    await queryRunner.query(
      `CREATE INDEX "idx_search_vocab_trgm" ON "search_vocab" USING gin ("term" gin_trgm_ops)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "search_vocab"`);
    // pg_trgm extension is left installed: shared infrastructure, dropping
    // it could break unrelated objects.
  }
}
```

- [ ] **Step 2: Write the failing test for the pure collector**

```python
# search-service/tests/test_build_search_vocab.py
"""Vocab builder: pure term collection + (DB-marked) rebuild idempotency."""
import os

import pytest

from scripts.build_search_vocab import collect_terms


def test_collect_terms_merges_sources_and_counts_df():
    titles = [("Urban Inequality Index",), ("Urban Freight Decarbonization",)]
    tags = [("Land Value Capture",)]
    aliases = [("LVC betterment levy",)]
    vocab = collect_terms(titles, tags, aliases)

    assert vocab["urban"] == ("title", 2)          # df counts occurrences
    assert vocab["inequality"] == ("title", 1)
    assert vocab["capture"][0] == "tag"
    assert vocab["betterment"][0] == "alias"
    # short tokens (<3 chars) and pure numbers excluded
    assert "of" not in vocab and "lvc" in vocab    # 3-char acronym kept


def test_collect_terms_lowercases_and_strips():
    vocab = collect_terms([("BRT Corridors—Design",)], [], [])
    assert "brt" in vocab and "corridors" in vocab and "design" in vocab
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_build_search_vocab.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.build_search_vocab'`

- [ ] **Step 4: Implement the builder**

```python
# search-service/scripts/build_search_vocab.py
"""Rebuild search_vocab (trigram did-you-mean vocabulary).

Sources: searchable document titles (title + title_en), topic tag labels,
tag aliases. UNSTEMMED words — keyword_vocab is Snowball-stemmed and
useless for display-quality suggestions. Delete-then-insert: idempotent.

Run: cd search-service && ./venv/bin/python -m scripts.build_search_vocab
"""
import logging
import re

from app.db import get_pool

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[a-zA-Z][a-zA-Z-]{2,}")

# Precedence when a term appears in several sources (title wins: it is the
# vocabulary users actually see).
_PRECEDENCE = {"title": 0, "tag": 1, "alias": 2}


def _words(text: str) -> list[str]:
    return [w.lower().strip("-") for w in _WORD_RE.findall(text or "") if len(w.strip("-")) >= 3]


def collect_terms(titles, tags, aliases) -> dict:
    """(rows of 1-tuples per source) -> {term: (source, df)} — pure."""
    vocab: dict = {}
    for source, rows in (("title", titles), ("tag", tags), ("alias", aliases)):
        for (text,) in rows:
            for w in _words(text):
                if w in vocab:
                    old_source, df = vocab[w]
                    keep = old_source if _PRECEDENCE[old_source] <= _PRECEDENCE[source] else source
                    vocab[w] = (keep, df + 1)
                else:
                    vocab[w] = (source, 1)
    return vocab


def run() -> int:
    with get_pool().connection() as conn:
        titles = conn.execute(
            """SELECT title FROM documents WHERE status = 'searchable' AND title IS NOT NULL
               UNION ALL
               SELECT title_en FROM documents WHERE status = 'searchable' AND title_en IS NOT NULL"""
        ).fetchall()
        tags = conn.execute(
            "SELECT value_id FROM tags WHERE facet = 'topic'"
        ).fetchall()
        aliases = conn.execute("SELECT alias FROM tag_aliases").fetchall()

        vocab = collect_terms(titles, tags, aliases)

        conn.execute("DELETE FROM search_vocab")
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO search_vocab (term, source, df) VALUES (%s, %s, %s)",
                [(t, s, d) for t, (s, d) in vocab.items()],
            )
    logger.info(f"search_vocab rebuilt: {len(vocab)} terms")
    return len(vocab)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_build_search_vocab.py -v`
Expected: 2 PASS

- [ ] **Step 6: Run the migration locally and build the vocab** (needs the local docker stack from `./scripts/local-bootstrap.sh`; skip this step if no local DB — note it in the task report)

```bash
npm run migration:run
cd search-service && ./venv/bin/python -m scripts.build_search_vocab
```

Expected: migration applies; builder logs a term count > 0.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/1787480000000-SearchVocab.ts search-service/scripts/build_search_vocab.py search-service/tests/test_build_search_vocab.py
git commit -m "feat(understanding): search_vocab table + offline vocab builder"
```

---

### Task 6: Trigram did-you-mean suggester

**Files:**
- Create: `search-service/app/spell_suggest.py`
- Create: `search-service/tests/fixtures/didyoumean_queries.json`
- Test: `search-service/tests/test_spell_suggest.py` (create)

**Interfaces:**
- Consumes: `understanding.Suggestion` (Task 3); `search_vocab` (Task 5); settings `spell_suggest_similarity` (Task 3)
- Produces: `spell_suggest.TrigramSuggester(exact_lookup, fuzzy_lookup, similarity_threshold)` with `.suggest(query: str) -> Suggestion | None`; module-level `spell_suggest.db_suggester() -> TrigramSuggester` (DB-backed). `exact_lookup: (list[str]) -> set[str]` (which words exist verbatim); `fuzzy_lookup: (str) -> tuple[str, float] | None` (best trigram match).

- [ ] **Step 1: Write the labeled fixture (with false-positive traps)**

```json
// search-service/tests/fixtures/didyoumean_queries.json
{
  "_comment": "Did-you-mean labeled set (spec §7). vocab = the fake corpus vocabulary for unit tests. Traps: real words absent from the corpus vocab must NOT be 'corrected'.",
  "vocab": ["decarbonization", "micromobility", "hydrogen", "freight", "bogota", "curitiba", "walkability", "electrification", "resilience", "transit"],
  "cases": [
    {"q": "freight decarbonisation pathways", "expect": "freight decarbonization pathways"},
    {"q": "micromobilty in latin america", "expect": "micromobility in latin america"},
    {"q": "hydrogin buses", "expect": "hydrogen buses"},
    {"q": "walkabillity and street design", "expect": "walkability and street design"},
    {"q": "transit electrification in bogata", "expect": "transit electrification in bogota"},
    {"q": "freight decarbonization pathways", "expect": null},
    {"q": "zebra crossings", "expect": null},
    {"q": "xylophone lessons", "expect": null},
    {"q": "curitiba brt history", "expect": null}
  ]
}
```

("zebra"/"xylophone" are real words missing from the fake vocab with no close trigram neighbor above threshold — the suggester must stay silent, not force a match.)

- [ ] **Step 2: Write the failing test**

```python
# search-service/tests/test_spell_suggest.py
"""Trigram did-you-mean: unit tests with an injected in-memory vocabulary
(fixture-driven, incl. false-positive traps) + a requires_db smoke test."""
import json
import os
from pathlib import Path

import pytest

from app.spell_suggest import TrigramSuggester
from tests.conftest import requires_db

_FIX = json.loads(
    (Path(__file__).parent / "fixtures" / "didyoumean_queries.json").read_text()
)


def _trigrams(w: str) -> set:
    w = f"  {w} "
    return {w[i:i + 3] for i in range(len(w) - 2)}


def _sim(a: str, b: str) -> float:
    ta, tb = _trigrams(a), _trigrams(b)
    return len(ta & tb) / len(ta | tb)


def _fake_suggester(vocab, threshold=0.45):
    vocab_set = set(vocab)

    def exact_lookup(words):
        return {w for w in words if w in vocab_set}

    def fuzzy_lookup(word):
        best = max(vocab_set, key=lambda t: _sim(word, t))
        return (best, _sim(word, best))

    return TrigramSuggester(exact_lookup, fuzzy_lookup, threshold)


@pytest.mark.parametrize("case", _FIX["cases"], ids=[c["q"] for c in _FIX["cases"]])
def test_labeled_suggestions(case):
    s = _fake_suggester(_FIX["vocab"])
    out = s.suggest(case["q"])
    if case["expect"] is None:
        assert out is None
    else:
        assert out is not None
        assert out.type == "spelling"
        assert out.text == case["expect"]


def test_lookup_failure_is_silent():
    def boom(_):
        raise RuntimeError("db down")

    s = TrigramSuggester(lambda ws: set(), boom, 0.45)
    assert s.suggest("hydrogin buses") is None


@requires_db
def test_db_suggester_smoke():
    from app.spell_suggest import db_suggester
    # Just proves the SQL runs against a real search_vocab (may be empty).
    db_suggester().suggest("hydrogin buses")
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_spell_suggest.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.spell_suggest'`

- [ ] **Step 4: Implement**

```python
# search-service/app/spell_suggest.py
"""Trigram did-you-mean against search_vocab (design §3, §4.1).

Evidence rule, server half: suggest only when a query word is
out-of-corpus-vocabulary AND a close trigram neighbor exists. The client
half (auto-switch when results are near-empty) lives in the UI. One
suggestion max per query; lookup failure is silent (failure-soft, spec §5).
"""
import logging
import re

from app.understanding import Suggestion

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[a-zA-Z][a-zA-Z-]{3,}")  # >=4 chars: short words are noise

_SKIP = {
    "have", "what", "where", "when", "which", "about", "with", "from",
    "published", "papers", "reports", "report", "study", "studies",
    "cities", "city", "urban", "their", "does", "into", "this", "that",
}


class TrigramSuggester:
    def __init__(self, exact_lookup, fuzzy_lookup, similarity_threshold: float):
        self._exact = exact_lookup
        self._fuzzy = fuzzy_lookup
        self._threshold = similarity_threshold

    def suggest(self, query: str) -> Suggestion | None:
        words = [w.lower() for w in _WORD_RE.findall(query) if w.lower() not in _SKIP]
        if not words:
            return None
        try:
            known = self._exact(words)
            corrections = {}
            for w in words:
                if w in known:
                    continue
                hit = self._fuzzy(w)
                if hit is not None and hit[1] >= self._threshold and hit[0] != w:
                    corrections[w] = hit[0]
        except Exception as exc:  # noqa: BLE001 — never fail a search on suggestions
            logger.warning(f"spell suggest degraded: {exc}")
            return None
        if not corrections:
            return None

        corrected = re.sub(
            _WORD_RE,
            lambda m: corrections.get(m.group(0).lower(), m.group(0)),
            query,
        )
        if corrected == query:
            return None
        return Suggestion(type="spelling", text=corrected)


def db_suggester() -> TrigramSuggester:
    from app.config import get_settings
    from app.db import get_pool

    def exact_lookup(words):
        with get_pool().connection() as conn:
            rows = conn.execute(
                "SELECT term FROM search_vocab WHERE term = ANY(%s)", (words,)
            ).fetchall()
        return {t for (t,) in rows}

    def fuzzy_lookup(word):
        with get_pool().connection() as conn:
            row = conn.execute(
                """SELECT term, similarity(term, %(w)s) AS sim
                   FROM search_vocab WHERE term %% %(w)s
                   ORDER BY sim DESC LIMIT 1""",
                {"w": word},
            ).fetchone()
        return (row[0], float(row[1])) if row else None

    return TrigramSuggester(
        exact_lookup, fuzzy_lookup, get_settings().spell_suggest_similarity
    )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_spell_suggest.py -v`
Expected: fixture cases + failure test PASS; db smoke skips without `DATABASE_URL`.

- [ ] **Step 6: Commit**

```bash
git add search-service/app/spell_suggest.py search-service/tests/test_spell_suggest.py search-service/tests/fixtures/didyoumean_queries.json
git commit -m "feat(understanding): trigram did-you-mean suggester with trap fixtures"
```

---

### Task 7: Topic sensing against `tag_embeddings`

**Files:**
- Create: `search-service/app/topic_sense.py`
- Test: `search-service/tests/test_topic_sense.py` (create)

**Interfaces:**
- Consumes: `tag_embeddings` (migration `1787160000000-TopicTaxonomy.ts:43-56`; PK `(tag_id, embedding_model)`, `vector` column, HNSW partial on `embedding_model='cohere-embed-v4'` with `::vector(1536)` cast); `understanding.Suggestion`; settings `topic_sense_top_k`, `topic_sense_min_cosine`.
- Produces: `topic_sense.nearby_topics(query_embedding: list[float]) -> list[tuple[str, float]]` (label, cosine — filtered/limited by settings); `topic_sense.attach_topic_suggestions(u: QueryUnderstanding, query: str, embed_model) -> None` (appends `nearby_topic` suggestions; failure-soft, appends `"topic_sense"` to `u.degraded` on error).

- [ ] **Step 1: Write the failing test**

```python
# search-service/tests/test_topic_sense.py
"""Topic sensing: pure filtering logic + failure-soft attach + DB smoke.

Invariant 2 (spec §2): topics are model-inferred on BOTH sides — they may
only ever become suggestions, never hard facets. The attach function must
therefore never touch u.facets."""
import os

import pytest

from app.topic_sense import attach_topic_suggestions, filter_topics
from app.understanding import QueryUnderstanding
from tests.conftest import requires_db


def test_filter_topics_applies_threshold_and_top_k():
    raw = [("freight", 0.61), ("air quality", 0.44), ("housing", 0.29), ("parks", 0.12)]
    out = filter_topics(raw, top_k=2, min_cosine=0.30)
    assert out == [("freight", 0.61), ("air quality", 0.44)]


def test_attach_appends_suggestions_never_facets(monkeypatch):
    import app.topic_sense as ts

    monkeypatch.setattr(ts, "nearby_topics", lambda emb: [("freight", 0.61)])

    class _Embed:
        def get_query_embedding(self, q):
            return [0.0] * 1536

    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", _Embed())
    assert [s.type for s in u.suggestions] == ["nearby_topic"]
    assert u.suggestions[0].text == "freight"
    assert u.facets == []
    assert "topic_sense" not in u.degraded


def test_attach_is_failure_soft(monkeypatch):
    import app.topic_sense as ts

    def boom(emb):
        raise RuntimeError("no table")

    monkeypatch.setattr(ts, "nearby_topics", boom)

    class _Embed:
        def get_query_embedding(self, q):
            return [0.0] * 1536

    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", _Embed())
    assert u.suggestions == []
    assert "topic_sense" in u.degraded


def test_attach_degrades_without_embed_model():
    u = QueryUnderstanding()
    attach_topic_suggestions(u, "trucks", None)
    assert "topic_sense" in u.degraded


@requires_db
def test_nearby_topics_sql_runs():
    from app.topic_sense import nearby_topics
    nearby_topics([0.0] * 1536)  # proves the SQL parses against a real DB
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_topic_sense.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.topic_sense'`

- [ ] **Step 3: Implement**

```python
# search-service/app/topic_sense.py
"""Query-to-topic sensing via tag_embeddings cosine (design §4.1).

The query embedding is looked up through the SAME embed model instance the
dense lane used, so after stage 1 the call is an LRU cache hit — zero extra
Bedrock calls in the normal path.

Invariant 2: output is SUGGESTIONS ONLY (nearby_topic). Never facets.
"""
import logging

import numpy as np

from app.understanding import QueryUnderstanding, Suggestion

logger = logging.getLogger(__name__)

# Matches the partial HNSW index (1787160000000-TopicTaxonomy.ts): the
# ::vector(1536) cast + embedding_model predicate are what make it usable.
_TOPIC_SQL = """
    SELECT t.value_id, 1 - (te.embedding::vector(1536) <=> %(q)s) AS cosine
    FROM tag_embeddings te
    JOIN tags t ON t.id = te.tag_id
    WHERE te.embedding_model = %(model)s
      AND t.facet = 'topic'
    ORDER BY te.embedding::vector(1536) <=> %(q)s
    LIMIT %(k)s
"""


def filter_topics(rows, top_k: int, min_cosine: float):
    """Pure: threshold + limit. Split out so the policy is unit-testable."""
    return [(label, cos) for label, cos in rows if cos >= min_cosine][:top_k]


def nearby_topics(query_embedding) -> list:
    from app.config import get_settings
    from app.db import get_pool

    s = get_settings()
    qvec = np.array(query_embedding, dtype=np.float32)
    with get_pool().connection() as conn:
        rows = conn.execute(
            _TOPIC_SQL,
            {"q": qvec, "model": s.embedding_model, "k": max(s.topic_sense_top_k * 4, 20)},
        ).fetchall()
    return filter_topics(
        [(label, float(cos)) for label, cos in rows],
        top_k=s.topic_sense_top_k,
        min_cosine=s.topic_sense_min_cosine,
    )


def attach_topic_suggestions(u: QueryUnderstanding, query: str, embed_model) -> None:
    """Append nearby_topic suggestions to `u`. Failure-soft (spec §5)."""
    if embed_model is None:
        u.degraded.append("topic_sense")
        return
    try:
        emb = embed_model.get_query_embedding(query)
        for label, _cos in nearby_topics(emb):
            u.suggestions.append(Suggestion(type="nearby_topic", text=label))
    except Exception as exc:  # noqa: BLE001 — never fail a search on topic sensing
        logger.warning(f"topic sense degraded: {exc}")
        u.degraded.append("topic_sense")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_topic_sense.py -v`
Expected: 4 PASS + 1 skip (without DB)

- [ ] **Step 5: Commit**

```bash
git add search-service/app/topic_sense.py search-service/tests/test_topic_sense.py
git commit -m "feat(understanding): tag-embedding topic sensing (suggestions only)"
```

---

### Task 8: Extend startup doc-metadata hydration

**Files:**
- Modify: `search-service/app/pg_store.py:69-90` (`load_documents_metadata`)
- Test: `search-service/tests/test_pg_store.py` (extend)

**Interfaces:**
- Produces: each `documents_metadata[external_id]` dict gains `"language": str|None`, `"article_type": str|None`, `"year_int": int|None` (from `year_published`, falling back to parsing the catalog `YEAR published` string). Caveat inherited from the cross-lingual design §5.7: this map is startup-hydrated — data edits need a service restart to appear.

- [ ] **Step 1: Write the failing test** (append to `search-service/tests/test_pg_store.py`, following that file's existing conventions — check its imports/markers first and reuse them)

```python
# append to search-service/tests/test_pg_store.py
def test_year_int_fallback_parsing():
    from app.pg_store import _year_int

    assert _year_int(2021, {"YEAR published": "2019"}) == 2021   # column wins
    assert _year_int(None, {"YEAR published": "2019"}) == 2019   # string fallback
    assert _year_int(None, {"YEAR published": "n.d."}) is None
    assert _year_int(None, {}) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_pg_store.py -v -k year_int`
Expected: FAIL with `ImportError: cannot import name '_year_int'`

- [ ] **Step 3: Implement**

In `pg_store.py`, add above `load_documents_metadata`:

```python
def _year_int(year_published, raw: dict):
    """Facet-filter year: real column first, catalog string fallback."""
    if year_published is not None:
        return int(year_published)
    try:
        return int(str(raw.get("YEAR published", "")).strip())
    except (ValueError, TypeError):
        return None
```

Change the SELECT in `load_documents_metadata` to:

```python
            "SELECT external_id, source_metadata, language, article_type, year_published "
            "FROM documents WHERE status = 'searchable'"
```

change the loop header to `for ext, src, language, article_type, year_published in rows:` and add to the per-doc dict (after `"raw_metadata": raw,`):

```python
            # Query-understanding facet fields (design 2026-08-19 §4.5).
            # Startup-hydrated: data edits need a restart to appear here.
            "language": language,
            "article_type": article_type,
            "year_int": _year_int(year_published, raw),
```

- [ ] **Step 4: Run tests**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_pg_store.py -v`
Expected: new test PASS, existing tests unaffected (DB ones skip without `DATABASE_URL`).

- [ ] **Step 5: Commit**

```bash
git add search-service/app/pg_store.py search-service/tests/test_pg_store.py
git commit -m "feat(understanding): hydrate language/article_type/year_int into documents_metadata"
```

---

### Task 9: Single pre-rerank facet filter point

**Files:**
- Create: `search-service/app/facet_filter.py`
- Test: `search-service/tests/test_facet_filter.py` (create)

**Interfaces:**
- Consumes: `understanding.Facet` (Task 3); `documents_metadata` shape (Task 8)
- Produces (Task 10 wires them):
  - `facet_filter.apply_facet_filters(nodes: list[NodeWithScore], facets: list[Facet], docs_meta: dict) -> list[NodeWithScore]` — only `action="hard"` facets filter; empty/soft/suggest facets → nodes returned unchanged (same list object).
  - `facet_filter.legacy_request_facets(request) -> list[Facet]` — converts `min_year`/`max_year`/`required_program`/`excluded_keywords` to `source="user"` hard Facets so legacy params flow through the SAME code path when understanding is active (spec §4.5: one application point, no second path).

- [ ] **Step 1: Write the failing test** (MagicMock-node pattern from `test_cite_doc_ids_filter.py:31-40`)

```python
# search-service/tests/test_facet_filter.py
"""Single pre-rerank facet application point (design §4.5).

Semantics mirror the legacy apply_metadata_filters where they overlap
(year-unparseable docs are EXCLUDED when a year filter is set; program is
exact-match on node metadata; excluded_keywords substring on title+text)."""
from types import SimpleNamespace
from unittest.mock import MagicMock

from app.facet_filter import apply_facet_filters, legacy_request_facets
from app.understanding import Facet


def _node(doc_id, year_meta="2020", program="", text="body text", title="t"):
    n = MagicMock()
    n.node.metadata = {
        "doc_id": doc_id, "year": year_meta, "program_series": program, "title": title,
    }
    n.node.text = text
    return n


def _hard(facet, value):
    return Facet(facet=facet, value=value, confidence=0.9, source="parser", action="hard")


DOCS_META = {
    "d-en-2023": {"language": "en", "article_type": "report", "year_int": 2023},
    "d-es-2019": {"language": "es", "article_type": "report", "year_int": 2019},
    "d-noyear": {"language": "en", "article_type": None, "year_int": None},
}


def test_year_min_filters_on_docs_meta():
    nodes = [_node("d-en-2023"), _node("d-es-2019")]
    out = apply_facet_filters(nodes, [_hard("year_min", "2022")], DOCS_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en-2023"]


def test_year_filter_excludes_unparseable_year():
    nodes = [_node("d-noyear", year_meta="n.d.")]
    assert apply_facet_filters(nodes, [_hard("year_min", "2000")], DOCS_META) == []


def test_year_falls_back_to_node_metadata_when_doc_unknown():
    nodes = [_node("mystery", year_meta="2024")]
    out = apply_facet_filters(nodes, [_hard("year_min", "2022")], {})
    assert len(out) == 1


def test_language_filters_on_docs_meta():
    nodes = [_node("d-en-2023"), _node("d-es-2019")]
    out = apply_facet_filters(nodes, [_hard("language", "es")], DOCS_META)
    assert [n.node.metadata["doc_id"] for n in out] == ["d-es-2019"]


def test_program_and_excluded_keyword():
    nodes = [
        _node("d-en-2023", program="WRR", text="clean freight"),
        _node("d-es-2019", program="WRR", text="dirty coal freight"),
    ]
    out = apply_facet_filters(
        nodes,
        [_hard("program", "WRR"), _hard("excluded_keyword", "coal")],
        DOCS_META,
    )
    assert [n.node.metadata["doc_id"] for n in out] == ["d-en-2023"]


def test_soft_and_suggest_facets_do_not_filter():
    nodes = [_node("d-es-2019")]
    soft = Facet(facet="language", value="en", confidence=0.5, source="llm", action="soft")
    assert apply_facet_filters(nodes, [soft], DOCS_META) is nodes


def test_no_hard_facets_returns_same_list_object():
    nodes = [_node("d-en-2023")]
    assert apply_facet_filters(nodes, [], DOCS_META) is nodes


def test_legacy_request_facets_conversion():
    req = SimpleNamespace(
        min_year=2020, max_year=2024,
        required_program="WRR", excluded_keywords=["coal", "oil"],
    )
    got = sorted((f.facet, f.value) for f in legacy_request_facets(req))
    assert got == [
        ("excluded_keyword", "coal"), ("excluded_keyword", "oil"),
        ("program", "WRR"), ("year_max", "2024"), ("year_min", "2020"),
    ]
    assert all(f.source == "user" and f.action == "hard" for f in legacy_request_facets(req))


def test_legacy_request_facets_empty_request():
    req = SimpleNamespace(min_year=None, max_year=None, required_program=None, excluded_keywords=None)
    assert legacy_request_facets(req) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_filter.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.facet_filter'`

- [ ] **Step 3: Implement**

```python
# search-service/app/facet_filter.py
"""THE facet application point — post-fusion, pre-rerank (design §4.5).

One code path for parser-detected, user-chip, and legacy-param facets.
Only action='hard' facets exclude (Invariant 1: every one of these is
rendered as a removable chip by the UI; Invariant 2: all hard facet types
are human-verifiable metadata)."""
from typing import List

from app.understanding import Facet


def legacy_request_facets(request) -> List[Facet]:
    out: List[Facet] = []
    if getattr(request, "min_year", None):
        out.append(Facet(facet="year_min", value=str(request.min_year),
                         confidence=1.0, source="user", action="hard"))
    if getattr(request, "max_year", None):
        out.append(Facet(facet="year_max", value=str(request.max_year),
                         confidence=1.0, source="user", action="hard"))
    if getattr(request, "required_program", None):
        out.append(Facet(facet="program", value=request.required_program,
                         confidence=1.0, source="user", action="hard"))
    for kw in (getattr(request, "excluded_keywords", None) or []):
        out.append(Facet(facet="excluded_keyword", value=kw,
                         confidence=1.0, source="user", action="hard"))
    return out


def apply_facet_filters(nodes, facets: List[Facet], docs_meta: dict):
    year_min = year_max = None
    language = program = None
    excluded = []
    for f in facets:
        if f.action != "hard":
            continue
        if f.facet == "year_min":
            year_min = int(f.value)
        elif f.facet == "year_max":
            year_max = int(f.value)
        elif f.facet == "language":
            language = f.value
        elif f.facet == "program":
            program = f.value
        elif f.facet == "excluded_keyword":
            excluded.append(f.value.lower())

    if year_min is None and year_max is None and language is None and program is None and not excluded:
        return nodes

    out = []
    for nws in nodes:
        md = nws.node.metadata or {}
        doc = docs_meta.get(md.get("doc_id")) or {}

        if year_min is not None or year_max is not None:
            year = doc.get("year_int")
            if year is None:
                try:
                    year = int(md.get("year"))
                except (ValueError, TypeError):
                    year = None
            if year is None:
                continue  # unparseable year is excluded under a year filter (legacy semantics)
            if year_min is not None and year < year_min:
                continue
            if year_max is not None and year > year_max:
                continue

        if language is not None and doc.get("language") != language:
            continue

        if program is not None and md.get("program_series", "") != program:
            continue

        if excluded:
            title = (md.get("title") or "").lower()
            text = nws.node.text.lower()
            if any(kw in title or kw in text for kw in excluded):
                continue

        out.append(nws)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_filter.py -v`
Expected: 9 PASS

- [ ] **Step 5: Commit**

```bash
git add search-service/app/facet_filter.py search-service/tests/test_facet_filter.py
git commit -m "feat(understanding): single pre-rerank facet filter point"
```

---

### Task 10: Wire understanding into `/query` (contract + orchestration + EMF)

The integration task. Everything is behind `understanding is not None`; flag off touches NOTHING.

**Files:**
- Modify: `search-service/app/main.py` — `QueryRequest`/`QueryResponse` (`:133-176`), `hybrid_query` (`:959-1336`), `_emit_query_emf` (`:859-897`)
- Modify: `search-service/app/understanding.py` (add `build_understanding`)
- Test: `search-service/tests/test_understanding_wiring.py` (create)

**Interfaces:**
- Consumes: everything from Tasks 3–9.
- Produces:
  - `QueryRequest` + `facets: Optional[List[FacetSpec]] = None` (`class FacetSpec(BaseModel): facet: str; value: str`) and `expansion: bool = True`
  - `QueryResponse` + `query_understanding: Optional[Dict[str, Any]] = None`
  - `understanding.build_understanding(query: str, explicit_facets, today_year: int) -> QueryUnderstanding` — explicit facets present ⇒ parsers are skipped and each explicit facet becomes `Facet(source="user", action="hard", confidence=1.0)`; spell suggestion runs either way.
  - `debug["understanding_ms"]`; EMF metrics `understanding_ms` (Milliseconds), `facets_hard`, `suggestions` (Count).

- [ ] **Step 1: Write the failing tests**

```python
# search-service/tests/test_understanding_wiring.py
"""Contract additions + orchestrator behavior + flag-off guard.

The additive-field test copies the model_fields skip-idiom from
test_cite_doc_ids_filter.py:55-82 so the file is green on older branches."""
import pytest

from app.main import FacetSpec, QueryRequest, QueryResponse
from app.understanding import build_understanding


def test_query_request_new_fields_default_off():
    req = QueryRequest(query="q")
    assert req.facets is None
    assert req.expansion is True


def test_query_request_existing_fields_untouched():
    req = QueryRequest(query="q")
    # spot-check the contract fields the CLAUDE.md note protects
    assert req.mode == "cite" and req.max_results == 150
    assert req.vector_top_k == 500 and req.bm25_top_k == 500
    assert req.rerank is True and req.similarity_threshold == 0.0


def test_query_response_understanding_defaults_none():
    r = QueryResponse(docs=[], total_results=0, query="q", mode="cite", debug={})
    assert r.query_understanding is None


def test_build_understanding_parses_facets_and_never_raises():
    u = build_understanding("hydrogen since 2020 in spanish", explicit_facets=None, today_year=2026)
    pairs = sorted((f.facet, f.value) for f in u.facets)
    assert ("year_min", "2020") in pairs and ("language", "es") in pairs
    assert all(f.source == "parser" for f in u.facets)


def test_explicit_facets_disable_parsers():
    u = build_understanding(
        "hydrogen since 2020 in spanish",
        explicit_facets=[FacetSpec(facet="year_min", value="2023")],
        today_year=2026,
    )
    assert [(f.facet, f.value, f.source) for f in u.facets] == [("year_min", "2023", "user")]


def test_explicit_facet_with_invalid_name_is_dropped_not_fatal():
    u = build_understanding(
        "q", explicit_facets=[FacetSpec(facet="nonsense", value="x")], today_year=2026
    )
    assert u.facets == []
    assert "explicit_facets" in u.degraded


def test_build_understanding_is_failure_soft(monkeypatch):
    import app.understanding as un

    def boom(*a, **k):
        raise RuntimeError("parser exploded")

    monkeypatch.setattr("app.facet_parsers.parse_facets", boom)
    u = build_understanding("anything since 2020", explicit_facets=None, today_year=2026)
    assert u.facets == []
    assert "facet_parsers" in u.degraded
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_understanding_wiring.py -v`
Expected: FAIL with `ImportError: cannot import name 'FacetSpec' from 'app.main'`

- [ ] **Step 3: Add `build_understanding` to `app/understanding.py`**

Append:

```python
def build_understanding(query: str, explicit_facets, today_year: int) -> QueryUnderstanding:
    """Deterministic tier (P1). Each signal isolated + failure-soft (spec §5).

    Explicit facets present ⇒ the user touched the chips: auto-detection is
    OFF for facets (spec §3 — the system stops second-guessing). Spelling
    suggestions still run. Topic sensing is attached separately after stage 1
    (topic_sense.attach_topic_suggestions) so the embed cache is warm.
    """
    u = QueryUnderstanding()

    if explicit_facets is not None:
        for spec in explicit_facets:
            try:
                u.facets.append(
                    Facet(facet=spec.facet, value=spec.value,
                          confidence=1.0, source="user", action="hard")
                )
            except Exception:  # noqa: BLE001 — invalid chip dropped, not fatal
                if "explicit_facets" not in u.degraded:
                    u.degraded.append("explicit_facets")
    else:
        try:
            from app import facet_parsers
            u.facets.extend(facet_parsers.parse_facets(query, today_year))
        except Exception:  # noqa: BLE001
            u.degraded.append("facet_parsers")

    try:
        from app.spell_suggest import db_suggester
        s = db_suggester().suggest(query)
        if s is not None:
            u.suggestions.append(s)
    except Exception:  # noqa: BLE001
        u.degraded.append("spell_suggest")

    return u
```

- [ ] **Step 4: Add contract fields in `app/main.py`**

Above `class QueryRequest` (`main.py:133`):

```python
class FacetSpec(BaseModel):
    """Explicit chip state from the UI (design §4.6). Loose on purpose —
    validation happens when it becomes an understanding.Facet; an invalid
    chip is dropped there, never a 422 here."""
    facet: str
    value: str
```

Inside `QueryRequest`, after `return_intermediate_results` (`main.py:155`):

```python
    # Query understanding (design 2026-08-19 §4.6) — additive only.
    facets: Optional[List[FacetSpec]] = None  # explicit chip state; presence disables auto-detect
    expansion: bool = True                    # eval control: False forces raw-query behavior
```

Inside `QueryResponse`, after `debug` (`main.py:171`):

```python
    query_understanding: Optional[Dict[str, Any]] = None
```

- [ ] **Step 5: Run the tests again**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_understanding_wiring.py -v`
Expected: 7 PASS

- [ ] **Step 6: Orchestrate in `hybrid_query`**

(a) After `query_bundle = QueryBundle(query_str=request.query)` (`main.py:975`):

```python
        # Query understanding — deterministic tier (design 2026-08-19).
        # ALL understanding code below is behind `understanding is not None`:
        # flag off ⇒ byte-identical legacy pipeline.
        understanding = None
        if understanding_active(settings, request):
            from datetime import datetime
            u_start = time.time()
            understanding = build_understanding(
                request.query,
                explicit_facets=request.facets,
                today_year=datetime.now().year,
            )
            understanding.timings["deterministic_ms"] = round((time.time() - u_start) * 1000, 1)
```

with imports added at the top of `main.py` next to the other `app.` imports:

```python
from app.understanding import build_understanding, understanding_active
```

(b) After the translation-pair filter block (`main.py:1039`), before Stage 2:

```python
        # Stage 1.6: THE facet application point — post-fusion, pre-rerank
        # (design §4.5). Legacy params flow through the same path so there
        # is exactly one filter behavior when understanding is active.
        if understanding is not None:
            from app.facet_filter import apply_facet_filters, legacy_request_facets
            all_facets = understanding.facets + legacy_request_facets(request)
            pre_facet = len(stage1_results)
            stage1_results = apply_facet_filters(
                stage1_results, all_facets, service_state.get("documents_metadata") or {}
            )
            logger.info(f"Stage 1.6 (Facet Filters): {pre_facet} → {len(stage1_results)} results")
```

(c) Guard the legacy Stage 2.5 (`main.py:1084`) so it is skipped when the new point ran — change the condition to:

```python
        if understanding is None and (request.min_year or request.max_year or
            request.excluded_keywords or request.required_program):
```

(d) After Stage 2.1 / before Stage 2.5 region is NOT the place for topic sensing — attach it right after `stage1_results` is assigned from the retriever (after `main.py:1019`), where the dense lane has just warmed the embed cache:

```python
        if understanding is not None:
            from app.topic_sense import attach_topic_suggestions
            t_start = time.time()
            attach_topic_suggestions(understanding, request.query, service_state.get("embed_model"))
            understanding.timings["topic_sense_ms"] = round((time.time() - t_start) * 1000, 1)
```

(Ordering note: (d) executes before (b) in file order — place (d) immediately after stage1 retrieve, (b) after the translation-pair block.)

(e) In `response_data` (`main.py:1285`), after the `"mode"` entry:

```python
            "query_understanding": understanding.model_dump() if understanding is not None else None,
```

and in the `debug` dict after `"passage_ms"`:

```python
                "understanding_ms": (understanding.timings.get("deterministic_ms")
                                     if understanding is not None else None),
                "facets_hard": (sum(1 for f in understanding.facets if f.action == "hard")
                                if understanding is not None else None),
                "suggestions": (len(understanding.suggestions)
                                if understanding is not None else None),
```

- [ ] **Step 7: EMF counters**

In `_emit_query_emf` (`main.py:859-897`), the current `metrics` dict is all-Milliseconds. Restructure minimally: after the existing `metrics = {...}` block add:

```python
        counts = {
            "facets_hard": debug.get("facets_hard"),
            "suggestions": debug.get("suggestions"),
        }
        counts = {k: v for k, v in counts.items() if v is not None}
        metrics["understanding_ms"] = debug.get("understanding_ms")
```

(keep the existing `metrics = {k: round(v, 1) ...}` filter line AFTER this), and change the `CloudWatchMetrics` entry to:

```python
                "CloudWatchMetrics": [{
                    "Namespace": "AskWRI/Query",
                    "Dimensions": [["mode"]],
                    "Metrics": ([{"Name": k, "Unit": "Milliseconds"} for k in metrics]
                                + [{"Name": k, "Unit": "Count"} for k in counts]),
                }],
```

and spread both into the payload: `**metrics, **counts`. Also update the early-exit guard to `if not metrics and not counts: return`.

- [ ] **Step 8: Run the full python suite**

Run: `cd search-service && ./venv/bin/python -m pytest tests/ -v`
Expected: no failures. Pay attention to `test_diagnostic_parity.py` and `test_query_nonblocking.py` — if either fails, the wiring leaked outside the `understanding is not None` guard; fix the leak, do not adapt the test.

- [ ] **Step 9: Commit**

```bash
git add search-service/app/main.py search-service/app/understanding.py search-service/tests/test_understanding_wiring.py
git commit -m "feat(understanding): wire deterministic tier into /query behind dark flag"
```

---

### Task 11: Next.js pass-through (route projection + client)

**Files:**
- Modify: `src/app/api/llamaindex/route.ts:23-39` (add to `LlamaIndexResponse`), `:215-228` (top-level response)
- Modify: `src/lib/llamaindex-client.ts:66-89` (`chatCiteLlamaIndex`), `:80-88` (return shape)
- Test: `src/lib/__tests__/llamaindex-client.test.ts` (create; if a test for this lib already exists under a different path, extend that file instead)

**Interfaces:**
- Consumes: Python `QueryResponse.query_understanding` (Task 10). Request fields need NO route change — the `...options` spread at `route.ts:107` forwards `facets`/`expansion` verbatim.
- Produces: route response gains top-level `query_understanding` (object | null); `chatCiteLlamaIndex(query, overrides)` returns `{ok, docs, sources, usage, debug, queryUnderstanding}`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/llamaindex-client.test.ts
import { chatCiteLlamaIndex } from '../llamaindex-client';

describe('chatCiteLlamaIndex', () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
  });

  it('forwards facets/expansion overrides and surfaces queryUnderstanding', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        docs: [],
        sources: [],
        usage: null,
        debug: {},
        query_understanding: {
          facets: [{ facet: 'year_min', value: '2020', action: 'hard' }],
          suggestions: [],
        },
      }),
    });

    const res = await chatCiteLlamaIndex('hydrogen since 2020', {
      facets: [{ facet: 'year_min', value: '2020' }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.facets).toEqual([{ facet: 'year_min', value: '2020' }]);
    expect(res.queryUnderstanding.facets[0].facet).toBe('year_min');
  });

  it('returns null queryUnderstanding when upstream omits it', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, docs: [], sources: [], usage: null, debug: {} }),
    });
    const res = await chatCiteLlamaIndex('anything');
    expect(res.queryUnderstanding).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- llamaindex-client`
Expected: FAIL (`queryUnderstanding` undefined / type error)

- [ ] **Step 3: Implement**

`route.ts`: add `query_understanding?: Record<string, unknown> | null;` to the `LlamaIndexResponse` interface (`:23-39`), and in the top-level response object (`:215-228`) add one line:

```typescript
      query_understanding: llamaIndexResponse.query_understanding ?? null,
```

`llamaindex-client.ts`: in the object `chatCiteLlamaIndex`/`callLlamaIndexService` returns (`:80-88`), add:

```typescript
    queryUnderstanding: data.query_understanding ?? null,
```

(match the surrounding style — the file re-emits `docs`, `usage`, `debug` from the parsed `data`). Type the overrides param so `facets?: { facet: string; value: string }[]` and `expansion?: boolean` are legal keys (extend the existing overrides type rather than `any`).

- [ ] **Step 4: Run tests**

Run: `npm test -- llamaindex-client`
Expected: 2 PASS. Then `npm test` — no other suite broken.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/llamaindex/route.ts src/lib/llamaindex-client.ts src/lib/__tests__/llamaindex-client.test.ts
git commit -m "feat(ui): project query_understanding through the llamaindex route + client"
```

---

### Task 12: Interpretation line + removable chips

**Files:**
- Create: `src/app/components/results/InterpretationLine.tsx`
- Modify: `src/app/components/results/index.tsx:38-82` (render inside the banner section), `src/app/components/results/types.ts:53-71` (`ResultsPageProps`), `src/app/results/CitePanel.tsx:111-122` (prop pass-through), `src/app/results/page.tsx` (state + chip handlers + cache key)
- Test: `src/app/components/results/__tests__/InterpretationLine.test.tsx` (create)

**Interfaces:**
- Consumes: `queryUnderstanding` from Task 11 (`facets[{facet, value, action, source}]`, `suggestions[{type, text}]`).
- Produces:
  - `InterpretationLine({ chips, suggestion, onRemoveChip, onApplySuggestion })` where `chips: FacetChip[]`, `FacetChip = { facet: string; value: string; label: string }`
  - `facetChipLabel(facet: string, value: string) -> string` (exported for tests)
  - `page.tsx` owns `userFacets: {facet, value}[] | null` (null = auto mode) and re-queries on chip removal; the query cache key includes the facet state.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/components/results/__tests__/InterpretationLine.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { InterpretationLine, facetChipLabel } from '../InterpretationLine';

describe('facetChipLabel', () => {
  it('formats year and language facets for humans', () => {
    expect(facetChipLabel('year_min', '2022')).toBe('2022–present');
    expect(facetChipLabel('year_max', '2019')).toBe('up to 2019');
    expect(facetChipLabel('language', 'es')).toBe('Spanish');
    expect(facetChipLabel('program', 'WRR')).toBe('WRR');
  });
});

describe('InterpretationLine', () => {
  const chips = [{ facet: 'year_min', value: '2022', label: '2022–present' }];

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(
      <InterpretationLine chips={[]} suggestion={null} onRemoveChip={jest.fn()} onApplySuggestion={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders removable chips and fires onRemoveChip', () => {
    const onRemove = jest.fn();
    render(
      <InterpretationLine chips={chips} suggestion={null} onRemoveChip={onRemove} onApplySuggestion={jest.fn()} />
    );
    expect(screen.getByText('2022–present')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Remove 2022–present filter'));
    expect(onRemove).toHaveBeenCalledWith(chips[0]);
  });

  it('renders a did-you-mean suggestion and fires onApplySuggestion', () => {
    const onApply = jest.fn();
    render(
      <InterpretationLine chips={[]} suggestion="freight decarbonization" onRemoveChip={jest.fn()} onApplySuggestion={onApply} />
    );
    fireEvent.click(screen.getByText('freight decarbonization'));
    expect(onApply).toHaveBeenCalledWith('freight decarbonization');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- InterpretationLine`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the component**

```tsx
// src/app/components/results/InterpretationLine.tsx
'use client';

import React from 'react';
import { Tag } from '@worldresources/wri-design-systems';

export type FacetChip = { facet: string; value: string; label: string };

const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish', pt: 'Portuguese', zh: 'Chinese', en: 'English', id: 'Indonesian',
};

export function facetChipLabel(facet: string, value: string): string {
  if (facet === 'year_min') return `${value}–present`;
  if (facet === 'year_max') return `up to ${value}`;
  if (facet === 'language') return LANGUAGE_NAMES[value] ?? value;
  return value;
}

// Trust anchor (design §3): every hard facet the server applied is visible
// here and removable in one click. If this line is empty, nothing filtered.
export function InterpretationLine({
  chips,
  suggestion,
  onRemoveChip,
  onApplySuggestion,
}: {
  chips: FacetChip[];
  suggestion: string | null;
  onRemoveChip: (chip: FacetChip) => void;
  onApplySuggestion: (text: string) => void;
}) {
  if (chips.length === 0 && !suggestion) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
      {chips.length > 0 && (
        <span style={{ fontSize: '14px', color: '#555' }}>Showing:</span>
      )}
      {chips.map((chip) => (
        <span key={`${chip.facet}:${chip.value}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
          <Tag label={chip.label} variant="info-grey" />
          <button
            aria-label={`Remove ${chip.label} filter`}
            onClick={() => onRemoveChip(chip)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '12px', color: '#555' }}
          >
            ✕
          </button>
        </span>
      ))}
      {suggestion && (
        <span style={{ fontSize: '14px' }}>
          Did you mean{' '}
          <button
            onClick={() => onApplySuggestion(suggestion)}
            style={{ color: '#0A6CFF', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: '14px' }}
          >
            {suggestion}
          </button>
          ?
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- InterpretationLine`
Expected: 4 PASS

- [ ] **Step 5: Thread state through the page**

In `src/app/components/results/types.ts` extend `ResultsPageProps` with:

```typescript
  queryUnderstanding?: {
    facets: { facet: string; value: string; action: string; source: string }[];
    suggestions: { type: string; text: string }[];
  } | null;
  onRemoveFacet?: (chip: { facet: string; value: string }) => void;
  onApplySuggestion?: (text: string) => void;
```

In `src/app/components/results/index.tsx`, inside the banner `<section>` (`:38-82`), after the "Returned results for…" block, render:

```tsx
      <InterpretationLine
        chips={(queryUnderstanding?.facets ?? [])
          .filter((f) => f.action === 'hard')
          .map((f) => ({ facet: f.facet, value: f.value, label: facetChipLabel(f.facet, f.value) }))}
        suggestion={
          queryUnderstanding?.suggestions?.find((s) => s.type === 'spelling')?.text ?? null
        }
        onRemoveChip={(chip) => onRemoveFacet?.(chip)}
        onApplySuggestion={(text) => onApplySuggestion?.(text)}
      />
```

Pass the three new props through `CitePanel.tsx:111-122` unchanged.

In `src/app/results/page.tsx`:

- state: `const [userFacets, setUserFacets] = useState<{ facet: string; value: string }[] | null>(null);` and `const [understanding, setUnderstanding] = useState<any>(null);`
- `doCite` sends overrides: `chatCiteLlamaIndex(q, userFacets ? { facets: userFacets } : {})` and after the response `setUnderstanding(res.queryUnderstanding ?? null)`.
- cache key (`:97-123`): change `cite:<q>` to `` `cite:${q}:${JSON.stringify(userFacets ?? 'auto')}` `` — a removed chip must never serve the auto-mode cached result.
- `onRemoveFacet(chip)`: derive current hard chips from `understanding.facets` (action `'hard'`), drop the removed one, `setUserFacets(remaining)`, then re-run the query (the effect keying should include `userFacets`; follow the existing `runQuery` effect structure at `:125-130`).
- `onApplySuggestion(text)`: `router.push('/results?q=' + encodeURIComponent(text))` (same mechanism as `Landing/index.tsx:30-37`).
- reset `userFacets` to `null` whenever the `q` URL param changes (new search = auto mode again).

- [ ] **Step 6: Run the whole JS suite + lint**

Run: `npm test` then `npm run lint`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/app/components/results/InterpretationLine.tsx src/app/components/results/__tests__/InterpretationLine.test.tsx src/app/components/results/types.ts src/app/components/results/index.tsx src/app/results/CitePanel.tsx src/app/results/page.tsx
git commit -m "feat(ui): interpretation line with removable facet chips + did-you-mean"
```

---

### Task 13: Auto-switch + empty-state topic rescue

**Files:**
- Modify: `src/app/results/page.tsx` (auto-switch logic in `doCite`, empty-state render branch at `:394-427`)
- Create: `src/app/components/results/EmptyStateTopics.tsx`
- Test: `src/app/components/results/__tests__/EmptyStateTopics.test.tsx` (create)

**Interfaces:**
- Consumes: `queryUnderstanding.suggestions` (types `spelling`, `nearby_topic`) from Task 12's state.
- Produces: `EmptyStateTopics({ query, topics, onPickTopic })`; auto-switch state `autoSwitchedFrom: string | null` in `page.tsx`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/app/components/results/__tests__/EmptyStateTopics.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { EmptyStateTopics } from '../EmptyStateTopics';

describe('EmptyStateTopics', () => {
  it('shows the query and clickable nearby topics', () => {
    const onPick = jest.fn();
    render(
      <EmptyStateTopics query="quantum transit" topics={['freight', 'air quality']} onPickTopic={onPick} />
    );
    expect(screen.getByText(/No strong matches for/)).toBeInTheDocument();
    expect(screen.getByText(/quantum transit/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('freight'));
    expect(onPick).toHaveBeenCalledWith('freight');
  });

  it('renders a plain empty message when there are no topics', () => {
    render(<EmptyStateTopics query="quantum transit" topics={[]} onPickTopic={jest.fn()} />);
    expect(screen.getByText(/No strong matches for/)).toBeInTheDocument();
    expect(screen.queryByText(/Nearby topics/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- EmptyStateTopics`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the component**

```tsx
// src/app/components/results/EmptyStateTopics.tsx
'use client';

import React from 'react';
import { Tag } from '@worldresources/wri-design-systems';

// Empty states that navigate (design §3): a dead end becomes a door.
export function EmptyStateTopics({
  query,
  topics,
  onPickTopic,
}: {
  query: string;
  topics: string[];
  onPickTopic: (topic: string) => void;
}) {
  return (
    <div style={{ padding: '32px', textAlign: 'center' }}>
      <p style={{ fontSize: '16px', marginBottom: '12px' }}>
        No strong matches for &ldquo;{query}&rdquo;.
      </p>
      {topics.length > 0 && (
        <>
          <p style={{ fontSize: '14px', color: '#555', marginBottom: '8px' }}>
            Nearby topics in our library:
          </p>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
            {topics.map((t) => (
              <button
                key={t}
                onClick={() => onPickTopic(t)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
              >
                <Tag label={t} variant="info-grey" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- EmptyStateTopics`
Expected: 2 PASS

- [ ] **Step 5: Wire into `page.tsx`**

- Empty state: in the render branch at `:394-427`, when the query has completed (track a `loading` boolean around `runQuery`) and `pageDocs.length === 0`, render `EmptyStateTopics` with `topics={understanding?.suggestions?.filter(s => s.type === 'nearby_topic').map(s => s.text) ?? []}` and `onPickTopic={(t) => router.push('/results?q=' + encodeURIComponent(t))}` instead of the spinner.
- Auto-switch (design §3, decidable rule): in `doCite`, after a response, if `docs.length < 3` AND a `spelling` suggestion exists AND `autoSwitchedFrom === null`, set `autoSwitchedFrom = originalQuery` and re-run with the corrected text. Render the reverse link above the results (in the banner area, next to the InterpretationLine):

```tsx
{autoSwitchedFrom && (
  <p style={{ fontSize: '14px', marginTop: '4px' }}>
    Searched for “{currentQuery}” instead ·{' '}
    <button
      onClick={() => {
        setAutoSwitchedFrom(null);
        runAsTyped(autoSwitchedFrom); // re-query original with expansion suggestions suppressed for this run
      }}
      style={{ color: '#0A6CFF', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
    >
      search for “{autoSwitchedFrom}” as typed
    </button>
  </p>
)}
```

`runAsTyped(q)` calls the same query path but passes `{ expansion: false }` in overrides so the server does not re-suggest and the client does not re-switch (one auto-switch per user-initiated search, loop-proof). Reset `autoSwitchedFrom` to `null` whenever the `q` URL param changes.

- [ ] **Step 6: Run the whole JS suite + a manual smoke**

Run: `npm test` and `npm run lint`. Then, if the local stack is up (`./scripts/local-bootstrap.sh` done previously), run `npm run dev` with `QUERY_UNDERSTANDING_ENABLED=true` exported in `search-service/.env.local`, search "freight since 2022", and verify: chip renders, ✕ re-queries without the year filter, misspelled "hydrogin buses" shows the suggestion. Record what you saw in the task report (verification-before-completion: no claim without having looked).

- [ ] **Step 7: Commit**

```bash
git add src/app/components/results/EmptyStateTopics.tsx src/app/components/results/__tests__/EmptyStateTopics.test.tsx src/app/results/page.tsx src/app/components/results/index.tsx
git commit -m "feat(ui): did-you-mean auto-switch + empty-state nearby topics"
```

---

### Task 14: P1 gate — flag-off proof + flag-on measurement

**Files:**
- Create: `docs/plans/2026-08-19-query-expansion-p1-gate-results.md`

**Interfaces:**
- Consumes: Task 2's committed baselines; every prior task merged.
- Produces: the gate document. P2 does not start until every rule below passes. The flag stays OFF in every deployed environment regardless of outcome — activation is a separate, gated ops step.

- [ ] **Step 1: Full local suites**

```bash
cd search-service && ./venv/bin/python -m pytest tests/ -v
```

then `npm test`, `npm run lint`, `npm run format:check`. Expected: all green.

- [ ] **Step 2: Flag-OFF eval re-run (byte-identical proof)** — same rig as Task 2:

```bash
npm run eval:cite
npm run eval:answer-retrieval
npx tsx evaluation/run-non-english-smoke.ts
```

Decision rule: results must be IDENTICAL to the Task 2 baselines (same recall, same ranks; the smoke set 16/16). Any delta = a leak outside the `understanding is not None` guard → STOP, find the leak, re-run. This is the spec §5 byte-identical guarantee, measured.

- [ ] **Step 3: Flag-ON eval run** — export `QUERY_UNDERSTANDING_ENABLED=true` for the service (and ensure `search_vocab` is built on the rig DB via Task 5's script), re-run the same three suites plus a manual probe set of ~10 facet-bearing queries (draw them from `tests/fixtures/facet_queries.json`).

Decision rules (spec §7):
- cite golden macro recall: may not fall (eval queries carry no facet phrasing, so movement means the wiring itself changed ranking — investigate).
- answer-retrieval chunk recall: may not fall.
- non-EN smoke: 16/16 holds.
- facet probes: extracted facets match the fixture labels; every applied facet visible in `query_understanding.facets`.

- [ ] **Step 4: Write and commit the gate document** — record: baseline vs flag-off vs flag-on numbers for each suite, the probe-set observations, any threshold changes derived from the fixture sets (with before/after values), and an explicit PASS/FAIL per rule. End with either "P2 unblocked" or the failure analysis.

```bash
git add docs/plans/2026-08-19-query-expansion-p1-gate-results.md
git commit -m "docs(understanding): P1 gate results"
```

---

## Self-review notes (already applied)

- Spec coverage: §3 UX (Tasks 12–13), §4.1 deterministic tier (4, 6, 7), §4.5 filter point (8, 9, 10c), §4.6 contract (10, 11), §5 failure posture (3, 6, 7, 10, gate Step 2), §6 observability (1, 10 Step 7; chip-removal counts arrive server-side via the facets-in-request delta — the dedicated feedback event is deferred to P3 with the rest of the suggestion-acceptance loop), §7 P0+P1 rows + gates (1, 2, 14). Deferred by design: multi-lane RRF, alias lane, `DOMAIN_EXPANSIONS` retirement (P2 plan); LLM tier, intent, catalog mode, disambiguation readings (P3 plan).
- Type consistency: `Facet`/`Suggestion`/`FacetSpec` names and signatures are identical in every task that mentions them; `lane_ranks`, `understanding_active`, `apply_facet_filters`, `legacy_request_facets`, `facetChipLabel` each defined once and consumed by exact name.
- The `%%` in Task 6's SQL is the psycopg-escaped `%` trigram operator — intentional, not a typo.
