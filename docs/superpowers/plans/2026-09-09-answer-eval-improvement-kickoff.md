# Kickoff: improve the answer-eval baseline results

**Date:** 2026-09-09
**Mission:** the first gen-2 answer-eval baseline against deployed QA is diagnostic
gold but terrible on its face — strict fact recall 0.070, evidence coverage 0.157,
chunk hit rate 0.099, selection utilization 0.184. Your job is to move those
numbers by fixing root causes, without tuning to the test and without breaking the
measurement machinery that was just built.

You are picking up a workstream that is mid-flight. The measurement harness is
DONE and healthy (PR #412, CI green) — do not rebuild it. The results it produced
are the target of this work.

---

## 0. Read these first (in order)

| File | Why |
|---|---|
| `evaluation/README.md` — section "Scoring dimensions (what the report means)" | Every metric, its denominator, where it lives. Do not invent metric semantics. |
| `evaluation/baselines/2026-09-09-answer-noselection-qa.json` | THE baseline. Header = provenance; `draft_block` = means; `per_case[n].per_pass` = per-pass detail. |
| `docs/superpowers/specs/2026-09-08-answer-eval-two-step-flow-design.md` | The two-step flow contract: selection modes, what is measured vs gated, §10 ordering, §7 scoring caveats. |
| `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md` | Metric definitions (§2.2/§2.3), rulings 1–6, judge lanes. |
| `CLAUDE.md` | Repo conventions, branch model, commands, env vars. Non-negotiable. |
| `evaluation/answer/score.ts` + `run-score.ts` | The scoring code, if any number seems surprising. |

## 1. How to run the eval (the loop you will live in)

```bash
# capture (paid: ~$0.002/case synthesis + ~$0.0006/case preflight lookups)
npm run eval:answer-capture -- evaluation/eval-review/evalsets/evalset_answer_02.json \
  --selection-mode no-selection --label <name>-<yyyymmdd>
# judge (resumable; decided baseline judge — keep it stable across comparisons)
npm run eval:answer-judge -- --capture evaluation/answer/artifacts/capture-<label>.json \
  --judge-model glm-5.3 --judge-thinking max --concurrency 4
# score (pure, free, byte-identical)
npm run eval:answer-score -- --capture .../capture-<label>.json --judged .../judged-<label>.json
# compare two runs (refuses cross-mode/cross-fixture diffs)
npm run eval:answer-compare -- report-A.json report-B.json
```

- Targets **deployed QA by default** (`EVAL_TARGET` or `https://qa.askwri-app.org`). No local services needed.
- `--direct-search URL --direct-answer URL` switches to local services for cheap knob iteration (search-service on :8000; local stack via `./scripts/local-bootstrap.sh`, idempotent).
- `--knob key=value` injects knobs (recorded in provenance). Knobs are how you sweep without code changes.
- Artifacts land in `evaluation/answer/artifacts/` (gitignored). Judge artifacts RESUME — an interrupted judge re-run costs only missing items.
- The judge budget bug (empty completions at `max_tokens=2000` for reasoning models) was fixed 2026-09-09 (MAX_TOKENS 16000, PR #412). 72/72 items judge cleanly now. Do not re-triage tombstones.

## 2. The baseline, in one table (2026-09-09, no-selection, 16 cases, deployed QA)

| Dimension | Value | Read it as |
|---|---|---|
| evidence_coverage | **0.157** (10/16 cases measurable) | Only ~16% of checkable key facts' supporting text reached the model |
| doc_map | 0.776 | Ranking of what WAS retrieved is decent |
| attainable_recall | 0.844 | 5 cases at 0.5 (q4, q5, q6, q7, q16) |
| chunk_id_hit_rate | 0.099 (10/16 cases) | Exact-chunk matches almost never happen |
| selection_utilization | 0.184 (range 0.05–0.67) | Of ~20 selected docs, <20% contributed anything the model saw |
| fact_recall_strict | **0.070** — 13 of 16 cases scored exactly 0 | Judge finds almost no fact FULLY stated |
| fact_recall_lenient | 0.583 | Partial credit is common |
| citation_precision | 0.979 · unsupported 5/16 (0.125) | When the model speaks, it cites honestly |
| compliance | 16/16 valid · parsed · English | Pipeline mechanics are clean |
| expected_doc_in_selection | **true for 16/16 cases** | The cite stage is NOT the bottleneck |
| rank_gaps | 16 passages across 7 cases | Cross-lingual: question can't surface zh evidence that EXISTS |
| facts_no_passage | 26 facts (6 cases unmeasurable) | Fixture gaps — facts with no supporting passage/snippet |
| cost | $0.032 retrieval + ~90k/152k judge tokens | Cheap to iterate |

**The causal chain the numbers tell:** selection is fine (16/16 expected docs
selected) → but within the selection, answer-mode retrieval misses half of some
cases' evidence (aR 0.5) and almost nothing survives to the model (evidence 0.157,
utilization 0.184, ≤8 passages × ≤400 chars is the budget) → so synthesis can
only partially state facts (lenient 0.583) and almost never fully (strict 0.070).
Synthesis quality itself (precision 0.979, compliance 16/16) is NOT the problem.
Fix evidence delivery and the synthesis numbers should climb; do not start by
rewriting the synthesis prompt.

## 3. Failure taxonomy → candidate levers (verify, don't assume)

1. **Within-selection evidence misses (aR 0.5 on 5 cases; utilization 0.184).**
   The answer-mode retriever (`mode: 'answer'` + `cite_doc_ids`, search-service
   `main.py` ~1401–1405) filters to the selection then reranks. Why do half the
   selected docs' chunks lose? Candidate levers: pool sizes before rerank,
   reranker top-N for answer mode, dense/sparse lane weights for answer queries
   (note: `answer_expansion_lane_weight=0.25` precision-first default), the
   15-chunk incoming cap vs 8-passage send budget, `max_passages`/`passage_chars`
   knobs (sweepable via `--knob` without deploys in direct mode).
2. **Cross-lingual rank gaps (7 cases, 16 passages).** English question fails to
   surface zh chunks that exist (verified: snippet-derived queries rank them #1).
   Query-expansion lanes (topic/geo) are ON in QA (PR #353/#357) and did not fix
   this. Levers: answer-mode query translation/expansion, zh-side retrieval
   boosts, multilingual embeddings. This is search-service retrieval-tuning
   workstream territory.
3. **Strict-vs-lenient gap (0.070 vs 0.583).** Two hypotheses to separate: the
   model never SEES the facts (evidence problem — fix #1/#2 first), vs the model
   sees but paraphrases (the "crisp 3–5 sentence" v2 prompt forbids recitation).
   If it's the latter: prompt work is app-tier product change (`src/app/api/answer/route.ts`,
   promptVersion v1/v2), gated per design §10.4 — needs a no-selection
   confirmation run before shipping as default.
4. **Fixture quality (26 facts_no_passage; 6 cases unmeasurable for coverage).**
   The evalset (`evaluation/eval-review` submodule, `evalset_answer_02.json` v3.0)
   needs: `doc_sets` restructure (unlocks `fixture-set` mode = clean-attribution
   tuning sweeps, step 2 of the two-step design), passage/variant completion for
   the 26 orphan facts, q16 union doc-set decision. This is evalset-PR work in the
   SUBMODULE (separate repo, pin-bump flow per README).
5. **Judge calibration (uncalibrated).** Human labels blocked until the
   eval-review notebook accepts `answer-eval/capture@2`. Before trusting any
   improvement as real, spot-check judge verdicts by hand on a few cases
   (judged artifact has raw verdicts + spans).

## 4. Guardrails (violating these wastes the workstream)

- **Branch model:** all work lands on `qa` via PR. NEVER push or PR to `main` — merging to main IS a production deploy, no gate. Docs-only pushes deploy nothing; code pushes to qa auto-deploy QA (tests gate).
- **Don't tune to the test:** 16 cases is small. Any knob change proposed as a default needs a fresh no-selection run AND should be sanity-checked against cite-mode evals (`npm run eval:cite`). Prefer `--direct-*` local iteration over QA round-trips; never chase single-case deltas.
- **Judge stability:** keep `--judge-model glm-5.3 --judge-thinking max` for all comparisons (compare/pairwise fingerprints guard this). Judge differs from synthesis model (gpt-5.4-mini) on purpose — keep it that way.
- **Fingerprints:** re-capturing under the same label invalidates the judged artifact (by design). New experiment = new `--label`. Convention: `<what>-<yyyymmdd>`.
- **Conventions:** retrieval tuning lives in `search-service/` (config.py, main.py; python deps PINNED via requirements.in + compile script). Answer synthesis lives in `src/app/api/answer/route.ts`. Eval harness lives in `evaluation/answer/`. Don't cross the streams.
- **Full suite gate:** `npm run test:ci` needs the DB up: `docker compose -f docker-compose.local.yml up -d && npm run migration:run` (green as of 2026-09-09: 963 passed). Lint: 0 errors enforced. Prettier enforced on commit paths.
- **Costs:** capture ≈ $0.002/case; judge ≈ tokens (lunaroute $ unmeasured). A 16-case loop ≈ $0.03 + ~150k judge tokens. Fine to iterate; don't burn passes ≥3 without a hypothesis.

## 5. Suggested first session

1. Read §0 files. Then open `per_case` in the baseline and classify each of the 16 cases into the §3 buckets (per_pass has per-pass detail; the judged artifact has raw verdicts).
2. Hand-verify the judge on 2–3 cases (strict=0 with lenient>0: read the answer vs key facts — is the judge harsh, or is evidence genuinely absent from `passages_sent`?).
3. Pick ONE bucket (recommendation: #1 within-selection evidence delivery — biggest lever, cheapest to iterate locally via `--direct-*` + `--knob`).
4. Baseline a change: capture → judge → score with a new label, `eval:answer-compare` against `report-baseline-noselection-20260909.json`.
5. Commit the new dated baseline JSON to `evaluation/baselines/` alongside a compare summary, PR to `qa`.

## 6. Reference index

- Baseline JSON (committed): `evaluation/baselines/2026-09-09-answer-noselection-qa.json`
- Raw artifacts (local, gitignored): `evaluation/answer/artifacts/{capture,judged,report}-baseline-noselection-20260909.json`
- Human-readable HTML view (local): `evaluation/answer/artifacts/report-baseline-noselection-20260909.html`
- Harness: `evaluation/answer/` (capture.ts, judge.ts, score.ts, compare.ts, judge-client.ts, preflight.ts)
- Harness tests: `evaluation/answer/__tests__/` (266 tests — keep green)
- Scoring dictionary: `evaluation/README.md` → "Scoring dimensions"
- Specs: `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md`, `2026-09-08-answer-eval-two-step-flow-design.md`
- Plans: `docs/superpowers/plans/2026-09-03-answer-eval-harness-pr2.md`, `2026-09-08-answer-eval-two-step-harness.md`
- PR #412 (harness fix + baseline + docs): https://github.com/wri/askwri/pull/412 (merged 4d8d7fa)
- Evalset fixtures: `evaluation/eval-review/` submodule @ 1dcbeab (bump flow in README)
- Deployed env facts (verified 2026-09-08): `USE_NANO_FILTER` unset→OFF, translation_pairs OFF, `OPENAI_MODEL=gpt-5.4-mini`, no LUNAROUTE on QA (synthesis → api.openai.com direct)
