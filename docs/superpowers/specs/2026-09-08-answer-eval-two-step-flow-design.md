# Answer Eval for the Two-Step Flow — Design

**Date:** 2026-09-08 (rev 2 — premise-checked; see Revision notes)
**Status:** Draft for review
**Scope:** Rework the answer-mode eval harness (fixture contract, capture,
preflight, score, compare) to measure the product's two-step flow: cite mode
→ doc selection → answer mode constrained to the selected docs. The judge and
human-labels calibration are unchanged except for a one-line schema
acceptance in the mode-2 notebook (§8). Cite-mode evals are unchanged and
remain the owner of cite-quality measurement.

## Revision notes (rev 2, after adversarial premise check)

- §1 corrected: the two-step flow **predates** the harness (shipped
  2026-02-23/03-03, PR #57). The harness was built measuring a flow that no
  longer existed at design time.
- §5 now **mirrors the UI faithfully** in no-selection mode: the cite call
  sends `max_results: 40` (the client's override, not the preset's 25) and
  the synthesis input applies the UI's `validDocs` filter.
- §5 specifies the **zero-doc edge**: cite returns 0 docs → answer mode is
  unreachable in the product; recorded as a distinct outcome, never an error
  and never a silent unconstrained run.
- §5 pins where the selection block lives and extends the capture
  fingerprint to cover it.
- §3 corrected: q16 spans two clusters; its doc set is the union (decision
  for the evalset PR).
- §7 corrected: the model sees ≤ **8** passages by default (`maxPassages`
  8 for gpt-5 / 6 otherwise; 15 is only the incoming-docs cap).
- §7 adds the expected-doc-in-selection diagnostic and notes abstention
  semantics differ by mode.
- §8 reconciled: the schema bump requires the mode-2 notebook's
  `answer-eval/capture@1` check to move to `@2` — that one-line change is
  in scope.
- §10 split: passage re-derivation is **blocked on the AWS/DB divergence
  answer**; structural doc-set work is not.
- §6 reframed: the doc-scoped gate already ships; this section is mostly
  status quo plus the zero-doc outcome.

## 1. Why

Answer mode does not search the whole corpus, and has not since the two-step
flow shipped 2026-02-23/03-03 (PR #57, `AW-28`). The harness shipped
2026-09-03..04 — six months later — measures the obsolete single-shot flow:
`run-capture` issues an unconstrained `mode: 'answer'` query over the whole
corpus and hands all ~15 docs to synthesis. The prior spec even listed
`cite_doc_ids` in the gateway allowlist without noticing the UI sends it.
The first real end-to-end run (2026-09-08: 5 cases, $0.0118, capture →
judge → score, byte-identical replay) proved the machinery works — but even
the cases that ran measured retrieval no user experiences. Its preflight
also correctly refused the other 14 cases on a fixture-data defect (§6),
which stays a real repair regardless of this redesign.

Verified in code 2026-09-08:

| Fact | Where |
|---|---|
| Cite mode is the entry point; `/api/llamaindex` defaults to `mode: 'cite'` with `CITE_PRESET` | `src/app/api/llamaindex/route.ts:80,112–118` |
| The cite-mode **client** overrides `max_results: 40` (preset's 25 is overridden by the spread) | `src/lib/llamaindex-client.ts:75` |
| "Ask a research question" is always clickable — no selection required | `ResultsTable.tsx:175–180` |
| `consultedDocs` = selected rows (cap 20) or, with no selection, the top 20 of the cite results | `ResultsTable.tsx:20,242–246` |
| Answer mode re-queries `mode: 'answer'` **with `cite_doc_ids: consultedDocs`** — and the search service really filters to those docs' chunks before rerank (`main.py:1401–1405`) | `AIResearchModal.tsx:102–119` |
| The UI filters to `validDocs` (kps nonempty, snippet >10 chars) before `/api/answer`, which consumes the docs it is given and does no retrieval of its own | `AIResearchModal.tsx:138–147`, `route.ts:371–399` |
| Off-topic queries that return 0 docs render the empty state — the results table (and its Ask button) never appears; answer mode is unreachable | `page.tsx:616–640` |

Product decision (2026-09-08): both paths stay in the product — explicit
selection and the no-selection top-20 default. The eval must measure both.

## 2. What changes, in one paragraph

Selection becomes an explicit, recorded dimension of an eval run. Every case
is answered within a doc set: either the fixture's curated set
(**`fixture-set`** mode, primary — tuning runs here because the selection is
constant, so knob deltas attribute cleanly) or the top-20 of a cite query
(**`no-selection`** mode, the product's default path, mirrored faithfully
down to the client's `max_results: 40`). Scoring is unchanged in kind but
conditional on the selection. The cite stage is not scored here. The judge
and calibration are untouched except where the capture schema version
forces it.

## 3. Fixture contract (eval-review side)

- **`doc_sets`** becomes a first-class top-level array, like `twins` today:
  `{ "id", "doc_ids": [...], "note" }`.
- Each test case references a `doc_set_id`. Multiple questions share one
  set. The current clusters map **almost** one-to-one (trucks, bikeshare,
  ports, mexico-covid, mexico-financing) — **q16 is the exception**: its
  expected docs span the covid and financing clusters. Decision for the
  evalset PR: q16's doc set is the **union** of both clusters' docs (its
  question is answerable from either), recorded in the set's note.
- `expected_passages` is unchanged in shape, but each snippet must be
  contained in the chunk text the system serves for a doc in the case's set
  (enforced by preflight, §6). Twins stay: retrieving the twin counts; an
  expected passage may name the source doc or the twin. Note: both current
  twin pairs already appear in `expected_passages`, so twin-scoped checks
  are a no-op for this evalset (kept for future sets).
- **Negative cases get a doc set too** — the question is asked against a set
  that cannot answer it. Intended sets (to be named explicitly in the
  evalset PR): Schengen visa and boiling point → the trucks set (plainly
  wrong-domain); Lagos commute → the Mexico transport set (near-domain).
  Abstention remains the pass condition, now measured under a realistic
  horizon.
- **Migration of `evalset_answer_02`:** questions, key facts, canonical
  answers, twins, and negatives survive verbatim; doc sets are extracted
  from the clusters (with q16 as the union, above); expected passages are
  re-derived against served chunk text (§10: this sub-step is blocked on the
  AWS divergence answer). Expert review via the existing mode-1 notebook
  afterward.

## 4. Selection modes

| mode | selection | use |
|---|---|---|
| `fixture-set` | the case's doc set, nothing else | primary; tuning sweeps run here |
| `no-selection` | top 20 of a cite query, mirroring the UI default path | realism / regression; may fail at the cite stage — that is the point of the mode |

- Top-k of cite is a flag later, not a baseline.
- Mode is recorded in the capture (§5) and **`compare` and `runPairwise`
  both refuse cross-mode diffs** — a hand-picked-set run and a top-20 run
  are not comparable, because the second can fail for a reason the first
  cannot have. (Same guard class as gateway-vs-direct today.)
- `no-selection` costs one extra retrieval call per case (the cite query;
  see §6 for the estimate fix). The doc list it produced is stored in the
  capture for auditability; **no cite-quality metrics are computed from it**
  (decision 2026-09-08) — except the one boolean in §7.
- **Known limitation, accepted:** `fixture-set` is a lab instrument, not a
  user path — users can only select docs that survive the cite floor into
  the top-40, and cite-eval evidence suggests some expected docs may never
  reach the reranker. Isolation is the point; but any knob change validated
  only under `fixture-set` gets a `no-selection` confirmation run before it
  ships as a default (§10 step 4).

## 5. Capture

Per case (not per pass — see below):

1. **Derive the selection once per run** — `fixture-set`: the set's
   `doc_ids`; `no-selection`: cite query shaped exactly like the UI's
   (`mode: 'cite'`, `max_results: 40` as the client sends, no other
   overrides; no facets auto-detection or spelling auto-switch — noted
   divergence) → top-20 doc ids, capped at `MAXIMUM_CONSULTED_DOCS = 20`.
   The selection is derived **once** and reused across passes, so pass
   spreads measure synthesis variance only.
   - **Zero-doc edge:** if the cite query returns 0 docs, the product never
     reaches answer mode (empty state; the Ask button is unreachable). The
     harness records the outcome **`unreachable`** — never an error, never a
     silent unconstrained run. Scoring (§7): for a negative case this is a
     UI-level abstention (pass); for a positive case it is a cite-stage
     failure (recall 0, synthesis lanes excluded, counted in a new
     `unreachable` bucket in the report header).
2. **Answer retrieval** — `mode: 'answer'` with `cite_doc_ids` = the
   selection, exactly the call `AIResearchModal.tsx:102–119` makes. Gateway
   mode sends only `query`/`mode`/`cite_doc_ids` (the deployed preset
   applies — no preset fields are sent, matching the UI); direct mode needs
   a cite-mode mirror of `ANSWER_MODE_QUERY_DEFAULTS` for step 1 and **must
   not invent dense/sparse weights the gateway does not set for cite mode**.
3. **Synthesis** — `/api/answer` with the docs **after the UI's
   `validDocs` filter** (kps nonempty, snippet >10 chars — the product
   drops empty/contentless docs; the harness mirrors the filter). The nano
   relevance filter inside the route is part of what we measure (its
   deployed `USE_NANO_FILTER` value is environment-gated and unverified —
   open item §11).

Artifact: `capture-<label>.json` as today, plus a **top-level**
`selection` block (`{ mode, selected_doc_ids }` per case). Schema version
bump to `answer-eval/capture@2`. **The capture fingerprint extends to cover
the selection** (sha over cases + selection): a re-capture under the same
label with a different mode or doc set must not silently reuse stale judge
verdicts or labels. Judged-resume and label-binding mechanics are otherwise
unchanged.

## 6. Preflight (the small check)

Mostly status quo: the doc-scoped containment gate already ships
(`cite_doc_ids: [doc]`, wide pools, reranker off, `snippetContained` — the
lookup validated by hand 2026-09-08). What changes:

- Static, mode-independent, per case: every `text_snippet` must be contained
  in chunks served for the docs it names (source or twin). Catalog, twins,
  and synthesis-probe checks unchanged.
- **Not gated:** whether the expected doc appears in a cite top-20 (that is
  a measurement of `no-selection` mode, never a precondition) and the
  zero-doc edge (a recorded outcome, not a preflight failure).
- The call estimate now includes the extra cite call in `no-selection` mode
  (retrieval estimate doubles for that mode).
- The 36 current snippet failures remain failures under this gate — they
  are the fixture-data defect fixed by §3's re-derivation, not by harness
  code.

## 7. Scoring

- All existing metrics, with the universe being the selection: evidence
  coverage (expected passages vs chunks sent), fact recall strict/lenient,
  citation precision, unsupported claims, abstention, compliance. Unjudged
  and error handling unchanged.
- **New diagnostic, one boolean:** `expected_doc_in_selection` per case
  (no-selection mode) — whether any expected doc (or twin) made the
  selection. Without it, `attainable_recall = 0` is ambiguous between
  "never selected" and "selected, chunks didn't make the cut". Data is
  already captured; this is the only cite-derived datum in the report.
- **Concentration becomes selection-aware.** New per-case line
  **selection utilization**: of the docs in the selection, how many
  contributed ≥1 chunk to `passages_sent` (alongside the existing
  `top_doc_share`). Structural ceiling to keep in mind when reading it: the
  model sees ≤ `max_passages` (8 for gpt-5, 6 otherwise) passages by
  default — 15 is only the incoming-docs cap — so a 20-doc selection
  cannot exceed 8/20 utilization at default knobs. Also: cite typically
  returns fewer than 25 docs after its floor, so the selection is often
  "everything cite returned" — utilization deltas reflect ranking and the
  passage budget, not the top-20 cap.
- **Abstention semantics differ by mode** and the report says which:
  `likely_off_topic` is corpus-level and computed pre-filter, so under
  `fixture-set` (e.g. the Lagos question against the Mexico set) it can be
  false, leaving the route's `low_coverage` as the abstention signal. Both
  signals are recorded as today; only the interpretation note is new.
- **Translation-pair caveat:** answer mode drops translation-side docs when
  `translation_pairs_enabled` is on (default off, deployed value unverified).
  The trucks/bikeshare sets contain both twins; that planned sweep will
  halve those sets. Recorded here so the effect is attributed correctly.
- Headline/draft split unchanged; twin collapse unchanged; the report header
  records the mode (§4 cross-mode guards).

## 8. What is deliberately unchanged — and the one forced change

The judge (all three lanes), judged-artifact fingerprint/resume mechanics,
the labels loader and `run-score --labels` calibration path, compare and
pairwise mechanics (only the new mode guard), the http timeout/retry layer,
provenance style, and the mode-1 notebook are unchanged.

**Forced change:** the schema bump to `answer-eval/capture@2` requires the
mode-2 notebook (`review-system-output-answer.py`) to accept the new schema
version — a one-line change in that repo, in scope for this work, pinned by
the existing cross-repo checksum test. Without it, label production breaks.

## 9. Tests (sketch)

Same style as the existing harness tests — wire-level against fake servers,
no live calls anywhere:

- capture: `fixture-set` sends `cite_doc_ids` = the set; `no-selection`
  issues the cite query first (`max_results: 40`), takes top-20, then the
  answer query; the `validDocs` filter is applied before synthesis; the
  selection block is recorded; the fingerprint covers it.
- **zero-doc edge:** cite query returning 0 docs records `unreachable`
  (negative case → abstention pass; positive case → cite-stage failure),
  no answer call is made, no error is thrown.
- preflight: doc-scoped containment pass/fail; no gating on cite membership;
  the no-selection call estimate includes the cite call.
- score: selection utilization; `expected_doc_in_selection`;
  `unreachable` bucket; metrics on the selection universe; mode in the
  report header.
- compare **and pairwise**: cross-mode refusal with reason.
- replay: byte-identical.
- notebook pin: the mode-2 notebook accepts `capture@2` (cross-repo test,
  mirrors the existing fingerprint pin).

## 10. Ordering

1. Harness changes (this design) — synthetic fixtures only.
2. **Evalset restructure, split in two:**
   a. structural doc-set work (doc sets extracted, q16 union decision,
      negative set assignments) — parallel-safe, can start now;
   b. **passage re-derivation — blocked on the AWS/DB divergence answer**
      (§11): if the corpus re-ingestion diverged from the DB, re-deriving
      against current served text would bake a transient corpus state into
      the fixture.
3. Baseline runs: `fixture-set` first (tuning reference), then
   `no-selection`.
4. Sweeps (§7 of the 2026-09-03 overhaul spec) resume under `fixture-set`
   mode — **and any knob change proposed as a default gets a
   `no-selection` confirmation run before shipping** (retrieval-knob
   conclusions from 1–2-doc universes may not transfer to 20-doc
   selections).

Steps 1 and 2a can proceed in parallel; 2b blocks 3.

## 11. Open items

- **AWS session expired 2026-09-08** — the DB-vs-served-text divergence
  (variant wording, e.g. the trucks 推广/市场渗透率 passage) is unverified
  against the source of truth; it decides whether snippet repair means
  "fix the evalset text" or "the corpus re-ingestion diverged", and it
  blocks §10.2b. Needs `aws login`.
- **Judge provider for baseline runs** — the designed default
  `glm-5.2-vision` needs a lunaroute key this machine lacks; the 2026-09-08
  smoke used `gpt-5.4-mini` via OpenAI, which was **also the synthesis
  model** — a self-judging hazard for interpreting the smoke-era verdicts
  (the prior spec's judge-must-differ principle). Decide (and differ)
  before baselines.
- **Deployed env values unverified:** `USE_NANO_FILTER` (the nano filter is
  env-gated; if off on QA, "part of what we measure" is vacuous) and
  `translation_pairs_enabled`. Both are read-only checks against the QA
  task definition once AWS access is back.
- Submodule pin bump follow-up from PR #398 is still pending.

## 12. Out of scope

- Product change: requiring ≥1 selected doc to enter answer mode. The
  behavior stays as shipped; the eval tests both paths.
- Cite-mode quality measurement (stays with the cite evals).
- Top-k selection policies beyond a flag; adversarial wrong-docs selections.
- Mirroring the UI's facets auto-detection and spelling auto-switch in the
  no-selection cite call (recorded divergence; revisit if cite-recall
  realism matters).
- The sweeps themselves — this design enables them.
