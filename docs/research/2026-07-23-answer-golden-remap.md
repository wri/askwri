# Answer golden-set chunk-ID remap — execution record (2026-07-23)

Task 1 of `docs/plans/2026-07-22-answer-eval-rewrite.md`. Regenerates the
answer golden set's chunk-level ground truth against the current
Mistral-parsed, cohere-embedded local corpus.

**Why:** `chunk_id` is positional (`{doc_id}_chunk_{idx}`, built at
`search-service/app/indexing.py:360`), so any re-parse renumbers every chunk.
The 2026-07-22 Mistral re-parse invalidated all of them. Doc-level ground
truth survives re-chunking; chunk-level does not. The visible symptom was
ans_002 scoring **0% at chunk level in every run**, old pipeline and new.

## Environment

- Local search service on :8000, `documents_count` 171, `retrieval_backend`
  postgres, `keyword_backend` sparse, dense lane **live** (Bedrock
  cohere-embed-v4).
- Bedrock reachability required commenting out the fake MinIO
  `AWS_ENDPOINT_URL` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in
  `search-service/.env.local` (they load via `load_dotenv(override=False)`
  and beat the real `~/.aws` provider). **Restored afterwards.**

## Result

`npx tsx evaluation/map-passages-to-chunks.ts --remap`

- Mapped **190**, skipped 0, failed 0.
- **No low-overlap passages.** Minimum overlap **34.1%**, above the 0.3
  manual-relabel threshold — so no snippet needed hand-editing. Plan Step 4
  was a no-op, which is the good outcome: Mistral's OCR preserved the
  passages well enough to re-locate every one.
- `expected_doc_ids` **byte-identical** to the backup across all 9 cases.
- 177 of the 190 chunk IDs changed; all 177 distinct IDs resolve against
  `document_chunks.legacy_chunk_id`. Zero unresolved.

## Decision: dedupe expected_passages by chunk_id (190 -> 178)

Re-chunking at `chunk_size=400` collapsed some formerly-distinct passages
into a single chunk: **12 intra-case collisions** across 6 cases.

This is not cosmetic. `calculateChunkMetrics` pushes one `exact_matches`
entry per EXPECTED passage while `retrieved` holds each chunk once, so a
duplicated `chunk_id` inflates `tp` against an un-inflated
`retrieved.length` — the same double-count class PR #250 fixed for adjacent
credit, reachable here through duplicate expected entries. With `tp` up to
21 against `retrieved.length` 15 it could push precision above 1 and trip
`assertChunkMetricsValid`.

Resolution: collapse duplicates, keep the first passage. Two passages that
now live in one chunk *are* one expected chunk; fabricating a second-best
chunk to avoid the collision would be inventing ground truth. Dropped
snippets recorded below for provenance.

| Case | Collapsed chunk_id |
|---|---|
| ans_001 | `..._sao-paulo-addis-ababa_4308_chunk_4`, `..._chunk_17` |
| ans_003 | `..._stronger-ndcs-with-cities-states-and-regions_3703_chunk_27`, `..._chunk_5` |
| ans_005 | `..._financing-electric-and-hybrid-electric-buses-10_6301_chunk_11`, `..._chunk_36` |
| ans_006 | `..._accelerating-nature-based-solutions-in-brazilian_3331_chunk_15`, `..._chunk_4` |
| ans_007 | `..._multilevel-action-for-community-led-climate_7058_chunk_4`, `..._unlocking-the-potential-for-transformative_9741_chunk_10` |
| ans_008 | `..._sustainable-urban-mobility-in-the-ndcs-the_7992_chunk_19`, `..._chunk_30` |

## Validation (`npm run eval:answer-retrieval`)

| Case | chunk P | chunk R | chunk P (adj) | doc F1 |
|---|---|---|---|---|
| ans_001 | 46.7 | 36.8 | 50.0 | 85.7 |
| **ans_002** | **26.7** | **28.6** | 30.0 | 76.9 |
| ans_003 | 66.7 | 47.6 | 70.0 | 100 |
| ans_004 | 60.0 | 37.5 | 66.7 | 100 |
| ans_005 | 20.0 | 20.0 | 36.7 | 100 |
| ans_006 | 40.0 | 35.3 | 40.0 | **28.6** |
| ans_007 | 46.7 | 41.2 | 46.7 | 72.7 |
| ans_008 | 73.3 | 50.0 | 73.3 | 66.7 |
| ans_009 | 46.7 | 24.1 | 50.0 | 66.7 |

Aggregate: chunk P 47.4 / R 35.7 / F1 40.3; adjacent P 51.5 / R 39.1 /
F1 44.0; **doc P 88.1 / R 77.0 / F1 77.5**.

- **ans_002 is no longer 0%** — the stale-ID hypothesis is confirmed.
- **No case exceeds 100% precision**; `assertChunkMetricsValid` never fired.
- Doc-level F1 77.5 is unchanged from the pre-remap reference, as expected:
  the remap touched only chunk IDs, and doc IDs were verified stable.

## Still open

- **ans_006 doc-F1 28.6** — the embed-v4 single-doc concentration regression
  is untouched by this task and now cleanly measurable. It is the target of
  the per-doc-cap A/B (Task 3), for which the `answer_rerank_per_doc_cap`
  setting now exists (default `None`, no behaviour change).
- Chunk-level recall is capped by construction: cases expect 14-29 passages
  but answer mode returns `maxResults: 15`. Recall above ~50% is unreachable
  for the larger cases regardless of retrieval quality — worth rescoping the
  expected sets or reading chunk recall only relative to that ceiling.
- If the answer eval is ever retargeted at the deployed qa corpus, this
  remap must be re-run: qa's chunk IDs differ from local's and change again
  with the 2026-07-23 Phase D re-parse.
