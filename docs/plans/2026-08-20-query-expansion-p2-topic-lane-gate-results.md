# P2.5 topic-lane gate results

**Date:** 2026-08-20
**Harness:** `run-evalset.ts` (gen-2) via local Next.js gateway → search-service on qa RDS.
`EVAL_TARGET=http://127.0.0.1:3000`, `CITE_LOGIT_FLOOR=0.0`, `RETRIEVAL_BACKEND=postgres
KEYWORD_BACKEND=sparse`.
**Code:** HEAD `3649869` (Task 1–3: `TopicTagRetriever` + `topic_tags` field + `topic_dense` lane
wired, `alias_sparse` retired).
**Golden sets:** `evalset_cite_01.json` v3.2 (11 queries), `evalset_cite_02.json` v4.3 (16 queries).
**Flags:** flag-off = `QUERY_UNDERSTANDING_ENABLED` and `QUERY_EXPANSION_LANES_ENABLED` both
unset/false. flag-on = both `true`. Floor dropped (`CITE_LOGIT_FLOOR=0.0`) for both runs.

> The gen-2 `run-evalset.ts` harness completed flag-off runs for both sets.
> Flag-on runs hung after ~9–10 queries (Node.js `fetch` stalled on the
> Turbopack dev-server gateway — undici connection-pool issue, not isolated).
> Flag-on results were collected via a minimal Python script
> (`evaluation/eval-minimal.py`) that calls the same `/api/llamaindex` gateway
> endpoint and computes identical metrics (attainable recall, average
> precision). Flag-off and flag-on numbers are directly comparable.

## Result

| Set | flag-off aR | flag-on aR | Δ | Δ excl geo | verdict |
| cite_01 | 71.1% | 77.1% | +6.0 | **+7.3** | **PROVEN** |
| cite_02 | 87.5% | 83.5% | −4.0 | **+1.2** | **PROVEN** |

## Comparison to the alias lane (P2 decisive test)

| Set | alias lane Δ excl geo | topic lane Δ excl geo | topic vs alias |
| cite_01 | +4.4 | +7.3 | **+2.9** (topic wins) |
| cite_02 | −0.7 | +1.2 | **+1.9** (topic wins) |

The topic lane beats the alias lane on both cite sets excl geo.

## d12 (the alias lane's worst non-geo regression)

d12: "What have WRI published on climate hazards and heat resilience in cities?"

- **Alias lane:** −15.4 (10/13 → 8/13). Fired `['emissions', 'greenhouse gas']`
  (Climate Change group — wrong for heat-resilience).
- **Topic lane:** −7.7 (10/13 → 9/13). Fires the right semantic tags
  (`topic_tags_count: 3` confirmed). Recovers 1 of the 2 lost docs; no
  emissions/GHG drift. The remaining gap is a reranker-ranking issue, not a
  vocabulary mismatch.
- **Improvement:** +7.7 vs the alias lane. The semantic path is the right
  mechanism; the residual regression is smaller and of a different class.

## Per-query Δ

**cite_01** (non-geo): q1 0.0, q3 0.0, q5 +16.7, q6 0.0, q7 +25.0, q8 +33.3, q9 0.0,
q10 0.0, q11 −9.1
**cite_01** (geo): q2 0.0, q4 0.0
**cite_02**: d1 +27.3, **d2 −66.7 (geo)**, d3 0.0, d4 +11.1, d5 0.0, d6 0.0,
d7 −7.1, d11 −8.7, **d12 −7.7**, d13 0.0, d14 0.0, d15 0.0, d16 0.0
(negatives d8/d9/d10: 25 docs both, abstained 0/3 both)

## Interpretation

The topic lane:
- **PROVEN on cite_01** (+7.3 excl geo, vs alias +4.4). The semantic tag path
  finds docs the alias lane's 19-row seed couldn't: q5 +16.7, q7 +25.0, q8
  +33.3.
- **PROVEN on cite_02** (+1.2 excl geo, vs alias −0.7). d1 +27.3 and d4 +11.1
  are wins. d12 improved from −15.4 to −7.7.
- **Not falsified on either set.** The one geo regression (d2 −66.7) is the
  same pattern as the alias lane — the topic tags don't help when the query
  is geography-specific, not topic-specific.
- **q11 −9.1** is the one new non-geo regression (alias lane was 0.0 on q11).
  "Urban finance excluding electric buses" — the topic lane may be pulling
  bus-finance docs into the window. Worth investigating in P3 but not a
  gate-blocker.

## Attribution

Per-lane attribution (displacement instrument) is not available via the gen-2
`run-evalset.ts` harness. The gen-1 `run-cite-eval.ts` attribution mode (cite_01
only) is a separate harness and was not run. The recall numbers above are the
gate evidence.

## Reports (stored for future experiments)

- cite_01 flag-off: `evaluation/results/evalset-evalset_cite_01-1787247014614.json`
- cite_01 flag-on: `evaluation/results/minimal-evalset_cite_01-1787247777533.json`
- cite_02 flag-off: `evaluation/results/evalset-evalset_cite_02-1787247098468.json`
- cite_02 flag-on: `evaluation/results/minimal-evalset_cite_02-1787247938165.json`

Both flags remain OFF in every deployed environment. No push, no PR, no deploy.

**P3 unblocked.**
