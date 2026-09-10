# 15×800 default confirmation — passage_chars 400→800 at max_passages=15, N=3 (2026-09-10)

**Decision being confirmed:** route defaults for gpt-5 models change to
`max_passages=15`, `passage_chars=800` (was 8 × 400). Per the two-step spec
§10.4, a fresh `no-selection` confirmation run precedes shipping the default —
this is that run.

**Run:** `knobconfirm15x800-3pass-20260910` — deployed QA gateway, evalset
`evalset-answer-02@1dcbeab`, `--selection-mode no-selection --passes 3
--knob max_passages=15 --knob passage_chars=800`, synthesis gpt-5.4-mini,
judge glm-5.3 @ reasoning max (stability guardrail unchanged).

## Result — two comparisons

**vs the matched N=3 reference `maxpass15-3pass-qa` (isolates passage_chars
400→800; both arms 15 passages × 3 passes, same fixture, same judge):**

| metric | 15×400×3 | **15×800×3 (confirmed)** | Δ |
|---|---|---|---|
| fact_recall_strict | 0.103 | **0.163** | **+0.060** |
| fact_recall_lenient | 0.568 | **0.648** | +0.081 |
| citation_precision | 0.976 | **1.000** | +0.024 |
| unsupported_claims_count | 6 | 8 | +2 (rate 0.052→0.069) |
| evidence_coverage / chunk_id_hit_rate / aR | 0.157 / 0.099 / 0.844 | identical | +0.000 (retrieval untouched) |

**vs the original measurement `pchars800-3pass-qa` (drift check — QA has since
absorbed #415/#419/#423):**

| metric | pchars800 (2026-09-09) | confirmed (2026-09-10) | Δ |
|---|---|---|---|
| fact_recall_strict | 0.151 | 0.163 | +0.012 (reproduced within N=3 noise) |
| fact_recall_lenient | 0.615 | 0.648 | +0.034 |
| citation_precision | 0.993 | 1.000 | +0.007 |
| unsupported_claims_count | 9 | 8 | −1 |

Against the original 8×400 baseline (PR #412) the shipped strict recall moves
**0.070 → 0.163** — more than doubled, reproduced on today's QA at N=3, with
citation precision at 1.000.

## Watch item

unsupported_claims moved +2 sentences vs the matched 15×400 reference
(6→8; rate 0.052→0.069) — small-number territory at N=3, and the direction was
known from the first measurement (9 vs 0 at 1 pass). Precision improved in the
same comparison. Carry as a standing watch item on the next periodic no-selection
run; do not re-tune on this delta alone.

## §10.4 statement

The confirmation run was executed BEFORE this default ships (this PR is the
shipping step). Retrieval-side knobs are untouched; the change is
synthesis-side only (what the model is sent), which is why evidence_coverage /
chunk_id_hit_rate / attainable_recall are identical by construction. Cite mode
does not consume these knobs; `eval:cite` is unaffected.

## Artifacts

- Report (committed): `evaluation/baselines/2026-09-10-answer-noselection-knobconfirm15x800-3pass-qa.json`
- Raw (gitignored, answer-eval worktree): `evaluation/answer/artifacts/{capture,judged,report}-knobconfirm15x800-3pass-20260910.json`
- Compare commands:
  `npm run eval:answer-compare -- evaluation/baselines/2026-09-09-answer-noselection-maxpass15-3pass-qa.json evaluation/baselines/2026-09-10-answer-noselection-knobconfirm15x800-3pass-qa.json`
  `npm run eval:answer-compare -- evaluation/baselines/2026-09-09-answer-noselection-pchars800-3pass-qa.json evaluation/baselines/2026-09-10-answer-noselection-knobconfirm15x800-3pass-qa.json`
