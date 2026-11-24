# Flag-on vs flag-off measurement on QA — Design

- **Date:** 2026-11-24
- **Issue:** [wri/askwri#498](https://github.com/wri/askwri/issues/498) — Section B, items 6 and 8 (item 9's promotion is a separate unit; item 7's model decision is an input to it)
- **Status:** Proposed; awaiting approval
- **Branch:** `feat/query-understanding-promotion` (PR targets `qa`)
- **Scope:** small change — one labelled lever in the eval harness, a run matrix, and a recorded baseline.

## Problem

The case for turning QA's five query-understanding flags on in production rests on a
comparison measured 2026-08-26, before three model changes, on a harness that no longer
exists (`evaluation/eval-minimal.ts`, `EVAL_EXPANSION`, `AP_TOL`). Item 8's claim — "run the
evalsets several times and report the spread" — also cannot be answered as written: the LLM
sidecar is `@lru_cache`d per process (`search-service/app/understanding_llm.py:52`), so
repeat runs inside one deployment are served from cache and show ~0 variance. The real risk
is not run-to-run variance inside a deployment; it is which single sample each **deploy**
draws and then freezes for its lifetime.

## What makes this possible without touching anything

- `QueryRequest.expansion` (`search-service/app/main.py:174`) is the flag-off guard:
  `understanding_active()` returns False when it is False, which makes the whole
  understanding/expansion path — lanes and LLM sidecar — byte-identical to the flag-off
  code path (`search-service/app/understanding.py:62-68`).
- That field is already forwardable: `/api/llamaindex` accepts it (`FORWARDABLE_FIELDS`) and
  passes it to `/query`.
- With lanes off, `domain_expansion = not lanes_on` (`main.py:1534`), so the off arm also
  reproduces **production's current path**, including the hand-built synonym dictionary that
  item 12 wants deleted.

So one request-level field gives a true flag-off baseline against deployed QA: no redeploy,
no flag flip, no local corpus, no credentials.

## Goals

- A measured flag-on vs flag-off comparison on `evalset_cite_01` (11 cases) and
  `evalset_cite_02` (16 cases), against deployed QA running `4b3a05e`.
- Latency and cost alongside quality: `service_ms` p50/p95 and per-request cost for each arm.
- A recorded baseline in `evaluation/baselines/` per `evaluation/README.md`'s requirements.
- An answer to item 8 that says what was and was not measurable, and why.
- A go/no-go memo: promote, promote-with-changes, or hold. Its thresholds are a judgement, not a measured
  noise floor — repeats inside one deployment are cached, so they cannot estimate MAP variance.

## Non-goals

- Changing any search-service code, any flag, or either environment's configuration.
- Item 7 (the search-service model decision). The memo will record the models in force and
  state what a swap would require, but no model is changed here.
- Item 9 (enabling in production) — a release under `production-release.md`.
- The "every difference has a deadline" mechanism — a separate design.

## Anti-goals

- A flag-off arm that is not actually flag-off (measuring a cache, or a partially disabled
  path, and calling it a baseline).
- A run whose provenance cannot be reconstructed: no target, commit, fixture commit, or
  model settings recorded → the baseline is unusable in three months, which is exactly the
  failure this replaces.
- Optimising for a number: the point is to learn whether promotion is a good idea, not to
  find a run that flatters the flags.

## Approaches considered

**How to get a flag-off arm.** *(i) The request-level `expansion: false` lever — chosen.*
*(ii) Flip the flags in qa.tfvars and redeploy, measure, revert, redeploy again.* Rejected:
two deploys, hours of wall time, and it mutates the target being measured. *(iii) Run the
search service locally with the flags off.* Rejected: needs the corpus, the embedding
backfill, and API keys — days of setup to measure one comparison.

**How to answer item 8.** *(a) Repeat runs against QA.* Cheap, and included — but it measures
the cache, not the model, so on its own it would be a false negative. *(b) Sample the sidecar
directly K times per eval query.* Answers the actual question (is `temperature=0` stable
enough that a deploy's frozen sample is representative?) but needs an `OPENAI_API_KEY`.
*(c) Both, with the key-gated half refused honestly if no key is available — chosen.*

## Decisions

1. **The lever is loud.** `EVAL_EXPANSION=off` sends `expansion: false`; the run header, the
   JSON report and the baseline all record it. A run with no lever keeps sending no
   retrieval params, exactly as `evaluation/README.md` requires.
2. **Matrix:** both cite sets × {flags on, flags off} × 3 repeats = 12 runs, plus the
   `answer_02` set only if the cite comparison is ambiguous (kept out to bound cost).
3. **What the off arm means is stated, not implied:** it is QA's retrieval with the
   understanding path disabled — the same code path production runs today.
4. **Repeatability is reported as three separate facts:** within-deployment spread (expected
   ~0, with the `lru_cache` reason), the sidecar's own K-sample spread (if a key exists), and
   the fact that cross-deploy variation is not measurable without repeated deploys.
5. **The baseline is the deliverable**, not a chat message: numbers a reviewer can check.

## What this measurement can and cannot tell us

**Can:** whether the flags help or hurt on the current corpus and model config; what they
cost in latency and dollars; how the abstain signal behaves when enabled (it is always false
in production today, and the off arm reproduces that); whether the 2026-08 result still
holds.

**Cannot:** whether each *deploy* draws a representative sidecar sample (unless the direct
probe runs); production's own traffic mix; whether the search-service models (item 7) are
the right ones.

## The change

- `evaluation/run-evalset.ts` — read `EVAL_EXPANSION`; when it is `off`, add `expansion:
  false` to the request body and print `expansion: off` in the run header and in the report
  JSON. No other behaviour changes; unset = today's request exactly.
- `evaluation/baselines/2026-11-24-flag-on-vs-off-qa.md` — the baseline: target and commit
  (`4b3a05e` from the QA task definition's image tag), fixtures commit, corpus size, model
  settings, per-set doc/chunk AP and attainable recall for both arms, latency p50/p95, cost,
  abstain counts, and the go/no-go memo.

## Verification

- `npx jest evaluation/` — the harness tests still pass, and a new test asserts that
  `EVAL_EXPANSION=off` produces `expansion: false` in the request body *and* that unset
  leaves the body at `{query, mode}`.
- The 12 runs are repeatable from the commands recorded in the baseline.
