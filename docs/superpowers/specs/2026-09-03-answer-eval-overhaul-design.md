# Answer Eval Overhaul — Design

**Date:** 2026-09-03
**Status:** Draft for review
**Branch:** `worktree-answer-evals-rework`
**Scope:** Replace the answer-mode evaluation end to end (ground truth, harness,
judge) and fix the product defects that make answer quality unmeasurable today.
Cite-mode evaluation (`run-evalset.ts` on the cite sets) is out of scope and
unchanged.

## 1. Why

Answer-mode evaluation has never produced numbers the team trusted. The
2026-09-02 CI run against QA shows the symptom: `evalset_answer_02` scores doc
MAP 77% and recall 84%, but chunk MAP 2% and chunk recall 9.9% (8 of 47).
Traced causes, all verified on 2026-09-03:

| Problem | Where | Effect |
|---|---|---|
| Passages labeled only on the zh/es source doc; English queries retrieve the English twin | fixture + `translation_pairs_enabled=False` (`search-service/app/config.py:72`) | q4–q7: 14–15 of 15 chunks from the twin, 0 from the source; chunk recall 0 while the system is right |
| No per-doc cap in answer mode | `answer_rerank_per_doc_cap=None` (`config.py:245`) | 10 of 10 chunk-scored cases returned 15/15 chunks from one document |
| 15-chunk list vs. up to 12 expected passages | `ANSWER_PRESET.maxResults` (`src/config/retrieval.ts`) | recall capped by construction |
| Inline citations are assigned by position, not by the model | `AIResearchModal.tsx:212–248`; `AnswerPanel.tsx:203`; `SupportingCitations.tsx:80` | citation marker *k* always resolves to the *k*-th highest-scored passage; the model emits no per-sentence attribution (`src/app/api/answer/route.ts:69–78`) |
| "Based on N Knowledge Products" counts retrieved docs | `AnswerPanel.tsx:44`, fed by `setSupportingDocs(docs)` at `AIResearchModal.tsx:130` | N is unrelated to what the model used |
| Model sees 8 (gpt-5) or 6 passages, cut to 400/350 chars, title + year only | `route.ts:321–322, 375, 405, 425` | synthesis quality partly measures truncation; tiers exist only for ids the model returned |
| `likely_off_topic` (abstain gate, #379) is returned and ignored | `src/app/api/llamaindex/route.ts:229`; no consumer in `AnswerMode/` | off-topic questions still get a synthesized answer |
| Gateway forwards any body field to `/query` | `llamaindex/route.ts:58` (`...options` after defaults) | good for sweeps, but any stray field overrides the preset |
| `run-evalset.ts` hangs on Node fetch against a local Next server | undocumented; `eval-minimal.ts` header, added 2026-08-25 | two harnesses; all P3 sweeps ran on the minimal one |
| Gen-1 answer golden set is circular (labels from the system's own retrieval + GPT judge) | `evaluation/answer-golden-dataset.json` + six scripts | dead weight; last real run July |
| No harness scores synthesis at all | `eval:qa` is retrieval-only | `canonical_answer`/`key_facts` unused |
| OpenAI endpoint hardcoded | `route.ts:248, 466`; `run-answer-synthesis-llm-eval.ts:125` | cannot A/B another provider |

Decisions taken in the 2026-09-03 brainstorm:

- Primary job of the eval: **tuning instrument** for retrieval + synthesis.
  Regression gating in CI is not a goal now.
- Runs are **heavy, on demand**: strong judge, N passes per case, replayable.
  Nothing new runs in CI.
- Ground truth comes from the colleague's **doc-review process** in
  `gofenris/askwri-eval-review` (submodule `evaluation/eval-review`), scaled
  up, not replaced.
- **Product contract changes are in scope**; the eval measures what users see.
- Model changes on the table: **synthesis model** (OpenAI gpt-5.4 → gpt-5.6 or
  GLM) and **judge family** (must differ from synthesis). Retrieval models
  unchanged.
- Judge and synthesis candidates run through **lunaroute** (OpenAI-compatible,
  `LUNAROUTE_BASE_URL` / `LUNAROUTE_API_KEY`, model `glm-5.2-vision`).
  Known quirks: flaky structured JSON, ~7× slower than GPT, very low
  concurrent-request cap (429s at parallelism > ~2).

## 2. Ground truth and scoring model

### 2.1 Fixture

`evalsets/evalset_answer_NN.json` in the eval-review submodule, unchanged in
shape. Each case: `id`, `question`, `query_type`, `difficulty`,
`retrieval_ground_truth.{expected_external_ids, expected_passages[]}`,
`synthesis_ground_truth.{canonical_answer, key_facts[]}`, `note`. Each passage:
`doc_id`, `chunk_id`, `page`, `text_snippet` (verbatim chunk text),
`text_snippet_translation_en`, `supports_key_fact` (verbatim copy of the fact,
`" | "`-joined when one chunk backs several).

**The passage-to-fact pair is the evidence unit.** This is what the colleague's
review notebook labels, so the schema is not inverted.

Additions, all optional so existing cases keep working:

- `twins: [[external_id, external_id], ...]` at evalset top level: language
  versions of one publication. Doc-grain scoring treats a pair as one document.
- Twin passages: for a fact whose source is zh/es, the maintainer resolves the
  same fact in the twin document with the lookup script and adds it as another
  `expected_passages` entry with the same `supports_key_fact`. Nothing in the
  notebook changes.
- `review_status` per case: `draft` | `expert_approved` | `rejected`. Written
  by the ingest script (§2.4). Absent means `draft`.
- Negative cases: `expected_external_ids: []` and `key_facts: []`, scored as
  abstentions (§2.3).

### 2.2 Retrieval scoring (computed, no LLM)

Per positive case, over the ranked chunk list the system returned:

- **Evidence coverage** (primary): fraction of key facts for which at least one
  retrieved chunk contains a supporting passage's `text_snippet` after
  normalization (full/half-width punctuation folding, whitespace-around-
  punctuation folding — the same `normalize()` as
  `eval-review/scripts/lookup_chunk_id.py`). Match is by text containment, not
  `chunk_id`, so re-ingestion and chunk-boundary drift do not zero it. A twin
  passage counts.
- **Doc MAP** and **attainable recall**: as in `run-evalset.ts` today, with a
  twin pair collapsed to one document before scoring and corpus gaps excluded
  from the denominator.
- **Concentration**: distinct documents in the returned list; share of the list
  from the top document.
- **Chunk-id hit rate**: diagnostic only. Evidence coverage flat with chunk-id
  hits falling means re-ingestion, not regression.

### 2.3 Synthesis scoring (judged, §4)

Per case:

- **Fact recall**: per key fact, `stated` | `partial` | `absent` in the answer
  text. Reported as strict recall (stated only) and lenient recall (stated +
  partial). Both are kept so the value of `partial` can be assessed on real
  data; if the two track each other over the first runs, `partial` is dropped.
- **Sentence support**: per sentence, `supported` | `unsupported` by the
  passages that sentence cites. Reported as citation precision.
- **Unsupported claims**: sentences with no support in the full retrieved set.
  Reported as a count and a rate; not a hard failure. A run-level threshold can
  be added later if the count proves stable.
- **Contract compliance** (computed): every cited id exists in `passages_sent`;
  all sentences English; sentence count within bounds; JSON parsed without
  repair.
- **Abstention** (negative cases): the system either returned `low_coverage` /
  honored `likely_off_topic`, or it did not. Reported apart from the means.

Every judged item stores the judge's rationale and, for support verdicts, the
quoted supporting span.

### 2.4 Human review loop

The colleague's notebook `notebooks/review-evalset-answer.py` emits
`annot-<evalset>-<query>-by-<reviewer>.json` with per-passage yes/no/skip
("does this passage support the stated key fact") and one yes/no/skip on the
canonical answer, plus notes. Files land in a Drive folder via Apps Script and,
locally, in `review-output/`.

**Ingest script** (in the eval-review repo, run by the maintainer, output
committed with the evalset):

- A passage labeled `no` is dropped from scoring; its fact is flagged in
  `note`.
- A canonical answer labeled `no` sets the case to `draft` with the reviewer's
  note.
- All passages `yes` and answer `yes` (any reviewer, no `no` from another) sets
  `expert_approved`. Conflicting reviewers leave `draft` and list both.
- Headline numbers cover `expert_approved` cases; `draft` cases are reported in
  a separate block, never mixed into the means.

**Second notebook mode** (colleague's side, tracked in §8): review a *system
answer* from a stored capture — per key fact stated/absent, per sentence
supported/unsupported. Its output is the judge-agreement set (§4.5) and the
human adjudication for pairwise comparison (§4.6).

## 3. Harness

New directory `evaluation/answer/`. Deleted in the same change:
`run-answer-retrieval-eval.ts`, `run-answer-synthesis-capture.ts`,
`run-answer-synthesis-llm-eval.ts`, `prepare-synthesis-review.ts`,
`assemble-synthesis-ground-truth.ts`, `generate-answer-golden-set.ts`,
`generate-answer-report.ts`, `relabel-answer-chunks.ts`,
`calibrate-answer-thresholds.ts`, `sweep-answer-retrieval.ts`,
`eval-nano-filter.ts`, `chart-answer-precision.py`, `eval-minimal.ts`,
`answer-golden-dataset*.json`, `answer-labels-review.json`,
`answer-retrieval-raw.json`, `answer-synthesis-*.json`,
`answer-question-bank.json`, the `eval:answer-*`, `eval:golden-*`,
`eval:synthesis-*` npm scripts, and the Next.js routes under
`src/app/api/eval/` that serve gen-1 data (`labels`, `labels/override`,
`review-labels`, `synthesis-eval`, `synthesis-eval/review`, `synthesis-raw`,
`review-synthesis`) together with `serve-label-review.ts`,
`upload-eval-to-s3.ts`, `download-eval-from-s3.ts`, and the matching sections
of `evaluation/README.md`. `run-evalset.ts` and `run-cite-eval.ts` stay.

### 3.1 Targets

- `gateway`: `POST <target>/api/llamaindex` then `POST <target>/api/answer`
  against a deployed instance. Retrieval knobs that are `QueryRequest` fields
  (`expansion_lane_weight`, `expansion`, `fusion_top_k`, `max_results`,
  `rerank_top_n`, `dense_weight`/`sparse_weight`) are forwardable through the
  gateway allowlist (§5.4). Synthesis knobs are forwarded as `/api/answer`
  request fields (§5.1).
- `direct`: local search service `/query` plus local `/api/answer`. Needed for
  knobs that are config, not request: `answer_rerank_per_doc_cap`,
  `translation_pairs_enabled`. The runner does not restart services; it
  records the service's `/health` config block into provenance so a run is
  attributable to its settings.

### 3.2 Stages and artifacts

```
capture  →  capture-<label>.json     (API calls: retrieval + synthesis)
judge    →  judged-<label>.json      (API calls: judge only; resumable)
score    →  report-<label>.json      (no API calls; pure)
compare  →  stdout                   (two reports, same fixture + passes)
```

`capture` stores, per case per pass: retrieved chunk list with scores,
`chunk_id`, `doc_id`, `likely_off_topic`; `passages_sent`; raw model JSON;
parsed sentences with `cites`; `source_relevance`; wall and service latency;
cost from usage fields.

`judge` reads a capture and writes verdicts keyed by `(case, pass, item)`.
A partial `judged-*.json` is resumed; only missing items run. Verdicts carry
the prompt hash and judge model.

`score` is a pure function `(fixture, judged) → report`. Scorer changes re-run
this stage only.

`compare` refuses runs with different fixture commits, pass counts, or case
sets, and prints per-case deltas with the per-pass spread.

### 3.3 Provenance in every artifact

Fixture commit (submodule SHA), target URL or local config snapshot, every
injected knob, synthesis model and base URL, judge model and base URL, prompt
hashes (synthesis system prompt version, each judge prompt), pass count,
harness git SHA, timestamp.

### 3.4 Pre-flight

1. Fixture validation: every `text_snippet` must be found (normalized) in the
   target's chunk text for its `doc_id`; every `expected_external_id` must be
   in the catalog; twins must both exist. Failure lists cases and aborts
   before any paid call.
2. One-token probe to each provider (synthesis, judge). A non-200 aborts.
3. Print approved vs. draft counts and the estimated call count.

### 3.5 Controls

`--only <case>`, `--limit N`, `--passes N` (default 1; use 3 when a number must
carry weight), `--label`, `--concurrency` (default 1 for judge), `--target`,
`--knob key=value` (repeatable). Cost is accumulated and printed at the end.

### 3.6 The fetch hang

Spike before the runner is written: reproduce `run-evalset.ts`'s hang against
a local Next dev server, identify the cause (keep-alive / undici pool /
dev-server behaviour), and choose between a fix in the client and explicit
timeouts with `undici`. The runner ships with whatever the spike concludes and
a test that a stalled response times out rather than hangs.

## 4. Judge

### 4.1 Provider

One OpenAI-compatible client; base URL and key from env. Default judge:
`glm-5.2-vision` via lunaroute. `--judge-model` / `--judge-base-url` swap it.
Same client serves the answer route (§5.1) so provider handling has one
implementation.

### 4.2 Calls

Three small prompts per case, each with a strict JSON schema:

1. **Fact recall** — inputs: key facts, answer text. Output per fact:
   `{fact_index, verdict: stated|partial|absent, evidence: "<quote from answer>"}`.
2. **Sentence support** — inputs: one sentence, only the passages it cites
   (with language tag). Output: `{verdict: supported|unsupported, span: "<quote from passage>"}`.
   One call per sentence.
3. **Unsupported claims** — inputs: answer text, full retrieved passage set.
   Output: `{unsupported_sentence_indices: [...], reasons: [...]}`.

### 4.3 Reliability

Temperature 0. Schema validation; one retry with the validation error appended;
second failure records `unjudged` with raw text kept, never scored as zero.
Concurrency 1 by default. 429 → backoff and retry (max 5). 401 → abort the run
immediately.

### 4.4 Language

Passages may be zh/es; answers are English. The judge is told each passage's
language and instructed to judge meaning. Agreement (§4.5) is reported
separately for zh/es cases and English cases.

### 4.5 Calibration

Until the system-output review mode (§2.4) produces human labels, every report
header says `judge: uncalibrated`. Once labels exist, `score` prints judge vs.
human agreement per verdict type, and `--judge-only` on a stored capture allows
two judge models to be compared for agreement with each other at zero
synthesis cost.

### 4.6 Pairwise mode

`compare --pairwise <captureA> <captureB>`: same fixture, cases, and passes.
The judge sees question, shared passages, and both answers in randomized
order, returns a preference and a reason. Reported as win rate with the
order-swapped check so position bias is visible. Human adjudication of
disagreements uses the system-output notebook mode.

## 5. Product contract and fixes

### 5.1 Answer route (`src/app/api/answer/route.ts`)

- Output schema (route response):
  `{"ok":true,"synthesis":{"sentences":["s1","s2"],"cites":[[1,3],[2]],"source_relevance":[…],"warning?":"low_coverage"},"passages_sent":[{"id":1,"doc_id":"…","chunk_id":"…","page":7,"text":"… as sent"}],"debug":{"knobs":{…},"invalid_cites":0,…}}`.
  `synthesis.sentences` is `string[]`; `synthesis.cites` is the parallel
  `number[][]` (same length, present on every path including fallbacks and
  exceptions). Passage ids are the 1-based indices of `passages_sent`
  (renumbered after the nano filter). Invalid ids are dropped server-side and
  counted in `debug.invalid_cites`.
- Request accepts optional `model`, `base_url`, `max_passages`,
  `passage_chars`, `prompt_version`, `likely_off_topic`. Defaults reproduce
  today's behaviour (gpt-5 branch: 8 passages, 400 chars). Production callers
  send none of them; a test asserts the defaults byte-match the current prompt
  and truncation.
- Provider call goes through the shared OpenAI-compatible client (§4.1);
  hardcoded `https://api.openai.com` at `:248` and `:466` removed. Env:
  `OPENAI_BASE_URL` (default OpenAI), plus `LUNAROUTE_*` for the candidate.
- Response adds `passages_sent` (id, doc_id, chunk_id, page, text as sent) and
  echoes the effective knobs in `debug`.
- When `likely_off_topic` is true, the prompt's existing low-coverage path is
  forced (the model is told coverage is poor) and the response carries
  `warning: low_coverage`. Product choice flagged in §8: force-abstain vs.
  warn-and-answer. Default here: warn-and-answer, since the flag's precision is
  unmeasured.

### 5.2 UI

- `AIResearchModal.tsx`: build `inline` from `sentences[].cites` mapped through
  `passages_sent`; delete the slice-by-position block (`:212–248`).
- `AnswerPanel.tsx` / `SupportingCitations.tsx`: a citation marker scrolls to
  the passage it cites; "Directly cited" lists cited passages; the rest go
  under "Also retrieved". `numberOfUsedKnowledgeProducts` = distinct `doc_id`
  among cited passages.
- Honor `likely_off_topic`: pass it to `/api/answer`; render the low-coverage
  warning the route returns.

### 5.3 Retrieval (search-service), flag-dark

- `answer_rerank_per_doc_cap`: value chosen by sweep (§7). Ships unchanged
  (`None`); activation is an env change in `qa.tfvars`, gated on before/after
  from this harness.
- `translation_pairs_enabled` for answer mode: re-examined by sweep. Either
  outcome is fine because §2.2 scores twins as one document.
- No change to `max_results` default; it is already a request knob.

### 5.4 Gateway (`src/app/api/llamaindex/route.ts`)

Replace `...options` with an explicit allowlist of forwardable fields:
`expansion_lane_weight`, `expansion`, `fusion_top_k`, `max_results`,
`rerank_top_n`, `dense_weight`, `sparse_weight`, `cite_doc_ids`, `facets`,
`min_year`, `max_year`, `excluded_keywords`, `required_program`,
`retrieval_mode`, `return_intermediate_results`. Unknown fields are rejected
with 400. A test asserts an unlisted field cannot override the preset. The
unused `chatAnswerLlamaIndex` in `src/lib/llamaindex-client.ts` (sends
`max_results: 100`) is deleted.

### 5.5 Ordering

1. Contract + UI (§5.1, §5.2) and gateway allowlist (§5.4) — one PR, behaviour
   identical for production callers except citations become real.
2. Fetch-hang spike (§3.6), then harness (§3) + judge (§4) — one PR, plus the
   gen-1 deletion.
3. Fixture additions (§2.1) and ingest script — in the eval-review repo.
4. Sweeps (§7) — each retrieval knob on its own branch, flag-dark, activated
   by a separate env change.

## 6. Tests

- **Scorer**: hand-built fixture + judged file with known scores; evidence
  coverage with twin passages, normalization edge cases (full-width
  punctuation, line breaks mid-word), twin collapse in doc MAP, concentration.
- **Replay determinism**: `score` on the same inputs twice is byte-identical.
- **Compare guard**: differing fixture SHA or pass count is refused.
- **Judge client**: schema validation, retry-once, `unjudged` on second
  failure, 401 abort, 429 backoff — against a fake server.
- **Runner**: fake gateway + fake answer route; capture shape; resume of a
  partial judged file; timeout instead of hang.
- **Answer route**: every cited id ∈ `passages_sent`; invalid ids dropped and
  counted; defaults byte-match current prompt/truncation when no knobs are
  sent; base URL override reaches the client.
- **Gateway**: allowlist; unlisted field → 400; preset not overridable.
- **UI**: marker *k* on sentence *s* resolves to the passage the model cited;
  N counts cited docs; `likely_off_topic` renders the warning.
- **Python**: existing `test_bedrock_rerank.py` per-doc-cap tests already
  cover §5.3; add a test that answer-mode `per_doc_cap` reads the setting.

## 7. Sweeps the harness will drive (not assumed)

Each is a before/after on the same fixture, target, and pass count, reported
by `compare`; N=3 before any default changes.

1. `answer_rerank_per_doc_cap` ∈ {off, 2, 3, 4} — concentration vs. evidence
   coverage vs. fact recall.
2. `max_passages` ∈ {6, 8, 12, 15} × `passage_chars` ∈ {400, 800, full} —
   fact recall and unsupported-claim rate vs. cost/latency.
3. Synthesis model: gpt-5.4 vs. gpt-5.6 vs. glm-5.2-vision on identical
   captures — pairwise and absolute.
4. `translation_pairs_enabled` on/off for answer mode.
5. `expansion_lane_weight` for answer mode, re-checked with fact recall rather
   than doc MAP alone.

## 8. Open items (tracked, with owners)

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | Twin passages resolved for facts whose source is zh/es (lookup script, per fact) | eval-review maintainer | evidence coverage on twin cases |
| 2 | Fixture validation of quotes against the live corpus after each re-ingestion | harness (§3.4) | every run |
| 3 | System-output review mode in the notebook (per fact / per sentence labels on a stored capture) | colleague | judge calibration (§4.5), pairwise adjudication (§4.6) |
| 4 | Ingest script for `annot-*.json` → `review_status` | eval-review maintainer | headline vs. draft split |
| 5 | Negative answer cases in the fixture | eval-review maintainer | abstention scoring |
| 6 | Product choice: `likely_off_topic` → force-abstain or warn-and-answer | product owner | §5.1 default is warn-and-answer |
| 7 | Deployed `OPENAI_MODEL` / `USE_NANO_FILTER` values on QA (from secrets JSON, unverified) | ops | which truncation numbers apply to QA captures |
| 8 | Fetch-hang root cause | harness spike (§3.6) | runner implementation |
| 9 | Submodule pin bump to include clusters 4–5 and the notebook | this branch | first run |
| 10 | lunaroute cost per call (unmeasured) | first run | budget estimate |

## 9. Out of scope

Cite-mode evaluation and its sets; retrieval model changes (embedding,
reranker, understanding sidecar); the alignment/why/relates routes; CI gating;
streaming.
