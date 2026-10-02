# System One (Decision) Models — Evaluation of Fit in AskWRI

**Date:** 2026-10-01
**Status:** Research and measurement complete for the facets that have ground truth. No production change proposed or made.
**Branch / worktree:** `explore/system1-classification` at `.worktrees/system1-classification` (4 commits, local only, not pushed)
**Harness:** `evaluation/system-one/` — see its `README.md` for operational detail
**Relates to:** `docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md` (the classify stage and its 755-tag degradation note), `search-service/worker/stages/classify.py`

---

## 1. Summary

**What was asked.** Explore whether "System One" models — a new class of model that
returns typed, calibrated decisions instead of text — should be used for the
classification work this system already does.

**What was done.** Surveyed the type, catalogued every decision point in the codebase,
built a reusable evaluation harness, and measured the candidates against the models
already in production.

**The three findings that matter.**

1. **Small open decision models are competitive but not better, on accuracy.** On the
   one facet with real ground truth, `kev-4b` (a 4B open model) scores 77.8% against the
   production model's 78.1%. That is a tie, and the gap is smaller than the production
   model's own run-to-run variation. The newest OpenAI flagship, `gpt-6.1-sol`, leads at
   80.2%, which is about three documents out of 167.

2. **What is genuinely different is the confidence.** `kev-4b`'s probabilities track its
   own accuracy, so a threshold on them actually works: at a 0.7 cutoff you can
   auto-accept 28% of documents at 89% correct. The LLM's confidence saturates at 0.97
   and is right 79% of the time there, so no threshold isolates a trustworthy subset. At
   a 10% error budget, `kev-4b` automates ~28% and the incumbent automates **zero.**
   This finding survived every later test, including against `gpt-6.1-sol`.

3. **The blocker is ground truth, not models.** The facet this was really about —
   `topic` — has no usable labels. Its `external` tags are a single portfolio stamp
   applied across an import batch, not a label set. So `topic` can only be measured for
   *agreement*, never for accuracy.

**Recommendation.** No model swap on accuracy grounds. The threshold result is worth
pursuing, but it cannot be acted on until `topic` has labels, because the 0.7 accept
threshold in production does not transfer between models and must be re-derived per model
against labels.

---

## 2. What the model class is

A System One model (TypeSafe's name; "decision model" is the clearer term) takes a piece
of **state** — text, JSON, or an image — plus a set of **typed questions**, and returns
**numbers only**. It does not generate text.

| Primitive | Asks | Returns |
|---|---|---|
| `noul` | yes/no | probability of yes (0.5 means genuinely unsure, not "medium") |
| `choice` | pick one of your options | winning key, full distribution, confidence |
| `score` | where on your ordered rubric | expected position, distribution, confidence |

Questions in one request are evaluated against the same state **in parallel**, and one
question cannot read another's answer. The claimed advantages are structural: the response
cannot be a type error, so the JSON-parse-and-repair machinery LLM integrations accumulate
disappears; and nothing is generated token by token, so it is fast.

TypeSafe's own framing is that this gives up string generation in exchange for parallel
sampling and a training objective (theirs is "RLCD", reinforcement learning for calibrated
decisions) that optimises probabilities rather than human-preferred text.

**The `noul` vs `choice` distinction matters operationally and is easy to miss.** `choice`
is single-select by construction. Anything that assigns *several overlapping* labels needs
one `noul` per candidate, which is also what TypeSafe's guidance recommends. This repo's
`classify` stage assigns up to five topic tags per document, so it is a `noul` workload,
not a `choice` one — though the measured results below were mostly run in `choice` form
before that was understood (see §9, Corrections).

---

## 3. The candidates and what is reachable

| Model | Origin | Weights | Reachable from here | Cost |
|---|---|---|---|---|
| **Jev** | TypeSafe AI, launched 2026-09-15 | closed, hosted only | **Yes** — hosted, key verified | $0.042 / MTok in, output free |
| **djev** | Maisa, on Google DiffusionGemma | Apache-2.0 local stack exists | **Yes** — lunaroute gateway | free via gateway |
| **kev-4b** | Jared Palmer, LoRA + pointer head on Qwen3.5-4B | Apache-2.0 | **Yes** — lunaroute gateway | free via gateway |
| **Kev 0.8B / 9B / 27B** | same project | Apache-2.0 | Not served; self-host available | self-host |
| **Decisions API** | OpenAI, DevDay 2026-09-29, on a specialised GPT-6 Luna | closed | **No** — `403 Decision API is not enabled for this user` | unknown |
| **Strands Decider 2B** | AWS Strands Labs, released 2026-10-01 | Apache-2.0, on Qwen3.5-2B | **Yes, self-host** (see below) | self-host |

Notes on each:

- **Jev** is the original and consistently tops independent benchmarks on calibration. It is
  closed and hosted, but reachable: a `TYPESAFE_API_KEY` is configured and `GET /v1/models`
  returns `jev-latest` and `jev-preview`. Measured limits (2026-10-01): **255 `noul`
  questions per request accepted**, `choice` hard-capped at 255 options, and every call in
  the 20-255 range returned in **0.1-0.2s**. There is no 32-question cap here, unlike djev.
  That makes the entire 757-tag `topic` vocabulary reachable as calibrated per-tag
  probabilities in 3 requests per document, for roughly $0.12 of input across the corpus.
- **djev** is the only candidate of this set with native image input. It is measurably the
  weakest of the reachable models on both accuracy and calibration (see §8).
- **kev** is the interesting one: Apache-2.0, four sizes, trains on your own labelled
  examples (~$1 on an H100 for a 4B run), and it serves **the same `/v1/systemone` contract**
  so TypeSafe's SDK works against it unchanged. Kev-27B is within a point of Jev on unseen
  questions, but the gateway only exposes `kev-4b`.
- **Strands Decider 2B** was verified to speak the identical `/v1/systemone` contract, so it
  plugged into the harness with **zero code changes** — only `SYSTEMONE_BASE_URL`. It was not
  benchmarked: local serving crashed under concurrent requests with an Apple Metal assertion
  (`failed assertion _status < MTLCommandBufferStatusCommitted` in `IOGPUMetalCommandBuffer`),
  and `causal_conv1d` is not installed so it falls back to a slow reference kernel. Fixable by
  running serially, judged not worth the time for a 2B model whose larger sibling only tied
  the incumbent.

`gpt-6.1-luna` **does not exist** (`404`). The 6.1 line has Sol only. Any future reference to
"6.1 Luna" is an error.

---

## 4. Where this class fits in this codebase

Decision points found by reading the code, not guessed at. Ranked by fit.

| # | Call site | What it decides today | Decision shape | Notes |
|---|---|---|---|---|
| 1 | `src/app/api/answer/route.ts` | per-passage `strong`/`partial`/`weak` over 20-30 passages, plus corpus coverage `good`/`limited`/`poor` | pure multi-label `choice`/`noul`, per user request | currently `gpt-5.4-nano` behind a dark flag. Highest-volume decision call in the system. Already shuffles passages to fight position bias. |
| 2 | `search-service/app/understanding_llm.py` | intent (exactly 4 labels) + facets (`year_min`, `year_max`, `language`, `program`, `excluded_keyword`) | `choice` + `score` | `gpt-5.4-mini`, ~0.8-1.0s, dark flag. Mixed call: also returns `variants` and `core_topic`, which are generation and cannot move. |
| 3 | `search-service/worker/stages/classify.py` | 0-5 topic tags and 0-10 geographies per document, with per-tag confidence | `noul` per candidate | **The closest structural match in the repo.** Already emits confidence and already thresholds at `tag_confidence_accept = 0.7`. Currently `gpt-5.6-luna`, a reasoning model doing a labelling job. |
| 4 | `src/app/api/batch-relates/route.ts` | `direct`/`indirect` per document, plus an explanation sentence | `choice` | Half the call is a perfect binary decision; the sentence is generation. |

**Bad fits, and why:** `query_translate.py` (translation is generation; already disabled
because `gpt-5-mini` took >3s), `summarize.py` (generation), `parse.py` metadata extraction
(returns strings, not decisions), `batch-why` (prose explanations).

`evaluation/answer/judge-client.ts` has the perfect *shape* (`stated`/`partial`/`absent`,
`supported`/`unsupported`) but the wrong *job*: grading answers needs frontier reasoning and
it runs offline, so there is no speed win. Its actual role here is as the measuring
instrument — and it cannot be used to grade a model, since that would be circular.

**Two structural observations from the survey.**

- **Several call sites mix a decision and prose in one request.** `understanding_llm.py`
  returns facets *and* query rephrasings; `alignment/route.ts` returns a 4-level score *and*
  3-4 synthesis bullets; `batch-relates` returns a label *and* a sentence. Each would have to
  be split before any of the decision half could move.
- **The JSON-repair machinery disappears.** `alignment/route.ts` carries a three-variant
  fallback chain (`json_schema` → `tools` → `json_object`) purely because models sometimes
  emit invalid structured output. `classify.py` has a validator that raises on malformed
  responses plus a retry path for truncation. `judge-client.ts` has a validation-repair turn
  that sends the model its own bad JSON back. None of that is needed when the type is
  enforced by construction. That is a maintenance win that does not appear in any accuracy
  number.

---

## 5. The harness

`evaluation/system-one/` — three scripts plus artifacts. Deliberately not a framework.

| File | Role |
|---|---|
| `dataset.ts` | shared document loading: basis, candidate sets, gold. Used by both runners. |
| `systems.ts` | the model registry. Every competitor implements `pick` (single label) or `apply` (per-tag probabilities). |
| `run.ts` | single-label head-to-head against gold, with `--reps` for run-to-run variance |
| `consensus.ts` | multi-model agreement and silver labelling; `--mode noul` for the production shape |
| `README.md` | how to run, how to add a variant, ground-truth traps, measured API limits, results |

**Design properties that earned their keep:**

- **Contract-based, so a self-hosted model is a URL.** `systemOne(model, baseUrl)` speaks
  `/v1/systemone`, which covers hosted Jev, the lunaroute gateway, a self-hosted Kev of any
  size, and Strands Decider. Adding a variant is one function; pointing at a new server is one
  environment variable. Verified, not assumed.
- **The incumbent path reproduces production.** `llm()` reimplements
  `worker/llm.py`'s `chat_json` including its single retry with a doubled token budget, so the
  baseline is the real behaviour rather than an idealised one. Retry exhaustion is recorded as
  a failure, not patched over, because that failure rate is itself a result.
- **Identical inputs for every system.** Same state, same question, same candidate set.
  Differences are the model's alone.
- **`--reps` prints per-pass accuracy separately from the pooled mean.** A gap between systems
  that sits inside one system's own variation is not a difference, and this is what made that
  distinguishable.
- **A guard against fake gold.** The runner refuses a facet with fewer than three distinct gold
  values, rather than reporting chance-level accuracy that a reader would take as a broken
  model. This exists because that mistake was made (see §6).
- **`--instruction` for question variants**, so instruction wording can be tested on identical
  documents.

---

## 6. Ground truth: there isn't any

The harness scores against `document_tags` where `source = 'external'`. **These are not
verified labels.** They were force-applied across the founding corpus — then a single
decarbonization-related collection — and carried over unchanged into today's
206-document corpus. Nothing verified them and no intelligence produced them. They are
legacy.

| Facet | Distinct `external` values | Rows | What it actually is |
|---|---|---|---|
| `office` | 9 (WRI Global 46.7%, India, China, México, US, Brasil, Colombia, Africa, Indonesia) | 167 | legacy assignment — varied, but unverified |
| `doc_type` | 7 (Working Paper 54.2%, Report, Technical Note, …) | 166 | legacy assignment — varied, but unverified |
| `topic` | **1** — "Transport decarbonization" | 146 | degenerate batch stamp |
| `program` | **1** — "Cities" | 167 | degenerate batch stamp |

`topic` and `program` are visibly degenerate: one value each, smeared across a whole
batch. 146 unrelated documents (electric school buses, air-quality tooling, road safety,
informal workers) all carry "Transport decarbonization".

**`office` and `doc_type` are therefore the best available reference, not ground truth.**
Every figure in §8 should be read as *agreement with a legacy assignment*, not as
correctness. Relative comparisons between models stay valid, because every model faces
the same labels. Absolute levels do not mean what the word "accuracy" implies, and the
residual error may be the legacy label being wrong rather than the model.

Corroboration that the legacy column is only partly meaningful: on `office` every
generator beats its majority-class baseline substantially (82% against 46.7%), so the
column tracks reality for most documents. On `doc_type` every system falls *below* its
majority baseline (40% at best against 54%) — which is what a legacy column that no
longer tracks anything derivable looks like.

`source='human'` exists in the schema and the admin UI writes it, but there are **15
human rows total across 11 documents, and none of them are `topic`.**

**Four traps that produced wrong conclusions during this work, recorded so they are not
repeated.**

0. **A column called `external` is not ground truth.** This document asserted "WRI's own
   metadata" until the provenance was corrected: the values are a legacy force-applied
   stamp with nothing verifying them. Anything scored against them measures *agreement*,
   not correctness. Check provenance before calling labels authoritative — the column name
   does not tell you.

1. **A single-valued gold set reads as a model failure.** The first `topic` run scored every
   model at 6-9% and looked like a damning result. It was meaningless: the question asked four
   models to guess a constant, and every model's answer was *more* correct than the gold. This
   is why the harness now refuses facets with fewer than three distinct gold values.
2. **"One tag per document" does not mean "one distinct tag per corpus."** The row count (146
   docs, 1 tag each) was read as 146 primary topics. Checking the *distinct values* rather than
   the row count is what exposed it.
3. **A good gold set for one facet is not a good gold set for another.** `office` is genuinely
   single-valued and works. `doc_type` is also single-valued, but the value is a catalogue
   attribute that the input text never states, so it cannot be predicted from the basis at all.

---

## 7. Measured API limits

Measured against the live gateway, with the error that established each. These decide what
shapes are possible.

| Limit | Value | Evidence |
|---|---|---|
| `choice` options | **255** | kev-4b and djev both `400` at 300 / 500 / 757: `choice question "pick" has 757 options; the limit is 255` |
| `questions` per request, `djev` | **32** | `400` at 40/60: `"questions" exceeds this model's max_questions of 32`. Exactly 32 also fails with a generic invalid-request error; 20 works |
| `questions` per request, `kev-4b` | **> 60** | 60 `noul` questions accepted, 0.5s |
| Latency, 255-option `choice` | 0.8-1.0s | so candidate sets can grow far beyond the current `tag_candidate_top_n = 20` |
| Latency, 20 `noul` questions | 0.4-0.6s | |

Consequence: `topic` has **757** tags and `geography` **201**, so neither fits in a single
`choice`. System One can only do `topic` via retrieve-then-classify over a subset, or via
`noul`-per-candidate. The 255 ceiling is 12x the candidate set production uses today, so
raising `tag_candidate_top_n` is essentially free latency-wise — relevant because candidate
recall is a real ceiling on `topic` (though it could not be measured, having no labels).

---

## 8. Results

### 8.1 `office` — the only facet with varied reference labels

167 documents, 9 classes, majority-class baseline **46.7%**, candidate recall 100%. Five
passes for the first three systems, three for the last two.

| System | top1 | per-pass | Brier | meanConf | ms |
|---|---|---|---|---|---|
| `gpt-6.1-sol` | **80.2%** | 80.2 / 80.8 / 79.6 | **0.184** | 0.962 | 2189 |
| `gpt-5.6-luna` (production) | 78.6% | 78.4 / 78.4 / 79.0 | 0.199 | 0.971 | 1221 |
| `systemone:kev-4b` | 77.8% | 77.8 × 3 | 0.206 | 0.576 | **256** |
| `gpt-6-luna` | 75.2% | 75.4 / 76.0 / 74.3 | 0.221 | 0.920 | 1862 |
| `systemone:djev` | 65.3% | 65.3 × 3 | 0.279 | 0.920 | 286 |

Five-pass pooled view of the original three: `gpt-5.6-luna` 78.1% (76.6 / 78.4 / 79.0 / 78.4
/ 77.8), `kev-4b` 77.8% (identical on all five), `djev` 65.3% (identical on all five).

**Accuracy is a tie** between kev-4b and the production model. The 0.3-point gap is inside the
incumbent's own 2.4-point spread.

**The System One models are deterministic** — kev-4b returned bit-identical accuracy on every
pass — so all variance in the harness comes from the reasoning LLMs.

**`gpt-6-luna` is a downgrade**: its pass range (74.3-76.0) does not overlap `gpt-5.6-luna`'s
(78.4-79.0). The newer Luna is worse than the one production runs.

**`gpt-6.1-sol` leads**, and its range (79.6-80.8) does not overlap `gpt-5.6-luna`'s, so the
difference is real — but it is ~3 documents out of 167, at 6x the latency.

**The confidence is where the difference is.** Accuracy on the subset you would auto-accept, by
threshold:

| Threshold | `gpt-5.6-luna` | `kev-4b` | `djev` |
|---|---|---|---|
| ≥ 0.50 | 100% coverage / 78% acc | 69% / 84% | 98% / 66% |
| ≥ 0.60 | 99% / 78% | 47% / 87% | 96% / 66% |
| ≥ 0.70 | 98% / 79% | 28% / 89% | 93% / 68% |
| ≥ 0.80 | 96% / 79% | 8% / 100% | 86% / 71% |

The incumbent's threshold is decorative: crank it to 0.8 and you still accept 96% of its
answers at 79% correct, because 773 of 835 answers sit in one bin at 0.985 mean confidence.
There is no confident subset to route. `kev-4b` spreads across bins with accuracy rising
monotonically (0.36→64.7%, 0.56→76.3%, 0.66→83.9%, 0.75→85.3%, 0.84→100%), so its confident
answers can be automated.

Note that `kev-4b`'s confidences are on a **different scale** (mean 0.576 vs 0.92-0.97 for the
LLMs) while carrying comparable information (Brier 0.206 vs 0.199). This is the single most
operationally important caveat in this document.

`djev` is worse on both axes, and its confidence is non-monotone in the middle bins
(0.65→16.7%, 0.74→27.8%), so it carries no usable ordering at all.

### 8.2 `doc_type` — not a valid target

166 documents, majority-class baseline 54.2%.

| System | top1 | Brier |
|---|---|---|
| `gpt-6.1-sol` | 40.0% | 0.365 |
| `systemone:kev-4b` | 24.1% | **0.179** |
| `gpt-6-luna` | 21.3% | 0.489 |
| `gpt-5.6-luna` | 18.3% | 0.607 |
| `systemone:djev` | 17.1% | 0.393 |

**Every system scores below the trivial majority baseline.** The publication series is a
catalogue attribute that the summary text does not state; picks scatter across `Report` and
`Issue Brief` and essentially none say `Working Paper`, which is the gold for 54% of documents.
This is a bad input, not a bad model. It becomes measurable once the basis includes cover or
front-matter text.

`gpt-6.1-sol` reaching 40% where nothing else clears 24% is notable — it infers the series from
something the others miss — but the absolute levels mean nothing yet. Read the ordering only.

### 8.3 `topic` — agreement only, no accuracy possible

No ground truth exists (§6), so only agreement among four independent model families could be
measured. Generators: `opus-5.5` and `sonnet-5.5` (Bedrock), `glm-5.3` (Zhipu),
`deepseek-4.1-flash`. None of them is a system under test.

**Single-label form (`choice`, top-20 candidates, 15 docs).** 53% unanimous (8/15), 80% with
at least 3 of 4 agreeing. Same-family agreement (`opus` × `sonnet`) **93%** versus cross-family
**68%** — a measured 25-point rubber-stamping effect, which is why Anthropic's two models are
counted as one vote.

**Multi-label form (`noul` per candidate, the production shape, 15 docs, zero failures).**

| Generator | set size at 0.7 | yes-rate at 0.7 |
|---|---|---|
| `opus-5.5` | 5.3 | 26.3% |
| `sonnet-5.5` | 3.9 | 19.7% |
| `glm-5.3` | 5.9 | 29.3% |
| `deepseek-4.1-flash` | **8.3** | **41.7%** |

Mean pairwise Jaccard 0.617 at 0.7; 0.728 on top-5. Pairwise *binary* agreement is 78-93%, which
**is misleading**: only ~27% of the yes/no cells are yes, so agreeing on "no" dominates the
average. Of the 126 tags that any generator accepted, only **55** were accepted by all four —
**core over union 0.44**.

**The disagreement is breadth, not content.** For the NDC document the sets are nested
supersets of one another (`{Climate Governance, Climate Policy}` ⊂ glm's ⊂ deepseek's), not
rival answers. The same holds for the China truck document. The models broadly agree on *which*
tags apply and differ in *how many* to include.

**Operational consequence:** the 0.7 threshold does not transfer between models. Sonnet accepts
3.9 tags at 0.7 and deepseek 8.3. Production's `tag_confidence_accept = 0.7` was derived for a
model whose confidences run at 0.97 mean; `kev-4b`'s run at 0.58. Carrying 0.7 across would
silently change how many tags are accepted while the column name looks identical. The codebase
already states the right principle ("thresholds are DERIVED from a labeled set, never
hand-picked"); these measurements are what make it non-negotiable.

### 8.4 Validation of the silver-label method (`office`) — negative result

The plan was to validate consensus silver labels on `office`, where varied reference labels
exist, *before* trusting them on `topic`. This is that validation: four generators, the
single-label question, 167 documents.

| Generator | accuracy |
|---|---|
| `opus-5.5` | 82.0% (137/167) |
| **unanimous consensus (all four agree)** | **80.7% (109/135)** |
| `sonnet-5.5` | 79.0% (132/167) |
| `glm-5.3` | 73.7% (123/167, 5 failed) |
| `deepseek-4.1-flash` | 71.3% (119/167) |

**Consensus buys nothing over the best single model.** 80.7% is *worse* than `opus`
alone at 82.0%, and only modestly better than `sonnet`. Four models spanning three
independent families agreeing does not make the answer better.

Note what the denominator is: every figure here is agreement with the **legacy
column**, not correctness (§6). So the measurement is "consensus reproduces the
legacy assignment no better than the best single generator does" — which is the
comparison that matters, since all four models face the same labels.

The cause is correlated error: the generators converge on the same answer 19% of the
time where that answer disagrees with the reference, because they read the same
ambiguous summary and fail the same way. On `office` that is the "WRI Global" default
(46.7% of the corpus); on `topic` the analogous trap is the hypernym/hyponym pairs
(`Pollution` / `Air Pollution`). Agreement is not evidence of correctness when the
error is systematic and shared.

**Consequence for the silver-label plan: it does not hold up.** A set that agrees with
the reference 80.7% of the time disagrees 19% of the time — and that is measured
against a legacy column, so its true error against reality could be worse. The model
differences this workstream is trying to measure are 1-3 points. Label noise is
roughly an order of magnitude larger than the signal, so any model comparison scored
against those labels would be measuring the labels. Silver labels are usable as a
*prior* — a starting point for human review — but not as the reference against which
models are validated.

Recording this because it is the third time on this workstream that an unvalidated
label source produced a conclusion that did not survive checking. Validating before
scaling is what caught it, at the cost of one 167-document run.

---

## 9. Findings about the taxonomy, independent of any model

These came out of the same database and hold regardless of which model class is used.

- **757 topic tags, all embedded**; geography 201, office 9, doc_type 8, program 1.
- **0 of 757 tags have a parent.** The `parent_tag_id` column exists (added by the issue-323
  migration) but is unused, so the taxonomy is flat while containing both hypernyms and
  hyponyms (`Pollution` *and* `Air Pollution`, `Congestion` *and* `Urban Mobility`). Asking for
  "the single primary topic" is therefore under-specified.
- **Near-duplication is *not* the problem.** Of 286,146 tag pairs, only **9** exceed 0.85 cosine
  similarity, and 1 exceeds 0.95. They are acronym, case and spelling variants:
  `PCS` / `PCs` (**cosine 1.000, case-only**), `Net Zero Emissions` / `Net Zero` (0.904),
  `Public Transportation` / `Public Transit` (0.895), `Carbon Dioxide` / `CO2` (0.877),
  `GHG Accounting` / `Greenhouse Gas Accounting` (0.861), `Gender Equity` / `Gender Equality`
  (0.850).
- **`Comuting` is a misspelled tag and `Commuting` does not exist.**
- `embedded_text` for these tags is the bare label — no description or alias boilerplate
  diluting the vectors.

**Corrections to earlier conclusions in this workstream.** Two hypotheses were raised and then
killed by measurement, and are recorded here rather than quietly dropped:

1. *"The topic taxonomy is full of near-duplicate tags, which caps achievable accuracy."*
   **Wrong** — 9 pairs out of 286,146 (§ above).
2. *"Flatness drives the model disagreements on topic."* **Partly an artifact.** The
   hypernym/hyponym splits were largely manufactured by asking a single-select question of a
   multi-label task; in `noul` form the answers are nested rather than conflicting. The
   underlying ambiguity is real but its apparent severity was inflated by the question shape.

The "free human labels in `document_tags`" claim also had to be retracted: there are 15 human
rows in total and none of them are `topic`.

---

## 10. Conclusions

1. **No model swap is justified on accuracy.** On the only facet with ground truth, a 4B open
   decision model ties the production model and the newest flagship beats it by ~3 documents.
2. **The confidence result is the real one, and it is about trust rather than speed or cost.**
   `kev-4b`'s probabilities support a working threshold; the incumbent's do not. At a 10% error
   budget that is ~28% automated versus 0%.
3. **`gpt-6-luna` is not an upgrade** and should not be assumed to be. Newer is not better here.
4. **`djev` is dominated** on every axis measured and should not be pursued.
5. **`topic` cannot be evaluated at all** until it has labels. Everything measured about it is
   agreement, which bounds nothing without knowing what correct looks like.
6. **Consensus silver labels are not ground truth.** Validated on `office`: unanimous
   agreement reaches 80.7% where the best single generator reaches 82.0%, because errors
   are correlated across models. A 19% label error rate cannot referee 1-3 point model
   differences. Topic labels must be human (§8.4).
7. **The 0.7 threshold must be re-derived per model** before any swap, because the scales are
   not comparable.
8. **The harness is reusable and the contract-based design works** — a self-hosted model needs a
   URL, not code.

---

## 11. Open questions and next steps

**Blocking.**

- **Build a `topic` gold set — by hand.** The silver-label shortcut was tested and does
  not hold up (§8.4): consensus labels are ~81% correct, and that error rate is an order
  of magnitude larger than the model differences being measured. Tagging ~40 documents in
  the admin UI, which already writes `source='human'` rows at the right granularity, is the
  only path that produces a usable reference.
- **Re-derive `tag_confidence_accept` per model** against whatever labels exist, before any
  swap.

**Unblocked and cheap.**

- **Scale the topic agreement run** from 15 to 60-100 documents to confirm the breadth finding
  and collect a larger sample of taxonomy collisions. Agreement figures remain useful
  (`consensus.ts --mode noul`); it is only their use as *labels* that failed.
- **Put `kev-4b` and `djev` into the `noul` comparison** — `systemOneNoul()` is built and
  untested. The question is whether their per-tag probabilities threshold more stably than the
  frontier generators' do.
- **Raise `tag_candidate_top_n` from 20.** A 255-option `choice` costs 0.8-1.0s, so candidate
  recall is cheap to improve, and recall is a hard ceiling on any classifier.
- **Fix the two taxonomy defects** (`Comuting`, `PCS`/`PCs`) and consider whether the flat
  taxonomy should carry parents.

---

## 12. Reproducing

Requires `OPENAI_API_KEY`, `SYSTEMONE_API_KEY` (or `LUNAROUTE_API_KEY`), a live AWS session for
the Bedrock generators, and QA RDS access via `with-remote-env.sh`.

```bash
export SYSTEMONE_API_KEY=...
export LUNAROUTE_API_KEY=...
export DATABASE_SSL_REJECT_UNAUTHORIZED=false   # match libpq `require` against RDS

# head-to-head against gold, with variance
./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/run.ts --facet office --reps 5

# generator agreement / silver labels
./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/consensus.ts --facet topic --limit 15

# production shape: per-tag probabilities
./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/consensus.ts --facet topic --mode noul --limit 15

# any self-hosted model speaking /v1/systemone
SYSTEMONE_BASE_URL=http://127.0.0.1:8010/v1 ./scripts/with-remote-env.sh qa \
  npx tsx evaluation/system-one/run.ts --facet office --systems systemone:my-model
```

Committed artifacts in `evaluation/system-one/`: `results-2026-10-01-office-5reps.json`,
`results-2026-10-01-doc_type.json`, `results-gpt6-2026-10-01-{office,doc_type}.json`,
`topic-noul-15docs-2026-10-01.json`.

---

## Sources

TypeSafe AI launch and API (`typesafe.ai`, `docs.typesafe.ai`); TechCrunch on Jev and on
OpenAI's Decisions API and AWS Strands Decider 2B; InfoQ; `archerhume.com` "Jev's Architecture
Unmasked" (the reverse-engineering that Kev and other clones are built on); `github.com/jaredpalmer/kev`
and its Hugging Face model cards; `djev.dev` `llms.txt`; AWS Strands blog and
`pypi.org/project/strands-decider`; JevBench and Benchmark Heaven independent rankings;
OpenAI API model list and endpoint probing as recorded in §3 and §7.
