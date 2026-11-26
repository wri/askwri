# Facet policy table and explicit negation — Design

- **Date:** 2026-11-26
- **Issue:** [wri/askwri#450](https://github.com/wri/askwri/issues/450)
- **Status:** Proposed; awaiting approval
- **Branch:** `fix/450-facet-policy` (targets `qa`)
- **Scope:** project — one policy constant, one matcher rewrite, a small eval-harness lever, and a measured negation run.

## Problem

#450 asks two questions. (1) Per facet type, should a facet filter the candidate pool or
shape it? (2) Negation has no retrieval support; `excluded_keyword` is a lowercase substring
test over title + chunk text.

The measured complaint (2026-10-09) was that promoting every detected facet to `hard`
collapsed MAP and recall, and that applying a negation filter damaged the query that named
its own subject (`q4` Brazil 6/6 → 2/6, `d1` China 9/11 → 2/11). Those numbers came from a
harness promotion nobody triggers in normal use: the LLM sidecar emits every facet as
`action="suggest"` (`understanding_llm.py:108`), and a suggestion only filters after a user
clicks it. So the failure mode is real but gated on a user action; it is not the automatic
path.

Two framings in the issue are stale and the design does not carry them:

- **Geography already shapes, never filters.** `topic` and `geography` are not `Facet`
  types. They are tag lanes (`TagRetriever`, `topic_retrieval.py:53`) driven by
  `EXPANSION_FACETS`, which QA sets to `["topic","geography"]` (`qa.tfvars:89`).
- **A policy table is only worth having if retrieval consults it.** A table that mirrors
  the existing branches would be comments with extra steps.

## What exists today (verified)

| Concern | Where | Behaviour |
|---|---|---|
| Application point | `main.py:1695-1716` | Only `action="hard"` facets filter, post-fusion / pre-rerank |
| Hard producers | parser, user chips, legacy params, a clicked suggestion | `facet_parsers._facet`, `user_facets`, `legacy_request_facets` |
| Suggest tier | `understanding_llm.py:108` | Never auto-applied; rendered as a clickable chip |
| `program` | `facet_filter.py:143`, `main.py:457` | Exact string equality in both filter paths |
| `excluded_keyword` | `facet_filter.py:152-156` | Case-insensitive substring over title + **chunk** text, chunk-level |
| Legacy filters | `main.py:1786-1800` | Stage 2.5, a separate implementation, only when understanding is off |
| Translation | `main.py:1700-1710`, `1835-1850` | Answer seeds join rerank after Stage 1.6; cite credits a translation to its canonical original |

`translation_pairs_enabled` and `answer_translation_enabled` default False and are set in no
environment tfvars, so both bypasses below are latent, not live.

## Decisions taken

1. **Per-type policy table (option B).** Every facet type declares a mode; retrieval reads
   the mode instead of branching on the type name. An undeclared type cannot silently
   filter.
2. **Negation is wanted.** Phase 1 is a correct, explicit-only exclusion filter. A ranking
   signal (demotion, negative lane) is not phase 1: it has no supporting measurement, and
   "exclude X" is an instruction to remove, not to down-rank.
3. **No sidecar determinism work here.** That is #498 item 9. No claim in this design
   depends on an auto-detected LLM facet.
4. **`program` gets normalization, not aliases.** Synonym resolution ("WRR" vs "World
   Resources Report") cannot fix series identity (`q9`, `d6`) and stays deferred.

## Design

### 1. Policy table

In `understanding.py`, beside `Facet`:

```python
FACET_MODES = {
    "year_min": "filter", "year_max": "filter",
    "date_min": "filter", "date_max": "filter",
    "language": "filter", "office": "filter", "program": "filter",
    "excluded_keyword": "negate",
}
```

- `apply_facet_filters` dispatches on `FACET_MODES[f.facet]`; a hard facet with no mode is
  ignored and logged, never applied by accident.
- Eligibility by provenance is unchanged and stays explicit: parser and user facets apply;
  `suggest` never does. The table governs **how** a type applies; `action` governs
  **whether** it applies.
- A test asserts `set(FACET_MODES) == set(get_args(Facet.model_fields["facet"].annotation))`,
  so adding a facet type without a mode fails the suite.
- `topic` / `geography` are documented in the table's docstring as `lane`, not as rows:
  they are tag lanes, not `Facet` types, and inventing rows for them would imply a code
  path that does not exist.

### 2. Negation

- **Explicit only.** The sidecar may suggest `excluded_keyword`; the user must click. No
  auto-application, at any confidence.
- **Match:** normalize with NFD + casefold + combining-mark strip; replace dashes with
  spaces; collapse whitespace; match the phrase on token boundaries. No stemming, no
  synonyms. `coal` does not match `coalition`; `zero emission` matches `zero-emission`.
- **Document identity:** `doc_id`. If any candidate chunk of a document matches, every
  candidate chunk of that document is removed. Chunk-level removal would let cite mode
  still cite the document from a surviving chunk.
- **Text searched:** the document title, the chunk texts **in the candidate pool**, and
  answer-translation seeds. When a candidate is a confirmed translation, its canonical
  original's title is scanned too, because cite assembly substitutes that title into the
  result. Chunks outside the pool are not fetched, so a term that appears only in an
  unfetched chunk will not exclude the document. This is a stated limitation, not a hidden
  one.
- **Blank values** are skipped; an empty term must never match everything.
- **Translation interaction:** when `translation_pairs_enabled` is on, the excluded set is
  keyed by canonical original, applied to `translation_seed`, and consulted at cite
  assembly so a surviving translation cannot resurrect an excluded original. Both flags
  are off everywhere today; the guard exists so flipping one cannot silently bypass a
  user's exclusion.
- **Cost:** each term compiles once per request; each document's title and each chunk text
  is normalized once. Pool sizes are request-sized, so no caching layer is needed.

### 3. One pool for exclusion and program: Stage 1.6

Negation and program matching need the **pre-rerank** pool. Stage 2.5 sees only rerank
survivors, so a document whose matching chunk was dropped during reranking can be excluded
by Stage 1.6 but kept by Stage 2.5. The two paths would disagree on the same matcher.

Therefore Stage 1.6 owns negation and program in **both** flag states:

- With understanding on, `legacy_request_facets` already routes them here (unchanged).
- With understanding off, the Stage 1.6 branch also runs when `request.excluded_keywords`
  or `request.required_program` is set, converting those two to facets (explicit user
  facets stay as they are).
- Stage 2.5 stops applying negation and program and keeps **year only**. The year-filter
  divergence between the two paths (`#444` item 3) is deliberately untouched.

This is the only production-visible behaviour change: production runs understanding off,
and legacy callers are the ones who reach the flag-off Stage 1.6 branch.

### 4. Program normalization

Rename `_normalize_office` to `_normalize_meta` (accent-, case-, whitespace-insensitive)
and compare normalized values on both sides. Aliases and synonyms are out of scope.

### 5. Response and UI

- No response-contract change: `action` stays `hard` / `suggest`.
- `facetChipLabel` gains `excluded_keyword` → `Exclude <value>`; the chip is already
  removable through `onRemoveFacet`.
- Flag-off requests still return `query_understanding: null`, so an exclusion applied
  through the legacy API has no chip. That path has no UI entry today and is unchanged;
  office/language/date remain visible through `FilterPanel`, which reads the URL.

## Measurement

The policy table is verified by unit and API tests, not by a retrieval metric. Negation gets
one attributable A/B:

- Add `EVAL_FACETS` to `evaluation/lib/gateway-body.ts`: a validated JSON array of
  `{facet, value}`, recorded in the run header and the report JSON. Per-case manifest, not a
  single phrase applied to the suite.
- Both arms run with `EVAL_EXPANSION=off`, which disables the parser and sidecar but still
  reaches Stage 1.6 for explicit facets (`main.py:1706-1716`). Both arms therefore receive
  identical deterministic input, and the delta is the matcher.
- Cases: `q11` (exclude electric buses) and `d7` (exclude school buses) as intended
  exclusions; `q4` and `d1` as bad-suggestion click regressions, reported separately.
- Metrics: AP and attainable recall as usual, plus **excluded-document leakage** and the
  list of gold documents the exclusion removed. An expected gold doc that the user asked to
  exclude is a correct removal, not a miss; the baseline names it rather than letting AP
  absorb it silently.
- Evidence for both comes from the filter itself, not from re-reading result text: the
  response's `debug` payload gains `excluded_doc_ids` when `return_intermediate_results` is
  set. The harness turns that on and intersects the ids with the returned docs (leakage)
  and the gold set (removed). Final text alone cannot show why a document disappeared or
  whether a sibling chunk matched.
- No run with the sidecar on. Any statement about auto-detected facets is recorded as
  blocked on determinism.

## Non-goals

- Metadata lanes, RRF weighting per facet type, or any other pool-shaping machinery.
- Semantic negation (subject-aware suppression, demotion, negative sparse lane).
- Program aliases / series identity.
- Sidecar determinism, #444's year-path unification, recency or office policy changes.
- Auto-applying LLM facets, at any confidence.

## Deferred, with the reason recorded

| Item | Why deferred |
|---|---|
| Semantic negation (document *about* X vs mentioning X) | Needs a model and a measured baseline; phase 1 must not pretend a phrase match is semantics |
| Pool-shaping evidence per type | The only shaping types (topic/geography) already shape; the rest are constraints. No measurement yet shows a filter loses docs a lane would recover |
| Program synonyms | No canonical program list in the repo; normalizing cannot merge "WRR" and "World Resources Report" |
| #450 closure | Phase 1 settles the mechanism questions; semantic negation and shaping evidence remain open. Recommend a scope comment, not a close |

## Risks

- A boundary match still hits standalone `Brazil`, `China`, `WRI`. Only explicit
  confirmation protects against this; a user can still make a bad click, see the chip, and
  remove it.
- Document-level exclusion is destructive on one incidental chunk hit. That is the point of
  an explicit exclusion, and the measurement reports exactly which documents vanish.
- Pool-only text misses matches outside the fetched chunks. Stated above.
- `program` normalization will not merge distinct series titles; that stays a data problem.

## Test plan

- `test_facet_filter.py`: table exhaustiveness; blank and punctuation-only terms; word
  boundary (`coal` vs `coalition`); hyphen/whitespace variants; accents; doc-level removal;
  title-only match; program normalization; unknown mode ignored.
- `test_explicit_facets_flag_off.py`: an explicit `excluded_keyword` applies with
  understanding off (the production path), and the same exclusion yields the same
  `excluded_doc_ids` with understanding on and off.
- `InterpretationLine` test: `Exclude …` label and removal.
- Eval: the two-arm run above, recorded under `evaluation/baselines/`.

## Rollout

Code lands on `qa`. Production behaviour changes only for legacy callers of
`excluded_keywords` / `required_program` via Stage 2.5; the explicit-facet UI path is
unchanged apart from label text. No flag flip, no migration.
