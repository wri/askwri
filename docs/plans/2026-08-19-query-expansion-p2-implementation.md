# Query Expansion & Understanding — P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship P2 of the query-expansion design — generalize `HybridFusionRetriever` from the fixed {dense, sparse} pair to a lane list, add a deterministic alias-expansion lane sourced from `tag_aliases`, and retire the `DOMAIN_EXPANSIONS` OR-stuffing behind the flag — dark behind `QUERY_EXPANSION_LANES_ENABLED=false`, gated against the P1 gate baselines.

**Architecture:** A new P2 flag (`query_expansion_lanes_enabled`) activates only when P1's `query_understanding_enabled` is also on (`lanes_active()`). Flag-on: the deterministic tier looks up `tag_aliases` groups matched in the query, the fusion retriever runs one extra 1×-weight sparse lane carrying the alias-expanded query, the two original lanes get 2× weight (only when an extra lane materializes), and the original sparse lane drops the `DOMAIN_EXPANSIONS` OR-stuffing — that flag-gated bypass IS the retirement (operator decision 2026-08-19; physical deletion of `query_expansion.py`'s dictionary is a post-activation cleanup outside P2, because deleting it would change the flag-off path). Flag-off: byte-identical to today, OR-stuffing included. The reranker only ever sees the original query (spec §4.4) — untouched by this plan.

**Tech Stack:** FastAPI + pydantic + psycopg pool (search-service), LlamaIndex `BaseRetriever`/RRF (fusion), TypeORM raw-SQL seed script (app tier owns `tag_aliases`), tsx eval runner + Jest (attribution instrument).

**Spec:** `docs/plans/2026-08-19-query-expansion-design.md` (§4.1 deterministic tier, §4.3 multi-lane weighted RRF, §4.4 precision guard, §5 failure posture, §6 observability, §7 P2 row + gates, §8 testing). Baselines: `docs/plans/2026-08-19-query-expansion-p1-gate-results.md`. Instrument provenance: `docs/plans/2026-07-24-cross-lingual-retrieval-design.md` §5.2.

## Global Constraints

- Invariant 1 (spec §2): anything that **excludes** documents must be visible & reversible; anything that only reorders may be silent. The alias lane only reorders/widens — no UI change in P2; `alias_expansions` is still surfaced in `query_understanding` for diagnosis.
- Invariant 2 (spec §2): hard filters ONLY on human-verifiable metadata. The alias lane never filters anything.
- `QueryRequest`/`QueryResponse` existing fields untouched; new fields additive only (spec §4.6). The `/query` contract note in `CLAUDE.md` applies. `debug` is `Dict[str, Any]` — additive keys are contract-preserving.
- Flag off (`query_expansion_lanes_enabled=False`, the default) must be **byte-identical** to current behavior — OR-stuffing included. All new P2 query-path code sits behind `lanes_active(settings, request)`, which also requires `query_understanding_enabled` and honors `request.expansion`. Additionally: P1-on/P2-off must reproduce the P1-gate flag-on behavior exactly (no P2 leak into P1).
- **The reranker only ever sees the original query** (spec §4.4). No task in this plan may touch what `postprocess_nodes` receives as `query_bundle`.
- No retry loops in the query path; every signal one attempt, failure-soft, recorded in `understanding.degraded` (spec §5). A failed alias lookup or a failed alias-lane retrieval degrades toward P1 behavior, never toward a 500.
- No new Python deps. Do not touch `requirements.txt` / `requirements.in`.
- Two-writer rule: `tag_aliases` is **app-owned** (migration `1787160000000-TopicTaxonomy.ts`). Python only READS it. The seed script is app-tier (TypeORM), like `scripts/seed-admin.ts`.
- Commit style: conventional commits, `git add <explicit paths>`, no Co-Authored-By trailer.
- Run Python tests: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/<file> -v` (this worktree has no venv; use the main repo's — deps from the venv, `app.*` imports from the worktree cwd, verified in P1). Run JS tests: `npm test -- <pattern>`.
- The `requires_db` pytest marker (`tests/conftest.py:34-37`) guards DB tests; copy that idiom, never hard-require a DB in unit tests.
- **Run the leak detectors after every task that touches `main.py` or `query_expansion.py`:** `test_diagnostic_parity.py`, `test_query_nonblocking.py` must stay green.
- No production deploy. No flag flip in any deployed environment. Do not push or open a PR without asking the operator. If a fixture label or gate rule looks wrong, STOP and ask the operator.
- Scope: P2 only. P3 (LLM sidecar / variants content) and P4 (SQL pushdown) are NOT in this plan. The lane list must structurally support variant dense+sparse lanes (P3 adds the content), but no LLM call is added here.
- Operator decisions recorded 2026-08-19 (this session): (a) alias seed derived from `DOMAIN_EXPANSIONS` mapped onto the tag taxonomy, mapping file reviewed by the operator before it is applied to qa; (b) retirement = flag-gated bypass, physical deletion deferred to post-activation cleanup; (c) 2× original-lane weighting applies only when an expansion lane actually materializes.

## Investigation results this plan is built on (2026-08-19, worktree at `626815e`)

- `DOMAIN_EXPANSIONS` plugs in at `main.py:237` (`HybridFusionRetriever._retrieve` → `sparse_query_for` → `build_sparse_query` → `expand_query_conservative`), unconditionally, sparse lane only. The diagnostic BM25 lane mirrors it at `main.py:1042-1046` (pinned by `test_diagnostic_parity.py`).
- `HybridFusionRetriever` construction site: `main.py:1055-1064`. RRF loops: `main.py:288-321`. `lane_ranks` (P0) is `{node_id: {"dense": rank|None, "sparse": rank|None}}`; only `tests/test_lane_attribution.py` consumes it — keys may grow per lane.
- **`tag_aliases` on qa is EMPTY (0 rows; 775 tags).** Task 7 (seed) is a prerequisite for a meaningful gate. `tags` has NO `label` column — canonical identity is `(facet, value_id)`, and `value_id` is human-readable ("Carbon Sequestration", "Kyoto Protocol").
- `search_vocab` builder (`search-service/scripts/build_search_vocab.py`) already reads `tag_aliases` — rebuild after seeding.
- The rerank window is `BedrockReranker._select_candidates(nodes, settings.rerank_candidates)` (`app/bedrock_rerank.py:73-100`) — pure function, callable for the displacement instrument without touching the shared reranker's state.
- The cite eval runner (`evaluation/run-cite-eval.ts`) does not send `return_intermediate_results` today; attribution is added behind `EVAL_LANE_ATTRIBUTION=1` so the default instrument stays byte-identical to the one that produced the P0/P1 baselines.

---

### Task 1: P2 config flag + `lanes_active()` guard

**Files:**
- Modify: `search-service/app/config.py` (after `topic_sense_min_cosine`, line 116)
- Modify: `search-service/app/understanding.py` (after `understanding_active`, line 47)
- Test: `search-service/tests/test_lane_fusion.py` (create)

**Interfaces:**
- Produces: `Settings.query_expansion_lanes_enabled: bool = False`, `Settings.alias_expand_max_groups: int = 3`, `Settings.alias_expand_max_terms: int = 2`; `understanding.lanes_active(settings, request) -> bool` — THE P2 flag-off guard. Every later task's query-path code sits behind it.

- [x] **Step 1: Write the failing tests**

```python
# search-service/tests/test_lane_fusion.py
"""P2 multi-lane fusion (design 2026-08-19 §4.3).

lanes_active is THE P2 flag-off guard: it must require BOTH flags and honor
the request-level expansion control, so flag-off (either flag) is
byte-identical and `expansion: false` disables lanes for eval control."""
from types import SimpleNamespace


def _settings(understanding=False, lanes=False):
    return SimpleNamespace(
        query_understanding_enabled=understanding,
        query_expansion_lanes_enabled=lanes,
    )


def test_lanes_active_requires_both_flags():
    from app.understanding import lanes_active
    req = SimpleNamespace(expansion=True)
    assert lanes_active(_settings(False, False), req) is False
    assert lanes_active(_settings(True, False), req) is False
    assert lanes_active(_settings(False, True), req) is False
    assert lanes_active(_settings(True, True), req) is True


def test_lanes_active_honors_request_expansion_control():
    from app.understanding import lanes_active
    assert lanes_active(_settings(True, True), SimpleNamespace(expansion=False)) is False


def test_p2_flag_defaults_off():
    from app.config import Settings
    assert Settings.model_fields["query_expansion_lanes_enabled"].default is False
    assert Settings.model_fields["alias_expand_max_groups"].default == 3
    assert Settings.model_fields["alias_expand_max_terms"].default == 2
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_lane_fusion.py -v`
Expected: FAIL with `ImportError: cannot import name 'lanes_active'`

- [x] **Step 3: Implement**

In `search-service/app/config.py`, after `topic_sense_min_cosine: float = 0.30` (line 116), add:

```python
    # P2 multi-lane fusion (design 2026-08-19 §4.3). Dark by default; active
    # only when query_understanding_enabled is ALSO on (lanes_active()).
    # Cost of enabling: one tag_aliases SELECT per query, plus — when a query
    # matches an alias group — one extra parallel BM25 retrieve and 2x weight
    # on the original lanes. Flag-on ALSO retires DOMAIN_EXPANSIONS
    # OR-stuffing on the original sparse lane (the gated retirement, spec
    # §4.3): the P2 gate must prove the alias lane covers its recall BEFORE
    # any activation. Flag-off is byte-identical, OR-stuffing included.
    query_expansion_lanes_enabled: bool = False
    # Alias-expansion caps — mirror expand_query_conservative's shape
    # (3 groups x 2 terms) so what replaces it is auditable against it.
    alias_expand_max_groups: int = 3
    alias_expand_max_terms: int = 2
```

In `search-service/app/understanding.py`, after `understanding_active` (line 47), add:

```python
def lanes_active(settings, request) -> bool:
    """THE P2 flag-off guard (design §4.3). Requires the P1 flag too: lanes
    consume the deterministic tier (alias lookup) and record degradation in
    the understanding object."""
    return understanding_active(settings, request) and bool(
        getattr(settings, "query_expansion_lanes_enabled", False)
    )
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_lane_fusion.py -v`
Expected: 3 PASS

- [x] **Step 5: Commit**

```bash
git add search-service/app/config.py search-service/app/understanding.py search-service/tests/test_lane_fusion.py
git commit -m "feat(retrieval): P2 lanes flag + lanes_active guard (dark)"
```

---

### Task 2: Deterministic alias expander — `app/alias_expand.py`

The alias-expansion source (design §4.1 deterministic tier): match `tag_aliases` groups in the query, return the group's OTHER terms as expansions. This is what replaces `DOMAIN_EXPANSIONS`' key→synonyms dictionary, with the taxonomy as the data source.

**Files:**
- Create: `search-service/app/alias_expand.py`
- Test: `search-service/tests/test_alias_expand.py` (create)

**Interfaces:**
- Produces: `AliasExpander(fetch_groups, max_groups, max_terms).expand(query) -> list[str]` (pure, deterministic; exceptions from `fetch_groups` propagate — the CALLER records degradation, Task 3). `db_expander() -> AliasExpander` — DB-backed via the shared psycopg pool (`app/db.py` `get_pool()`, same idiom as `spell_suggest.db_suggester`).

- [ ] **Step 1: Write the failing tests**

```python
# search-service/tests/test_alias_expand.py
"""Alias-expansion lane source (design §4.1, §4.3 P2).

Deterministic: longest matched phrase first, alphabetical (case-insensitive)
within a group, hard caps. Word-boundary matching only — substring hits
('art' in 'chart') are the over-matching DOMAIN_EXPANSIONS suffered."""
import pytest

from app.alias_expand import AliasExpander
from tests.conftest import requires_db


def _expander(groups, max_groups=3, max_terms=2):
    return AliasExpander(lambda: groups, max_groups=max_groups, max_terms=max_terms)


def test_alias_match_expands_to_rest_of_group():
    groups = {"Land Value Capture": ["LVC", "betterment levy"]}
    out = _expander(groups).expand("how does LVC work in Bogota?")
    # matched term "LVC" excluded; rest sorted case-insensitively
    assert out == ["betterment levy", "Land Value Capture"]


def test_label_match_expands_to_aliases():
    groups = {"Land Value Capture": ["LVC", "betterment levy", "land value tax"]}
    out = _expander(groups).expand("land value capture policies")
    # matching is case-insensitive; case-insensitive sort, max_terms=2 cap
    assert out == ["betterment levy", "land value tax"]


def test_word_boundary_no_substring_match():
    # "art" is inside "charting" but must not match (word boundary)
    groups = {"Art": ["visual arts"]}
    assert _expander(groups).expand("charting emissions") == []


def test_terms_shorter_than_three_chars_never_match():
    groups = {"Electric Vehicles": ["EV"]}
    assert _expander(groups).expand("ev charging") == []


def test_longest_matched_phrase_wins_group_cap():
    groups = {
        "Urban Finance": ["municipal finance"],
        "Finance": ["funding"],
        "Transit": ["public transport"],
        "Climate": ["ghg emissions"],
    }
    out = _expander(groups, max_groups=3).expand(
        "urban finance for transit and climate and finance"
    )
    # 4 groups match; "urban finance" (13 chars) sorts first; only 3 kept
    assert "municipal finance" in out
    assert len(out) <= 6  # 3 groups x 2 terms


def test_duplicate_terms_deduped_across_groups():
    groups = {"Buses": ["transit"], "Metro": ["transit"]}
    assert _expander(groups).expand("buses and metro") == ["transit"]


def test_empty_query_and_empty_groups():
    assert _expander({}).expand("anything") == []
    assert _expander({"A B C": ["x y z"]}).expand("") == []


def test_fetch_failure_propagates_to_caller():
    def boom():
        raise RuntimeError("db down")
    with pytest.raises(RuntimeError):
        AliasExpander(boom, 3, 2).expand("urban finance")


@requires_db
def test_db_expander_reads_tag_aliases():
    from app.alias_expand import db_expander
    from app.db import get_pool

    label = "__p2test Freight Decarbonization"
    with get_pool().connection() as conn:
        tag_id = conn.execute(
            "INSERT INTO tags (id, facet, value_id) "
            "VALUES (gen_random_uuid(), 'topic', %s) RETURNING id",
            (label,),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO tag_aliases (tag_id, alias) VALUES (%s, %s), (%s, %s)",
            (tag_id, "freight decarb", tag_id, "zero-emission freight"),
        )
    try:
        out = db_expander().expand("what about freight decarb in cities?")
        assert label in out
        assert "zero-emission freight" in out
    finally:
        with get_pool().connection() as conn:
            conn.execute("DELETE FROM tags WHERE id = %s", (tag_id,))  # cascades
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_alias_expand.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.alias_expand'`

- [ ] **Step 3: Implement `app/alias_expand.py`**

```python
# search-service/app/alias_expand.py
"""Alias-expansion lane source (design 2026-08-19 §4.1 deterministic tier,
§4.3 P2).

tag_aliases lookup for vocabulary expansion — the correct-mechanics
replacement for DOMAIN_EXPANSIONS OR-stuffing: expansions feed a SEPARATE
1x-weight sparse lane (Task 5) and never touch the original ranking.

Failure posture: expand() lets fetch errors propagate; the caller
(build_understanding) records `alias_expansion` in understanding.degraded
and the query proceeds without a lane (spec §5 — one attempt, no retry)."""
import logging
import re

logger = logging.getLogger(__name__)


class AliasExpander:
    """Deterministic by construction: longest matched phrase first,
    case-insensitive alphabetical order within a group, hard caps mirroring
    expand_query_conservative (3 groups x 2 terms) so what replaces the
    dictionary is auditable against it."""

    def __init__(self, fetch_groups, max_groups: int = 3, max_terms: int = 2):
        self._fetch_groups = fetch_groups  # () -> {value_id: [alias, ...]}
        self._max_groups = max_groups
        self._max_terms = max_terms

    def expand(self, query: str) -> list[str]:
        if not query or not query.strip():
            return []
        groups = self._fetch_groups() or {}
        q = query.lower()
        matches = []  # (matched_term, [expansion terms])
        for label, aliases in groups.items():
            terms = [label] + list(aliases)
            matched = None
            # Longest term first so a phrase beats its own substring.
            for t in sorted(terms, key=len, reverse=True):
                if len(t) < 3:
                    continue  # 'EV'-length terms over-match (design §4.1)
                pattern = (
                    r"(?<![a-z0-9])" + re.escape(t.lower()) + r"(?![a-z0-9])"
                )
                if re.search(pattern, q):
                    matched = t
                    break
            if matched is None:
                continue
            expansions = sorted(
                (t for t in terms if t.lower() != matched.lower()),
                key=str.lower,
            )[: self._max_terms]
            if expansions:
                matches.append((matched, expansions))
        # Longest matched phrase first (specific beats generic), then cap.
        matches.sort(key=lambda m: len(m[0]), reverse=True)
        out: list[str] = []
        seen = {q}
        for _, terms in matches[: self._max_groups]:
            for t in terms:
                if t.lower() not in seen:
                    seen.add(t.lower())
                    out.append(t)
        return out


def db_expander() -> AliasExpander:
    from app.config import get_settings
    from app.db import get_pool

    def fetch_groups():
        with get_pool().connection() as conn:
            rows = conn.execute(
                """SELECT t.value_id, a.alias
                   FROM tag_aliases a JOIN tags t ON t.id = a.tag_id"""
            ).fetchall()
        groups: dict[str, list[str]] = {}
        for value_id, alias in rows:
            groups.setdefault(value_id, []).append(alias)
        return groups

    s = get_settings()
    return AliasExpander(
        fetch_groups, s.alias_expand_max_groups, s.alias_expand_max_terms
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_alias_expand.py -v`
Expected: 8 PASS, 1 skip without `DATABASE_URL` (the `requires_db` test passes against the local docker stack: `export DATABASE_URL=postgresql://askwri:password@localhost:5432/qa`).

- [ ] **Step 5: Commit**

```bash
git add search-service/app/alias_expand.py search-service/tests/test_alias_expand.py
git commit -m "feat(retrieval): deterministic tag_aliases expander (P2 alias lane source)"
```

---

### Task 3: `QueryUnderstanding.alias_expansions` + deterministic-tier wiring

**Files:**
- Modify: `search-service/app/understanding.py` (schema line 31-38; `build_understanding` line 50-85)
- Test: `search-service/tests/test_understanding.py` (extend)

**Interfaces:**
- Consumes: `AliasExpander.expand` / `db_expander` (Task 2).
- Produces: `QueryUnderstanding.alias_expansions: list[str]` (additive schema field, default `[]`); `build_understanding(query, explicit_facets, today_year, expansion_lanes: bool = False)` — new keyword-only-in-practice arg, default `False` so every existing caller is unchanged. When `True`, runs the alias lookup, failure-soft into `degraded: ["alias_expansion"]`.

- [ ] **Step 1: Write the failing tests** (append to `search-service/tests/test_understanding.py`)

```python
def test_alias_expansions_default_empty_and_lookup_not_run():
    import app.alias_expand as ae

    def _boom():
        raise AssertionError("alias lookup must not run when expansion_lanes is off")

    orig = ae.db_expander
    ae.db_expander = _boom
    try:
        from app.understanding import build_understanding
        u = build_understanding("urban finance", explicit_facets=None, today_year=2026)
        assert u.alias_expansions == []
        assert "alias_expansion" not in u.degraded
    finally:
        ae.db_expander = orig


def test_alias_expansions_populated_when_lanes_on(monkeypatch):
    import app.alias_expand as ae
    from app.understanding import build_understanding

    class _Stub:
        def expand(self, query):
            return ["mass transit", "BRT"]

    monkeypatch.setattr(ae, "db_expander", lambda: _Stub())
    u = build_understanding(
        "bus systems", explicit_facets=None, today_year=2026, expansion_lanes=True
    )
    assert u.alias_expansions == ["mass transit", "BRT"]
    assert "alias_expansion" not in u.degraded


def test_alias_lookup_failure_soft(monkeypatch):
    import app.alias_expand as ae
    from app.understanding import build_understanding

    def _raise():
        raise RuntimeError("db down")

    monkeypatch.setattr(ae, "db_expander", _raise)
    u = build_understanding(
        "bus systems", explicit_facets=None, today_year=2026, expansion_lanes=True
    )
    assert u.alias_expansions == []
    assert "alias_expansion" in u.degraded
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_understanding.py -v`
Expected: the three new tests FAIL (`TypeError: build_understanding() got an unexpected keyword argument 'expansion_lanes'` / missing attribute); the existing six still PASS.

- [ ] **Step 3: Implement**

In `search-service/app/understanding.py`:

a) Add to `QueryUnderstanding` (after `variants`, line 35):

```python
    alias_expansions: list[str] = Field(default_factory=list)
```

b) Change `build_understanding`'s signature (line 50) to:

```python
def build_understanding(
    query: str, explicit_facets, today_year: int, expansion_lanes: bool = False
) -> QueryUnderstanding:
```

c) Before the `return u` (line 85), add:

```python
    if expansion_lanes:
        # P2 alias lane source (design §4.3). One attempt, failure-soft:
        # no expansions means no extra lane — degrade toward P1 behavior.
        try:
            from app.alias_expand import db_expander
            u.alias_expansions = db_expander().expand(query)
        except Exception:  # noqa: BLE001
            u.degraded.append("alias_expansion")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_understanding.py tests/test_alias_expand.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add search-service/app/understanding.py search-service/tests/test_understanding.py
git commit -m "feat(understanding): alias_expansions field + deterministic-tier alias lookup (P2)"
```

---

### Task 4: `HybridFusionRetriever` lane-list generalization

The §4.3 generalization: fixed {dense, sparse} becomes a lane list. Original pair stays first-class (byte-identity); extra lanes are additive. P2 only ever passes one sparse extra lane; P3's variant dense+sparse lanes reuse the same list.

**Files:**
- Modify: `search-service/app/main.py:192-332` (`HybridFusionRetriever.__init__` + `_retrieve`)
- Modify: `search-service/app/query_expansion.py:319-379` (`build_sparse_query`, `sparse_query_for` — add `domain_expansion` kwarg)
- Test: `search-service/tests/test_lane_fusion.py` (extend)

**Interfaces:**
- Consumes: nothing new (pure retriever change; wiring is Task 5).
- Produces:
  - `HybridFusionRetriever(..., extra_lanes: Optional[List[dict]] = None, domain_expansion: bool = True)`. Each lane dict: `{"name": str, "retriever": <has .retrieve(QueryBundle)>, "query_str": str, "weight": float | None, "top_k": int | None}` — `weight=None` resolves to `self.sparse_weight`; `top_k` slices that lane's results (like `bm25_top_k`).
  - Original-lane weights are multiplied by **2.0 only when at least one extra lane returned results** (operator decision c).
  - `self.lane_ranks: {node_id: {<lane name>: rank | None}}` — keys are exactly the lanes that fed RRF (`"dense"`, `"sparse"` + extra names). Two-lane shape unchanged.
  - `self.degraded_lanes: list[str]` — extra lanes whose retrieval raised (dropped, failure-soft). Always set (empty when none).
  - `build_sparse_query(query, translate=None, languages=..., max_expansions=3, domain_expansion=True)`; `sparse_query_for(query, domain_expansion=True)` — `domain_expansion=False` skips `expand_query_conservative` (base = raw query; translation posture unchanged).

- [ ] **Step 1: Write the failing tests** (append to `search-service/tests/test_lane_fusion.py`)

```python
from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode

from app.main import HybridFusionRetriever


def _nws(node_id: str, score: float) -> NodeWithScore:
    return NodeWithScore(node=TextNode(id_=node_id, text=f"text {node_id}"), score=score)


class _StubRetriever:
    def __init__(self, results):
        self._results = results
        self.seen_queries = []

    def retrieve(self, bundle):
        self.seen_queries.append(bundle.query_str)
        return list(self._results)


class _BoomRetriever:
    def retrieve(self, bundle):
        raise RuntimeError("lane down")


def _retriever(dense, sparse, extra_lanes=None, **kw):
    return HybridFusionRetriever(
        vector_retriever=_StubRetriever(dense),
        bm25_retriever=_StubRetriever(sparse),
        mode="cite",
        fusion_top_k=10,
        extra_lanes=extra_lanes,
        **kw,
    )


def test_no_extra_lanes_reproduces_two_lane_output_exactly():
    """Design §8: the generalization must reproduce current two-lane output
    exactly when given the legacy lane list (weights NOT doubled)."""
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    r = _retriever(dense, sparse)
    out = r._retrieve(QueryBundle(query_str="anything"))
    scores = {n.node.node_id: n.score for n in out}
    assert scores["a"] == 0.5 * (1.0 / 61)
    assert scores["b"] == 0.5 * (1.0 / 62) + 0.5 * (1.0 / 61)
    assert scores["c"] == 0.5 * (1.0 / 62)
    assert set(r.lane_ranks["a"].keys()) == {"dense", "sparse"}
    assert r.degraded_lanes == []


def test_extra_lane_weight_math_and_2x_originals():
    dense = [_nws("a", 0.9), _nws("b", 0.8)]
    sparse = [_nws("b", 5.0), _nws("c", 4.0)]
    alias = _StubRetriever([_nws("c", 3.0), _nws("d", 2.0)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q OR syn", "weight": None, "top_k": None},
    ])
    out = r._retrieve(QueryBundle(query_str="q"))
    scores = {n.node.node_id: n.score for n in out}
    # originals at 2x their 0.5 default; alias at 1x sparse weight (0.5)
    assert scores["a"] == 1.0 * (1.0 / 61)
    assert scores["b"] == 1.0 * (1.0 / 62) + 1.0 * (1.0 / 61)
    assert scores["c"] == 1.0 * (1.0 / 62) + 0.5 * (1.0 / 61)
    assert scores["d"] == 0.5 * (1.0 / 62)
    assert [n.node.node_id for n in out] == ["b", "c", "a", "d"]
    # lane_ranks covers all three lanes for every fused node
    assert r.lane_ranks["b"] == {"dense": 2, "sparse": 1, "alias_sparse": None}
    assert r.lane_ranks["d"] == {"dense": None, "sparse": None, "alias_sparse": 2}
    # the alias lane got ITS OWN query text
    assert alias.seen_queries == ["q OR syn"]


def test_extra_lane_top_k_slices_that_lane_only():
    dense = [_nws("a", 0.9)]
    sparse = [_nws("b", 5.0)]
    alias = _StubRetriever([_nws(f"x{i}", 5.0 - i) for i in range(5)])
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": alias,
         "query_str": "q", "weight": None, "top_k": 2},
    ])
    r._retrieve(QueryBundle(query_str="q"))
    alias_ranked = [nid for nid, lanes in r.lane_ranks.items()
                    if lanes["alias_sparse"] is not None]
    assert set(alias_ranked) == {"x0", "x1"}


def test_extra_lane_failure_drops_lane_and_records_degraded():
    dense = [_nws("a", 0.9)]
    sparse = [_nws("b", 5.0)]
    r = _retriever(dense, sparse, extra_lanes=[
        {"name": "alias_sparse", "retriever": _BoomRetriever(),
         "query_str": "q", "weight": None, "top_k": None},
    ])
    out = r._retrieve(QueryBundle(query_str="q"))
    assert r.degraded_lanes == ["alias_sparse"]
    # no materialized extra lane => weights NOT doubled (degrade toward P1)
    scores = {n.node.node_id: n.score for n in out}
    assert scores["a"] == 0.5 * (1.0 / 61)
    assert set(r.lane_ranks["a"].keys()) == {"dense", "sparse"}


def test_domain_expansion_false_uses_raw_query_for_sparse_lane():
    dense = [_nws("a", 0.9)]
    sparse_stub = _StubRetriever([_nws("b", 5.0)])
    r = HybridFusionRetriever(
        vector_retriever=_StubRetriever(dense),
        bm25_retriever=sparse_stub,
        mode="cite",
        fusion_top_k=10,
        domain_expansion=False,
    )
    r._retrieve(QueryBundle(query_str="urban finance mechanisms"))
    # "urban finance" is a DOMAIN_EXPANSIONS key; with the kwarg off the
    # sparse lane must see the RAW query (the gated retirement, §4.3)
    assert sparse_stub.seen_queries == ["urban finance mechanisms"]


def test_build_sparse_query_domain_expansion_kwarg():
    from app.query_expansion import build_sparse_query, expand_query_conservative
    q = "What have we published on urban finance since 2020?"
    assert build_sparse_query(q) == expand_query_conservative(q, max_expansions=3)
    assert build_sparse_query(q, domain_expansion=False) == q
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_lane_fusion.py -v`
Expected: new tests FAIL (`TypeError: ... unexpected keyword argument 'extra_lanes'`); Task 1's three still PASS.

- [ ] **Step 3: Implement `query_expansion.py` kwarg**

In `build_sparse_query` (line 319), add the parameter and change the first body line:

```python
def build_sparse_query(
    query: str,
    translate=None,
    languages=DEFAULT_TRANSLATION_LANGUAGES,
    max_expansions: int = 3,
    domain_expansion: bool = True,
) -> str:
```

```python
    base = (
        expand_query_conservative(query, max_expansions=max_expansions)
        if domain_expansion
        else query
    )
```

(Leave the docstring's byte-identical note; append one line: `domain_expansion=False is the P2 gated retirement of DOMAIN_EXPANSIONS — the alias lane carries vocabulary expansion instead (design §4.3).`)

In `sparse_query_for` (line 360), add the parameter and pass it through:

```python
def sparse_query_for(query: str, domain_expansion: bool = True) -> str:
```

```python
    return build_sparse_query(
        query,
        translate=get_translator(),
        languages=languages,
        max_expansions=3,
        domain_expansion=domain_expansion,
    )
```

- [ ] **Step 4: Implement the retriever generalization**

In `HybridFusionRetriever.__init__` (line 195), add parameters (before `**kwargs`):

```python
        extra_lanes: Optional[List[Dict[str, Any]]] = None,
        domain_expansion: bool = True,
```

and store them (after `self.bm25_top_k = bm25_top_k`):

```python
        # P2 lane list (design §4.3): additive lanes beyond the original
        # {dense, sparse} pair. Each: {"name", "retriever", "query_str",
        # "weight" (None -> sparse_weight), "top_k" (None -> no slice)}.
        self.extra_lanes = list(extra_lanes) if extra_lanes else []
        # False = the gated DOMAIN_EXPANSIONS retirement (P2 flag-on).
        self.domain_expansion = domain_expansion
```

In `_retrieve`:

a) Line 237, pass the kwarg:

```python
        expanded_query = sparse_query_for(
            query_bundle.query_str, domain_expansion=self.domain_expansion
        )
```

b) Replace the thread-pool block (lines 255-277) with the same block plus extra-lane futures — dense degradation and sparse strictness unchanged, extra lanes failure-soft:

```python
        self.degraded_lanes = []
        extra_results: Dict[str, List[NodeWithScore]] = {}
        pool_size = 2 + len(self.extra_lanes)
        with concurrent.futures.ThreadPoolExecutor(max_workers=pool_size) as executor:
            dense_future = executor.submit(
                _timed(self.vector_retriever.retrieve, "dense_ms", query_bundle))
            sparse_future = executor.submit(
                _timed(self.bm25_retriever.retrieve, "sparse_ms", expanded_bundle))
            extra_futures = {
                lane["name"]: executor.submit(
                    _timed(lane["retriever"].retrieve, f"{lane['name']}_ms",
                           QueryBundle(query_str=lane["query_str"])))
                for lane in self.extra_lanes
            }
            # Post-cutover the dense lane is a Bedrock API call with no local
            # fallback (query embed via BedrockCohereQueryEmbedding). Degrade
            # to sparse-only rather than 500 — mirrors the rerank lane's
            # degradation to fused (decision 2026-07-22). Sparse-only is
            # English-keyword-only, so surface it via /health, not silently.
            try:
                dense_results = dense_future.result()
                service_state["dense_degraded_at"] = None
                service_state["dense_error"] = None
            except Exception as exc:  # noqa: BLE001 — any embed/DB failure degrades, sparse still raises below
                from datetime import datetime, timezone
                logger.warning(
                    f"Dense lane failed ({exc}) — serving sparse-only results (degraded)"
                )
                service_state["dense_degraded_at"] = datetime.now(timezone.utc).isoformat()
                service_state["dense_error"] = str(exc)
                dense_results = []
            sparse_results = sparse_future.result()
            # Extra lanes are additive recall: a failed lane is dropped, the
            # query proceeds (spec §5 — degrade toward P1 behavior).
            for lane in self.extra_lanes:
                try:
                    lane_results = extra_futures[lane["name"]].result()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        f"{lane['name']} lane failed ({exc}) — lane dropped (failure-soft)"
                    )
                    self.degraded_lanes.append(lane["name"])
                    continue
                lane_top_k = lane.get("top_k")
                if lane_top_k is not None:
                    lane_results = lane_results[:lane_top_k]
                extra_results[lane["name"]] = lane_results
```

c) Replace the RRF section (lines 287-321) with the generalized loop. The 2× multiplier applies **only when an extra lane materialized** (operator decision c); with no extras the arithmetic is bit-identical to today's (`w * (1.0 / (60 + i + 1))` with the same `w`):

```python
        # Multi-lane weighted RRF (design §4.3). Original lanes at 2x ONLY
        # when an expansion lane materialized (operator decision 2026-08-19):
        # no lane -> weights untouched -> flag-on-no-alias == P1 behavior.
        # k=60 and node-id dedupe unchanged.
        if extra_results:
            w_dense, w_sparse = self.dense_weight * 2.0, self.sparse_weight * 2.0
        else:
            w_dense, w_sparse = self.dense_weight, self.sparse_weight
        lane_specs = [("dense", dense_results, w_dense),
                      ("sparse", sparse_results, w_sparse)]
        for lane in self.extra_lanes:
            if lane["name"] not in extra_results:
                continue
            lane_weight = lane.get("weight")
            lane_specs.append((
                lane["name"], extra_results[lane["name"]],
                lane_weight if lane_weight is not None else self.sparse_weight,
            ))

        fused_scores = {}
        lane_rank_maps = {}
        for lane_name, lane_results, lane_weight in lane_specs:
            # Per-lane rank attribution (design 2026-08-19 P0). These are the
            # rankings that FED RRF — the only valid basis for lane-level
            # claims (cross-lingual design §5.2).
            lane_rank_maps[lane_name] = {
                n.node.node_id: i + 1 for i, n in enumerate(lane_results)
            }
            for i, node_with_score in enumerate(lane_results):
                node_id = node_with_score.node.node_id
                rrf_score = lane_weight * (1.0 / (60 + i + 1))  # k=60 is standard
                fused_scores[node_id] = fused_scores.get(node_id, 0) + rrf_score

        # Combine and sort by fused score
        all_lane_results = dense_results + sparse_results
        for lane_name, lane_results, _ in lane_specs[2:]:
            all_lane_results = all_lane_results + lane_results
        all_nodes = {node.node.node_id: node for node in all_lane_results}

        # Sort by fused score and take top k
        sorted_nodes = sorted(
            fused_scores.items(),
            key=lambda x: x[1],
            reverse=True
        )[:self.fusion_top_k]

        self.lane_ranks = {
            node_id: {name: lane_rank_maps[name].get(node_id)
                      for name, _, _ in lane_specs}
            for node_id, _ in sorted_nodes
        }
```

(The `logger.info` dense/sparse count lines at 284-285 stay; the final-results loop at 323-332 stays.) Add `Dict`/`Any` to the existing `typing` import in `main.py` if not already imported (check: `Dict, Any` are already imported for `QueryResponse.debug`).

- [ ] **Step 5: Run the new tests + the P0 attribution tests + leak detectors**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_lane_fusion.py tests/test_lane_attribution.py tests/test_diagnostic_parity.py tests/test_query_nonblocking.py -v`
Expected: all PASS — the P0 two-lane tests must pass UNCHANGED (byte-identity), the leak detectors green.

- [ ] **Step 6: Run the full python suite**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/ -v`
Expected: no new failures (DB-marked tests skip without `DATABASE_URL`; the 3 known local-env failures listed in the P1 gate addendum are pre-existing).

- [ ] **Step 7: Commit**

```bash
git add search-service/app/main.py search-service/app/query_expansion.py search-service/tests/test_lane_fusion.py
git commit -m "feat(retrieval): generalize HybridFusionRetriever to a weighted lane list (P2, dark)"
```

---

### Task 5: `/query` wiring — alias lane, gated retirement, debug + EMF instrument

**Files:**
- Modify: `search-service/app/main.py` — import (line 90), understanding block (1011-1026), diagnostic BM25 (1040-1049), retriever construction (1051-1073), rerank block (1126-1152), debug dict (1398-1405), `_emit_query_emf` (905-910)
- Modify: `search-service/tests/test_query_nonblocking.py:98` (stub signature — see Step 4)
- Test: `search-service/tests/test_lane_wiring.py` (create), `search-service/tests/test_diagnostic_parity.py` (extend)

**Interfaces:**
- Consumes: `lanes_active` (Task 1), `understanding.alias_expansions` (Task 3), `extra_lanes`/`domain_expansion`/`degraded_lanes` (Task 4), `BedrockReranker._select_candidates` (existing, `app/bedrock_rerank.py:73`).
- Produces (all additive, `debug` only): `debug["alias_lane_size"]` (int|None — count of alias expansion terms), `debug["lanes_degraded"]` (list|None), and in diagnostic mode (`return_intermediate_results`) `debug["fused_nodes"]` (ordered `[{node_id, doc_id, url, fused_rank, lanes}]`) and `debug["rerank_window_ids"]` (the exact node ids `_select_candidates` kept — the displacement instrument Task 6 reads). EMF count metric `alias_lane_size`.

- [ ] **Step 1: Write the failing tests**

```python
# search-service/tests/test_lane_wiring.py
"""P2 /query wiring: alias lane construction, gated retirement, flag-off
leak detection (design §4.3, §5). TestClient + stubs — no DB/network,
same pattern as test_diagnostic_parity.py."""
from unittest.mock import patch

from fastapi.testclient import TestClient
from llama_index.core.schema import NodeWithScore, TextNode

from app import main as app_main
from app.query_expansion import sparse_query_for
from app.understanding import QueryUnderstanding


class RecordingRetriever:
    def __init__(self):
        self.seen_queries = []

    def retrieve(self, bundle):
        self.seen_queries.append(bundle.query_str)
        return [
            NodeWithScore(node=TextNode(id_=f"c{i}", text="t",
                                        metadata={"doc_id": f"d{i}", "url": f"https://wri.org/research/doc-{i}"}),
                          score=1.0 - i * 0.01)
            for i in range(5)
        ]


class _DenseStub:
    def retrieve(self, bundle):
        return []


def _post(client, **overrides):
    body = {"query": "urban finance mechanisms", "mode": "cite", "rerank": False}
    body.update(overrides)
    return client.post("/query", json=body)


def _stubbed(monkeypatch, lanes_on, alias_expansions):
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: lanes_on)

    def _build(query, explicit_facets, today_year, expansion_lanes=False):
        u = QueryUnderstanding()
        if expansion_lanes:
            u.alias_expansions = list(alias_expansions)
        return u

    monkeypatch.setattr(app_main, "build_understanding", _build)
    import app.topic_sense as ts
    monkeypatch.setattr(ts, "attach_topic_suggestions", lambda u, q, m: None)
    return stub


def test_lanes_on_alias_lane_and_raw_original_sparse(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=True,
                    alias_expansions=["municipal finance", "transit financing"])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # Original sparse lane: RAW query (retirement). Alias lane: query + terms.
    assert "urban finance mechanisms" in stub.seen_queries
    assert ("urban finance mechanisms OR municipal finance OR transit financing"
            in stub.seen_queries)
    # No OR-stuffed DOMAIN_EXPANSIONS query anywhere.
    stuffed = sparse_query_for("urban finance mechanisms")
    assert stuffed not in stub.seen_queries
    assert resp.json()["debug"]["alias_lane_size"] == 2


def test_lanes_on_no_alias_match_single_sparse_raw(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=True, alias_expansions=[])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    # Retirement still applies; no extra lane constructed.
    assert stub.seen_queries == ["urban finance mechanisms"]
    assert resp.json()["debug"]["alias_lane_size"] == 0


def test_p1_only_keeps_or_stuffing(monkeypatch):
    stub = _stubbed(monkeypatch, lanes_on=False, alias_expansions=[])
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["alias_lane_size"] == 0


def test_flag_off_no_alias_code_touched(monkeypatch):
    """Leak detector: default flags => alias module must never run and the
    sparse lane is byte-identical (OR-stuffed) — spec §5."""
    import app.alias_expand as ae
    monkeypatch.setattr(ae, "db_expander",
                        lambda: (_ for _ in ()).throw(AssertionError("leak")))
    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    client = TestClient(app_main.app)
    resp = _post(client)
    assert resp.status_code == 200
    assert stub.seen_queries == [sparse_query_for("urban finance mechanisms")]
    assert resp.json()["debug"]["alias_lane_size"] is None


def test_diagnostic_debug_has_fused_nodes_and_window(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, alias_expansions=["municipal finance"])
    client = TestClient(app_main.app)
    resp = _post(client, return_intermediate_results=True)
    assert resp.status_code == 200
    debug = resp.json()["debug"]
    fused = debug["fused_nodes"]
    assert fused[0]["fused_rank"] == 1
    assert {"node_id", "doc_id", "url", "fused_rank", "lanes"} <= set(fused[0])
    # rerank=False => no window capture (None), key still present
    assert debug["rerank_window_ids"] is None


def test_non_diagnostic_debug_omits_heavy_payloads(monkeypatch):
    _stubbed(monkeypatch, lanes_on=True, alias_expansions=["municipal finance"])
    client = TestClient(app_main.app)
    resp = _post(client)
    debug = resp.json()["debug"]
    assert debug["fused_nodes"] is None
    assert debug["rerank_window_ids"] is None
```

Append to `search-service/tests/test_diagnostic_parity.py`:

```python
def test_diagnostic_mirrors_retirement_when_lanes_on(monkeypatch):
    """Flag-on parity: the diagnostic BM25 lane must see the SAME raw query
    the fusion original-sparse lane sees (spec F7 extended to P2)."""
    from fastapi.testclient import TestClient

    from app import main as app_main
    from app.understanding import QueryUnderstanding

    class RecordingRetriever:
        def __init__(self):
            self.seen_queries = []

        def retrieve(self, bundle):
            self.seen_queries.append(bundle.query_str)
            from llama_index.core.schema import NodeWithScore, TextNode
            return [NodeWithScore(node=TextNode(id_="c0", text="t",
                                                metadata={"doc_id": "d0"}), score=1.0)]

    class _DenseStub:
        def retrieve(self, bundle):
            return []

    stub = RecordingRetriever()
    monkeypatch.setitem(app_main.service_state, "bm25_retriever", stub)
    monkeypatch.setitem(app_main.service_state, "pg_dense_ready", True)
    monkeypatch.setattr(app_main, "make_dense_retriever", lambda top_k: _DenseStub())
    monkeypatch.setattr(app_main, "understanding_active", lambda s, r: True)
    monkeypatch.setattr(app_main, "lanes_active", lambda s, r: True)
    monkeypatch.setattr(
        app_main, "build_understanding",
        lambda query, explicit_facets, today_year, expansion_lanes=False: QueryUnderstanding(),
    )
    import app.topic_sense as ts
    monkeypatch.setattr(ts, "attach_topic_suggestions", lambda u, q, m: None)

    client = TestClient(app_main.app)
    resp = client.post("/query", json={
        "query": "urban finance mechanisms", "mode": "cite", "rerank": False,
        "return_intermediate_results": True,
    })
    assert resp.status_code == 200
    # Diagnostic call AND fusion call both use the RAW query when lanes are on.
    assert all(q == "urban finance mechanisms" for q in stub.seen_queries)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_lane_wiring.py tests/test_diagnostic_parity.py -v`
Expected: new tests FAIL (`lanes_active` not imported in `main`, `alias_lane_size` missing); the two existing parity tests still PASS.

- [ ] **Step 3: Implement the wiring**

a) `main.py:90` import:

```python
from app.understanding import build_understanding, lanes_active, understanding_active
```

b) Understanding block — change the `build_understanding` call (1020-1025) to pass the P2 signal, and compute `lanes_on` right after the block (so the diagnostic path below can use it):

```python
            understanding = await asyncio.to_thread(
                build_understanding,
                request.query,
                explicit_facets=request.facets,
                today_year=datetime.now().year,
                expansion_lanes=lanes_active(settings, request),
            )
```

after line 1026 (outside the `if`):

```python
        # P2 (design §4.3): lanes_on implies understanding is not None.
        lanes_on = lanes_active(settings, request)
```

c) Diagnostic BM25 (1043-1046) — mirror the retirement:

```python
            bm25_only_results = await asyncio.to_thread(
                service_state["bm25_retriever"].retrieve,
                QueryBundle(query_str=_sqf(request.query, domain_expansion=not lanes_on)),
            )
```

d) Retriever construction (1051-1064) — build the alias lane and pass the P2 params:

```python
        # Stage 1: Hybrid Fusion Retrieval
        stage1_start = time.time()
        vector_retriever = make_dense_retriever(request.vector_top_k)

        # P2 alias lane (design §4.3): one extra 1x-weight sparse lane
        # carrying original query + tag_aliases expansions. The reranker
        # still only ever sees the original query (§4.4).
        extra_lanes = None
        if lanes_on and understanding is not None and understanding.alias_expansions:
            alias_query = " OR ".join([request.query] + understanding.alias_expansions)
            logger.info(f"Alias lane: {alias_query[:120]}")
            extra_lanes = [{
                "name": "alias_sparse",
                "retriever": service_state["bm25_retriever"],
                "query_str": alias_query,
                "weight": None,   # 1x — resolves to the retriever's sparse_weight
                "top_k": request.bm25_top_k,
            }]

        hybrid_retriever = HybridFusionRetriever(
            vector_retriever=vector_retriever,
            bm25_retriever=service_state["bm25_retriever"],
            mode=request.mode,
            similarity_threshold=request.similarity_threshold,
            dense_weight=request.dense_weight,
            sparse_weight=request.sparse_weight,
            fusion_top_k=request.fusion_top_k,
            bm25_top_k=request.bm25_top_k,
            extra_lanes=extra_lanes,
            domain_expansion=not lanes_on,
        )
```

e) After the Stage 1 `logger.info` (line 1073), record degradation and capture the fused snapshot BEFORE any later stage mutates scores in place:

```python
        if understanding is not None:
            understanding.degraded.extend(
                getattr(hybrid_retriever, "degraded_lanes", []) or []
            )

        # Diagnostic-only fused snapshot (P2 instrument): rank + per-lane
        # attribution per node, captured before rerank mutates scores.
        fused_nodes = None
        if request.return_intermediate_results:
            _ranks = getattr(hybrid_retriever, "lane_ranks", {}) or {}
            fused_nodes = [{
                "node_id": n.node.node_id,
                "doc_id": n.node.metadata.get("doc_id"),
                "url": n.node.metadata.get("url", ""),
                "fused_rank": i + 1,
                "lanes": _ranks.get(n.node.node_id),
            } for i, n in enumerate(stage1_results)]
```

f) Rerank block — initialize `rerank_window_ids = None` on the line before `rerank_applied = False` (line 1126), then inside `if base_reranker:` (after line 1131, before the `try`):

```python
                # P2 displacement instrument: the EXACT candidate set the
                # reranker saw. _select_candidates is pure — recomputing it
                # here is race-free on the shared reranker singleton.
                if request.return_intermediate_results:
                    rerank_window_ids = [
                        n.node.node_id
                        for n in base_reranker._select_candidates(
                            stage1_results, settings.rerank_candidates)
                    ]
```

g) Debug dict — after the `"suggestions"` entry (line 1405), add:

```python
                "alias_lane_size": (len(understanding.alias_expansions)
                                    if understanding is not None else None),
                "lanes_degraded": (getattr(hybrid_retriever, "degraded_lanes", None)
                                   if understanding is not None else None),
                "fused_nodes": (fused_nodes
                                if request.return_intermediate_results else None),
                "rerank_window_ids": (rerank_window_ids
                                      if request.return_intermediate_results else None),
```

h) `_emit_query_emf` — in the `counts` dict (line 905-908), add:

```python
            "alias_lane_size": debug.get("alias_lane_size"),
```

- [ ] **Step 4: Fix the nonblocking leak-detector stub signature**

`main.py` now calls `build_understanding(..., expansion_lanes=...)`; the stub in `tests/test_query_nonblocking.py:98` must accept it (behavior unchanged):

```python
    def _slow_build_understanding(query, explicit_facets, today_year, expansion_lanes=False):
```

- [ ] **Step 5: Run the new tests + BOTH leak detectors**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_lane_wiring.py tests/test_diagnostic_parity.py tests/test_query_nonblocking.py tests/test_lane_fusion.py tests/test_lane_attribution.py tests/test_understanding.py -v`
Expected: all PASS

- [ ] **Step 6: Run the full python suite**

Run: `cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/ -v`
Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_lane_wiring.py search-service/tests/test_diagnostic_parity.py search-service/tests/test_query_nonblocking.py
git commit -m "feat(retrieval): wire alias lane + gated DOMAIN_EXPANSIONS retirement into /query (P2, dark)"
```

---

### Task 6: Eval-runner lane attribution — the displacement instrument

Design §7's named regression mechanism, made measurable: "variant lanes add candidates that can displace golden docs from the 100-slot rerank window… the eval runner emits a per-query attribution so failures are diagnosable, not just detectable." Env-gated so the DEFAULT runner stays byte-identical to the instrument that produced the P0/P1 baselines (measured-change discipline).

**Files:**
- Create: `evaluation/lib/lane-attribution.ts`
- Test: `evaluation/lib/lane-attribution.test.ts` (create — Jest collects `evaluation/lib` already, cf. `metrics.test.ts`)
- Modify: `evaluation/lib/service-client.ts` (add `callPythonServiceFull`, additive)
- Modify: `evaluation/run-cite-eval.ts` (`runTestCase`, behind `process.env.EVAL_LANE_ATTRIBUTION === '1'`)

**Interfaces:**
- Consumes: `debug.fused_nodes` + `debug.rerank_window_ids` (Task 5), `extractUrlSlug` (`evaluation/lib/metrics.ts:19`).
- Produces: `classifyDisplacement(missedUrls: string[], fusedNodes: FusedNode[], rerankWindowIds: string[]): DisplacementRecord[]`; `callPythonServiceFull(query, mode, params) -> Promise<any>` (whole `/query` JSON, accepts `return_intermediate_results`); per-result `lane_attribution`, `alias_lane_size`, and `lane_contribution` (per-lane count of returned docs — spec §6) fields in the eval report (additive; absent when the env var is unset).

- [ ] **Step 1: Write the failing test**

```typescript
// evaluation/lib/lane-attribution.test.ts
import { classifyDisplacement, FusedNode } from './lane-attribution'

const node = (
  node_id: string,
  url: string,
  fused_rank: number,
  lanes: Record<string, number | null>,
): FusedNode => ({ node_id, doc_id: null, url, fused_rank, lanes })

const GOLDEN = 'https://www.wri.org/research/golden-doc'

describe('classifyDisplacement', () => {
  it('flags a golden doc outside the window with variant-only nodes inside', () => {
    const fused = [
      node('v1', 'https://www.wri.org/research/noise-a', 1, {
        dense: null,
        sparse: null,
        alias_sparse: 1,
      }),
      node('g1', GOLDEN, 3, { dense: 40, sparse: null, alias_sparse: null }),
    ]
    const out = classifyDisplacement([GOLDEN], fused, ['v1'])
    expect(out).toEqual([
      {
        expected_url: GOLDEN,
        status: 'displaced_by_variant_lane',
        best_fused_rank: 3,
        variant_only_in_window: 1,
      },
    ])
  })

  it('below_window when nothing variant-only sits in the window', () => {
    const fused = [
      node('o1', 'https://www.wri.org/research/noise-b', 1, {
        dense: 1,
        sparse: 2,
        alias_sparse: null,
      }),
      node('g1', GOLDEN, 5, { dense: 90, sparse: null, alias_sparse: null }),
    ]
    const out = classifyDisplacement([GOLDEN], fused, ['o1'])
    expect(out[0].status).toBe('below_window')
  })

  it('in_window_not_returned when the golden doc made the window', () => {
    const fused = [node('g1', GOLDEN, 1, { dense: 1, sparse: 1, alias_sparse: null })]
    const out = classifyDisplacement([GOLDEN], fused, ['g1'])
    expect(out[0].status).toBe('in_window_not_returned')
  })

  it('never_retrieved when no lane surfaced the doc at all', () => {
    const out = classifyDisplacement([GOLDEN], [], [])
    expect(out[0].status).toBe('never_retrieved')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lane-attribution`
Expected: FAIL — `Cannot find module './lane-attribution'`

- [ ] **Step 3: Implement `evaluation/lib/lane-attribution.ts`**

```typescript
/**
 * P2 displacement instrument (design 2026-08-19 §7, named regression
 * mechanism): classify each MISSED golden doc by what the fused list and
 * the exact rerank window say happened to it. A "variant-only" node is one
 * no original lane surfaced (dense and sparse both null) — it exists only
 * because an expansion lane (e.g. alias_sparse) added it.
 */
import { extractUrlSlug } from './metrics'

export interface FusedNode {
  node_id: string
  doc_id: string | null
  url: string
  fused_rank: number
  lanes: Record<string, number | null> | null
}

export interface DisplacementRecord {
  expected_url: string
  status:
    | 'never_retrieved'
    | 'in_window_not_returned'
    | 'displaced_by_variant_lane'
    | 'below_window'
  best_fused_rank?: number
  variant_only_in_window?: number
}

function isVariantOnly(lanes: Record<string, number | null> | null): boolean {
  if (!lanes) return false
  if (lanes.dense != null || lanes.sparse != null) return false
  return Object.entries(lanes).some(
    ([name, rank]) => name !== 'dense' && name !== 'sparse' && rank != null,
  )
}

export function classifyDisplacement(
  missedUrls: string[],
  fusedNodes: FusedNode[],
  rerankWindowIds: string[],
): DisplacementRecord[] {
  const window = new Set(rerankWindowIds)
  const variantOnlyInWindow = fusedNodes.filter(
    (n) => window.has(n.node_id) && isVariantOnly(n.lanes),
  ).length

  return missedUrls.map((url) => {
    const slug = extractUrlSlug(url)
    const nodes = fusedNodes.filter(
      (n) => slug && extractUrlSlug(n.url) === slug,
    )
    if (nodes.length === 0) {
      return { expected_url: url, status: 'never_retrieved' as const }
    }
    const best = Math.min(...nodes.map((n) => n.fused_rank))
    if (nodes.some((n) => window.has(n.node_id))) {
      return {
        expected_url: url,
        status: 'in_window_not_returned' as const,
        best_fused_rank: best,
      }
    }
    if (variantOnlyInWindow > 0) {
      return {
        expected_url: url,
        status: 'displaced_by_variant_lane' as const,
        best_fused_rank: best,
        variant_only_in_window: variantOnlyInWindow,
      }
    }
    return {
      expected_url: url,
      status: 'below_window' as const,
      best_fused_rank: best,
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lane-attribution`
Expected: 4 PASS

- [ ] **Step 5: Add `callPythonServiceFull` to `evaluation/lib/service-client.ts`**

After `callPythonService` (line 110), add — same request body plus the diagnostic flag, returning the WHOLE response so callers can read `debug`:

```typescript
/**
 * Like callPythonService but returns the FULL /query JSON (docs + debug +
 * query_understanding). Used by the lane-attribution eval mode, which needs
 * debug.fused_nodes and debug.rerank_window_ids.
 */
export async function callPythonServiceFull(
  query: string,
  mode: 'answer' | 'cite',
  params?: {
    vector_top_k?: number
    bm25_top_k?: number
    rerank_top_n?: number
    max_results?: number
    dense_weight?: number
    sparse_weight?: number
    return_intermediate_results?: boolean
  },
): Promise<any> {
  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode,
      max_results: params?.max_results ?? 100,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      vector_top_k: params?.vector_top_k,
      bm25_top_k: params?.bm25_top_k,
      rerank_top_n: params?.rerank_top_n,
      dense_weight: params?.dense_weight,
      sparse_weight: params?.sparse_weight,
      return_intermediate_results: params?.return_intermediate_results,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Python service error: ${response.status} - ${errorText}`)
  }

  return response.json()
}
```

- [ ] **Step 6: Wire attribution mode into `evaluation/run-cite-eval.ts`**

a) Extend the import at line 12-16 with `callPythonServiceFull`, and add near the top (after the golden-set load):

```typescript
import { classifyDisplacement } from './lib/lane-attribution'

// Lane-attribution mode (P2 displacement instrument). OFF by default so the
// default runner stays byte-identical to the instrument that produced the
// P0/P1 baselines. Attribution runs are DIAGNOSTIC — never compare their
// P/R/F1 against a non-attribution baseline (measured-change discipline);
// use a distinct EVAL_LABEL so checkpoints don't mix.
const LANE_ATTRIBUTION = process.env.EVAL_LANE_ATTRIBUTION === '1'
```

b) In `runTestCase` (line 171), replace the single `callCiteService` call (line 183) with:

```typescript
    let docs: DocMeta[]
    let fullResponse: any = null
    if (LANE_ATTRIBUTION) {
      fullResponse = await callPythonServiceFull(fullQuery, 'cite', {
        vector_top_k: 800,
        bm25_top_k: 800,
        rerank_top_n: 500,
        max_results: 100,
        return_intermediate_results: true,
      })
      docs = (fullResponse.docs || []).map(transformToDocMeta)
    } else {
      docs = await callCiteService(fullQuery)
    }
```

(`transformToDocMeta` is already exported from `./lib/service-client`; add it to the import list at line 12-16.)

c) In the success return object (after `execution_time_ms`, line 223), add — `lane_contribution` is design §6's per-lane contribution: for each lane, how many RETURNED docs it surfaced (chunk-level match via the raw docs' `chunk_id`):

```typescript
      ...(LANE_ATTRIBUTION
        ? {
            lane_attribution: classifyDisplacement(
              metrics.false_negatives,
              fullResponse?.debug?.fused_nodes ?? [],
              fullResponse?.debug?.rerank_window_ids ?? [],
            ),
            alias_lane_size: fullResponse?.debug?.alias_lane_size ?? null,
            lane_contribution: (() => {
              const lanesFor = new Map<string, Record<string, number | null>>(
                (fullResponse?.debug?.fused_nodes ?? []).map(
                  (n: any) => [n.node_id, n.lanes ?? {}],
                ),
              )
              const contribution: Record<string, number> = {}
              for (const raw of fullResponse?.docs ?? []) {
                const lanes = lanesFor.get(raw.chunk_id) ?? {}
                for (const [name, rank] of Object.entries(lanes)) {
                  if (rank != null)
                    contribution[name] = (contribution[name] || 0) + 1
                }
              }
              return contribution
            })(),
          }
        : {}),
```

(If `TestResult` is a typed interface in this file, add optional fields `lane_attribution?: any[]`, `alias_lane_size?: number | null`, `lane_contribution?: Record<string, number>`.)

- [ ] **Step 7: Verify the default runner is untouched**

Run: `npm test -- lane-attribution` (PASS) then `npx tsc --noEmit -p tsconfig.json` if the repo typechecks eval scripts — otherwise verify with `npx tsx --env-file-if-exists=.env evaluation/run-cite-eval.ts --help 2>&1 | head -5` that the script still parses (it will fail fast on /health, which is fine — the point is no syntax/type error). Confirm `git diff evaluation/run-cite-eval.ts` shows changes ONLY inside the `LANE_ATTRIBUTION` conditionals + imports.

- [ ] **Step 8: Commit**

```bash
git add evaluation/lib/lane-attribution.ts evaluation/lib/lane-attribution.test.ts evaluation/lib/service-client.ts evaluation/run-cite-eval.ts
git commit -m "feat(eval): lane-attribution mode — per-query variant-lane displacement instrument (P2)"
```

---

### Task 7: Seed `tag_aliases` (prerequisite for a meaningful gate)

**qa has 0 alias rows against 775 tags** (probed 2026-08-19). Without a seed the alias lane is a no-op and the gate cannot prove it covers `DOMAIN_EXPANSIONS` recall. Operator decision (a): derive the seed from `DOMAIN_EXPANSIONS` mapped onto the existing taxonomy, as a checked-in mapping file the operator reviews before it touches qa. `tag_aliases` is app-owned — the script is app-tier TypeORM, modeled on `scripts/seed-admin.ts`. Operational task (like P0's baseline capture): verification is by running, not unit tests.

**Files:**
- Create: `scripts/tag-aliases-seed.json` (curated mapping — drafted by implementer, REVIEWED BY OPERATOR)
- Create: `scripts/seed-tag-aliases.ts`
- Modify: `package.json` (one script entry)

**Interfaces:**
- Produces: `npm run seed:tag-aliases` — idempotent (`ON CONFLICT DO NOTHING`), reports inserted/skipped counts and unmatched tags, exits 1 if any mapping entry matches no tag. Populated `tag_aliases` on local docker + qa.

- [ ] **Step 1: Draft the mapping file from `DOMAIN_EXPANSIONS` × the qa taxonomy**

For each `DOMAIN_EXPANSIONS` group (`search-service/app/query_expansion.py:19-200`), find the matching tag on qa:

```bash
./scripts/with-remote-env.sh qa psql -c "SELECT facet, value_id FROM tags WHERE value_id ILIKE '%finance%' OR value_id ILIKE '%transit%' OR value_id ILIKE '%hydrogen%' OR value_id ILIKE '%climate%' OR value_id ILIKE '%housing%' OR value_id ILIKE '%land value%' OR value_id ILIKE '%charging%' OR value_id ILIKE '%health%' OR value_id ILIKE '%equity%' OR value_id ILIKE '%policy%' OR value_id ILIKE '%planning%' OR value_id ILIKE '%nature%' OR value_id ILIKE '%pollution%' OR value_id ILIKE '%micromobility%' OR value_id ILIKE '%bus%' ORDER BY facet, value_id"
```

Draft `scripts/tag-aliases-seed.json` in this shape — one entry per DOMAIN_EXPANSIONS group that has a sensible tag; the group's key AND its synonyms become that tag's aliases (skip terms identical to the `value_id` itself, and skip the pure-geography entries `bangalore`/`brazil` unless a matching place tag exists):

```json
{
  "_comment": "P2 alias seed derived from DOMAIN_EXPANSIONS (query_expansion.py), mapped onto the tag taxonomy. Reviewed by operator before qa apply (decision 2026-08-19). Aliases are lowercase phrases; matching is word-boundary, case-insensitive (app/alias_expand.py).",
  "entries": [
    {
      "facet": "topic",
      "value_id": "<exact value_id from the probe>",
      "aliases": ["urban finance", "transit financing", "municipal finance"]
    }
  ]
}
```

Record, in a `"_unmapped"` array in the same file, every DOMAIN_EXPANSIONS group with NO matching tag — those groups' recall coverage is at risk when the flag turns on, and the gate (Task 8) will show whether it matters. **STOP: show the drafted file to the operator and get approval before Step 4 (qa apply). Local apply (Step 3) may proceed for testing.**

- [ ] **Step 2: Write `scripts/seed-tag-aliases.ts`**

```typescript
import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
import { AppDataSource } from '../src/db/data-source'

/**
 * Seed tag_aliases from scripts/tag-aliases-seed.json (P2 alias lane,
 * design 2026-08-19 §4.3). App-owned table; idempotent (ON CONFLICT DO
 * NOTHING). Exits 1 if any entry matches no tag, so a taxonomy drift is
 * loud, not silent.
 */
async function main() {
  const file = path.join(__dirname, 'tag-aliases-seed.json')
  const { entries } = JSON.parse(fs.readFileSync(file, 'utf8'))
  await AppDataSource.initialize()
  let inserted = 0
  let skipped = 0
  const missing: string[] = []
  for (const e of entries) {
    const rows = await AppDataSource.query(
      `SELECT id FROM tags WHERE facet = $1 AND lower(value_id) = lower($2)`,
      [e.facet, e.value_id],
    )
    if (rows.length === 0) {
      missing.push(`${e.facet}:${e.value_id}`)
      continue
    }
    for (const alias of e.aliases) {
      const res = await AppDataSource.query(
        `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2)
         ON CONFLICT (tag_id, alias) DO NOTHING RETURNING tag_id`,
        [rows[0].id, alias],
      )
      if (res.length > 0) inserted += 1
      else skipped += 1
    }
  }
  console.log(
    `tag_aliases seed: ${inserted} inserted, ${skipped} already present, ` +
      `${missing.length} unmatched tag(s)${missing.length ? ': ' + missing.join(', ') : ''}`,
  )
  await AppDataSource.destroy()
  if (missing.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

Add to `package.json` scripts (next to `seed:admin`, line 41):

```json
    "seed:tag-aliases": "ts-node --project tsconfig.typeorm.json -r ./scripts/load-env.js scripts/seed-tag-aliases.ts",
```

- [ ] **Step 3: Apply locally and prove idempotency**

```bash
npm run seed:tag-aliases
```

Expected: `N inserted, 0 already present, 0 unmatched` (local docker `askwri-pg` — its corpus was cloned from qa so the taxonomy matches; if the local `tags` table diverges, unmatched entries print and exit 1 — resolve by fixing the mapping, not by ignoring). Run again:

```bash
npm run seed:tag-aliases
```

Expected: `0 inserted, N already present` — idempotent. Then run the alias DB test against local:

```bash
export DATABASE_URL=postgresql://askwri:password@localhost:5432/qa
cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/test_alias_expand.py -v
```

- [ ] **Step 4: OPERATOR-APPROVED qa apply + vocab rebuild**

Only after the operator approves the mapping file:

```bash
./scripts/with-remote-env.sh qa npm run seed:tag-aliases
```

then rebuild `search_vocab` (it sources `tag_aliases` — `build_search_vocab.py:52` — so the P1 did-you-mean vocabulary stays complete; design §4.1):

```bash
./scripts/with-remote-env.sh qa bash -c 'cd search-service && ./venv/bin/python -m scripts.build_search_vocab'
```

Verify:

```bash
./scripts/with-remote-env.sh qa psql -c "SELECT count(*) AS aliases, count(DISTINCT tag_id) AS tags FROM tag_aliases"
```

Expected: counts match the mapping file.

- [ ] **Step 5: Commit**

```bash
git add scripts/tag-aliases-seed.json scripts/seed-tag-aliases.ts package.json
git commit -m "chore(seed): tag_aliases seed from DOMAIN_EXPANSIONS mapping (P2 prerequisite)"
```

---

### Task 8: P2 gate — flag-off proof + flag-on measurement + displacement attribution

**Files:**
- Create: `docs/plans/2026-08-19-query-expansion-p2-gate-results.md`

**Interfaces:**
- Consumes: every prior task merged; P0 baselines (`evaluation/results/2026-08-19-p0-baseline-{cite,answer}.json`); the P1 gate doc's numbers (amended cite macro recall excl. q10 = 0.8583; answer chunk R = 0.3307); Task 7's qa seed applied.
- Produces: the gate document. **P3 does not start until every rule passes. Both flags stay OFF in every deployed environment regardless of outcome** — activation is a separate, gated ops step the operator controls.

Rig: local search service pointed at qa RDS, the SAME rig as P0 Task 2 and the P1 gate (numbers from different harnesses must never be compared). Service start:

```bash
./scripts/with-remote-env.sh qa bash -c 'cd search-service && ./venv/bin/python -m app.main'
```

- [ ] **Step 1: Full local suites**

```bash
cd search-service && /Users/gutelius/dev/askwrimvp/search-service/venv/bin/python -m pytest tests/ -v
```

then `npm test`, `npm run lint`, `npm run format:check`. Expected: all green (the 3 known local-env DB failures from the P1 gate addendum are pre-existing and excluded).

- [ ] **Step 2: Flag-OFF eval re-run (byte-identical proof)** — both flags at defaults (OFF):

```bash
npm run eval:cite
npm run eval:answer-retrieval
```

Decision rule: recall/ranks IDENTICAL to the P0 baselines (cite R Δ = 0.0000; answer all aggregates Δ = 0.0000 — the P1 gate showed reranker score rounding can wiggle P/F1 in the 3rd decimal; recall must be exact). Any recall delta = a leak outside `lanes_active` → STOP, find the leak, re-run. This re-proves the P1 gate's flag-off guarantee for the P2 code (kickoff gate rule 4).

- [ ] **Step 3: Flag-ON eval run** — export for the service process:

```bash
export QUERY_UNDERSTANDING_ENABLED=true
export QUERY_EXPANSION_LANES_ENABLED=true
```

restart the service on the qa rig, re-run both suites (no `EVAL_LANE_ATTRIBUTION` — same instrument as the baselines).

Decision rules (spec §7 + kickoff):
- **cite golden macro recall may not fall — amended rule** (P1 gate, operator option b): exclude correctly-faceted golden queries (today only `q10_urban_finance_since_2020`) from the macro-recall comparison; baseline to beat/match is **0.8583**. q10 keeps its own assertion instead: every returned doc satisfies `year >= 2020`.
- **answer-retrieval chunk recall may not fall**: baseline chunk R **0.3307**.
- Per-case: list every query whose recall moved either direction, with its `alias_lane_size` — movement on a query with `alias_lane_size == 0` means the retirement (raw sparse query) changed it; that is the DOMAIN_EXPANSIONS coverage the alias seed missed → check the mapping file's `_unmapped` list before calling it a failure, and STOP for the operator if a gate rule looks wrong.

- [ ] **Step 4: Displacement attribution run** (diagnostic — never numerically compared to Step 3):

```bash
export EVAL_LANE_ATTRIBUTION=1
export EVAL_LABEL=p2-attribution
npm run eval:cite
```

Decision rule (kickoff gate rule 3): **zero `displaced_by_variant_lane` records** across all queries' false negatives. Any `displaced_by_variant_lane` hit = the 2× original-weight bound failed to protect a golden doc → gate FAIL, diagnose with the per-lane ranks in the report. Also record per-query `alias_lane_size` and `lane_contribution` (both emitted by the attribution runner, Task 6) — spec §6's per-lane contribution.

- [ ] **Step 5: Write and commit the gate document**

Record: baseline vs flag-off vs flag-on tables for both suites (P/R/F1 + amended recall), q10 assertion result, the displacement-attribution summary (records per status), per-lane contribution, any unmatched-mapping recall effects, and explicit PASS/FAIL per rule. End with either "P3 unblocked" or the failure analysis. State: **both flags remain OFF in every deployed environment; activation (which realizes the DOMAIN_EXPANSIONS retirement) is a separate, gated ops step; physical deletion of `DOMAIN_EXPANSIONS` happens only after activation, as its own reviewed change.**

```bash
git add docs/plans/2026-08-19-query-expansion-p2-gate-results.md
git commit -m "docs(understanding): P2 gate results"
```

---

## Self-review notes (applied at write time)

- Spec coverage: §4.1 alias lookup (Tasks 2, 3), §4.3 lane list + weights + alias lane + gated retirement (Tasks 4, 5), §4.4 precision guard (constraint; no task touches the rerank query), §5 failure posture (Tasks 2-5: propagate→degraded, lane-drop, leak tests), §6 per-lane contribution + EMF (Tasks 5, 6, gate Step 4), §7 P2 row + gates + named regression mechanism (Tasks 6, 8), §8 tests (two-lane reproduction Task 4, dedupe/weight math Task 4, byte-identical no-op Task 5 + gate Step 2). Kickoff "determine from the codebase" items: all three resolved in the investigation section. tag_aliases-empty prerequisite → Task 7.
- Type consistency: `lanes_active(settings, request)`, `AliasExpander.expand -> list[str]`, `db_expander()`, `alias_expansions`, `build_understanding(..., expansion_lanes=False)`, lane dict `{name, retriever, query_str, weight, top_k}`, `degraded_lanes`, `fused_nodes`/`rerank_window_ids` debug keys, `classifyDisplacement(missedUrls, fusedNodes, rerankWindowIds)`, `callPythonServiceFull` — each defined once, consumed by exact name.
- Deliberate scope exclusions: no UI change (alias lane only reorders — Invariant 1 permits silence); no variants content (P3); no physical deletion of `DOMAIN_EXPANSIONS` (post-activation cleanup — operator decision b); no SQL pushdown (P4).
- The 2×-only-when-materialized rule (operator decision c) is enforced in the retriever (`if extra_results`), so a degraded alias lane also falls back to unscaled weights — failure degrades toward P1 behavior, tested in Task 4.
