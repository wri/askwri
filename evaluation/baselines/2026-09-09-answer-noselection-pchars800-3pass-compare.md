
## Update — the matched N=3 reference (landed after the 1-pass table above)

The 15×400 config re-measured at 3 passes (`maxpass15-3pass-noselection-20260909`,
same fixture/judge): **strict 0.103** (not the 1-pass 0.093), lenient 0.568,
precision 0.976, unsupported rate 0.052. The formal same-pass-count comparison:

| Metric | 15×400 (3p) | 15×800 (3p) | Δ |
|---|---|---|---|
| fact_recall_strict | 0.103 | **0.151** | **+0.048** |
| fact_recall_lenient | 0.568 | **0.615** | +0.047 |
| citation_precision | 0.976 | **0.993** | +0.017 |
| unsupported_claims_rate | 0.052 | 0.083 | +0.031 |
| all retrieval metrics | — | — | byte-identical (send-side knob only) |

The passage_chars effect is real at matched pass counts. Cost of the confirm:
~150k judge tokens; reference committed at
`2026-09-09-answer-noselection-maxpass15-3pass-qa.json`.
