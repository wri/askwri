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

**Status:** mechanism validated on the local corpus. The qa deploy remains a
separately gated exercise: apply qa `title_en` repairs → set
`SPARSE_EN_HANDLES=true` in backfill shell AND ingestion-worker env (two
terraform surfaces) → flag-on rebuild (worker idle) → capture/analyze cite
scores → floor config → eval:cite at the derived floor.
