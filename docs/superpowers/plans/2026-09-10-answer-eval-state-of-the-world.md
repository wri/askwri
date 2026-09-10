# Answer-eval workstream — state of the world after 2026-09-10 (handoff doc)

**Read this first if you are picking up the answer-eval improvement workstream.**
Companion docs: `2026-09-09-answer-eval-improvement-kickoff.md` (workstream
start), `docs/plans/2026-09-09-answer-mode-query-translation-design.md` §7
(the translation mechanism contract),
`2026-09-10-answer-translation-terminology-grounding.md` (the executed
terminology plan), `2026-09-10-answer-eval-next-levers.md` (the corrected
program after the premise-check rejected the first next-step framing).

## What is shipped (merged to qa, all CI-gated)

- **#419** — answer-mode query translation mechanism, flag-dark
  (`answer_translation_enabled=false`).
- **#421** — vocabulary grounding v1 (seed-term extraction → grounded
  re-rendering, source = English question, failure-soft) + the
  **rerank-isolation probe instrument**
  (`search-service/scripts/probe_rerank_isolation.py`) with `--pool-realistic`
  (reconstructs the product's ~240-source candidate pool). Flag-dark.
- **#425 (merged c035a62, 2026-09-10)** — **gpt-5 synthesis defaults are now
  15 passages × 800 chars** (was 8 × 400). §10.4-confirmed before shipping:
  strict fact recall **0.070 → 0.163** (N=3, glm-5.3@max judge),
  citation_precision 1.000. Watch item: unsupported_claims +2 sentences vs the
  matched 15×400 reference — carried on the next periodic no-selection run.

## Measured findings every future decision must respect (2026-09-10 census)

Union pool = standard fused candidates + doc-scoped dense seed under the
translated query (~240 sources). Union rank = expected chunk's EN-score
position in that pool.

| case | expected chunks | union rank |
|---|---|---|
| q3 | 25/27/29/30/209 | 123–216 |
| q4 | 166/209 | 126, 144 |
| q4 | 176/177 | 59, 64 |
| q5 | 5/8/9 | 131, 103, 102 |
| q7 | 8/9 | 103, 108 |

1. **No recall defect.** Every expected chunk is present in the union pool —
   the seed lane does its job. (The once-suspected q5 chunk_5 "recall bug" is
   refuted: union rank 131; its shipped-view absence is just the EN-only
   standard lane.)
2. **The shipped (flag-dark) state fails at CANDIDATE level:** 0/14 expected
   chunks enter standard candidates under the English question.
   Cross-lingual retrieval failure starts one stage before the rerank.
3. **FALSIFIED — do not re-run:** widening the rerank candidate window;
   `answer_rerank_per_doc_cap` as-implemented; translation-prompt variants
   beyond the shipped two-rendering + grounding (augment/termdense all lost
   or tied); the cut-size sweep 15/20/25 (no expected chunk exists in the
   16–40 band — cuts reach nothing).
4. **The mechanism's real failure mode:** translation-draw variance (hits
   5/14 vs 7/14 across runs) + boundary compression — zh-lane fact chunks
   score 0.83–0.90 *against their own documents' sibling chunks* (the
   top-15 boundary sits in the same band). In good draws max-merge already
   delivers them at merged ranks 9–15.
5. **Instrument lesson (paid for twice):** small-batch rerank isolation
   FLATTERS vocabulary lifts (batch-relative boundary position). Always gate
   prompt/rule changes with `--pool-realistic`, and demand set_equal validity
   gates — a 2026-09-10 implementer weakened the gate to pass and the review
   caught it.

## The lever menu (premise-check arbitrates A vs B before investment)

- **A. Determinize the translation draw** (temperature/seed on the grounded
  call): cheap, flag-dark, makes the good-draw state reproducible. Stabilizes
  the product and every future measurement; does not by itself raise quality.
- **B. zh-lane fact-chunk promotion** (rerank features against the sibling
  compression): the precisely-aimed intra-document competition lever; needs a
  design doc (brainstorm) before implementation. Biggest ceiling.
- **C. Fixture data debt (eval-review submodule, upstream PR + pin bump):**
  add the `twins` field (purely additive — harness support already live;
  pairs named in the case notes; VERIFY score.ts's twin-side containment
  semantics first), `doc_sets` (+ q16 union, negative assignments), and the
  26 orphan facts (all q11–q16, six es cases with zero recorded passages —
  source markdown + reviewer notes exist; authoring = expert snippet
  selection + DB chunk alignment). This un-cripples twin-crediting and makes
  es cases measurable — the enabler for any future promotion gate.

## Queue (as of end 2026-09-10)

1. Independent re-review of `feat/answer-eval-bucket2` (376e9fa) — the T1 fix
   round was controller-verified but the registry excluded the subagent model
   (~24 h); the re-review is owed.
2. Premise-checker re-run on the A/B fork.
3. T5a fixture edits (after 1; upstream PR needs owner approval).
4. Diagnose gate-B's "fresh draw" sensitivity in an EN-only view (queued with
   the re-review).
5. Fetch-mock hygiene: `src/__tests__/answer-route.test.ts` should use
   `mockImplementation(async () => modelReply(...))` (fresh Response per
   call) — `mockResolvedValue` single-use Responses caused a false
   "20-docs → 0 passages" scare (resolved: test artifact, NOT a product bug;
   the route's exception fallback behaved as designed).
6. Next periodic no-selection run on QA: first under the shipped 15×800
   defaults; carries the unsupported watch item.

## Standing process (non-negotiables + paid-for lessons)

- All work lands via PR to `qa`. **Never push/PR `main` — that IS a
  production deploy.** Docs-only pushes deploy nothing.
- Work in git worktrees (`.worktrees/<topic>`, branch off `origin/qa`,
  **upstream unset** — bare pushes must fail). Carryover per worktree: root
  `.env`, root **`.env.local`** (missed once — caused 6 suite errors),
  `search-service/.env.local` (hold-aside rule for Bedrock work — its MinIO
  keys poison boto3), symlink `search-service/venv`, needed artifacts from
  `evaluation/answer/artifacts/`.
- No evalset-derived content in any prompt. Judge stability: glm-5.3 @
  reasoning max for every comparison. N=3 before believing deltas.
- Subagent-driven development (SDD) with a ledger per plan
  (`.superpowers/sdd/<plan>/progress.md`); dispatch contracts must be blunt
  and step-numbered — context-heavy dispatches get summarized instead of
  executed (observed twice).
- Python deps pinned; python via `search-service/venv`; the probe script is
  standalone (no `app.*` imports, never reads `.env.local`).

## Raw evidence (gitignored, in the answer-eval worktree or main checkout)

`evaluation/answer/artifacts/`: capture/judged/report-knobconfirm15x800-3pass
(the §10.4 confirmation), probe-isolation-20260910 (instrument validation),
probe-mirror2-* (corrected mirror runs), snapshot-* (10-case EN-only shipped
state), snapshot-validity-20260910 (the honest FAILED 6/8 gate with
per-chunk divergence classifications), pool-probe-q3/q7 (union pools).
