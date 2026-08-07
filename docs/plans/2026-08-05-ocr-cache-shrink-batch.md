# OCR cost & oversize fixes: parse cache, Ghostscript shrink, Batch API

Proposal (2026-08-05), follow-ups from PR #314 / issue #310. Three worker-side
changes, ranked by value. Costs quoted at Mistral OCR 4 pricing ($4/1k pages
API, $2/1k batch). Honest scale note up front: at today's corpus size
(~200 docs × ~50 pp ≈ 10k pages) a full re-OCR is ~$40 — the cache's dominant
win is **latency and reliability of re-ingest campaigns** (OCR is the slowest
stage; 900s timeout per doc), with cost savings growing as the corpus does.

---

## Fix 1 — Parse cache: never re-OCR unchanged bytes (do first)

**Claim it rests on (verified):** re-ingest re-runs `parse` including the
Mistral call even when the PDF bytes are unchanged. `documents.content_hash`
already exists (sha256, stamped by intake at `worker/intake_s3.py:24,41-44`;
NULL for CSV-era rows) and `document_texts` is keyed 1:1 by document
(`1781280000000-Migration.ts:39-45`).

**Mechanism.** Cache validity = same bytes + same parser. Add three nullable
columns to `document_texts`:

```sql
ALTER TABLE document_texts
  ADD COLUMN IF NOT EXISTS parsed_content_hash text,
  ADD COLUMN IF NOT EXISTS parse_backend text,
  ADD COLUMN IF NOT EXISTS parse_model text;   -- '' for pypdf
```

- **Write path** (`parse.py` `run`, at the `document_texts` upsert
  ~`parse.py:348-355`): always stamp the three columns from
  `documents.content_hash`, `settings.parse_backend`, and
  `settings.mistral_ocr_model` (empty for pypdf).
- **Read path** (top of `run`, before `_load_pdf_bytes`): SELECT the stored
  row; if `parsed_content_hash` is non-NULL and equals `doc["content_hash"]`
  AND backend+model match current settings → **skip download and
  `_parse_pdf` entirely**, reuse stored `full_text`/`page_boundaries`, and
  fall through to the metadata-extraction LLM call and the
  prior_status/processing bookkeeping unchanged. Everything downstream
  (summarize/classify/embed under NEW prompts) still runs — that is the
  point: prompt campaigns re-run the cheap stages, not the OCR.
- Cache miss on ANY of: NULL hash (CSV-era docs), changed bytes (version
  replacement — intake updates `content_hash` on re-drop,
  `intake_s3.py:43`), backend flip (pypdf↔mistral), OCR model upgrade.
- Escape hatch: `FORCE_REPARSE=true` env (worker) bypasses the read path for
  deliberate re-OCR (e.g. after a Mistral quality regression).

**Activation is data-driven, no flag needed** — the read path can ship
enabled because it only ever hits when the stamps exist and match; every
pre-existing row has NULL stamps and misses. Per the repo's dark-ship
discipline the migration stays behavior-neutral; making the EXISTING corpus
cache-eligible is a separate, per-environment **gated ops step**, because the
correct `parse_backend` value differs by environment (qa is fully
Mistral-parsed since 2026-07-23; production is not):

```sql
-- qa only, after verifying qa's corpus is all-Mistral:
UPDATE document_texts dt
SET parsed_content_hash = d.content_hash,
    parse_backend = 'mistral', parse_model = '<current mistral_ocr_model>'
FROM documents d
WHERE d.id = dt.document_id AND d.content_hash IS NOT NULL;
```

Run that before the prompt-tuning `reingest_all` and the campaign performs
zero OCR calls.

**Tests.** Stage tests: (a) hit → `_parse_pdf` not called (monkeypatch
sentinel), stored text reused, metadata extraction still runs; (b) miss on
hash change / backend change / NULL; (c) `FORCE_REPARSE` bypass; (d) stamps
written on fresh parse. Pipeline test: ingest → re-ingest with a mocked OCR
counter asserting exactly one call.

**Risks.** Low. Worst case is a stale cache from a hand-edited
`document_texts` row — out-of-band edits aren't a supported path today.

**Effort.** ~half a day including tests. One migration
(`ADD COLUMN`, safe on qa and prod).

---

## Fix 2 — Ghostscript shrink-if-oversized (unblocks >50MB PDFs)

**Constraint (verified in #314):** Mistral OCR rejects >50MB files;
`MAX_FILE_BYTES` is pinned to 50MB so oversized uploads fail fast. The 59MB
`wri-india-nup-report.pdf` from issue #310 is currently blocked entirely.

**Mechanism.** In `_parse_pdf_mistral` (`parse.py:202-233`), when
`len(content) > MISTRAL_MAX_BYTES` (50MB constant), shell out to Ghostscript
on a temp copy and send the shrunk bytes to OCR. **S3 and the app keep the
original** — only the OCR submission shrinks:

```
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dNOPAUSE -dBATCH -dQUIET
   -dDownsampleColorImages=true  -dColorImageResolution=300
   -dDownsampleGrayImages=true   -dGrayImageResolution=300
   -dDownsampleMonoImages=true   -dMonoImageResolution=300
   -o out.pdf in.pdf
```

300 dpi, NOT the /ebook preset (150 dpi): vector charts pass through
untouched either way; 300 dpi protects OCR legibility of small labels in
raster figures. Typical oversized WRI reports carry 400-600 dpi imagery, so
2x+ shrink is expected. If gs fails or output is still >50MB → raise with a
clear message naming the size (job → error, visible in review queue).
Page-splitting (pypdf ranges, stitch text+boundaries) is the lossless
phase-2 fallback if real files ever defeat 300 dpi; don't build it
speculatively.

**Image change:** add `ghostscript` to the apt install in
`search-service/Dockerfile:17-22` (python:3.12-slim base; ~50MB layer).

**Then, as a separate decision:** once shrink is deployed and proven on the
59MB file, the intake cap can be raised (e.g. 100MB + proxy cap 105mb, the
values reverted in #314) because parse now has an answer for the 50-100MB
band. Do NOT bundle the cap raise with the shrink commit — prove the
mechanism first.

**Tests.** Unit: oversized synthetic PDF (embed a large image via pypdf) →
gs invoked, submission bytes < original, original bytes untouched; gs
missing → clear error. The 59MB real file is the manual acceptance probe.

**Effort.** ~half a day + a worker image deploy. No migration.

---

## Fix 3 — Mistral Batch API for bulk OCR campaigns (do last, smallest win)

**What it buys:** 50% off OCR ($2/1k pages) for exactly the high-volume
case. With Fix 1 in place, re-ingest campaigns do ~zero OCR, so batch only
matters for bulk NEW corpus imports (initial onboarding of another program's
corpus, a backfill after an OCR-model upgrade with `FORCE_REPARSE`). At
today's scale that's ~$20 saved per full-corpus OCR run — real but small.

**Shape: a standalone script, not a worker change.** The worker's per-doc
sequential pipeline is wrong for batch (async job, results arrive together).
Instead `search-service/scripts/batch_ocr.py`, run as a gated ops step:

1. Select target docs (`--where`, default: has PDF + NULL/lapsed cache
   stamps).
2. Per doc: upload the PDF via Mistral `/v1/files` and reference the signed
   URL in the batch entry — do NOT inline base64 data-URIs in the batch
   JSONL (a 50MB PDF becomes a 67MB JSONL line; the files route is the
   supported shape for large documents).
3. Submit the batch job, poll to completion, download results.
4. Write `document_texts` (full_text, page_boundaries, char_count) + the
   Fix-1 cache stamps directly — the Python side owns this table — then
   `queue.enqueue` each doc so the normal pipeline runs summarize→publish
   with a guaranteed parse cache hit.

Depends on Fix 1 (the stamps are what let the follow-up pipeline pass skip
OCR). **15-minute probe before building:** confirm against current Mistral
docs the batch endpoint's per-file/per-job size limits and that OCR requests
are batch-eligible with file references — the pricing pages assert the 50%
discount, but the exact job-shape limits were not verified in-session.

**Tests.** Dry-run mode asserting the JSONL/job payload shape; integration
is necessarily a manual ops run against the real API.

**Effort.** ~a day including the probe and dry-run mode.

---

## Sequencing

1. **Fix 1** now — it de-risks and de-costs the already-planned prompt
   re-ingest campaign (PR #314 follow-up), and Fix 3 depends on it.
2. Run the qa backfill ops step, then the prompt `reingest_all` (batch not
   needed — zero OCR calls).
3. **Fix 2** next time oversized pubs block a corpus update (the 59MB report
   is waiting on it; manual compression per the admin guide is the interim).
4. **Fix 3** when a bulk NEW-document OCR campaign is actually scheduled.
