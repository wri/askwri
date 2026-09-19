# max_passages 8→15 — first measured lever against the no-selection baseline

**Date:** 2026-09-09
**Run:** `maxpass15-noselection-20260909` vs `baseline-noselection-20260909` (PR #412)
**Change:** one synthesis knob, `--knob max_passages=15` (route default for gpt-5 models is 8).
Everything else identical: same fixture (`evalset-answer-02@1dcbeab`), deployed QA
gateway, gpt-5.4-mini synthesis, judge glm-5.3 @ reasoning max, 1 pass, 16 cases.

## Result

| Metric | baseline | maxpass15 | Δ |
|---|---|---|---|
| fact_recall_strict | 0.070 | **0.093** | +0.023 |
| fact_recall_lenient | 0.583 | **0.602** | +0.019 |
| unsupported_claims_count | 5 (rate 0.125) | **0** | −5 |
| selection_utilization | 0.184 | **0.230** | +0.045 |
| evidence_coverage | 0.157 | 0.157 | 0 (by construction — see below) |
| attainable_recall / chunk_id_hit_rate / doc_map | 0.844 / 0.099 / 0.776 | 0.844 / 0.099 / 0.770 | ~0 |
| citation_precision | 0.979 | 0.979 | 0 |
| compliance (valid/parsed/English) | 16/16 | 16/16 | 0 |
| cost | $0.032 retrieval | $0.032 | 0 (route reports no usage; input grew ~2×) |

All five baseline unsupported claims resolved. Per-case movements (1 pass — expect
noise): up q5 (lenient 0→0.667), q8 (strict 0.2→0.4), q13/q16 (strict 0→0.25),
q9 (lenient +0.167), q11 (lenient +0.25); down q6 (strict 0.667→0.333, a
borderline compound-fact judge call on essentially the same answer text) and
q3 (lenient 1.0→0.667). Judge spot-checks (q3/q5/q6/q9, both runs) found every
verdict defensible.

`evidence_coverage` cannot move under this knob: it is computed over the
15-chunk retrieval list (full text), not what the route sends. It measures
retrieval-side delivery, which this change does not touch.

## Why this lever (diagnostics from the baseline, 2026-09-09)

Of the 52 expected passages across the 10 measurable cases (q11–q16 have no
expected passages — 26 `facts_no_passage`), the baseline breakdown is:

- **5 sent** to the model,
- **3 in the 15 but cut by the top-8 send budget**,
- **44 (85%) never in the 15-chunk list at all**.

The top-8 cut is what `max_passages=15` removes — and it matters more than the
exact-chunk count suggests, because the English twins carry the same facts in
English: e.g. q4's EN-twin fact-bearing chunks (109/110) sat at ranks 14–15,
sent now for the first time. q6 already proved the model states facts fully
(strict 0.667) when twin content reaches it, while `evidence_coverage` stays 0
(the fixture has no `twins` entries — all 16 cases are zh/es sources).

### The lever that was falsified first (recorded so nobody re-runs it)

Widening the rerank candidate pipeline does **not** deliver the zh evidence.
Probe (local search-service mirrored against the QA RDS, read-only query path,
`RERANK_CANDIDATES=400` + lanes/window 500): the expected zh chunks sit at
dense ranks 292–460 (fused 255–363) for q3 and fused 163–307 for q4 — inside a
400-candidate rerank input, Cohere Rerank 3.5 **still ranked them below the
chunks that already win** (q3's final 15 was chunk-identical to baseline). The
cross-lingual rank gap lives in relevance scoring (dense embedding and reranker),
not in the window. That is the bucket-2 workstream (query translation for
answer mode, zh-side boosts, multilingual handling), and it is where the 85%
"never in the 15" mass actually sits.

Also falsified as-implemented: `answer_rerank_per_doc_cap` operates on the
candidate input with backfill, so with ≤5 docs in the window it changes nothing
(the backfill refills the same chunks).

### Structural notes carried forward

- `top_doc_share = 1.0` on 7/16 cases: the 15-chunk list is one document.
- `rank_gaps`: 16 passages across 7 cases (q1:2, q2:2, q3:5, q4:1, q5:3, q6:1, q8:2).
- Judge tombstone: 1 unjudged item this run (q10 `unsupported_claims` — the
  15-passage prompt doubled the input and exceeded the fixed 300 s judge
  timeout twice). Harness follow-up: expose a judge timeout or trim the
  unsupported-claims passage set; score excludes it from means (never zero).
- The QA-RDS mirror technique (local service + `DATABASE_URL` to QA RDS,
  `search-service/.env.local` moved aside so MinIO AWS vars stay out of the
  boto3 chain, config knobs via env) is the cheapest safe way to probe
  service-config changes without a deploy. Query path is read-only; parity
  with the gateway is top-6 stable, tail jitter from the query-variant LLM lane.

## Recommendation

Do not ship `max_passages=15` as a default from this single 1-pass run — the
guardrail applies (N=3, no-selection confirmation, cite-mode sanity check). The
signal justifies the follow-up sweep (`passage_chars` 400→800 at both passage
counts, and `max_passages=12`) and keeps priority on bucket 2 (cross-lingual
retrieval) for the 85% mass, plus the evalset PR (twin passages, the 26 orphan
facts) so `evidence_coverage` can see English-twin delivery at all.

## Artifacts

- Report: `evaluation/baselines/2026-09-09-answer-noselection-maxpass15-qa.json` (this directory)
- Raw (gitignored): `evaluation/answer/artifacts/{capture,judged,report}-maxpass15-noselection-20260909.json`
- Compare command:
  `npm run eval:answer-compare -- evaluation/baselines/2026-09-09-answer-noselection-qa.json evaluation/baselines/2026-09-09-answer-noselection-maxpass15-qa.json`
