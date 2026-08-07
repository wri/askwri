# AskWRI Doc-Mgmt — Consolidated Master Issue List (2026-07-06/07 fanout)

**Status:** THE master issue list. Supersedes `2026-07-06-doc-mgmt-findings.md` for status (which had a stale R1). Built from a 6-track read-only parallel review (`d649d01d`, all 6 completed) over the worker, admin API/UI, search-service, CSV migration, summaries/abstracts, and public routes/tests — each track re-verifying prior findings against HEAD `ce319ca` and adding new ones — plus direct live-DB evidence from the parent session. Every finding has file:line evidence in its track artifact (`.pi-subagents/artifacts/.../track{1..6}-*.md`).

**Companion to** `docs/plans/2026-07-01-doc-mgmt-review-findings.md` (the original 5-way review). Track artifacts in `.pi-subagents/artifacts/d649d01d_reviewer_{0..5}_output.md`.

**Branch:** `qa-wip-david`, HEAD `ce319ca`. **Stack:** 170 docs (169 searchable + 1 withdrawn canary), 30,529 chunks, pgvector 0.8.4, MinIO, search-service :8000 + app :3000 + worker (on-demand).

---

## A. Your explicitly-flagged items (with answers)

### A1 — "These should be editable fields" (authors / URL / Date published)
**Confirmed: they are NOT editable, NOT visible, and NOT searchable today.** All three CSV keys (`All authors`, `URL`, `Date published`) exist for all 169 docs but live **only** inside the opaque `documents.source_metadata.metadata` jsonb — no `documents` column, not rendered in the admin editor, and admin search only `ILIKE`s `title` + `external_id` (you can't find a doc by author or DOI).

The full change set per field (Track 3, §D) is the same shape for each: **(1)** migration `ALTER TABLE documents ADD COLUMN <col> <type>` + backfill from `source_metadata` jsonb; **(2)** entity `@Column`; **(3)** add to the server `EDITABLE_FIELDS` whitelist (`documentsAdmin.ts:8`); **(4)** add to the client `EDITABLE` list (`page.tsx:23`); **(5)** extend the search `ILIKE` (highest value: author + DOI); optional list-page filter/column. The PATCH route and detail GET need **no change** (the whitelist + generic loops handle it). Per-field specifics:
- **authors** → `text` column (preserve the delimited string; don't split); render as a textarea; **add `OR d.authors ILIKE %q%` to search** (the single highest-value search addition — "find by author").
- **URL** → `text` column; render as a clickable link in the echo column; validate `http(s)://`.
- **Date published** → `date` column (`ALTER ... date_published date`, backfill with `to_date(...,'MM/DD/YYYY')`); keep `year_published` as a derived convenience; add a date validation branch next to `yearPublished`'s; render `<input type="date">` (extends the `EDITABLE` type union).

**⚠ Critical companion fix (Track 3 P1-2 / Track 4 NEW-P2-12):** the CSV import API (`importDocuments.ts` `mapRowToDocument`) currently maps only **5** of the 14 CSV keys to columns — it does NOT promote `doi`, `article_type`, or `wri_primary_office` (the Phase-0 migration script maps **8**). So the two intake paths map different subsets. When you add authors/URL/date columns, you MUST extend `mapRowToDocument` + `classifyUpsert` in the same change, or API-imported docs will show those columns empty (data sitting unreadable in `source_metadata`) — recreating the exact invisibility you're complaining about, for the new fields.

### A2 — "Why do we need both abstract and summary" + "short summary truncates mid-sentence"
**Both confirmed.** Two distinct problems:

1. **`documents.abstract` is a dead, redundant column (0/170 populated).** Nothing writes it (not the migration — CSV `summary` goes to `document_summaries kind='long'`, not `documents.abstract`; not the worker; not the import API). Nothing reads it (not retrieval, not the catalog, not the public UI — only the admin editor renders it as an empty "Abstract" textarea). The design (§7.2) intended GROBID to fill it; GROBID was dropped (§9) with no replacement. So the live "summary" the system actually uses is **`document_summaries`** (kind=long/short), and `abstract` is an orphaned duplicate-in-spirit that goes nowhere. **Decision needed: either backfill+wire it (and decide if retrieval should read it), or drop the column + entity field + editor textarea.** The user's instinct ("why both") is correct — `abstract` should go (or be repurposed) since `document_summaries` is the real store.

2. **The short summary truncates mid-sentence at exactly 240 chars.** Root cause = **the CSV source data, not the migration** (Track 1 + Track 2): 144/169 `short_summary` values in `documents.csv` are exactly 240 chars and end mid-word (`…regiona`, `…Grid dec`, `…batte`, `…policymaker`); 25 are shorter; 0 exceed. The migration copies them **verbatim** (0 byte-mismatches DB↔CSV). The 240 cap was applied upstream when the CSV was authored. **The long `summary` is NOT truncated** (163–1090 chars, avg 587). **Worker-generated shorts are NOT 240-truncated** (the worker's prompt says "max 40 words", no char cap; the one generated canary short is 180 chars). So the 240 truncation is a CSV-source-only defect that needs an upstream regeneration + a `document_summaries` backfill.

3. **The truncated short summary is shown VERBATIM to end users** (Track 2 P0-1): the cite-mode results table column labeled "Summary" + "AI generated" (`ResultsTable.tsx:37`, `SelectableResultRow.tsx:138-146`) renders `rowData.short_summary` straight from the catalog's parsed `source_metadata.metadata.short_summary` — i.e. the mid-word-truncated, mislabeled-as-AI-generated value. This is the highest-visibility user-facing defect.

4. **Summary editing is deferred (design §11.8) — editors can SEE but not FIX** the truncated/garbage summaries (Track 2 P1-5): the admin Summaries panel is read-only; `EDITABLE_FIELDS` has no summaries. Meanwhile the dead `abstract` IS editable. The asymmetry is itself a finding.

### A3, A4 — (your "I don't know what you mean" on admin shortcut-review and languages[]) — rephrased
These were items 3 and 4 from my prior message. In plain terms:

- **(A3, Track 5 N-C):** An **editor can promote a `draft`/`error`/`processing` document straight to `searchable`**, bypassing the review queue. The status route only requires admin for *withdraw*; `setDocumentStatus` only restricts *restoring a withdrawn doc*. So an editor could expose a half-ingested or failed doc (no/partial chunks) to public retrieval. **Question for you:** is that intended (editors are trusted) or should promote be restricted to `needs_review → searchable` only?

- **(A4, Track 4 N-W1 + Track 3 P1-3/N-E):** There are **7 multi-language docs** in the live DB (`{en,es}`×3, `{en,pt}`×2, `{zh,en}`, `{en,zh}`). Two bugs touch them: (a) the admin editor lets you edit the singular `language` but NOT the `languages[]` array, so editing the primary **desynchronizes** it from the array; (b) worse, if the worker ever **re-ingests** one of these docs, its `language` stage **overwrites `languages[]` with a single code** — **permanently destroying** the multi-language array. **Question:** should the worker preserve the existing `languages[]` on re-ingest (never shrink it), and should the admin filter use `languages @>` instead of `language =`?

### A5 — Worker-ingested-doc metadata (in scope per your answer)
Confirmed (Track 4 N-W3 + §5 write-ownership audit): the worker **never** sets `documents.title` (beyond the filename-stem placeholder), `doi`, `year_published`, `publication_title`, `article_type`, or `wri_primary_office` from extraction. Intake inserts only `{external_id, s3_key, title=external_id, status=draft, content_hash}`; the pipeline only ever writes `language`, `languages`, `title_en` (non-EN only), and `extraction_confidence`. So worker-ingested PDFs (S3 drop with no sidecar) end up `searchable` with `title = <filename stem>`, no DOI, no year, no office, no authors — far less metadata than a CSV-imported doc, and none of it editable-derived. GROBID (which the design relied on for title/authors/DOI/abstract) was dropped with no replacement.

### A6 — Scope (your answer: "everything, including the cheap P1s")
Noted. The fix plan (next step) will cover all P0/P1 and the high-value P2s, batched by subsystem to keep diffs reviewable.

### A7 — Your "lots of other issues" — captured below
The fanout surfaced a large set beyond the ones you named. See §B (P0/P1) and §C (P2). Please share any of yours that aren't here so I can fold them in.

---

## B. P0 / P1 issues (correctness, data loss, security, user-facing)

### P0 — security
**P0-1 — D3 (still open, highest severity).** No role gate on `POST /api/import-documents` or `GET /api/admin/documents/[id]/file` (`requireIdentity(req)` with **no role arg** at `import-documents/route.ts:10` and `file/route.ts:13`), plus **unvalidated `s3_key = row.file_path`** (`importDocuments.ts:75`). Any authenticated user (editor — the lowest tier) can: (a) bulk-import a CSV row with `file_path:"eval-data/secret.pdf"` to create a doc with that `s3_key`, then download the raw object via `/file` (the S3 branch uses the raw `s3Key`, only the local branch sanitizes with `basename`); or (b) let the worker ingest it → if it parses, the content becomes `searchable` and surfaces to public users via `/query`. The proxy edge gate is session/bearer-only (no role check). *(Track 5; re-confirmed open.)*

**P0-2 — Truncated short summaries shown verbatim to end users, mislabeled "AI generated" (Track 2 P0-1).** The cite-mode results table "Summary" column (`ResultsTable.tsx:37` + "AI generated" tag, `SelectableResultRow.tsx:138-146`) renders `rowData.short_summary` from the catalog's parsed `source_metadata.metadata.short_summary` — the mid-word-truncated 240-char value (144/169 docs), under a label that says "AI generated" (it's CSV `source='external'`, not AI). Highest-visibility user-facing defect.

### P1 — correctness / data loss / data quality
**P1-1 — `document_summaries.language` is mislabeled for all 33 non-English docs (Track 1 P1-A).** The migration tags each summary with the doc's *primary* language, but the CSV summaries for all 33 non-EN docs are actually **in English** (langdetect over all 169: 33 mismatches, all `stored=zh/es/pt but detected=en`; spot-checks confirm English text under `es`/`pt`/`zh` tags). **Downstream block (the worse part):** the worker's `summarize` stage (`summarize.py:45-53`) targets `{doc["language"], "en"}` and **skips any `(lang,kind)` already present** — so the native `zh` slot is occupied by the English-mislabeled row, and the worker **never generates a real Chinese summary**. The mislabel is irreversible without deleting the rows first (the `(document_id, language, kind)` PK slot is taken); re-ingest does not self-heal. A `WHERE language='zh'` query returns English text.

**P1-2 — `title_en` is NULL for all 33 migrated non-English docs (Track 1 P1-B; prior P1, still open).** Migration sets `title_en = title if language=="en" else None` (`migrate_csv_to_postgres.py:168`). The worker's summarize stage only does `title_en = COALESCE(title_en, title)` (native title, not a translation) and migrated docs never run it. Design §6 says `title_en` is "always populated."

**P1-3 — Worker `language` stage destroys multi-language `languages[]` on re-ingest (Track 4 N-W1).** `language.py:38-40` `UPDATE documents SET language=%s, languages=%s ...` with `[lang]` (one-element list). Overwrites the array → 7 multi-language docs lose their secondary languages irreversibly on any re-ingest.

**P1-4 — Re-ingest does NOT refresh summaries (stale summaries + stale summary chunk after content change) (Track 4 NEW-P1-A).** `summarize.py:48` skip-existing + `parse.py:64-69` overwrites `document_texts` + `embed.py:100-103,152-161` rebuilds the summary chunk from the stale `document_summaries` long row. After a re-ingest with changed content, chunks/embeddings/text reflect the new PDF but `document_summaries` (long+short) AND the `unit_type='summary'` chunk reflect the **old** content. Silent, not self-correcting.

**P1-5 — Import job-save failure orphans the document; CSV re-import cannot recover it (Track 4 NEW-P1-B).** `importDocuments.ts:172` (doc save) then `:198` (job save) are not transactional; if the job save throws, the doc is committed `draft` with no job, and a CSV re-import always returns `'skipped'` (the doc's columns aren't NULL) so the `continue` at `:188-189` skips job creation entirely. Doc permanently stuck `draft`; only S3 re-drop or manual SQL recovers it.

**P1-6 — `documents.abstract` is a dead column (0/170) (Track 1 P2-B / Track 2 P2-8 / Track 3 P2-1).** Column + entity + editor textarea exist, but no writer (migration routes CSV `summary` to `document_summaries`, not `abstract`; worker never writes it; import API omits it) and no reader (retrieval/catalog/UI never `SELECT documents.abstract`). Editors can fill it believing it matters for search; it doesn't. *(Your A2 item.)*

**P1-7 — `authors` / `URL` / `Date published` invisible + uneditable + unsearchable (Track 3 P1-1).** The three CSV keys live only in `source_metadata.metadata` jsonb; no column, not rendered (the editor never shows `source_metadata` at all), not matched by admin search. *(Your A1 item.)*

**P1-8 — Import API does not map `doi`/`article_type`/`wri_primary_office` to columns (Track 3 P1-2 / Track 4 NEW-P2-12).** `importDocuments.ts:82-101` `mapRowToDocument` produces only `externalId, title, language, languages, yearPublished, publicationTitle, s3Key, sourceMetadata` — omitting `doi`/`articleType`/`wriPrimaryOffice` (and not seeding the `external` `document_tags` the migration creates for office/doc_type/program/topic). So API-imported docs have those structured columns empty while `source_metadata` holds the values. The two intake paths (Phase-0 migration vs live import API) map different subsets of the same CSV.

**P1-9 — Public PDF links 404 for all 169 migrated docs if prod uses the default S3 prefix (Track 6 NEW-1).** The public PDF route is **filesystem-based** (`/api/pdf/[filename]/route.ts:54` serves `/tmp/askWRI_docs/<filename>`), populated once at boot by `start.sh` syncing `s3://${DOCUMENTS_S3_BUCKET}/${DOCUMENTS_S3_PREFIX:-}`. Migrated docs have **bare-filename `s3_key`s** (no prefix). `config.py:46` defaults `documents_s3_prefix = "documents/"`. With the default prefix, the sync doesn't reach the migrated root → all 169 migrated public PDFs 404 at boot. The admin `/file` route (uses `doc.s3Key` directly) is unaffected. Deploy-config-dependent; verify prod prefix on deploy day (the local-dev design sets `DOCUMENTS_S3_PREFIX=` empty to match).

**P1-10 — `/api/catalog` CSV fallback + citation export degrade/500 unless `CATALOG_SOURCE=postgres` set (Track 6 NEW-2).** `catalog/route.ts:144` reads Postgres only if `CATALOG_SOURCE=postgres` (commented out in `.env.example:59`); else reads `/tmp/askWRI_docs/documents.csv`, which may not exist/be synced in postgres mode → catalog 500s. The client citation exporter reads authors/date/DOI/office/languages from the catalog index — if it 500s, exported rows keep only title+url+summary (authors/date/type/DOI/office/languages all blank).

**P1-11 — Worker never calls `setup_ssl_certificates()` (Track 4 R2, latent/dormant).** Under `USE_CUSTOM_SSL_CLIENT=true` the worker's OpenAI/embedding/boto3/httpx HTTPS calls use the default CA bundle and may fail SSL. Dormant as deployed (flag unset in terraform/.env.example); verify before enabling the flag for the worker.

**P1-12 — D2: import `OPEN_STATUSES` includes `needs_review` + read-then-insert race (Track 5, still open).** `importDocuments.ts:127` `['queued','running','needs_review']` (vs the unique index + `queue.enqueue` + `reenqueueIngestion` which treat open as `queued|running` only). A parked `needs_review` doc CSV-imported won't re-trigger ingestion (inconsistent with worker path); plus read-then-`save` with no `ON CONFLICT` → concurrent imports race → unhandled `23505` → 500.

---

## C. P2 issues (robustness, audit, UX, doc-drift) — selected high-value

**Migration fidelity (Track 1):**
- **P2-1 (D6, open):** `migrate_csv --reset` `TRUNCATE documents CASCADE` wipes `ingestion_jobs` (CASCADE ignores the FK action). Hazard if run with live worker jobs.
- **P2-2 (P2-C, open):** `wri_programs`/`Sub-tag` are tags-only (no column); editable only via the Tags panel.
- **P2-3 (P2-E):** `documents.title` (Article Title) diverges from chunk/summary title (Publication Title) for **157/169** docs (the migration sets `title`=Article Title; `indexing.build_nodes` uses Publication Title). Admin-UI title ≠ indexed/citation title.
- **P2-4 (P2-F):** `content_hash` and `extraction_confidence` are NULL for all 169 migrated docs → migrated docs invisible to hash-based dedup (a re-drop of a migrated PDF is never skipped as duplicate).
- **P2-5 (P2-G, =D3 part):** `s3_key` stored as bare basename (no `documents/` prefix) → worker `parse.py:32` `s3.get_object(Key=doc["s3_key"])` misses the `documents/`-prefixed object → silent title+summary fallback (loses full PDF) on re-process.
- **P2-6 (P2-H, latent):** `short_summary` has no fallback (asymmetric with `long`); no live trigger.
- **P2-7 (P2-I, latent):** `parse_year(str[:4])` would collapse a range like "2021-2022" to 2021; no live trigger.

**Summaries/abstracts (Track 2):**
- **P2-8 (P1-3):** Canonical `document_summaries` are NOT surfaced to the public UI/catalog — the UI reads raw `source_metadata` instead → silent divergence (the worker canary has generated summaries but `source_metadata.summary` is empty → UI shows empty). Three parallel stores of the long summary kept in sync only by accident.
- **P2-9 (P2-6):** `short_summary` used only for display/export/feedback — every live use surfaces the truncated text. The cite-mode feedback payload persists the truncated short into `cite_mode_feedback.summary`.
- **P2-10 (P2-7):** CSV citation export propagates the truncated short and mislabels it (`exportCitationsCsv.ts:86-92` + the 240-cap slice; header claims "not part of the metadata" but it is).
- **P2-11 (P2-9):** Answer-mode shows the full long summary; cite-mode shows the mid-word-truncated short — inconsistent UX for the same doc, both labeled "Summary."
- **P2-12 (P2-11):** Worker short-summary budget ("max 40 words") has no char/length guard; future worker shorts could be uneven (no validation before write).

**Worker pipeline (Track 4):**
- **P2-13 (NEW-P2-1):** `content_hash` has no DB unique index → concurrent intake of identical-content files registers duplicate `documents` rows (defeats dedup); duplicate audit rows for same-filename concurrent drops; the dedup `SELECT` is a full-table scan (no index).
- **P2-14 (NEW-P2-2):** `classify.py:76-78` `ON CONFLICT DO NOTHING` → re-classify is a no-op for existing llm tags (a rejected llm tag stays rejected; a suggested one can't be upgraded to accepted; stale tags for old content never corrected). Re-ingest refreshes chunks/text but not existing llm tags.
- **P2-15 (NEW-P2-3):** Worker stage mutations (status flips, summaries, tags, chunks) write **no** `audit_log` — only intake registration is audited. Worker-driven lifecycle transitions have no provenance.
- **P2-16 (NEW-P2-4):** `publish.py:47` returns `"needs_review"` unconditionally even when the withdrawn guard no-ops the doc UPDATE → a withdrawn doc's job ends `needs_review` (job/doc status mismatch; appears in review queue for a withdrawn doc).
- **P2-17 (NEW-P2-5):** `embed.py:171-172` has no withdrawn guard → a withdrawn doc's chunks get rewritten (wasted work; companion to N-W4).
- **P2-18 (NEW-P2-6):** `queue.next_stage("publish")` → `IndexError` (no bounds check); only hits a manually-requeued `stage='publish'` job; caught by `main.py:44` but burns an attempt with an opaque error.
- **P2-19 (NEW-P2-7, corrects N-W2):** `summarize.py:50` and `classify.py:58` (not just `embed`) hold the DB transaction open across their LLM calls — a long-lived txn across a multi-second network round-trip. (N-W2's "advisory lock held across OpenAI / pool exhaustion" claim was **overstated** — the lock is acquired *after* `_embed_texts` at `embed.py:171`, and pool exhaustion is unreachable at `desired_count=1`. The real residual is the long-held txn, P2.)
- **P2-20 (NEW-P2-8):** `summarize.py:59-63` sets `title_en` only for non-EN → worker-ingested EN docs have `title_en NULL` (violates "always populated"; falls back to `title`).
- **P2-21 (NEW-P2-9):** `_sweep_s3` `MaxKeys=50` no pagination (throughput for >50); non-PDF objects in `intake/` skipped but never deleted (orphaned forever).
- **P2-22 (NEW-P2-10, latent):** `publish.py:25-29` `extraction_confidence` NULL-propagates if `page_boundaries` is NULL → doc auto-promoted `searchable` with NULL confidence (not hit in practice — `parse` always writes a list).
- **P2-23 (NEW-P2-11):** `classify.py:11` imports `Jsonb` with a misleading "audit use below" comment but writes no audit (dead import + misleading comment).
- **P2-24 (R3, open):** Worker `_build_nodes_for_doc` diverges from `indexing.build_nodes` (title source, authors truncation, file_path vs s3_key) → worker-produced chunks' BM25-indexed string differs from migration output; no test pins them. (Folds in P2-3.)
- **P2-25 (R4, open):** zh OpenCC `t2s` can misattribute page numbers — `embed.py:106-108` converts to Simplified but reuses Traditional-text boundaries for `get_page_number_for_position`; no multi-page zh test.

**Admin API/authz/audit (Track 5):**
- **P2-26 (D1, open):** `IngestionJob.entity.ts:18` `onDelete:'SET NULL'` vs migration `ON DELETE CASCADE` → `migration:generate` emits a spurious revert. (DB is correct; entity is the lie.)
- **P2-27 (D4, open):** Mutation + audit not transactional anywhere (save then writeAudit separately); if audit INSERT fails, mutation stands un-audited.
- **P2-28 (D5, open):** Import audit records no actor; `source='external'` hardcoded; route has identity but drops it. *(P1-8 adjacent.)*
- **P2-29 (N-B, open):** `DELETE /documents/[id]/tags/[tagId]` documented (§11.5) but NOT implemented (only PATCH) — a `document_tags` row can never be physically removed via the API, only flipped to `rejected`.
- **P2-30 (N-C, open, =your A3):** Editor can promote `draft`/`error`/`processing`→`searchable`, bypassing review.
- **P2-31 (N-D, open):** Collection rename never regenerates `slug` (stale forever); the `23505` "name exists" handler is unreachable (name isn't unique, slug never changes).
- **P2-32 (N-F, open):** `/reindex` fires on every promote even when status is unchanged (no-op promote still triggers reindex, unaudited).
- **P2-33 (N-G, open):** File route streams the full PDF through Node (doc says signed URL/redirect); new S3 client per request; 1h browser cache on withdrawn docs.
- **P2-34 (N-H, open):** `listAdminDocuments` `LIMIT 500`, no pagination, no total → silent truncation above 500.
- **P2-35 (N-I, open):** Tags-page delete gate (UI: `accepted&&suggested===0`) mismatches server `deleteTagIfUnused` (blocks if **any** row incl. rejected) → Delete shown but server returns 409.
- **P2-36 (N-J, open):** Free-text editable fields unvalidated (only `yearPublished` validated) → `language='xyz'` stores fine, won't match the dropdown.
- **P2-37 (N-K, open):** Bearer scheme match is case-sensitive (RFC 7235 says case-insensitive); `bearer <token>` rejected.
- **P2-38 (N-L, open):** Intake partial-upload orphan + missing audit on mid-batch S3 failure; same-basename files in one batch overwrite.
- **P2-39 (NEW-1):** `createUser` audit omits the `email` field.
- **P2-40 (NEW-2):** Last-admin guard is non-atomic TOCTOU → two admins concurrently self-demoting can lock out all admins.
- **P2-41 (NEW-3):** Self-demote/self-deactivate permitted (no actor≠target guard).
- **P2-42 (NEW-4):** Login/logout + `lastLogin` mutation not audited (no security audit trail; the only login-failure record is an in-memory per-instance map that resets on deploy).
- **P2-43 (NEW-5):** `addHumanTag` is non-atomic SELECT-then-INSERT → concurrent duplicate → unhandled `23505` → 500 (same race class as D2).
- **P2-44 (NEW-6):** `decideDocumentTag` read-modify-write non-atomic (TOCTOU) + non-transactional audit → stale/incorrect `audit_log.before` under concurrency.
- **P2-45 (NEW-7):** `reenqueueIngestion` has no `withdrawn` guard → an editor can re-queue a withdrawn doc (the worker no-ops it via the claim-time guard, but spurious job + audit rows are created).
- **P2-46 (NEW-8):** `ADMIN_API_TOKEN` bearer grants **full admin** to the ingestion worker (no path/role scoping) — the worker process holds user-mgmt/withdraw/taxonomy-delete/file-download powers, not intake-only. A leak (token is plaintext in the task-def) = full admin takeover.
- **P2-47 (NEW-9):** `createTag` accepts arbitrary `facet`/`valueId` with no canonical-facet or shape validation (editor can mint `facet:'foo'`).

**Search-service contract (Track 6) — no P0/P1 on `/query`; contract preserved:**
- **P2-48 (N-S1, open):** `/api/embeddings/query` silently ignores `max_results` (builds `QueryRequest(top_k=...)` but `QueryRequest` has no `top_k` field → pydantic drops it → always 150). Not a `/query`-contract violation (different endpoint).
- **P2-49 (N-S2, open):** `/reindex` 409 TOCTOU (check-then-acquire race); safe (lock serializes) but fast-path not airtight.
- **P2-50 (N-S3, open):** `cite_doc_ids` in `/query` `response_data` is dead code (silently dropped; `QueryResponse` has no such field). Filtering is correct + tested.
- **P2-51 (NEW-3):** `/query` silently ignores `similarity_threshold` (declared, stored, echoed in debug, never applied to filter).
- **P2-52 (NEW-4):** `/query` silently ignores `include_metadata` (declared, never read; metadata always populated).
- **P2-53 (NEW-5):** `retrieval_mode` forwarded by the app tier is a no-op at the search service (no `retrieval_mode` field on `QueryRequest`).
- **P2-54 (NEW-6):** Inconsistent readiness reporting — `GET /api/embeddings/query` reports `vector_index: false` in postgres mode (dense works per-query via `PgVectorRetriever`); `/health` and `/stats` handle this correctly with `pg_dense_ready`.
- **P2-55 (NEW-7):** `/query` doesn't gate on `indexing_in_progress`; build-then-swap is non-atomic → a query racing a `/reindex` can read half-updated state (documented, unguarded).
- **P2-56 (NEW-8):** Admin metadata edits don't propagate to `/query` results — `/query` reads `document_chunks.node_metadata` (written once by migration/worker embed), not `documents.*`. `/reindex` in postgres mode doesn't regenerate chunk `node_metadata`. So admin-UI shows new title, public search shows stale title until re-ingest.
- **P2-57 (NEW-9, pre-existing):** `/query` `title` is truncated to 100 chars (both modes, so not a cutover regression); catalog/admin show full title → title-length divergence between surfaces.

**Public routes / cutover (Track 6):**
- **P2-58 (R5, open):** Public PDF links for worker docs added post-boot 404 until app restart (boot-only sync).
- **P2-59 (R1 — CORRECTED to FIXED):** `start.sh` documents sync is now unconditional (commit `7b0707c`, ancestor of HEAD). The 2026-07-06 doc's "still open" was stale. The genuine residual is R5 + P1-9.

**Tests / CI (Track 6) — the largest open risk:**
- **P2-60 (T1, open + worse):** CI runs only 7 pytest modules; `test_sparse_retriever.py` (the keyword-lane contract / "26/26 parity"), `test_worker_pipeline.py`, `test_pg_store.py`, `test_query_e2e.py`, `test_startsh_sync.py` (R1 regression), `test_config.py` (B3 regression) are all **excluded**. Node side: all 6 `*.db.test.ts` self-skip in CI (no postgres service in the `test` job) → the **entire app-tier DB query layer is untested in CI.**
- **P2-61 (T2, open):** `corpus_order` *order* not pinned by any test (`test_corpus_order_contiguous` asserts contiguity only, not order-vs-`enumerate(build_nodes(...))`) → a refactor changing CSV iteration order passes CI while silently changing BM25 tie-breaks.
- **P2-62:** No test that the migrated 169-doc data matches the CSV. `test_migration_script.py` runs against a synthetic 3-row CSV; doesn't cover `title_en` NULLs, `abstract` nulls, `source_metadata` 14-key preservation, or the 240-char truncation.
- **P2-63:** Parity claims ("26/26", "11/11 identical", "instant withdraw consistency") have **no** automated CI test — all operator-verified.

**Doc/impl drift (Tracks 3, 5):**
- **P2-64 (N-Doc1, open):** `§11.5` API map lists endpoints that don't exist: `DELETE /documents/[id]/tags/[tagId]`, `GET /collections/[id]`, `GET /collections/[id]/documents`, `GET /documents/[id]/tags`, `POST /documents` (bulk-add lives at `POST /collections/[id]/documents`).
- **P2-65 (N-Doc2, open):** `§11.1` JWT/deactivation is stale — code revalidates `active`+`role` per request (near-immediate deactivation); doc claims sessions outlive deactivation by 7 days. (Code is more secure than doc.)
- **P2-66 (§3, open):** `CLAUDE.md` write-ownership rule is stale ("Python side owns `document_chunks` and only those") — the worker also writes `documents`(draft), `document_texts`, `document_summaries`, `document_tags`(llm), `ingestion_jobs`, `audit_log`, `keyword_vocab`.
- **P2-67:** `seed-admin.ts` runbook discrepancy — resets password, force-reactivates, force-promotes to admin on an existing user (runbook says "will not overwrite"); writes no audit; no 12-char check.
- **P2-68:** `document-management.md:239` overstates worker-embed parity ("Phase 0-identical chunking") — per R3, chunk *metadata* diverges.

---

## D. Status roll-up (corrected)

**FIXED since 2026-07-01:** B1 (Dockerfile copies `worker/`), B3 (config `extra="ignore"`), **R1** (start.sh documents sync unconditional — `7b0707c`; my 2026-07-06 doc was stale here, now corrected).

**Still open (highest-severity first):** D3/P0-1 (security), P0-2 (truncated shorts to users), P1-1..P1-12 (correctness/data-loss/data-quality), plus the P2 cluster above.

**Overstated/corrected:** N-W2 (advisory lock is NOT held across OpenAI — acquired after `_embed_texts`; pool exhaustion unreachable at `desired_count=1`; real residual is long-held txn, P2). R1 (fixed, not open).

---

## E. Open questions before we plan fixes

1. **`abstract` (A2/P1-6):** ✅ DECISION: **drop entirely** — column (migration `DROP COLUMN`), entity property, `EDITABLE_FIELDS` entry, and editor textarea. Exhaustive investigation (2026-07-06/07): the column is written by NOTHING and read by NOTHING — not retrieval, not catalog, not the public app, not answer synthesis, not the worker, not the import API, not tests, not terraform, not eval. The only references are its own definition (migration DDL, entity, admin whitelist, editor label/render). The `main.py:914` "abstract" hit is a comment about page-1 chunk demotion, not the column; `evaluation/` hits are the word inside PDF snippet text. The PDF bake-off plan mentions abstract only as GROBID's hypothetical-future role, explicitly excluded from its gate. Re-adding later is a trivial additive migration if a parser ever needs it. (Earlier "keep nullable-hidden" hedge was wrong — it conflated a future hypothetical with current usage.)
2. **Authors/URL/Date_promote (A1/P1-7):** ✅ DECISION: promote all three to columns + editable + searchable (author + DOI search highest value), AND fix P1-8 (import API mapping) in the same change. Design-aligned (§20 fixed-columns interim; `document_attributes` revival folds later).
3. **Short-summary 240 truncation (A2/P0-2):** ✅ DECISION: regenerate `short_summary` — **native + English** per design §7.5 (not English-only) — via the worker "max 40 words" summarizer, backfill `document_summaries` kind=short, and stop the cite-mode UI "AI generated" mislabel for `source='external'`. CORRECTION: earlier framing was English-centric; must be native+English.
4. **A3/P2-30 (editor promote shortcut):** ✅ DECISION: restrict promote to `needs_review → searchable` only; editors cannot promote `draft`/`error`/`processing`. Design-aligned (§7.9/§11.311).
5. **A4/P1-3 (languages[]):** ✅ DECISION (pending final confirm of the plain-language rephrase): worker MERGES the newly-detected language into `languages[]` and never shrinks it; admin filter uses `languages @> ARRAY[$1]` (a {en,pt} doc shows under both). Design-aligned (§7.4 "detect the set present"; §323 "preserve"). See §H.
6. **P1-1 (mislabeled non-EN summaries):** ✅ DECISION: (a) RELABEL the 33 mislabeled rows zh/es/pt → en (cheap, correct, design §7.5 English rendition); (b) GENERATE the missing native-language summaries (zh/es/pt long+short) via a worker re-summarize batch/re-ingest (restores the per-language retrieval handle §7.5/§10 requires); (c) BACKFILL title_en = title for the 33. CORRECTION: earlier "delete + regenerate both" replaced by cheaper relabel-first. See §H.
7. **P1-9/P1-10 (public PDF/catalog cutover):** ✅ DECISION: code fixes with tests — public PDF route S3-backed via `doc.s3Key` (also kills R5 boot-sync gap); `postgres` as default/required catalog source.
8. **P2-60..P2-63 (CI gaps):** ✅ DECISION: add the excluded pytest modules + a postgres service for the `*.db.test.ts` to CI as part of this pass. Includes upload→intake→worker→searchable e2e (F6-2).
9. **Your "lots of other issues" (A7 / §F):** ✅ RECEIVED — captured in §F (F1-1..F6-2). Partner still working through the full list.

Once you confirm #5's rephrase and the #1 column nuance, I'll write the fix plan (subsystem-batched: multilingual-renditions → migration+data-quality → import API → worker → admin API/UI → public routes → CI/tests → docs/branding) and start executing with TDD per fix.

---

## H. Design-alignment review (2026-07-06/07)

Reviewed all findings against `docs/plans/2026-06-09-askwri-document-management-design.md`. **Headline: a cluster of findings are one story — the migration broke the design's multilingual-renditions model (§7.5/§10); fixing them restores it.** This is the highest-priority workstream because AskWRI is a multilingual search engine and these gaps directly degrade non-English retrieval/display.

### H.1 The multilingual-renditions workstream (design §6, §7.4, §7.5, §10)

Design intent: every document = one paper in its **original language**, with **native + English** summaries (long+short), **title_en** always populated, and the **full language set** preserved — so each language has a retrieval handle (a `unit_type='summary'` chunk in that language) and the within-language sparse lane can match a same-language query to a same-language doc. No query-time translation.

| Finding | What's broken (live evidence) | Design intent | Fix (decided) |
|---|---|---|---|
| P1-1 | 33 non-EN docs' English summaries tagged `zh`/`es`/`pt` (langdetect: 33 mismatches) | §7.5 native+English | #6: relabel → `en`; generate native |
| P1-2 | 33 non-EN docs `title_en IS NULL` | §6 "title_en always populated" | backfill `title_en = title` (translation deferred §10.4) |
| P1-3 / #5 | worker overwrites `languages[]` with `[lang]` on re-ingest; 7 bilingual docs at risk | §7.4 "detect the set present"; §323 "preserve" | worker merges, never shrinks; filter `languages @>` |
| #3 / P0-2 | all 169 shorts truncated mid-sentence at 240 chars (CSV source) | §7.5 "short" summary (complete sentence) | regenerate **native+English** shorts via worker; drop "AI generated" mislabel |
| #6 | 33 non-EN docs have no native summary (no retrieval handle for that language) | §7.5 native+English; §10 handle | generate native long+short |

**Two corrections the design prompted:**
- #3 was English-centric → must be native+English (§7.5).
- #6 was "delete + regenerate both" → relabel-first is cheaper and aligns (English rendition correctly labeled; native slot empties so the worker fills it on re-ingest).

**Note on the 7 bilingual docs' primary language:** the design (§190/§281) says one paper = one document in its *original* language, English is the bridge. For e.g. "Seizing Brazil's urban opportunity" (CSV `English, Portuguese`, DB primary `en`), the *original* may be Portuguese with an English rendition — the CSV-listed-first convention made it `en`. Primary-language correctness for these 7 is a curation follow-up, not a blocker; the array-preservation fix (#5) is the immediate must.

### H.2 Other findings — alignment status

- **#2 (authors/URL/date_published as columns):** ALIGNED. Design put these in deferred `document_attributes` (§6/§20), but §20 chose "fixed columns for now" and `doi`/`year_published`/etc. are already columns — same interim pattern. A future `document_attributes` revival folds them via a bounded migration (Track 3 §K).
- **#4 (restrict promote):** ALIGNED (§7.9 review queue gates low-confidence; §11.311).
- **#7 (S3-backed public PDF + postgres catalog default):** ALIGNED (system of record in Postgres/S3; removes the silent-deploy-failure footgun).
- **#8 (CI):** ALIGNED (quality; also restores the parity/contract guarantees the docs claim but CI doesn't enforce).
- **#1 (`abstract`):** TENSION. Design §6/§7.2 intended `abstract` from GROBID; GROBID dropped (§9), column is dead (0/170, no reader — verified). Partner said drop. Nuance: the active `docs/plans/2026-07-02-pdf-parsing-bakeoff-plan.md` may yield a parser that extracts abstracts → would want the column back. Resolution: drop the editor field (misleading) regardless; for the column, partner to choose drop vs keep-nullable-hidden.
- **§11.317 corpus-health dashboard (deferred):** the design's dashboard would surface "missing English renditions" — which is exactly P1-2/#6. The dashboard isn't built (Phase 2 §11.8 deferred), so these multilingual gaps are **invisible today**. Building that dashboard view (or a simpler "missing renditions" admin report) would make the multilingual workstream self-monitoring. Out of scope for this pass unless partner wants it.

### H.3 What I corrected in my own work after the design review
- Elevated P1-1/P1-2/P1-3/#3/#6 into a single multilingual-renditions workstream (was scattered across tracks).
- Reframed #3 as native+English (was English-only).
- Adopted relabel-first for #6 (was delete-and-regenerate-both).
- **`abstract`: dropped the "keep nullable-hidden" hedge.** Fully investigated — no reader/writer anywhere; drop entirely. (The hedge wrongly conflated GROBID's deferred/future hypothetical with current usage.)

### H.4 Partner decisions locked (2026-07-06/07)
- #1 abstract → drop entirely (see above).
- #3 → regenerate native+English shorts, backfill, drop "AI generated" mislabel.
- #6 → relabel 33 rows → en, generate native summaries, backfill title_en.
- #4 → promote restricted to `needs_review → searchable`.
- #5 → worker merges languages (never shrinks) + filter `languages @>` (pending final plain-language confirm, treating as yes).
- #7 → code-fix public PDF (S3 via doc.s3Key, kills R5) + postgres default catalog, with tests.
- #8 → add excluded pytest modules + postgres service for `*.db.test.ts` to CI this pass; includes upload→intake→worker→searchable e2e (F6-2).
- **Health dashboard:** YES — a corpus-health view **on the review page** (counts by status/language, review-queue depth, missing-renditions/missing-`title_en`, low-confidence docs). Scoped as part of the review-page redesign (F2-1); aligns with design §11.317 (deferred dashboard) surfaced where the user actually works.
- **Documentation + tooltips + branding + layout + all F1-1..F6-2 items:** confirmed captured in §F; dedicated UI/UX/branding/docs workstream in the plan. Not forgotten.

Next: write the subsystem-batched fix plan (multilingual-renditions → migration+data-quality → import API → worker → admin API/UI → public routes → CI/tests → UI/branding/docs) and execute TDD, one fix at a time.

---

## F. Partner-provided issues (2026-07-06/07, consolidated + verified)

Answers received 2026-07-06/07: #1 drop abstract (verified no readers — see §A2/P1-6); #2 confirmed (promote authors/URL/Date_published to columns + editable + searchable + fix P1-8 import API mapping in same change); #3 yes (regenerate 240-char shorts upstream + backfill + stop the cite-mode "AI generated" mislabel); #7 code fixes with lots of tests (public PDF route S3-backed via doc.s3Key — also kills R5; postgres as default/required catalog source); #8 yes (add excluded pytest modules + postgres service for *.db.test.ts to CI this pass). #4/#5/#6 pending partner decision (rephrased in plain terms; leans: #4 restrict promote to needs_review→searchable, #5 worker preserves languages[] on re-ingest + filter uses languages @>, #6 delete 33 mislabeled rows + regenerate native+English).

### F1 — UI/UX/branding/documentation (cross-cutting, new workstream)
- **F1-1 Branding missing throughout the doc-mgmt system.** No AskWRI branding beyond the sidebar "AskWRI Admin" text (`layout.tsx`). Needs consistent branding (header, favicon, colors, footer).
- **F1-2 Layout is not great.** General layout polish across all admin pages (spacing, hierarchy, responsive). Left-sidebar + content shell (`layout.tsx`) is the base.
- **F1-3 The entire system is missing documentation and tooltips.** No contextual help, no field-level tooltips, no inline guidance. Add tooltips/help text to every field and page, and a documentation surface.

### F2 — Review queue page
- **F2-1 Entirely unclear what to do on this page.** The review-queue page (`/admin/review`) gives no guidance on the promote/re-ingest decision. Needs clear instructions, per-doc context (why it's flagged — the job error/confidence), and action affordances with explanations.

### F3 — Documents page (`/admin/documents`)
- **F3-1 Doc title missing from many documents: "Not available" and "Pre-EM" display instead.** VERIFIED LIVE: 37/170 docs (34 "Pre-EM", 3 "Not available"), all searchable. Root cause = migration bug: `title = raw.get("Article Title") or raw.get("Publication Title")` picks the non-empty junk "Pre-EM" and never falls through to the good Publication Title. The search index already has the real title (uses Publication Title). Fix: prefer Publication Title, fall back to Article Title, then external_id; backfill the 37 docs. (NEW P1, data-quality + user-facing.)
- **F3-2 Unclear what it means to add docs to a collection at this point.** The bulk add-to-collection action has no explanation of what collections are for. Needs inline guidance.
- **F3-3 Divider line at bottom of the page is positioned over the final entry in the list — wrong place.** VERIFIED mechanism: table rows use `cell: borderBottom: '1px solid #eee'` (`page.tsx:24`) and the page has no proper footer/container boundary → the last row's bottom border collides with the page edge/footer. Fix in the layout/CSS pass.

### F4 — Collections page (`/admin/collections`)
- **F4-1 Again it's unclear what collections are for.** No explanation of the collections concept. Needs a page intro + tooltip on create/rename. (Relates to P2-31 — rename doesn't regenerate slug.)

### F5 — Tags page (`/admin/tags`)
- **F5-1 This work looks deferred.** The page literally says "Taxonomy v1 (raw CSV values). Rename/merge and version bumps are deferred until a curation owner is assigned" (`page.tsx`). Surface the deferral status clearly; decide if taxonomy v2 is in scope.
- **F5-2 We need to make these tag categories and type editable.** Today facets/values are read-only except add/delete; categories (facets) aren't editable. Make facet + value editable (rename, with audit).
- **F5-3 For now the admins will have access to editing.** Gate tag-category/value editing behind admin role (currently `createTag`/`deleteTagIfUnused` are editor/admin for add, admin-only for delete — confirm/extend).
- **F5-4 The add new tag feature doesn't work — non-functional facet dropdown, can't actually do anything.** VERIFIED: the facet `<select>` is populated only from `distinctFacets = Object.keys(byFacet)` (facets that already have tags); the "New facet…" (`__new__`) path reveals a second input but is clunky; AND there's no validation that `facet` is canonical (Track 5 NEW-9 — you can mint `facet:'foo'`). Redesign the add-tag UX with explicit facet categories, a real "create new facet" flow, and facet/value validation.
- **F5-5 Footer divider misplaced here as well.** Same CSS issue as F3-3.

### F6 — Upload page (`/admin/upload`)
- **F6-1 Need better design for this experience — buttons, guidance.** The upload page is bare (multipart form, minimal copy). Redesign with clear CTA buttons, guidance text, file requirements, and post-upload status (where the doc goes, what happens next).
- **F6-2 Haven't tested upload + subsequent processing yet — ensure automated test coverage over this functionality and the processing pipeline.** Track 6 found `test_worker_pipeline.py` (the only e2e pipeline test) is EXCLUDED from CI, and all 6 `*.db.test.ts` self-skip in CI. Add: upload→intake→worker→searchable e2e test (against a scratch pgvector DB), and bring the worker pipeline test into CI. (Overlaps P2-60..63.)

### G. New data-quality issue found during verification (2026-07-06/07)
- **G-1 (NEW P1, = F3-1):** 37 documents have garbage titles ("Pre-EM"×34, "Not available"×3) due to the migration's `Article Title or Publication Title` fallback picking non-empty junk. Backfill + fix the fallback chain. Live evidence: `SELECT title, count(*) FROM documents WHERE title IN ('Pre-EM','Not available') GROUP BY title` → 34 + 3. **FIXED in Wave 1 Task A1** (migration 1781320000000; verified 0 junk titles).

## I. NEW P0 — uploads vanish: worker not running, no health signal, misleading UI (2026-07-07, reproduced live)

**Reproduced:** a partner uploaded 2 PDFs via `/admin/upload`. The UI showed "2 file(s) dropped into intake — the worker registers them within ~10s." The files then **vanished** — not in the review queue, documents list, or anywhere.

**Root cause (systematic-debugging, evidence chain):**
1. The intake route (`src/app/api/admin/intake/route.ts`) **only uploads files to S3 `intake/`** and writes an audit row — it does **NOT** create a `documents` or `ingestion_jobs` row. Registration is the **worker's** job (`search-service/worker/intake_s3.py::_register`).
2. **The worker was not running** (no `worker.main` process; the task brief states it's "boot on demand" — not started).
3. So the files sat in `intake/` indefinitely, invisible to the admin UI (which reads from the DB), and the "~10s" message misled the user into believing a worker was polling.

**Live evidence:**
- audit row 149 (14:33:14): `intake_upload`, `files: [whos-driving-this-bus….pdf, climate-readiness….pdf]` → upload API ran.
- MinIO `intake/` held both files (1.3MB + 3.9MB) → upload succeeded.
- `ingestion_jobs` had only the old canary → no new job.
- 0 `draft`/`processing`/`needs_review`/`error` docs → no document row created.
- **Definitive test:** started the worker (`cd search-service && ./venv/bin/python -m worker.main`); it immediately picked up both files, ran parse→language→summarize→classify→embed→publish, and both became `searchable` with `done` jobs (verified in DB). Doc count went 170 → 171 searchable + 1 withdrawn = 172.

**Why it's a P0 (not just "forgot to start the worker"):**
- The upload UI **lies** — it promises registration "within ~10s" with no indication the worker is down (F6-1).
- There is **no worker-health signal anywhere** in the admin UI — an operator cannot diagnose this without SSH + `ps`/logs.
- There is **no automated test** covering upload→registration→processing→searchable (F6-2) — exactly why it slipped through.
- In prod the worker is a separate ECS service (`desired_count=1`); a deploy that fails the worker (e.g. the B1 Dockerfile bug, now fixed) would silently break all uploads with the same symptom.

**Fixes (folded into the plan as the TOP Wave 3 item — I1 below; depends on nothing from Wave 1/2):**
- **I1-a (UI):** the upload page must show real worker status, not a fixed "~10s" promise — query a `/api/admin/worker-health` endpoint (worker liveness + last-seen + queue depth) and show "Worker: running/idle" vs "Worker: NOT RUNNING — your upload is queued but will not be processed until it starts" (red). Link to the review queue. (F6-1)
- **I1-b (API):** add `GET /api/admin/worker-health` — reports whether the worker is running (heuristic: most-recent `ingestion_jobs.updated_at` within `WORKER_POLL_SECONDS * 3`, or a heartbeat row), queue depth (`SELECT count(*) FROM ingestion_jobs WHERE status IN ('queued','running')`), and last-processed-at.
- **I1-c (test):** add an upload→intake→worker→searchable e2e test (`search-service/tests/test_upload_e2e.py`): upload 2 PDFs via the intake route (or directly to `intake/`), start the worker `--once` in a loop, assert both reach `searchable` with chunks + summaries + a `done` job. (F6-2, overlaps P2-60..63 / Task G1.)
- **I1-d (corpus-health dashboard):** surface "Worker: running/stale/down" + queue depth on the review page (Task F3) so it's diagnosable from the UI (§H.4 / §11.317).
- **I1-e (upload UX):** after upload, show a per-file status that updates (queued → processing → searchable/needs_review) by polling the job/document, so the user sees progress instead of a one-shot "~10s" claim.

**Note:** the worker is now running (PID 33681) and the 2 uploaded docs are `searchable`; the partner is unblocked. The fix prevents recurrence.
