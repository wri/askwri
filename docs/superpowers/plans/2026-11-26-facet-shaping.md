# Facet shaping vs filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pre-rerank facet *boost* lever (off by default) and run the three-arm experiment #522 asks for, so each constraint facet type can be recorded as either "constraint" or "candidate for shaping" on measured numbers.

**Architecture:** The facet matching test comes out of `apply_facet_filters` into one predicate; a second caller, `boost_facet_matches`, keeps every candidate and adds one RRF vote to matching ones instead of dropping non-matching ones. A `FACET_MODE` setting selects which caller Stage 1.6 uses. The eval harness already carries `EVAL_FACETS`; the arm is chosen by service env, and `debug` records which mode answered.

**Tech Stack:** Python 3.12 / FastAPI / pydantic-settings / pytest (search-service); tsx eval harness (evaluation/); Terraform env vars (qa).

**Spec:** `docs/superpowers/specs/2026-11-26-facet-shaping-design.md`

## Global Constraints

- `FACET_MODE` defaults to `filter`. Production and QA behaviour is unchanged by this branch.
- Boost weight unit: one RRF vote at rank 1 — `weight / (60 + 1)`, the same `k=60` the fusion code uses (`main.py:381`).
- Boost applies to positive constraint facets only (`year_min`, `year_max`, `date_min`, `date_max`, `language`, `office`, `program`). `excluded_keyword` keeps filtering in both modes.
- `/query` request and response contract unchanged. `debug` is `Dict[str, Any]`; new keys are additive.
- An unrecognised `FACET_MODE` must fail at startup, never silently run the filter arm.
- Experiment arms run with `EVAL_EXPANSION=off` only.
- Series (`program`) is out of scope: no document carries a series value, so the arm is null by construction. Recorded as blocked.
- No eval run happens before the pre-registration commit (Task 5) exists.

## Review Focus

- A node whose `metadata` is missing or whose `doc_id` is `None`: filter keeps it, boost must keep it and must not crash collecting ids (the `excluded_doc_ids` path had exactly this bug).
- A facet value that cannot be parsed (`year_min` "abc", `date_min` "not-a-date"): the facet is dropped and every document is kept — never a 500, never an empty result.
- No positive constraint at all (only a negation, or only `suggest`-tier facets): boost mode must return the node list untouched, including its order.
- Score `None` on a node: boost must treat it as `0.0` rather than raise.
- Negation plus boost in the same request: excluded documents stay removed and are never boosted back.
- Empty result pool: both paths return `[]` without raising.

---

### Task 1: Extract the matching predicate (behaviour-preserving)

**Files:**
- Modify: `search-service/app/facet_filter.py:113-185`
- Test: `search-service/tests/test_facet_filter.py` (existing suite, unchanged)

**Interfaces:**
- Consumes: `FACET_MODES`, `Facet`, `_normalize_meta` (already in the file).
- Produces:
  - `_facet_constraints(facets: List[Facet]) -> dict` — keys `year_min: Optional[int]`, `year_max: Optional[int]`, `date_min: Optional[date]`, `date_max: Optional[date]`, `program: Optional[str]`, `languages: List[str]` (casefolded), `offices: List[str]`. Invalid values are dropped exactly as today.
  - `_matches(nws, doc: dict, md: dict, c: dict) -> bool` — the per-node test currently inline in `apply_facet_filters`.
  - `apply_facet_filters(nodes, facets, docs_meta, translation_pairs=None, excluded_ids=None)` — same signature, same behaviour.

- [ ] **Step 1: Run the existing suite as the refactor's baseline**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_filter.py tests/test_facet_parsers.py tests/test_explicit_facets_flag_off.py -q`
Expected: all pass (89 + the flag-off tests). Record the count.

- [ ] **Step 2: Move the parsing loop into `_facet_constraints` and the node test into `_matches`**

`_facet_constraints` is the existing `for f in facets:` loop, unchanged in semantics, returning the parsed values in a dict. `_matches` is the existing body of the node loop (date bounds → year bounds → language → program → office), returning `True`/`False` instead of `continue`/fall-through. Every `continue` becomes `return False`; the final fall-through becomes `return True`.

`apply_facet_filters` becomes: constraints → early return if empty and no exclusions → per node: drop if `doc_id in excluded`, else keep if `_matches(...)`. Exclusion is a pure conjunction with the other drops, so checking it first is equivalent.

- [ ] **Step 3: Run the same suite**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_filter.py tests/test_facet_parsers.py tests/test_explicit_facets_flag_off.py -q`
Expected: the same counts as Step 1, no failures. This is the whole proof for a behaviour-preserving refactor; a changed result means the extraction altered semantics — fix the extraction, not the test.

- [ ] **Step 4: Commit**

```bash
git add search-service/app/facet_filter.py
git commit -m "refactor(522): extract the facet matching predicate from apply_facet_filters"
```

---

### Task 2: `boost_facet_matches`

**Files:**
- Modify: `search-service/app/facet_filter.py` (append after `apply_facet_filters`)
- Test: `search-service/tests/test_facet_filter.py`

**Interfaces:**
- Consumes: `_facet_constraints`, `_matches` from Task 1.
- Produces: `boost_facet_matches(nodes, facets: List[Facet], docs_meta: dict, weight: float) -> tuple[list, Set[str]]` — every node kept, matching nodes' `.score` raised by `weight / (60 + 1)`, list re-sorted by score descending, second element the boosted `doc_id`s (excluding `None`).

- [ ] **Step 1: Write the failing tests**

```python
def test_boost_keeps_every_node_and_raises_only_matches():
    nodes = [_nws("a", 2020, 0.50), _nws("b", 1990, 0.90)]
    out, boosted = boost_facet_matches(
        nodes, [_facet("year_min", "2000")], {"a": {"year_int": 2020}, "b": {"year_int": 1990}}, 1.0)
    assert len(out) == 2                    # nothing removed, unlike the filter
    assert boosted == {"a"}
    assert out[0].node.metadata["doc_id"] == "a"          # 0.50 + 1/61 > 0.90
    assert out[0].score == pytest.approx(0.50 + 1 / 61)

def test_boost_weight_zero_is_a_no_op_including_order():
    nodes = [_nws("a", 0.50), _nws("b", 0.90)]
    out, boosted = boost_facet_matches(nodes, [_facet("office", "WRI India")], META, 0.0)
    assert [n.node.metadata["doc_id"] for n in out] == ["a", "b"]
    assert boosted == set()

def test_boost_with_no_positive_constraints_returns_nodes_untouched():
    nodes = [_nws("a", 0.50), _nws("b", 0.90)]
    out, boosted = boost_facet_matches(nodes, [_facet("excluded_keyword", "coal")], META, 1.0)
    assert out is nodes
    assert boosted == set()

def test_boost_tolerates_missing_metadata_and_none_score():
    node = NodeWithScore(node=TextNode(id_="c", text="t", metadata={}), score=None)
    out, boosted = boost_facet_matches([node], [_facet("year_min", "2000")], {}, 1.0)
    assert len(out) == 1 and boosted == set()
```

Use the file's existing helpers for `_nws`/`_facet`/`META` style; if none exist, build the nodes inline as the existing tests do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_filter.py -k boost -v`
Expected: FAIL — `ImportError: cannot import name 'boost_facet_matches'`.

- [ ] **Step 3: Implement `boost_facet_matches`**

Early-return `(nodes, set())` when `weight <= 0` or `_facet_constraints` yields no fields — untouched list and identity, so a boost arm with a bad manifest cannot quietly reorder results. Otherwise add `weight / (60 + 1)` to matching nodes' scores (`or 0.0` guard), collect non-`None` `doc_id`s, and return `sorted(out, key=lambda n: n.score or 0.0, reverse=True)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_facet_filter.py -q`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/facet_filter.py search-service/tests/test_facet_filter.py
git commit -m "feat(522): add pre-rerank facet boost alongside the filter"
```

---

### Task 3: `FACET_MODE` setting, Stage 1.6 wiring, debug keys

**Files:**
- Modify: `search-service/app/config.py` (with `cite_expansion_lane_weight`, ~line 174)
- Modify: `search-service/app/main.py:1672-1707` (Stage 1.6) and the debug payload near `main.py:2014-2030`
- Test: `search-service/tests/test_explicit_facets_flag_off.py`

**Interfaces:**
- Consumes: `boost_facet_matches`, `apply_facet_filters`, `excluded_doc_ids` from Tasks 1-2.
- Produces: `Settings.facet_mode: Literal["filter", "boost"]` (default `"filter"`), `Settings.facet_boost_weight: float = 1.0`; `debug["facet_mode"]` (always) and `debug["boosted_doc_ids"]` (sorted list under `return_intermediate_results`, else `None`).

- [ ] **Step 1: Write the failing end-to-end test**

In `test_explicit_facets_flag_off.py`, reusing its `_post` helper and `DOCS_META` (add `office` to the stubs' metadata so the facet bites):

```python
def test_boost_mode_keeps_and_reorders_instead_of_filtering(monkeypatch):
    monkeypatch.setattr(app_main.settings, "facet_mode", "boost")
    body = _post(monkeypatch, facets=[{"facet": "office", "value": "WRI India"}],
                 return_intermediate_results=True)
    assert body["debug"]["facet_mode"] == "boost"
    assert body["debug"]["boosted_doc_ids"] == [<the India doc id>]
    assert len(body["docs"]) == len(DOCS_META)          # nothing filtered out
    assert body["docs"][0]["doc_id"] == <the India doc id>

def test_boost_mode_still_applies_negation(monkeypatch):
    monkeypatch.setattr(app_main.settings, "facet_mode", "boost")
    body = _post(monkeypatch, excluded_keywords=["coal"], return_intermediate_results=True)
    assert "es_doc" not in [d["doc_id"] for d in body["docs"]]   # "coal power" doc removed
    assert body["debug"]["boosted_doc_ids"] == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py -q`
Expected: FAIL — no attribute `facet_mode` on settings.

- [ ] **Step 3: Add the settings and wire Stage 1.6**

`config.py` (add `from typing import Literal` at the top): `facet_mode: Literal["filter", "boost"] = "filter"` and `facet_boost_weight: float = 1.0`, with a two-line comment naming #522 and the `filter/61` unit. A typo in the env var must raise at import, matching `expansionArm()`'s precedent in the harness.

`main.py` Stage 1.6: keep the existing `all_facets` computation and the `excluded_doc_ids` call. Then branch:

```python
if settings.facet_mode == "boost":
    # An explicit exclusion is never a nudge: drop first, then boost the rest.
    stage1_results = [n for n in stage1_results
                      if (n.node.metadata or {}).get("doc_id") not in excluded]
    stage1_results, boosted = boost_facet_matches(
        stage1_results, all_facets, docs_meta, settings.facet_boost_weight)
else:
    stage1_results = apply_facet_filters(...)   # unchanged
```

Initialise `boosted: Set[str] = set()` alongside `excluded = set()` so the debug key is `[]`/`None` rather than undefined on every other path. Log the branch outcome the way the filter path does today (`Stage 1.6 (Facet Boost): N nodes, M boosted`).

Debug payload: `"facet_mode": settings.facet_mode` always; `"boosted_doc_ids": sorted(boosted) if request.return_intermediate_results else None`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_explicit_facets_flag_off.py tests/test_facet_filter.py tests/test_facet_parsers.py -q`
Expected: PASS. Then the whole suite: `./venv/bin/python -m pytest tests/ -q --ignore=tests/test_pg_store.py --ignore=tests/test_migration_script.py --ignore=tests/test_query_e2e.py --ignore=tests/test_reclassify.py --ignore=tests/test_sparse_retriever.py` (those five need a DB/service; they fail on a clean checkout too).

- [ ] **Step 5: Commit**

```bash
git add search-service/app/config.py search-service/app/main.py search-service/tests/test_explicit_facets_flag_off.py
git commit -m "feat(522): FACET_MODE=boost lever with facet_mode and boosted_doc_ids in debug"
```

---

### Task 4: Office probe evalset

**Files:**
- Create: `evaluation/evalsets/facet-office-probe.json`

**Interfaces:**
- Consumes: the harness's evalset shape — `{"name", "version", "test_cases": [{"id", "question", "expected_external_ids", "expected_document_ids", "task_description"}]}` (`run-evalset.ts:550`).
- Produces: two case ids the Task 5 manifest and Task 6 runs use: `office_q10_mexico`, `office_d7_india`.

- [ ] **Step 1: Write the probe set**

Two cases. Gold is the source case's gold intersected with a real office (query run 2026-11-26 against QA RDS); questions are rewritten so the facet is implied by the query.

```json
{
  "name": "facet-office-probe",
  "version": "1.0",
  "description": "Mechanism probe for #522 (office facet: filter vs boost). Gold = the source case's gold intersected with a real office; not a golden set.",
  "test_cases": [
    {
      "id": "office_q10_mexico",
      "question": "Have we published anything from WRI's Mexico office on urban finance since 2020?",
      "task_description": "Office probe derived from q10_urban_finance_since_2020.",
      "expected_external_ids": ["2023_analisis-de-los-mecanismos-financieros-para-la_3765", "2022_impactos-economicos-pandemia-covid19-transporte-publico_0070", "2020_acciones-federales-planeacion-urbana_0152"],
      "expected_document_ids": ["76039c19-d7e5-45f3-b543-88302b6034fa", "987353ab-9454-473f-8f00-eb767750dd24", "d24f1e12-50f0-46c6-bfb7-957e779701b4"]
    },
    {
      "id": "office_d7_india",
      "question": "What has WRI India published on electric bus adoption and operations?",
      "task_description": "Office probe derived from d7_electric-buses-excluding-school-buses.",
      "expected_external_ids": ["2022_rolling-out-electric-buses-a-guidebook-on-route_8515", "2024_real-world-electric-bus-operation-trend-in_3497", "2024_assessing-financing-challenges-for-implementing_4732", "2024_open-e-bus-blueprint_4307"],
      "expected_document_ids": ["20e4cc09-add5-4535-91d4-79a548649b0f", "011e3390-85a1-4169-9be8-4e8c5f28e95b", "0ae23d7a-5801-4bf2-95c4-a6e45311fae6", "49c0b8b9-28e2-47e0-ba9f-d645ae99d208"]
    }
  ]
}
```

- [ ] **Step 2: Verify the set loads without calling the target**

Run: `node -e "const s=require('./evaluation/evalsets/facet-office-probe.json'); console.log(s.test_cases.map(c=>c.id), s.test_cases.map(c=>c.expected_external_ids.length))"`
Expected: `[ 'office_q10_mexico', 'office_d7_india' ] [ 3, 4 ]`. No QA call in this task: the pre-registration must be committed first.

- [ ] **Step 3: Commit**

```bash
git add evaluation/evalsets/facet-office-probe.json
git commit -m "test(522): office facet mechanism probe evalset"
```

---

### Task 5: Pre-registration (committed before any run)

**Files:**
- Create: `evaluation/baselines/2026-11-26-facet-shaping-qa.md`

**Interfaces:**
- Consumes: case ids from Task 4, arms from the spec.
- Produces: the document Task 6 fills with numbers; its decision rule is frozen by this commit.

- [ ] **Step 1: Write the pre-registration**

Sections, with the decision rule copied verbatim from the spec (three conditions, tie = constraint, "improves but costs MAP" = not a promotion) and the arms/cases/tolerance tables. Record the committed SHA of this file in Task 6's report header. Include the exact run commands, the arm-defining env, and this caveat in place of a series table: *series is blocked — no document carries a `program_series` value in QA, so filter and boost are both no-ops; see #523.*

- [ ] **Step 2: Commit before running anything**

```bash
git add evaluation/baselines/2026-11-26-facet-shaping-qa.md
git commit -m "docs(522): pre-register the facet shaping decision rule and arms"
```

- [ ] **Step 3: Confirm the rule predates the data**

Run: `git log --format='%h %ad %s' --date=iso -1 -- evaluation/baselines/2026-11-26-facet-shaping-qa.md`
Expected: a commit timestamp earlier than every run recorded in Task 6.

---

### Task 6: Run the arms on QA and record the verdicts

**Files:**
- Modify: `evaluation/baselines/2026-11-26-facet-shaping-qa.md`
- Modify: `terraform/environments/qa.tfvars` (temporary, reverted in Step 8)

**Interfaces:**
- Consumes: every task above, plus the harness levers `EVAL_EXPANSION`, `EVAL_FACETS`.
- Produces: per-type verdicts to comment on #450.

- [ ] **Step 1: Land the lever on QA**

Open a PR (`fix/522-facet-shaping` → `qa`), merge, and wait for the deploy:
`./scripts/ecs-await-deploy.sh --cluster <qa cluster> --services "<search svc>" --expected-image-tag <sha>` (see #503). Confirm the search service reports `facet_mode` in a debug payload before proceeding.

- [ ] **Step 2: Arms 1 and 2 — no facet and hard filter**

```bash
export EVAL_EXPANSION=off
# arm 1: baseline, no facets. `{}` not unset: the unset path crashes on qa until #520 lands.
EVAL_FACETS='{}' npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_01.json
EVAL_FACETS='{}' npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_02.json
EVAL_FACETS='{}' npx tsx evaluation/run-evalset.ts evaluation/evalsets/facet-office-probe.json
# arm 2: hard filter
EVAL_FACETS='{"q10_urban_finance_since_2020":[{"facet":"year_min","value":"2020"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_01.json
EVAL_FACETS='{"d5_public-transport-financing-since-2022":[{"facet":"year_min","value":"2022"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/evalset_cite_02.json
EVAL_FACETS='{"office_q10_mexico":[{"facet":"office","value":"WRI Mexico"}],"office_d7_india":[{"facet":"office","value":"WRI India"}]}' \
  npx tsx evaluation/run-evalset.ts evaluation/evalsets/facet-office-probe.json
```

Save each report JSON beside the baseline. Then repeat arm 1 once per set to prove zero spread (spec, Tolerance). Any difference: record the spread and stop — no verdicts.

- [ ] **Step 3: Flip QA to the boost arm**

Add to the search-service env map in `terraform/environments/qa.tfvars`, with a comment naming #522, the run date, and "revert after the run": `"FACET_MODE" = "boost"`. Apply, wait for the deploy, and confirm one response's `debug.facet_mode == "boost"`.

- [ ] **Step 4: Arm 3 — boost**

Re-run the three arm-2 commands unchanged. The manifest is the same; only the service env differs. Confirm `debug.facet_mode == "boost"` in the saved report JSON before reading any number — an arm labelled by intention rather than evidence is void.

- [ ] **Step 5: Revert QA**

Remove `FACET_MODE` from `qa.tfvars`, apply, wait for the deploy, and confirm `facet_mode` is `filter` again in a live response.

- [ ] **Step 6: Fill the baseline**

Per case and per set: MAP, attainable recall, gold removed, leakage, and for arm 3 `boosted_doc_ids ∩ expected` and `∩ returned`, plus counts alongside every percentage. Then apply the pre-registered rule per type — recency, office — and write the verdict with the numbers that produced it. If `boosted_doc_ids ∩ expected` is empty for a type, record the arm as **inconclusive at weight 1.0**, not as "shaping fails".

- [ ] **Step 7: Commit the results**

```bash
git add evaluation/baselines/2026-11-26-facet-shaping-qa.md evaluation/baselines/*.json
git commit -m "docs(522): facet shaping vs filtering — three-arm QA baseline and per-type verdicts"
```

- [ ] **Step 8: Record the verdicts on #450**

One comment: the per-type verdicts with numbers, the series row as blocked (#523), and the note that a pre-rerank boost is pool admission, not ranking. No facet type changes mode on the strength of this experiment alone.

---

## Self-review

- **Spec coverage:** lever (Tasks 1-3), debug keys (3), probe set (4), pre-registration (5), three arms + tolerance + verdicts (6), series blocked (5, 6), env-knob/no-contract-change (3, 6). Non-goals need no task.
- **Step scan:** the two code steps name signatures and values; where a body is described it is the decision (early-return conditions, `61` unit), not the code. Task 1 has no new test on purpose — a refactor's proof is the unchanged suite, and its two runs are the steps.
- **Type consistency:** `_facet_constraints` → dict consumed by `_matches` (Task 1) → `boost_facet_matches` (Task 2) → Stage 1.6 (Task 3). `boosted` is a `Set[str]` everywhere; debug serialises `sorted(...)`. Case ids in Task 4 match the Task 6 manifest strings exactly.
- **Review Focus:** missing metadata/`None` doc_id, unparseable values, empty constraint set, `None` score, negation + boost, empty pool — each has a test in Task 2 or Task 3, except the unparseable-value and empty-pool cases, which the pre-existing `test_facet_filter.py` already covers and Task 1's suite run keeps honest.
- **Proportion:** the plan is ~1.5× the spec, and no task transcribes an implementation body.
