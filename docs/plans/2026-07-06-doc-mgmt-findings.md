# Document Management System — Findings: 2026-07-06 Pass

**Status:** Findings log — additive to [`2026-07-01-doc-mgmt-review-findings.md`](2026-07-01-doc-mgmt-review-findings.md).
Branch `qa-wip-david`, HEAD `ce319ca`. Verified against the live local stack (170 docs,
30,529 chunks, pgvector 0.8.4, MinIO, search-service :8000 + app :3000).

**Why this doc exists:** the 2026-07-01 pass was a 5-way review of the *code*. This pass
was asked specifically to answer a new question — **"did all the metadata that was in the
original CSV actually make it into the DB?"** — and to collect any further issues. The
CSV-coverage question is genuinely new (not covered by the 2026-07-01 doc). The other
findings below are either new, or a status update on a 2026-07-01 finding (fixed / still
open). Nothing here re-litigates a 2026-07-01 finding without new evidence.

**Method:** direct DB queries + source review of the migration script, worker, admin API/UI,
and search-service. Three read-only `reviewer` subagents ran in parallel over the worker,
admin, and search-service subsystems (one worker dispatch re-scoped to the local-dev commit
and was discarded; the worker was reviewed by direct read instead). Live-DB evidence is
shown inline.

---

## 0. Answer to the CSV-coverage question — the headline

**Short answer:** all 169 CSV rows became 169 `documents` rows (no row loss), and **all 14
CSV metadata keys are preserved verbatim** in `documents.source_metadata.metadata` (jsonb)
for all 169 docs. **What did NOT make it into structured/queryable columns:**

| CSV key | In a structured column? | Where it lives | Surfaced in admin UI? |
|---|---|---|---|
| `Article Title` | ✅ `documents.title` | + source_metadata | ✅ editor |
| `Publication Title` | ✅ `documents.publication_title` | + source_metadata | ✅ editor |
| `DOI` | ✅ `documents.doi` | + source_metadata | ✅ editor |
| `YEAR published` | ✅ `documents.year_published` (int, [:4]) | + source_metadata | ✅ editor |
| `languages` | ✅ `documents.language` (primary) + `languages[]` | + source_metadata | ✅ editor (primary only — see N-A) |
| `wri_primary_office` | ✅ `documents.wri_primary_office` | + source_metadata + `document_tags` (facet `office`) | ✅ editor |
| `article_type` | ✅ `documents.article_type` | + source_metadata + `document_tags` (facet `doc_type`) | ✅ editor |
| `wri_programs` | ❌ (tag only — facet `program`) | source_metadata + `document_tags` | ❌ not editable (tag panel only) |
| `Sub-tag` | ❌ (tag only — facet `topic`) | source_metadata + `document_tags` | ❌ not editable (tag panel only) |
| **`All authors`** | ❌ **no column** | source_metadata only | ❌ **not surfaced at all** |
| **`URL`** | ❌ **no column** | source_metadata only | ❌ **not surfaced at all** |
| **`Date published`** (full date) | ❌ **no column** (only `year_published`) | source_metadata only | ❌ **not surfaced at all** |
| `summary` (long) | ❌ (→ `document_summaries` kind=long) | source_metadata + document_summaries | read-only summaries panel |
| `short_summary` | ❌ (→ `document_summaries` kind=short) | source_metadata + document_summaries | read-only summaries panel |

**Live-DB evidence (the counts that prove "no loss"):**
```
SELECT count(*) ...                                 → 170 total (169 searchable + 1 withdrawn canary)
count(*) FILTER (WHERE doi IS NOT NULL)             → 169
count(*) FILTER (WHERE year_published IS NOT NULL)   → 169
count(*) FILTER (WHERE publication_title IS NOT NULL) → 169
count(*) FILTER (WHERE article_type IS NOT NULL)    → 169
count(*) FILTER (WHERE wri_primary_office IS NOT NULL) → 169
count(*) FILTER (WHERE source_metadata IS NOT NULL) → 169
-- source_metadata.metadata key presence (all 169):
  'All authors' 169, 'URL' 169, 'Date published' 169, 'wri_programs' 169,
  'Article Title' 169, 'Sub-tag' 148  ← matches CSV (148 rows have Sub-tag)
```
So the **data is all there** — nothing was dropped. The gap is **discoverability and
editability**, not storage:
- `All authors`, `URL`, `Date published` exist *only* inside the opaque `source_metadata`
  jsonb. An editor cannot view or correct them from the admin UI, and admin search
  (`listAdminDocuments`) only `ILIKE`s `title`/`external_id` — you cannot find a doc by
  author or DOI. (Confirmed by `src/db/queries/documentsAdmin.ts:49` and the editor's
  `EDITABLE` list at `src/app/admin/documents/[id]/page.tsx:23-31`.)
- The design doc (`2026-06-09-…-design.md` §6) intended authors/URL/date to live in a
  `document_attributes` (typed attributes) table, which Phase 0 **deferred** (see
  `document-management.md §2`). So "no column for them" is *by-design-deferred*, not a
  migration bug. But "not even viewable in the admin UI" is a real curation gap.

**The one genuine migration-script data bug here is `documents.abstract`:**
- The `documents` table has an `abstract` column (migration `1781280000000`, entity
  `Document.entity.ts:31`, in `EDITABLE_FIELDS` at `documentsAdmin.ts:12`, rendered as an
  "Abstract" textarea in the editor at `page.tsx:27`).
- **It is 0/170 populated.** `migrate_csv_to_postgres.py` never writes it (the CSV `summary`
  goes to `document_summaries` kind=long, not `documents.abstract`); the worker never writes
  it (`grep abstract search-service/{app,worker,scripts}` → nothing writes the column);
  `importDocuments.ts` `mapRowToDocument` never sets it. The design (§7.1) says abstract
  comes from GROBID extraction, and GROBID was dropped (§9). So `abstract` is an **orphaned
  column**: a dead field the editor can dutifully fill, believing it influences search — it
  does not (retrieval reads `document_texts`/`document_chunks`/`document_summaries`, never
  `documents.abstract`).
- This was flagged by the admin reviewer as **P2-1 (dead column)**. See finding **N-A** below.

**Recommended resolution for the CSV question** (a product decision, not a given):
1. Decide whether authors/URL/date_published should become first-class (promote to columns
   or revive `document_attributes`) or stay jsonb-only. Either way, surface them read-only
   in the editor so editors can at least *see* them, and extend admin search to DOI/author.
2. Decide `abstract`'s fate: populate it from the CSV `summary`/`short_summary` (cheap,
   one-time backfill + worker change), or drop the column + editor field if it's truly dead.

---

## 1. Status of the 2026-07-01 findings (verified 2026-07-06)

Re-checked each 2026-07-01 finding against HEAD `ce319ca`.

| ID | 2026-07-01 finding | Status now | Evidence |
|---|---|---|---|
| B1 | Dockerfile omits `worker/` → crash-loop | ✅ **FIXED** | `search-service/Dockerfile:56` now `COPY --chown=appuser:appgroup worker/ ./worker/` |
| B2 | App intake `PutObject` on `intake/` denied by IAM | ❓ not re-verified (Terraform; out of local scope) | — |
| B3 | `config.py` `extra="forbid"` bricks boot | ✅ **FIXED** (5a5d3a4) | `config.py:8` `extra="ignore"` |
| R1 | Public PDF serving breaks at postgres cutover (start.sh skips S3 sync) | ❌ **still open** (this is the "R5" known-issue) | `start.sh` still conditional; recorded in `2026-07-02-next-steps-qa-deploy.md` 🟡 list |
| R2 | Worker never calls `setup_ssl_certificates()` | ❓ latent/dormant (flag unset) | unchanged; verify on QA |
| R3 | Worker `_build_nodes_for_doc` diverges from `indexing.build_nodes` (title/authors/file_path) | ❌ **still open** | `embed.py:32-39` unchanged; no test added |
| R4 | zh OpenCC `t2s` can misattribute page numbers | ❌ **still open** | `embed.py` still converts then reuses Traditional boundaries; no multi-page zh test |
| D1 | `IngestionJob.entity.ts` `onDelete:'SET NULL'` vs migration `CASCADE` | ❌ **still open** | `IngestionJob.entity.ts:18` still `onDelete: 'SET NULL'` (DB is correct; `migration:generate` would emit a spurious revert) |
| D2 | Import `OPEN_STATUSES` includes `needs_review` + read-then-insert race | ❌ **still open** | `importDocuments.ts:127` still `['queued','running','needs_review']`; `:194` still read-then-`save` (no `ON CONFLICT`) |
| D3 | Unvalidated import `s3_key` → cross-prefix S3 read + worker parse miss; **no role gate on `/api/import-documents` or `/file`** | ❌ **still open** | `importDocuments.ts:75` `s3Key = row.file_path` (no validation); `import-documents/route.ts:11` `requireIdentity(req)` with **no role arg**; `documents/[id]/file/route.ts:16` same |
| D4 | Mutation + audit not transactional | ❌ **still open** | all query modules still `save` then `writeAudit` separately |
| D5 | Import audit doesn't record the actor | ❌ **still open** | `importDocuments.ts:213` still `INSERT ... (source, action, entity_type, after)` — no `actor_user_id`; route still drops identity |
| D6 | `migrate_csv --reset` `TRUNCATE CASCADE` hits `ingestion_jobs` | ❌ **still open** | script unchanged |
| D7 | Migration `178130` unguarded destructive DELETE | ❌ **still open** (no-op on first push) | migration unchanged |
| P1 | `title_en` NULL for all 33 migrated non-English docs | ❌ **still open** | migration script unchanged; `title_en` still `title if language=="en" else None` |
| P2 | `bahasa`/`id` mapping diverges migration vs import (intentional, documented) | — | unchanged (documented drift, by design) |
| T1 | Parity tests not in CI | ❓ not re-verified | — |
| T2 | `corpus_order` order not pinned by test | ❓ not re-verified | — |

**Net:** of the 2026-07-01 code findings, **only B1 and B3 are fixed.** R1/R3/R4/D1/D2/D3/D4/D5/D6/D7/P1 remain. The two deploy blockers still standing from that doc are **B2 (IAM, Terraform)** and **R1 (PDF serving)** — both are deploy-side, flagged as known.

---

## 2. New findings — not in the 2026-07-01 doc

### Worker (reviewed by direct read of `search-service/worker/`)

**N-W1 — `language` stage collapses multi-language `languages[]` to a single code on re-ingest (data loss). [P1]**
- **Where:** `search-service/worker/stages/language.py:33-37` — `UPDATE documents SET language=%s, languages=%s, ...` where the second arg is `[lang]` (a one-element list from `detect()`).
- **Root cause:** the worker's language detection produces a single code; the stage overwrites the *array* `languages` with `[lang]`, destroying any multi-language value. The CSV migration preserves multi-language arrays (e.g. `{en,es}`, `{en,pt}`, `{zh,en}` — 7 such docs exist in the live DB).
- **Impact:** re-ingesting (or re-running the pipeline on) any of the 7 multi-language docs **irreversibly drops the secondary languages** from `languages[]`. The dense lane (`pg_store.py`) and the admin language filter (`documentsAdmin.ts:44` uses singular `language`) are unaffected for the primary, but any future "filter by any language in `languages[]`" feature or multi-language summary generation loses data. The admin reviewer flagged the *filter* mismatch (P2-9); this is the *data-destruction* version, which is worse.
- **Live-DB evidence:** `SELECT external_id, language, languages FROM documents WHERE array_length(languages,1) > 1` → 7 rows (`{en,es}`×3, `{en,pt}`×2, `{zh,en}`, `{en,zh}`). All currently consistent (`language = ANY(languages)`), but a worker re-ingest would break that.

**N-W2 — `embed` stage holds an open DB transaction + advisory lock across the OpenAI embedding round-trip. [P2]**
- **Where:** `search-service/worker/stages/embed.py` — the whole stage runs in one `with get_pool().connection() as conn:` block (psycopg3 autocommit-off ⇒ one transaction), and `_embed_texts(...)` (an OpenAI network call) happens *inside* that transaction, before the `pg_advisory_xact_lock` + `DELETE` + `INSERT` loop.
- **Root cause:** transaction scope is the whole stage, not just the DB writes.
- **Impact:** not a correctness bug (the DELETE/INSERT loop is atomic, which is good), but the `pg_advisory_xact_lock(_LOCK_KEY)` for `corpus_order` allocation is held for the entire embedding round-trip — so concurrent workers embedding different docs serialize on corpus-order allocation unnecessarily, and a slow/stuck OpenAI call holds an open transaction + lock. On a flaky network this extends lock-hold time and can exhaust the pool (`max_size=5`). Refactor: do the OpenAI call *outside* the lock/transaction, then open a short transaction for the DELETE+INSERT+corpus_order.

**N-W3 — `intake_s3._register` re-ingest path leaves `title` as the external_id and never backfills metadata. [P2, design-adjacent]**
- **Where:** `search-service/worker/intake_s3.py:43-50` — on `ON CONFLICT (external_id) DO UPDATE SET content_hash = EXCLUDED.content_hash`, only `content_hash` is updated. The doc's `title` (set to `external_id` at intake, `:47`), `language`, `year_published`, etc. stay NULL/placeholder unless the pipeline derives them.
- **Root cause:** intake intentionally inserts minimal metadata; the pipeline (parse→language→summarize→classify) is supposed to fill the rest. But there is no stage that sets `title`/`year_published`/`doi`/`publication_title`/`article_type`/`wri_primary_office` from extraction — only `language` and `title_en` (summarize) are ever updated. So a worker-ingested PDF (S3 drop with no sidecar) ends up `searchable` with `title = <filename stem>`, no DOI, no year, no office, no article_type, no authors — *less* metadata than a CSV-imported doc, and none of it editable-derived.
- **Impact:** the design (§7.1) says extraction (GROBID) derives title/authors/DOI/abstract; GROBID was dropped (§9) and nothing replaced it for these fields. Worker-ingested docs are metadata-poor. This is largely a **known design deferral** (GROBID deferred), but the *consequence* — worker docs have NULL `title` beyond the filename and no structured metadata at all — is worth recording as a real data-quality gap, especially since the admin UI can't even show authors/URL for them.

**N-W4 — `parse` stage `status='processing'` write is not gated on `withdrawn` consistently with publish/parse-needs_review. [P2, minor]**
- **Where:** `search-service/worker/stages/parse.py:62` — `UPDATE documents SET status='processing' ... WHERE id=%s AND status <> 'withdrawn'`. Good. But the *needs_review* writes above it (`:48`, `:55`) have **no** `status <> 'withdrawn'` guard: `UPDATE documents SET status='needs_review' ... WHERE id=%s`.
- **Root cause:** inconsistent guarding. `publish.py` and the `processing` write guard against withdrawn; the two `needs_review` writes in parse do not.
- **Impact:** if a document is withdrawn *between* the claim and the parse stage (an admin takedown racing the worker), parse can flip it from `withdrawn` → `needs_review`, undoing the takedown. Low probability (the claim-time guard in `main.py:43-47` checks `withdrawn` and marks the job done, but there's a window between that check and the parse write). Matches the "never overwrite a withdrawn" invariant the codebase states elsewhere.

### Admin API/UI (from the admin reviewer, cross-verified)

**N-A — `documents.abstract` is a dead column (0/170 populated). [P2]** — *this is the CSV-coverage answer's main migration bug.* See §0. Evidence: `grep -rn abstract` shows only the migration DDL, the entity, the admin whitelist, and the editor textarea — **no writer anywhere**. Editor "Abstract" field is always empty; filling it has no retrieval effect.

**N-B — `DELETE /api/admin/documents/[id]/tags/[tagId]` is documented but NOT implemented. [P2, doc/impl drift]**
- **Where:** `src/app/api/admin/documents/[id]/tags/[tagId]/route.ts` exports **only `PATCH`** (accept/reject). There is no `DELETE` handler. `document-management.md §11.5` lists `DELETE …/tags/[tagId] — Remove a tag`.
- **Impact:** a `document_tags` row can never be physically removed via the API; only flipped to `status='rejected'`. Doc/impl mismatch.

**N-C — Editors can promote any non-withdrawn doc straight to `searchable`, bypassing review. [P2]**
- **Where:** `setDocumentStatus` (`documentsAdmin.ts:159-172`) only restricts `withdrawn→*` (admin). An editor can POST `status:'searchable'` on a `draft`/`processing`/`error` doc.
- **Impact:** can expose a half-ingested or failed doc (no/partial chunks) to retrieval, sidestepping the review queue. Policy question: should editors be able to shortcut review?

**N-D — Collection rename updates `name` but never regenerates `slug`. [P2]**
- **Where:** `collectionsAdmin.ts:54-72` `updateCollection` iterates only `['name','description']`; `slugify` is used only in `createCollection`.
- **Impact:** renaming "Annual Report"→"Quarterly Report" leaves `slug='annual-report'` forever. The PATCH route's `23505` "name exists" handler is effectively unreachable (`name` is not unique).

**N-E — `language` filter uses singular `language`, not `languages[]`; editing primary doesn't update the array. [P2]** — *the filter half of N-W1.* `documentsAdmin.ts:44` filters `d.language = $1`; `languages[]` is not in `EDITABLE_FIELDS`, so editing the primary desynchronizes from the array.

**N-F — `/reindex` fires on every promote even when status is unchanged. [P2, minor]** `documents/[id]/status/route.ts:30-38` fires `void fetch(.../reindex)` whenever `toStatus==='searchable'` *before* checking `fromStatus !== toStatus`. Wasteful on no-op promotes (mitigated: `/reindex` 409-coalesces).

**N-G — File/download route streams the full S3 object through Node, not a signed URL/redirect. [P2, doc/impl drift]** `documents/[id]/file/route.ts:30-32` buffers the whole PDF into Node memory with a new S3 client per request; `document-management.md §11.5` says "Signed URL or redirect." Also a withdrawn doc's PDF stays browser-cached for up to 1h (`Cache-Control: private, max-age=3600`).

**N-H — `listAdminDocuments` hard-caps at 500, no pagination, no total. [P2]** `documentsAdmin.ts:63` `LIMIT 500`; silent truncation above 500 (fine at 170 docs; fragile at the 1–5k design target).

**N-I — Tags-page delete gate mismatches server's "unused" definition. [P2, UX]** `admin/tags/page.tsx` shows Delete when `acceptedCount===0 && suggestedCount===0`, but `deleteTagIfUnused` blocks if **any** `document_tags` row exists (including `rejected`). A tag with only `rejected` rows shows Delete but the server returns 409.

**N-J — Free-text editable fields lack validation. [P2]** `EDITABLE_FIELDS` includes `language` (labeled "ISO 639-1" but unvalidated), `doi`, `articleType`, etc. Only `yearPublished` is validated. An editor can store `language='xyz'`, which then won't match the documents-page dropdown.

**N-K — Bearer scheme match is case-sensitive. [P2, interop]** `proxy.ts:38` + `identity.ts:18` compare `Bearer ${token}` exactly. RFC 7235 makes the scheme case-insensitive; a client sending `bearer <token>` is rejected. (Worker sends capitalized `Bearer`, so it works.)

**N-L — Intake: partial-upload orphan + missing audit on mid-batch failure. [P2]** `admin/intake/route.ts` uploads each file to S3, then `initializeDatabase()` + `writeAudit` only after the loop. A mid-batch S3 PutObject failure orphans earlier files in `intake/` and the `catch` returns 500 before `writeAudit` → no audit row. Two files with the same basename in one batch also overwrite (same S3 key).

### Search-service (from the search-service reviewer — no P0/P1, three P2)

**N-S1 — `/api/embeddings/query` silently ignores the requested `max_results`. [P2]** `main.py:1140` constructs `QueryRequest(query=..., mode=..., top_k=request.max_results)`, but `QueryRequest` has **no `top_k` field** (its limit fields are `max_results`/`vector_top_k`/`bm25_top_k`/`rerank_top_n`/`fusion_top_k`). pydantic `extra='ignore'` drops the kwarg → the endpoint always slices to `max_results=150` (default), regardless of the caller's `max_results`. **Not a `/query`-contract violation** (different endpoint), but a real correctness bug. The downstream transform doesn't re-slice, so oversize propagates to the response.

**N-S2 — `/reindex` 409 "already_running" is best-effort (check-then-acquire race). [P2]** `main.py:1255-1257` `if _reindex_lock.locked(): return 409` then `async with _reindex_lock`. TOCTOU — a second caller blocks instead of getting 409. Safe (the lock still serializes), but the fast-path isn't airtight. Low operational impact.

**N-S3 — `cite_doc_ids` in `/query` `response_data` is dead code (silently dropped). [P2, latent]** `main.py:1081` puts `"cite_doc_ids": request.cite_doc_ids` into `response_data`, but `QueryResponse` has no such field → `QueryResponse(**response_data)` drops it (verified: serialized body has exactly the 9 model fields). The *filtering* behavior is correct and tested (`test_cite_doc_ids_filter.py`); the line is just dead. Contract is preserved.

### Doc/impl drift (admin reviewer, also new vs 2026-07-01's §3)

**N-Doc1 — `document-management.md §11.5` API map lists endpoints that don't exist:** `DELETE …/tags/[tagId]` (N-B), `GET /api/admin/collections/[id]`, `GET /api/admin/collections/[id]/documents`, `GET /api/admin/documents/[id]/tags`, `POST /api/admin/documents` (bulk add-to-collection actually lives at `POST /api/admin/collections/[id]/documents`). Reconcile doc ↔ impl.

**N-Doc2 — `document-management.md §11.1` (JWT/deactivation) is stale in the *opposite* direction from 2026-07-01's note:** the 2026-07-01 doc already says "code is more secure than documented" — confirmed still true (`identity.ts:36-38` revalidates `active`+`role` per request). Just re-flagging that the doc text still hasn't been corrected as of `ce319ca`.

---

## 3. Severity roll-up and suggested ordering

**P0 (data loss / corruption / security):** none newly found. The 2026-07-01 **D3** (no role gate on `/api/import-documents` + `/file` + unvalidated `s3_key` → any authenticated user can read arbitrary S3 prefixes / surface private content to `/query`) remains the highest-severity open item from the prior pass and is **still open** — worth re-elevating.

**P1 (correctness / data loss on re-ingest):**
- **N-W1** — `language` stage destroys multi-language `languages[]` on re-ingest (live DB has 7 affected docs). ← *new*
- **D2** — import `needs_review`-in-OPEN_STATUSES → parked docs can't be re-processed via CSV; plus read-then-insert race. (2026-07-01, still open)
- **D5** — import audit has no actor. (2026-07-01, still open)

**P2 (robustness / doc-drift / UX):** N-A (abstract dead column), N-B…N-L, N-S1…N-S3, N-Doc1, N-Doc2, N-W2, N-W3, N-W4, plus the still-open 2026-07-01 P2s (D1/D4/D6/D7/P1/R3/R4).

---

## 4. Open questions for the human partner (please answer before we plan fixes)

These are product/policy decisions I should not make unilaterally:

1. **CSV metadata that's jsonb-only (authors / URL / Date published):** promote to first-class columns (or revive `document_attributes`), or keep jsonb-only and just surface them read-only in the admin editor + extend search to DOI/author? My recommendation: at minimum surface them read-only + extend search (low risk, high curation value); full promotion is a bigger schema change.

2. **`documents.abstract`:** populate it from the CSV `summary`/`short_summary` (one-time backfill + worker change so future ingests fill it), or drop the column + editor field as dead? The design intended GROBID to fill it and GROBID was dropped.

3. **N-C (editor can shortcut review by promoting `draft`/`error`/`processing` → `searchable`):** is that intended (editors are trusted) or should promote be restricted to `needs_review → searchable` only?

4. **N-W1 / N-E (multi-language `languages[]`):** should the worker preserve the existing `languages[]` on re-ingest (only update `language` if detection changes the primary, never shrink the array), and should the admin language filter use `languages @> ARRAY[...]` instead of `language =`? This touches the `language` stage semantics.

5. **N-W3 (worker-ingested docs are metadata-poor — no title/DOI/year/office/authors):** is filling these from PDF extraction a goal for this pass, or explicitly deferred (GROBID was dropped)? At minimum, should the worker set `title` from the PDF's first page / metadata when no sidecar, instead of leaving it as the filename stem?

6. **Scope of this fix pass:** the 2026-07-01 doc has ~10 still-open code findings (D1–D7, P1, R3, R4). Should this pass (a) fix only the CSV-coverage + new findings, (b) also close the still-open 2026-07-01 P1s (D2/D5) since they're cheap and adjacent, or (c) attempt all open findings? I'd suggest (b) — the CSV-coverage answer + N-W1 + D2 + D5 + the `abstract` decision form a coherent "metadata integrity" batch.

7. **Anything else you've already found** that you mentioned in the task ("there are other issues as well — don't forget to ask me about these")? Please share them so I can fold them into the plan rather than rediscover them.
