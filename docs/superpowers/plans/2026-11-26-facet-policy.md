# Facet Policy and Explicit Negation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every facet type declare a policy mode retrieval obeys, and replace substring negation with correct, document-level, explicit-only exclusion that applies identically whether query understanding is on or off.

**Architecture:** A `FACET_MODES` table in `understanding.py` gates the single application point (`main.py` Stage 1.6). Negation is a pure function over the pre-rerank candidate pool: normalize, word-boundary phrase match, then remove every chunk of a matched document. Stage 1.6 owns negation and program in both flag states; Stage 2.5 keeps year only. Measurement is one deterministic two-arm eval with fixed explicit facets.

**Tech Stack:** Python 3.12 / FastAPI / pytest; Next.js + Jest; `tsx` eval harness.

**Spec:** `docs/superpowers/specs/2026-11-26-facet-policy-design.md`

## Global Constraints

- Python 3.12; no new dependencies; `requirements.txt` is generated, never hand-edited.
- No migrations, no entity changes; `synchronize` stays false.
- Response contract unchanged: `action` stays `"hard"` / `"suggest"`, `query_understanding` keeps its shape.
- Only `action="hard"` facets apply; there is exactly one application point (Stage 1.6).
- No claim depends on the LLM sidecar; the eval runs with `EVAL_EXPANSION=off`.
- Production runs understanding off; legacy `excluded_keywords` / `required_program` callers must keep working.
- Branch `fix/450-facet-policy`, PR targets `qa`.

## Review Focus

- Blank or whitespace-only exclusion must never remove everything (test in Task 2).
- Word-boundary false positives: `coal` must not match `coalition` (Task 2).
- A document with one matching chunk and one clean chunk must be removed whole (Task 2).
- A legacy exclusion must make the same decision before and after rerank (Task 4).
- A translation-only match must not resurrect its canonical original (Task 5).

---

### Task 1: Facet policy table

**Files:**
- Modify: `search-service/app/understanding.py`
- Modify: `search-service/app/facet_filter.py:55-85`
- Test: `search-service/tests/test_facet_filter.py`

**Interfaces:**
- Produces: `FACET_MODES: dict[str, str]` mapping every `Facet.facet` literal to `"filter"` or `"negate"`.
- Consumes: `Facet` from `understanding.py`.

- [ ] **Step 1: Write the failing tests**

```python
def test_every_facet_type_has_a_policy_mode():
    from typing import get_args
    from app.understanding import FACET_MODES, Facet
    assert set(FACET_MODES) == set(get_args(Facet.model_fields["facet"].annotation))

def test_hard_facet_without_a_mode_is_not_applied():
    f = Facet.model_construct(facet="mystery", value="x", confidence=1.0,
                              source="user", action="hard")
    nodes = [_node("a")]
    assert apply_facet_filters(nodes, [f], {}) is nodes
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_facet_filter.py -q`
Expected: FAIL, `ImportError: cannot import name 'FACET_MODES'`

- [ ] **Step 3: Implement the table and dispatch**

In `understanding.py`, beside `Facet`:

```python
FACET_MODES: dict[str, str] = {
    "year_min": "filter", "year_max": "filter",
    "date_min": "filter", "date_max": "filter",
    "language": "filter", "office": "filter", "program": "filter",
    "excluded_keyword": "negate",
}
```

In `apply_facet_filters`, look up `mode = FACET_MODES.get(f.facet)`; `None` logs and
skips the facet. Keep the existing per-type value parsing under `mode == "filter"`, and
collect negation terms under `mode == "negate"` (still using the old substring test at this
task; Task 2 replaces it).

- [ ] **Step 4: Run the full facet suite**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_facet_filter.py tests/test_facet_parsers.py tests/test_explicit_facets_flag_off.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/understanding.py search-service/app/facet_filter.py search-service/tests/test_facet_filter.py
git commit -m "feat(450): declare a policy mode for every facet type"
```

---

### Task 2: Document-level exclusion matcher

**Files:**
- Modify: `search-service/app/facet_filter.py`
- Test: `search-service/tests/test_facet_filter.py`

**Interfaces:**
- Produces: `excluded_doc_ids(nodes, facets, docs_meta, translation_pairs=None) -> set[str]`
- Produces: `_normalize_meta(s: str) -> str` (renamed from `_normalize_office`)
- `apply_facet_filters(nodes, facets, docs_meta, translation_pairs=None, excluded_ids=None)` gains two optional parameters; existing positional calls keep working.

- [ ] **Step 1: Write the failing tests**

```python
def test_exclusion_respects_word_boundaries():
    nodes = [_node("coalition", text="coalition building"), _node("coal", text="coal power")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "coal")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["coalition"]

def test_exclusion_is_document_level():
    nodes = [_node("doc", text="school buses are safe"), _node("doc", text="electric buses")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "school buses")], {})
    assert out == []

def test_exclusion_normalizes_case_accents_hyphens_and_spacing():
    nodes = [_node("mx", title="México’s zero–emission  buses", text="x")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "ZERO EMISSION")], {})
    assert out == []

def test_blank_exclusion_never_matches():
    nodes = [_node("a")]
    out = apply_facet_filters(nodes, [_hard("excluded_keyword", "   ")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["a"]

def test_excluded_doc_ids_returns_translation_and_canonical():
    nodes = [_node("t1", text="english text", title="t")]
    pairs = {"t1": {"original": "o1", "original_title": "Zero-emission buses"}}
    got = excluded_doc_ids(nodes, [_hard("excluded_keyword", "zero emission")], {}, pairs)
    assert got == {"t1", "o1"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_facet_filter.py -q -k "exclusion or excluded_doc_ids"`
Expected: FAIL, `excluded_doc_ids` not defined / substring tests fail.

- [ ] **Step 3: Implement**

Rename `_normalize_office` to `_normalize_meta` (same accent/case/whitespace behavior, plus
dash→space) and update the office call site. Compile each term once per request as
`(?<!\w)` + `\s+`.join(escaped tokens) + `(?!\w)`; empty term set → empty result.
`excluded_doc_ids` scans each node's title (node metadata, falling back to
`docs_meta[doc_id]["title"]`) and `node.node.text`; on a match it adds the `doc_id`, and
when `translation_pairs[doc_id]` exists it also scans `original_title` and adds the
canonical `original`. `apply_facet_filters` computes or accepts the set and drops every
node whose `doc_id` is in it.

- [ ] **Step 4: Run the tests**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_facet_filter.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/facet_filter.py search-service/tests/test_facet_filter.py
git commit -m "fix(450): document-level, word-boundary negation"
```

---

### Task 3: Program normalization

**Files:**
- Modify: `search-service/app/facet_filter.py`
- Test: `search-service/tests/test_facet_filter.py`

**Interfaces:**
- Consumes: `_normalize_meta` from Task 2.

- [ ] **Step 1: Write the failing test**

```python
def test_program_match_is_normalized():
    nodes = [_node("a", program="World Resources Report"), _node("b", program="WRR")]
    out = apply_facet_filters(nodes, [_hard("program", "world  resources  report")], {})
    assert [n.node.metadata["doc_id"] for n in out] == ["a"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_facet_filter.py::test_program_match_is_normalized -q`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the exact program comparison with
`_normalize_meta(md.get("program_series", "")) == _normalize_meta(program)`.

- [ ] **Step 4: Run the facet suite**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_facet_filter.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/facet_filter.py search-service/tests/test_facet_filter.py
git commit -m "fix(450): normalize program series values"
```

---

### Task 4: One exclusion decision point for both flag states

**Files:**
- Modify: `search-service/app/main.py:1695-1716` (Stage 1.6), `main.py:1786-1800` (Stage 2.5), `main.py:416-475` (`apply_metadata_filters`)
- Test: `search-service/tests/test_explicit_facets_flag_off.py`

**Interfaces:**
- Consumes: `excluded_doc_ids`, `apply_facet_filters`, `legacy_request_facets`, `user_facets`.

- [ ] **Step 1: Write the failing tests**

Add `DOC_TEXTS` to the test module and make `_Retriever` use it:
`DOC_TEXTS = {**{d: "t" for d in DOCS_META}, "es_doc": "coal power"}`. Then:

```python
def test_flag_off_legacy_excluded_keywords_apply(monkeypatch):
    payload = _post(monkeypatch, excluded_keywords=["coal"])
    assert _doc_ids(payload) == {"en_doc", "en_with_es", "unknown_lang"}

class _TwoChunkRetriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(node=TextNode(id_="c-coal", text="coal power",
                metadata={"doc_id": "es_doc", "title": "es_doc"}), score=0.9),
            NodeWithScore(node=TextNode(id_="c-clean", text="clean power",
                metadata={"doc_id": "es_doc", "title": "es_doc"}), score=0.8),
        ]

class _KeepCleanReranker:
    def postprocess_nodes(self, nodes, query_bundle=None, top_n=None):
        return [n for n in nodes if "coal" not in n.node.text]

def test_legacy_exclusion_decides_on_the_pre_rerank_pool(monkeypatch):
    # Two chunks for one doc: rerank keeps the clean one, the matching one
    # would be dropped. A post-rerank decision would keep the document.
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", _TwoChunkRetriever())
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setitem(app_main.service_state, "documents_metadata", {})
    monkeypatch.setitem(app_main.service_state, "reranker_cite", _KeepCleanReranker())
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: False)
    resp = TestClient(app_main.app).post("/query", json={
        "query": "power", "mode": "cite", "rerank": True,
        "excluded_keywords": ["coal"]})
    assert resp.status_code == 200
    assert "es_doc" not in _doc_ids(resp.json())
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py -q`
Expected: FAIL, the legacy exclusion still runs after rerank.

- [ ] **Step 3: Implement**

- Flag-off Stage 1.6 branch triggers on `request.facets or request.excluded_keywords or
  request.required_program`; its facet list is `user_facets(request.facets)` plus
  `[f for f in legacy_request_facets(request) if f.facet in ("excluded_keyword", "program")]`.
- Stage 2.5 triggers on `request.min_year or request.max_year` only and calls
  `apply_metadata_filters(stage2_results, min_year=..., max_year=...)`.
- Remove the `excluded_keywords` and `required_program` parameters and blocks from
  `apply_metadata_filters`.

- [ ] **Step 4: Run the flag-off and facet suites**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py tests/test_facet_filter.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_explicit_facets_flag_off.py
git commit -m "fix(450): apply legacy negation and program before rerank"
```

---

### Task 5: Translation cannot resurrect an excluded work

**Files:**
- Modify: `search-service/app/main.py` (seed filter, cite assembly `main.py:1835-1850`)
- Test: `search-service/tests/test_facet_filter.py`, `tests/test_explicit_facets_flag_off.py`

**Interfaces:**
- Consumes: `excluded_doc_ids(..., translation_pairs=...)` from Task 2.

- [ ] **Step 1: Write the failing tests**

```python
PAIRS = {"t1": {"original": "o1", "original_title": "Zero-emission buses",
                "original_searchable": True}}

class _PairRetriever:
    def retrieve(self, bundle):
        return [
            NodeWithScore(node=TextNode(id_="c-o1", text="zero emission buses",
                metadata={"doc_id": "o1", "title": "Original"}), score=0.9),
            NodeWithScore(node=TextNode(id_="c-t1", text="autobuses electricos",
                metadata={"doc_id": "t1", "title": "Traduccion"}), score=0.8),
        ]

def test_citation_substitution_cannot_resurrect_excluded_original(monkeypatch):
    # The original is excluded by its own text; the translation does not match
    # and survives. Without the assembly guard it is credited back to o1.
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", _PairRetriever())
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setitem(app_main.service_state, "documents_metadata", {})
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: False)
    monkeypatch.setattr(app_main, "load_confirmed_pairs", lambda: PAIRS)
    resp = TestClient(app_main.app).post("/query", json={
        "query": "buses", "mode": "cite", "rerank": False,
        "facets": [{"facet": "excluded_keyword", "value": "zero emission"}]})
    assert resp.status_code == 200
    assert "o1" not in _doc_ids(resp.json())
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py -q`
Expected: FAIL, `o1` is substituted in.

- [ ] **Step 3: Implement**

Compute the excluded set once before Stage 1.6 from `stage1_results + translation_seed`,
pass it to `apply_facet_filters`, drop excluded seeds, and skip `canon` in the cite
substitution loop when it is in the set. Pass `translation_pairs` into `excluded_doc_ids`.

- [ ] **Step 4: Run the suites**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py tests/test_facet_filter.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_explicit_facets_flag_off.py search-service/tests/test_facet_filter.py
git commit -m "fix(450): keep excluded works out of translation assembly"
```

---

### Task 6: Exclusion diagnostics and chip label

**Files:**
- Modify: `search-service/app/main.py:2018-2045` (debug payload)
- Modify: `src/app/components/results/InterpretationLine.tsx:47-56`
- Test: `search-service/tests/test_explicit_facets_flag_off.py`, `src/app/components/results/__tests__/InterpretationLine.test.tsx`

**Interfaces:**
- Produces: `debug.excluded_doc_ids: string[] | null` when `return_intermediate_results` is set.
- Produces: `facetChipLabel("excluded_keyword", value) === "Exclude " + value`.

- [ ] **Step 1: Write the failing tests**

```python
def test_debug_exposes_excluded_doc_ids(monkeypatch):
    payload = _post(monkeypatch, excluded_keywords=["coal"], return_intermediate_results=True)
    assert payload["debug"]["excluded_doc_ids"] == ["es_doc"]
```

```tsx
it('labels an exclusion as Exclude <value>', () => {
  expect(facetChipLabel('excluded_keyword', 'school buses')).toBe('Exclude school buses')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py::test_debug_exposes_excluded_doc_ids -q`
Run: `cd <worktree> && npm install && npx jest src/app/components/results/__tests__/InterpretationLine.test.tsx -t "Exclude"`
Expected: both FAIL.

- [ ] **Step 3: Implement**

Add the debug key (sorted list, `None` when diagnostic mode is off). Add the label branch.

- [ ] **Step 4: Run both suites**

Run: `cd search-service && /Users/davidgutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py -q`
Run: `npx jest src/app/components/results/__tests__/InterpretationLine.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_explicit_facets_flag_off.py src/app/components/results/InterpretationLine.tsx src/app/components/results/__tests__/InterpretationLine.test.tsx
git commit -m "feat(450): expose excluded docs and label exclusion chips"
```

---

### Task 7: EVAL_FACETS lever

**Files:**
- Modify: `evaluation/lib/gateway-body.ts`
- Modify: `evaluation/run-evalset.ts:225-245` (`queryTarget`), `:250-330` (`runCase`), `:595-615` (report)
- Test: `evaluation/__tests__/gateway-body.test.ts`

**Interfaces:**
- Produces: `facetsForCase(caseId: string): FacetInput[]`, `FacetInput = {facet: string; value: string}`.
- Produces: `gatewayBody(query, mode, facets?: FacetInput[])` adds `facets` and `return_intermediate_results: true` when facets are present.
- Report gains `facets_manifest` (top level) and per-case `facets`.

- [ ] **Step 1: Write the failing tests**

```ts
it('sends per-case facets and asks for exclusion diagnostics', () => {
  process.env.EVAL_FACETS = JSON.stringify({
    q11: [{ facet: 'excluded_keyword', value: 'electric buses' }],
  })
  expect(facetsForCase('q11')).toEqual([{ facet: 'excluded_keyword', value: 'electric buses' }])
  expect(gatewayBody('q', 'cite', facetsForCase('q11'))).toMatchObject({
    facets: [{ facet: 'excluded_keyword', value: 'electric buses' }],
    return_intermediate_results: true,
  })
})

it('fails fast on a malformed facets manifest', () => {
  process.env.EVAL_FACETS = JSON.stringify({ q11: 'electric buses' })
  expect(() => facetsForCase('q11')).toThrow(/EVAL_FACETS/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest evaluation/__tests__/gateway-body.test.ts`
Expected: FAIL, `facetsForCase` not exported.

- [ ] **Step 3: Implement the lever and wire it through**

Parse and validate `EVAL_FACETS` once; unknown case keys fail the run before the first
request, per set. `queryTarget` takes the case's facets; `gatewayBody` attaches them.
Record the manifest and per-case facets in the report.

- [ ] **Step 4: Run the harness tests**

Run: `npx jest evaluation/__tests__/gateway-body.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add evaluation/lib/gateway-body.ts evaluation/run-evalset.ts evaluation/__tests__/gateway-body.test.ts
git commit -m "test(450): add a fixed-facet arm to the eval harness"
```

---

### Task 8: Measured negation baseline (after the QA deploy)

**Files:**
- Create: `evaluation/baselines/2026-11-26-facet-negation-qa.md`

**Prerequisite:** Tasks 1-7 are merged to `qa` and the deploy workflow has finished. The
harness measures a deployed target, so this task cannot run from the branch alone. Confirm
the live image SHA with `./scripts/ecs-await-deploy.sh --cluster <c> --services "<svc>"
--expected-image-tag <sha>` before running.

- [ ] **Step 1: Run the baseline and facet arms**

```bash
git submodule update --init evaluation/eval-review
export EVAL_EXPANSION=off
npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
EVAL_FACETS='{"q11_urban_finance_exclude_ebuses":[{"facet":"excluded_keyword","value":"electric buses"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_01.json
npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_02.json
EVAL_FACETS='{"d7_electric-buses-excluding-school-buses":[{"facet":"excluded_keyword","value":"school buses"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/eval-review/evalsets/evalset_cite_02.json
```

- [ ] **Step 2: Record the result**

In `evaluation/baselines/2026-11-26-facet-negation-qa.md`: target commit and fixture pin,
the four runs, MAP and attainable recall per arm, `debug.excluded_doc_ids` leakage
(returned ids ∩ excluded ids), and the gold ids removed. State that auto-detected facet
claims remain blocked on sidecar determinism (#498 item 9), and that a demotion signal was
not measured.

- [ ] **Step 3: Commit**

```bash
git add evaluation/baselines/2026-11-26-facet-negation-qa.md
git commit -m "docs(450): record the explicit negation baseline"
```

---

## Rollout

Code lands on `qa`; production changes only for legacy `excluded_keywords` /
`required_program` callers, which now filter pre-rerank. No flag flip, no migration,
no release.
