# sparse_en_handles BEFORE/AFTER gate results (2026-07-26)

Plan Task 10 execution record. **All five spec §3.4 gates PASS.**

**Rig:** LOCAL docker corpus (`askwri-pg`/`qa` db, 171 searchable docs,
28,164 sparse chunks), search service run from the worktree with real AWS
creds exported over `.env.local`'s MinIO placeholders (dense + rerank lanes
live via Bedrock us-east-1; the MinIO-creds-shadow-Bedrock footgun is real —
see runbook note). **Includes the Task 9 `title_en` repairs (`_9425`,
`_3254`), which qa does NOT yet have** — qa deltas will differ on those two
docs until `2026-07-26-title-en-repairs-qa-deferred.md` is applied.
Flag-on rebuild: `29 non-EN docs; 27 inject a title handle, 29 an English
summary`; avgdl 200.4 → 202.9.

| Gate | Result |
|---|---|
| 1. `eval:cite` no-regression | **PASS** — P 28.6→28.7, R 81.1→81.1 (identical), F1 41.0→41.3 |
| 2. `eval:answer-retrieval` no-regression | **PASS** — byte-identical (chunk 40.3 / adjacent 44.0 / doc 77.5) |
| 3. Probe benefit (`en-topical`/`en-tr` up, `en-body` flat) | **PASS** — see below |
| 4. Competitor displacement | **PASS** — bm25 slips of 1–2 ranks on a few competitors; finals flat or improved (`_3374` 34→17, `_7541` 9→8); no systematic top-10 loss |
| 5. Non-EN smoke (dl-inflation cost) | **PASS** — 0 of 14 queries changed ANY lane rank |

**Gate 3 highlights** (rerank-off arm; full data in
`evaluation/results/cross-lingual-probe-{before,after}*.json`):

- Five outright bm25 misses recovered: `_3387` **—→1** (the findings §2.3
  rank-93 case; final 7→1), `_2940` —→6 (final 4→1), `_2317` —→44,
  `_3765` —→41, `_9049` —→48 (final 31→22).
- `_1319` (one of the two genuine misses from 2026-07-24) bm25 4→1.
- Large bm25 lifts: `_9425` 56→17, `_6722` 26→9 (final 6→2), `_9845` 22→8,
  `_6237` 9→3, `_6748` 7→3, `_5869` 13→6.
- `en-body` class flat (±1-2 bm25 ranks, finals unchanged or +1) — exactly
  the designed immunity, confirming no accidental leakage into body scoring.
- Rerank-on arm consistent; the single target slip (`_1735` final 1→2,
  en-topical-net-zero-road) has an UNCHANGED bm25 rank — a rerank near-tie
  swap of the known q7/q10 class, not a sparse effect.

**Floor re-derivation:** deferred to the qa deploy. Cite recall was identical
and P/F1 moved +0.1/+0.3 at the existing 0.09 floor on this corpus; local
floor values don't transfer to qa (different corpus + deployed Bedrock path),
and the qa deploy runbook already mandates its own derivation.

**Status:** mechanism validated on the local corpus, and **ACTIVATED ON qa
2026-07-26 (~20:32 UTC)**:

- All three `title_en` repairs applied to qa RDS (provenance `human`; qa
  needed all three — see the executed stamp in
  `2026-07-26-title-en-repairs-qa-deferred.md`).
- Flag-on backfill committed against qa: 27,878 vectors, 0 NULL, vocab
  233,945, avgdl 200.4. `12 inject a title handle, 29 an English summary` —
  the lower title count vs local is CORRECT (qa zh docs' `title_en` equals
  their already-English indexed title, so the dedup skips them); handles
  verified present in `_3387`'s stored vectors. Worker scaled to 0 for the
  window and restored after.
- Floor re-derived on qa through the live Bedrock path: **0.09 HOLDS**
  (R 83.3 at 0.09; recall cliff to 78.8 at 0.10). No config change. Non-EN
  smoke targets rerank at 0.81–0.94.
- Worker env flag: `SPARSE_EN_HANDLES=true` recorded in
  `terraform/environments/qa.tfvars` (`ingestion_worker_environment_variables`
  — the non-secret surface; the runbook's `INGESTION_WORKER_ENV` secret is
  for actual secrets).

**qa latency exercise (2026-07-26, post-activation, deployed endpoint
`qa.askwri-app.org/api/llamaindex`, 20 queries × 2 passes):** multilingual-
surfacing queries cost the same as English-only controls — warm p50 1122ms
(topical, non-EN targets) vs 1106ms (English controls); cold p50 1353 vs
1243. EMF per-stage (n=40): total 1085ms avg = rerank 604 + stage1 479
(dense 473 ∥ sparse 265 — the handle-injected sparse lane sits entirely
inside the dense lane's shadow; zero critical-path cost, as designed).
18/20 queries surfaced non-EN documents, 9 of them at final rank ≤ 3.

Production remains un-activated (separate corpus, separate exercise).
