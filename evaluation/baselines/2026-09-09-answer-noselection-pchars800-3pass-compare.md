# passage_chars 400→800 (at max_passages=15) — second measured lever, N=3

**Date:** 2026-09-09
**Run:** `pchars800-3pass-noselection-20260909` vs `maxpass15-noselection-20260909` (1 pass)
**Change:** `--knob max_passages=15 --knob passage_chars=800 --passes 3` against deployed QA.
Same fixture (`evalset-answer-02@1dcbeab`), gpt-5.4-mini synthesis, glm-5.3 @ max judge.

## Result (draft block, 16 cases × 3 passes)

| Metric | baseline (8×400) | maxpass15 (15×400, 1p) | **pchars800 (15×800, 3p)** |
|---|---|---|---|
| fact_recall_strict | 0.070 | 0.093 | **0.151** |
| fact_recall_lenient | 0.583 | 0.602 | **0.615** |
| citation_precision | 0.979 | 0.979 | **0.993** |
| unsupported_claims_rate | 0.125 | 0.000 | 0.083 (9 over 45 judged passes) |
| selection_utilization | 0.184 | 0.230 | 0.230 |
| evidence_coverage / aR / chunk hits | 0.157 / 0.844 / 0.099 | same | same (retrieval untouched) |
| compliance | 16/16 | 16/16 | 48/48 |
| cost | $0.032 | $0.032 | $0.097 + 302k/411k judge tokens (218 calls) |

Ten cases now have nonzero strict recall (five at 15×400). Per-case 3-pass
spreads: several flat (q6 0.667, q8 0.4, q13 0.25, q3 lenient 1.0), a few wide
(q4 0–0.5, q5 0–0.33) — the macro-mean over 48 passes is the trustworthy number.
Caveat: the 15×400 reference is a 1-pass run; the matched 3-pass reference
(`maxpass15-3pass-noselection-20260909`, captured, judging separately) is the
formal comparison for any default proposal. Compare tool refuses cross-pass-count
diffs by design, so the table above is manual.

## Why the mechanism is context, not exact-chunk recovery

The expected chunks that make the 15-chunk list are short (~160–310 chars) with
the fixture snippet at offset 0 — fully delivered even at 400 chars. The one
baseline "truncation loss" (q9 chunk_154) turned out to be chunk-boundary drift:
the snippet no longer lives in that chunk's text at all (it exists elsewhere in
the doc; preflight's snippet-derived lookups pass). So 800 chars adds no
exact-chunk evidence; the strict-recall gain is richer context around the same
top-15 — the model extracts more complete statements from longer passages.

## Judge tombstones (harness follow-up, now confirmed pattern)

3 `unsupported_claims` items timed out (fixed 300 s judge timeout, retried once —
all three retried and timed out again). At 15 passages × 800 chars the
unsupported-claims prompt (full passage set) exceeds the fixed 300 s timeout
deterministically. Excluded from means, never zero. Follow-up: expose a judge
timeout knob and/or trim the unsupported-claims passage set. With this cell
judged, the grid's `full` level (and any wider `max_passages`) will hit the
same wall.

## Artifacts

- Report: `evaluation/baselines/2026-09-09-answer-noselection-pchars800-3pass-qa.json`
- Raw (gitignored): `evaluation/answer/artifacts/{capture,judged,report}-pchars800-3pass-noselection-20260909.json`
- Matched 3-pass reference (15×400): capture done, judging queued — commit to follow.
