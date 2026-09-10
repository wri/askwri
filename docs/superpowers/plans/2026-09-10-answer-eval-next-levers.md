# Next levers for the answer-eval workstream — corrected program (2026-09-10)

**Status:** program doc. Written after the premise-checker rejected the initial
"rerank-rule simulator" framing; this document is the corrected sequence. The
prior session's outcome (PR #421, merged): vocabulary grounding v1 landed
flag-dark; the mirror gate FAILED (5/14 and 7/14 expected chunks in the final
15 across runs, twins displaced); the direct A/B was skipped per plan §6.5's
own conditional; no activation proposed.

## 0. Why the framing changed (premise-check verdict, evidence-backed)

1. The recorded top-15 occupancy (q3, better run) is 14/15 ONE zh document's
   mid-document siblings — the initially proposed rule menu (demote
   chunk_index==0, demote first-N-per-doc, demote summaries) does not touch
   that composition; the rule it calls for is a **per-document representation
   cap**, which was not on the menu.
2. `expected_detail: null` in the probe artifacts cannot distinguish
   below-cut from absent-from-pool. q5's chunk_5 is confirmed pool-absent
   (candidate-generation/recall defect — doc-scoped dense seed top-K
   truncation is the suspect); chunk_209 is expected by TWO cases (q3+q4), so
   one defect suppresses two cases.
3. Expected-chunk-ID-in-15 is not the eval's metric: `evidence_coverage` is
   normalized containment (a same-doc sibling carrying the same passage scores
   identically), and `fact_recall` depends on what the model is SENT
   (≤8×400 today — ranks 9–15 are shadow inventory under current defaults).
4. The evalset has NO `twins` field (twin-crediting is dead code for this
   fixture) — the translation plan's twin-retention gate is incoherent for a
   displacement lever and left the real risk (metric regression) ungated.
5. Translation draws move the hit count by ±2 between runs; any single-draw
   simulation is inside noise (the workstream's own N=3 rule).
6. All six es cases have zero recorded passages — es transfer is uncheckable
   until fixtures are completed.

## The corrected sequence

- **Step 0 — 15×800 default-confirmation run (STARTED 2026-09-10).** Fresh
  no-selection run on deployed QA at `--knob max_passages=15 --knob
  passage_chars=800`, 3 passes, judge glm-5.3@max (stability guardrail).
  Compare vs `2026-09-09-answer-noselection-maxpass15-3pass-qa.json` (isolates
  passage_chars) and vs `2026-09-09-answer-noselection-pchars800-3pass-qa.json`
  (drift check: QA corpus 206 docs vs 201 at baseline, PR #415/#419 merged
  since). If it reproduces (strict ≈0.151, precision non-regression), a
  route-defaults PR (src/app/api/answer/route.ts) follows — §10.4: the
  confirmation precedes shipping. Record per-case sent-passage composition
  under both defaults.
- **Step 1 — snapshot with a validity gate.** Extend the committed
  `--pool-realistic` instrument: reconstruct pools + score maps for ALL 10
  measurable cases; acceptance = byte-reproduce the recorded runs per case for
  the recorded query texts (shipped 0/14; grounding r1 5/14, r2 7/14). Fix the
  `expected_detail` ambiguity: record below-cut ranks AND pool membership for
  every expected chunk.
- **Step 2 — decomposition census (nearly free, once Step 1 exists).**
  (a) pool-absence census (the q5/chunk_209 seeding trace — a recall-class fix
  may dominate everything); (b) top-15 occupancy by class (same-doc siblings,
  own-doc summary/TOC, index-0, EN-twin, other docs); (c) margin census
  (distance-to-cut for missing-but-in-pool chunks); (d) **cut-size sweep
  15/20/25** (free; if cut=20 recovers most of the 14, the rule program is
  dominated by a one-line config change plus a send-budget conversation).
- **Step 3 — rule grid only if admitted.** Production-implementable rules only
  (no answer-key-keyed rules — those are labeled ceiling probes); per-doc
  representation cap leads the menu; ≥3 translation draws per case with the
  no-rule band reported; per-case reporting, never pooled-only; counter = the
  same containment function as `evidence_coverage` (ID-count alongside).
  **Promotion gate:** nothing graduates on simulation — graduation requires a
  live flag-on eval at N=3 with evidence_coverage non-regression per
  measurable case, strict fact_recall improvement, citation precision
  non-regression.
- **Step 4 — retire the twin-retention gate in writing.** Replacement rollout
  guard: an EN-query regression check, not slot preservation.
- **Parallel track — evalset fixture completion (submodule PR):** add the
  `twins` field (schema work, un-cripples twin-crediting), passages for the 26
  orphan facts (6 es cases unmeasurable today), doc_sets restructure. This is
  the prerequisite for Step 3's promotion gate being meaningful at all.
- **Standing items:** third grounding run (the diagnosis rests on N=2);
  ANSWER_TRANSLATION_TIMEOUT_S decision + extraction-cost measurement remain
  activation prerequisites if the translation track is ever revisited; price
  any new lever against the recorded variant sweep (orjoin/augment/termdense
  in pool-probe-q3.json) before proposing it.

## Working conventions (standing)

- All work in git worktrees (`.worktrees/<topic>`, branch off `origin/qa`,
  upstream UNSET — pushes must be explicit; never bare-push). Carryover per
  worktree: root `.env`, `search-service/.env.local` (hold-aside rule for
  Bedrock), symlink `search-service/venv`, needed artifacts from
  `evaluation/answer/artifacts/`.
- PR to `qa` only; never `main` (merging to main IS a production deploy).
- No evalset-derived content in any prompt. N=3 before believing deltas.
  Judge glm-5.3@max for every comparison. Probe-gate every prompt change —
  with the pool-realistic instrument, not the 20-source batch.

## Ruling T4 (written 2026-09-10): the twin-retention gate is retired for this program

The translation plan's "EN-twin chunks retained" gate is retired as a gate for
any displacement lever (per-doc caps, demotions), for four reasons: (1) the
lever's mechanism IS displacement — the gate vetoes its own mechanism; (2) the
evalset has no `twins` field, so twin-crediting is dead code and the gate
preserves a population the metric cannot value; (3) it forces self-defeating
rules (floor-protecting baseline winners burns zero-sum slots against the
hits goal); (4) it came from a falsified prediction (design §3.4 "coexist in
the 15" — 25–27 displaced in measurement). Replacement rollout guard: an
EN-query regression check (flag-on must not degrade EN-only answer quality on
measurable cases) plus the standard metric gates (evidence_coverage
non-regression per measurable case, citation_precision non-regression,
unsupported rate non-regression). Coexistence is a welcome outcome, not a
gate (q5 r2 achieved 6 twins kept AND 2/3 expected hits naturally).
Carryover recipe amendment (2026-09-10): root .env.local must ALSO be copied into each worktree — its absence produced 6 npm-run migration errors in the jest suite (SSL-vs-local-docker); clean qa passes them.
- 2026-09-10: PR #425 MERGED (c035a62) after all-green CI — QA deploys with gpt-5 synthesis defaults 15 passages x 800 chars (confirmed 2x strict recall). Worktree answer-defaults-15x800 + branch deleted per finishing process. Step 0 SHIPPED. Remaining: T1 independent re-review + premise-checker re-run queued behind registry exclusion (expires 2026-09-11T22:02Z); bucket2 branch open pending that review; T5a queued behind both.

## Resolved observation (2026-09-10): 20-docs → 0 passages — NOT a product bug

Controller repro (throwaway jest test, deleted after): the second `post()` in
one test returned `passages_sent: []` with `debug.docListCreated = {count: 15,
totalBeforeFilter: 15, hasContent: true}` and `fallbackReason: "exception"`.
Root cause: the suite's fetch mock uses `mockResolvedValue(modelReply(...))`,
which returns the SAME Response object for every call; a Response body is
single-use, so the second synthesis call's `.json()` throws and the route's
designed exception fallback returns ok:true with no passages. The 20-doc cap
path itself is correct (allDocs sliced to MAX_PASSAGES_CAP=15 before the doc
list). Follow-ups: (1) test hygiene — switch the mock to
`mockImplementation(async () => modelReply(...))` in the next PR touching
`src/__tests__/answer-route.test.ts`; (2) remember when reading eval captures
that `fallbackReason: "exception"` means the model saw nothing.
