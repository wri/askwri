# AskWRI Doc-Mgmt Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Work ONLY in /Users/gutelius/Documents/GitHub/askwrimvp on branch qa-wip-david — do NOT create a git worktree** (the branch depends on gitignored state: `search-service/data/`, `search-service/venv/`, `.env.local` files, `/tmp/askWRI_docs` symlink — none of which follow into a worktree).

**Goal:** Fix the document-management system's correctness, data-quality, security, multilingual-renditions, and UI/UX gaps identified in `docs/plans/2026-07-06-doc-mgmt-master-issues.md`, aligned with the design (`docs/plans/2026-06-09-askwri-document-management-design.md`).

**Architecture:** Phased, dependency-ordered waves. Wave 1 = independent foundation (migrations+data-quality, Python worker, public routes). Wave 2 = app-tier API (import API, admin API) — depends on Wave 1 columns. Wave 3 = admin UI + CI/tests + docs/branding — depends on Wave 2 API. Each task is TDD with a failing test first. Frequent conventional commits (no `Co-Authored-By`).

**Tech Stack:** Next.js 16 App Router + TypeORM 0.3 (app tier, `src/`); FastAPI + LlamaIndex + pgvector (search-service, Python 3.13); Jest (jsdom + `*.db.test.ts` against live Postgres); pytest (`search-service/tests/`, self-provisioning scratch DBs). pgvector 0.8.4 local; RDS 0.8.2 prod.

## Global Constraints (from CLAUDE.md + task brief — verbatim)

- **Never modify** `.env`, `search-service/.env`, or anything under `terraform/`. Never print/commit their contents.
- **`package-lock.json`:** if `npm install` regenerates it, leave it **modified-unstaged** — never `git add` it. Stage files explicitly; never `git commit -am` or `git add -A`.
- **Commits:** conventional commits, **NO Co-Authored-By trailers**.
- **Migrations:** `src/db/migrations/<epoch_ms>-Migration.ts`, raw SQL via `queryRunner.query`. `synchronize` is always false. pgvector `vector`/`sparsevec` columns are NOT TypeORM-native → raw SQL only; no entity maps `document_chunks`/`document_texts`.
- **Write ownership:** app tier owns relational tables; Python side owns `document_chunks`/`document_texts`/`document_summaries`/`keyword_vocab` (raw SQL). The worker may write `documents`(draft/status), `document_summaries`, `document_tags`(llm), `ingestion_jobs`, `audit_log`. Never touch `document_tags` rows with `source='human'`/`'external'`.
- **`/query` contract:** preserve `QueryRequest`/`QueryResponse` exactly. Retrieval tuning (RRF/rerank/thresholds) is OUT OF SCOPE.
- **Env precedence:** real env > `.env.local` > `.env`. Local `.env.local` files are gitignored; never edit `.env`/`search-service/.env` for local values.
- **Local prod build:** `npx next build --webpack` (Turbopack panics on the venv symlink). Python: `cd search-service && ./venv/bin/python -m <module>`.
- **`abstract` is dead** (0/170, no reader/writer anywhere — exhaustively verified): drop it entirely.
- **Multilingual is core:** AskWRI is a multilingual search engine. Design §7.5/§10: every doc has **native + English** summaries, `title_en` always populated, full language set preserved.
- **Live stack:** Postgres `askwri-pg` (:5432), MinIO (:9000/9001), search-service (:8000), app (:3000). DB queries via `docker exec askwri-pg psql -U askwri -d qa -c "..."`. 170 docs (169 searchable + 1 withdrawn canary `askwri-canary-1783377155`).

## Test-running commands (use these exactly)

- App DB-integration: `npm run test:db` (runs the `*.db.test.ts` against live Postgres via `DATABASE_URL` from `.env.local`). Single file: `npx jest src/__tests__/admin-documents.db.test.ts --runInBand`.
- App pure-logic: `npm test` (jsdom). Lint: `npm run lint`. Build: `npx next build --webpack`.
- Python: `cd search-service && ./venv/bin/python -m pytest tests/ -v` (all) or a file: `./venv/bin/python -m pytest tests/test_worker_pipeline.py -v`. Needs `DATABASE_URL` + `REQUIRE_DB_TESTS=1` for DB-gated tests (set in `search-service/.env.local`).
- Always verify a fix end-to-end against the live DB when the test is a `*.db.test.ts`.

---

## Wave 1 — Foundation (independent; fan out 3 parallel tracks)

Tracks A (migrations+data-quality), B (Python worker), C (public routes) touch disjoint file sets → parallel.

---

### Task A1: Migration — drop `abstract`, add `authors`/`url`/`date_published` columns + backfill + fix 37 garbage titles + relabel 33 mislabeled summaries + backfill `title_en` + content_hash dedup index

**Files:**
- Create: `src/db/migrations/1781320000000-Migration.ts`
- Modify: `src/db/entities/Document.entity.ts` (drop `abstract`; add `authors`, `url`, `datePublished`)
- Test: `src/__tests__/migration-178132.db.test.ts` (new; runs against live DB after `npm run migration:run`)

**Interfaces:**
- Produces: `documents` gains nullable `authors text`, `url text`, `date_published date`; loses `abstract`. Backfilled from `source_metadata` jsonb. 37 titles fixed (prefer Publication Title). 33 mislabeled `document_summaries.language` relabeled → `en`. 33 `title_en` backfilled. Unique index on `content_hash` (partial, WHERE NOT NULL) added.

- [ ] **Step 1: Write the failing test** `src/__tests__/migration-178132.db.test.ts`

```ts
import { hasDb } from '../lib/db-test-helper'

const describeDb = hasDb ? describe : describe.skip

describeDb('migration 178132 — schema + data backfills', () => {
  it('documents has authors/url/date_published, not abstract', async () => {
    const cols = await runSql(`SELECT column_name FROM information_schema.columns WHERE table_name='documents' ORDER BY column_name`)
    const names = cols.map((r: any) => r.column_name)
    expect(names).toContain('authors')
    expect(names).toContain('url')
    expect(names).toContain('date_published')
    expect(names).not.toContain('abstract')
  })
  it('authors/url/date_published backfilled for all 169 migrated docs', async () => {
    const r = await runSql(`SELECT
      count(*) FILTER (WHERE authors IS NOT NULL) AS a,
      count(*) FILTER (WHERE url IS NOT NULL) AS u,
      count(*) FILTER (WHERE date_published IS NOT NULL) AS d
      FROM documents WHERE source_metadata IS NOT NULL`)
    expect(r[0].a).toBe('169')
    expect(r[0].u).toBe('169')
    expect(r[0].d).toBe('169')
  })
  it('no document title is "Pre-EM" or "Not available"', async () => {
    const r = await runSql(`SELECT count(*) FROM documents WHERE title IN ('Pre-EM','Not available')`)
    expect(r[0].count).toBe('0')
  })
  it('33 non-English docs have title_en populated and their summaries relabeled to en', async () => {
    const r = await runSql(`SELECT count(*) FILTER (WHERE language <> 'en' AND title_en IS NULL) AS bad_title_en,
      count(*) FILTER (WHERE language <> 'en') AS non_en FROM documents WHERE source_metadata IS NOT NULL`)
    expect(r[0].bad_title_en).toBe('0')
    // the 33 native-language summaries that were mislabeled are now en; native slots empty until worker regen
    const sums = await runSql(`SELECT language, count(*) FROM document_summaries GROUP BY language ORDER BY language`)
    const enRow = sums.find((s: any) => s.language === 'en')
    expect(Number(enRow.count)).toBeGreaterThanOrEqual(169) // all migrated + any worker en
  })
  it('content_hash has a unique partial index', async () => {
    const r = await runSql(`SELECT indexdef FROM pg_indexes WHERE tablename='documents' AND indexdef ILIKE '%content_hash%'`)
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].indexdef).toMatch(/UNIQUE/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx jest src/__tests__/migration-178132.db.test.ts --runInBand` → FAIL (columns don't exist; abstract still present).

- [ ] **Step 3: Write the migration** `src/db/migrations/1781320000000-Migration.ts`

```ts
import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1781320000000 implements MigrationInterface {
  name = 'Migration1781320000000'

  public async up(q: QueryRunner): Promise<void> {
    // Drop the dead abstract column (0/170 populated, no reader anywhere).
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "abstract"`)

    // Add editable metadata columns (CSV keys All authors / URL / Date published).
    await q.query(`ALTER TABLE "documents" ADD COLUMN "authors" text`)
    await q.query(`ALTER TABLE "documents" ADD COLUMN "url" text`)
    await q.query(`ALTER TABLE "documents" ADD COLUMN "date_published" date`)

    // Backfill from source_metadata.metadata jsonb for migrated docs.
    await q.query(`UPDATE documents SET authors = source_metadata->'metadata'->>'All authors'
      WHERE authors IS NULL AND source_metadata->'metadata'->>'All authors' IS NOT NULL`)
    await q.query(`UPDATE documents SET url = source_metadata->'metadata'->>'URL'
      WHERE url IS NULL AND source_metadata->'metadata'->>'URL' IS NOT NULL`)
    await q.query(`UPDATE documents SET date_published = to_date(source_metadata->'metadata'->>'Date published', 'MM/DD/YYYY')
      WHERE date_published IS NULL AND source_metadata->'metadata'->>'Date published' IS NOT NULL`)

    // Fix 37 garbage titles: prefer Publication Title when Article Title is a junk sentinel.
    await q.query(`UPDATE documents SET title = source_metadata->'metadata'->>'Publication Title'
      WHERE title IN ('Pre-EM','Not available')
        AND source_metadata->'metadata'->>'Publication Title' IS NOT NULL
        AND source_metadata->'metadata'->>'Publication Title' NOT IN ('Pre-EM','Not available')`)
    // Any still-junk title with no good Publication Title → fall back to external_id (cleaner than junk).
    await q.query(`UPDATE documents SET title = external_id
      WHERE title IN ('Pre-EM','Not available')`)

    // Relabel the 33 mislabeled summaries: their text is English but tagged native. → en.
    // (The native slots empty so the worker's summarize stage regenerates real native summaries.)
    await q.query(`UPDATE document_summaries SET language = 'en'
      WHERE language IN ('zh','es','pt')`)

    // Backfill title_en for the 33 non-English migrated docs (translation deferred per design §10.4).
    await q.query(`UPDATE documents SET title_en = title
      WHERE title_en IS NULL AND language <> 'en'`)

    // Dedup: unique partial index on content_hash (NULLs allowed, no two docs same hash).
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_documents_content_hash"
      ON "documents" ("content_hash") WHERE "content_hash" IS NOT NULL`)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_documents_content_hash"`)
    await q.query(`UPDATE document_summaries SET language = d.language
      FROM documents d WHERE document_summaries.document_id = d.id AND d.language IN ('zh','es','pt')`) // best-effort
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "date_published"`)
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "url"`)
    await q.query(`ALTER TABLE "documents" DROP COLUMN IF EXISTS "authors"`)
    await q.query(`ALTER TABLE "documents" ADD COLUMN "abstract" text`)
  }
}
```

- [ ] **Step 4: Update the entity** `src/db/entities/Document.entity.ts` — remove the `abstract` column; add `authors`, `url`, `datePublished`:

```ts
  @Column('text', nullable: true })
  authors!: string | null

  @Column('text', nullable: true })
  url!: string | null

  @Column('date', { name: 'date_published', nullable: true })
  datePublished!: string | null
```
(Delete the `abstract!: string | null` line and its decorator.)

- [ ] **Step 5: Run the migration + test** — `npm run migration:run` then `npx jest src/__tests__/migration-178132.db.test.ts --runInBand` → PASS. Verify live: `docker exec askwri-pg psql -U askwri -d qa -c "SELECT count(*) FILTER (WHERE title IN ('Pre-EM','Not available')) FROM documents"` → `0`.

- [ ] **Step 6: Commit** — `git add src/db/migrations/1781320000000-Migration.ts src/db/entities/Document.entity.ts src/__tests__/migration-178132.db.test.ts && git commit -m "fix(migration): drop abstract, add authors/url/date_published, fix 37 junk titles, relabel mislabeled summaries, backfill title_en, content_hash dedup index"`

---

### Task A2: Fix the Phase-0 migration script's title fallback + `--reset` TRUNCATE scope (prevent regressions on re-run)

**Files:**
- Modify: `search-service/scripts/migrate_csv_to_postgres.py` (title fallback chain; `--reset` scope)
- Test: `search-service/tests/test_migration_script.py` (extend — the existing synthetic-corpus test)

**Interfaces:** none new (one-time script; fixes make a fresh `--reset` safe + correct).

- [ ] **Step 1: Write the failing test** — in `test_migration_script.py`, add:

```python
def test_title_prefers_publication_title_when_article_title_is_junk(tmp_path, postgres_url):
    # CSV row with Article Title = "Pre-EM" but a good Publication Title
    ...build a 1-row CSV with {"Article Title": "Pre-EM", "Publication Title": "Real Title"}...
    run_migration(...)
    row = fetch_doc(postgres_url, ext_id)
    assert row["title"] == "Real Title"

def test_reset_does_not_truncate_ingestion_jobs(tmp_path, postgres_url):
    # seed an ingestion_jobs row, run --reset, assert the job survives
    ...
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — change `title = raw.get("Article Title") or raw.get("Publication Title") or ext_id` to prefer Publication Title when Article Title is a junk sentinel or empty:

```python
JUNK_TITLES = {"Pre-EM", "Not available", "", None}
def _title(raw, ext_id):
    art = raw.get("Article Title")
    pub = raw.get("Publication Title")
    if pub and pub not in JUNK_TITLES:
        return pub
    if art and art not in JUNK_TITLES:
        return art
    return ext_id
```
And replace the `--reset` `TRUNCATE documents CASCADE` with explicit per-table truncates that exclude `ingestion_jobs` (and `audit_log`): `TRUNCATE document_chunks, document_texts, document_summaries, document_tags, document_collections, documents, tags, collections` (no CASCADE).

- [ ] **Step 4: Run → PASS** (`./venv/bin/python -m pytest tests/test_migration_script.py -v`).

- [ ] **Step 5: Commit** — `git commit -m "fix(migration script): prefer Publication Title over junk Article Title; --reset no longer truncates ingestion_jobs/audit_log"`

---

### Task B1: Worker `language` stage — merge languages, never shrink (P1-3/#5)

**Files:**
- Modify: `search-service/worker/stages/language.py:38-40`
- Test: `search-service/tests/test_worker_stages.py` (extend) or `test_worker_pipeline.py`

- [ ] **Step 1: Failing test** — a doc with `languages=['en','es']`, run the language stage with detected `lang='en'`; assert `languages` still contains `es` (merge, not overwrite):

```python
def test_language_stage_merges_not_overwrites(db, doc_with_languages_en_es):
    before = fetch_languages(db, doc_id)  # ['en','es']
    run_stage("language", doc_id)  # detects 'en'
    after = fetch_languages(db, doc_id)
    assert set(after) == {'en','es'}  # 'es' preserved
```

- [ ] **Step 2: Run → FAIL** (currently `UPDATE ... languages=%s` with `[lang]` overwrites).

- [ ] **Step 3: Fix** — `language.py`:

```python
        lang = detect(row[0])
        # Merge the newly-detected language into the existing set; never shrink the array
        # (design §7.4: detect "the set present"; a re-ingest must not drop a language).
        existing = doc["languages"] or []
        merged = list(dict.fromkeys([lang, *existing]))  # dedupe, preserve order, lang first
        conn.execute(
            "UPDATE documents SET language=%s, languages=%s, updated_at=now() WHERE id=%s",
            (lang, merged, document_id),
        )
```
(`fetch_document` already returns `languages`; verify it's in the SELECT — it is, `stages/__init__.py:25`.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(worker): language stage merges languages[] instead of overwriting (never shrink)"`

---

### Task B2: Worker `summarize` stage — allow replacing summaries on re-ingest + generate native+English (NEW-P1-A, #6 native regen)

**Files:**
- Modify: `search-service/worker/stages/summarize.py:44-53` (skip-logic)
- Test: `search-service/tests/test_worker_stages.py` (extend)

- [ ] **Step 1: Failing test** — a doc with a stale `long` summary (old content) + a `document_texts` updated to new content; run summarize; assert the `long` summary is regenerated (text changes) AND a native summary is generated when the native slot is empty (post-relabel):

```python
def test_summarize_replaces_stale_summary_on_reingest(db, doc_with_stale_summary_and_new_text):
    before = fetch_long_summary(db, doc_id)
    run_stage("summarize", doc_id)
    after = fetch_long_summary(db, doc_id)
    assert after != before  # regenerated from new text

def test_summarize_generates_native_when_slot_empty(db, zh_doc_with_en_only_summaries):
    # post-relabel: zh doc has en summaries only, no zh
    run_stage("summarize", doc_id)
    assert fetch_summary(db, doc_id, lang='zh', kind='long') is not None
```

- [ ] **Step 2: Run → FAIL** (skip-logic preserves stale rows).

- [ ] **Step 3: Fix** — replace the "skip if both exist" guard with "regenerate rows whose source='generated' on re-ingest; never touch source='external'/'human'":

```python
        targets = {doc["language"], "en"}
        for lang in sorted(targets):
            for kind in ("long", "short"):
                row = existing_summary(conn, document_id, lang, kind)
                if row is None:
                    pass  # generate below
                elif row["source"] in ("external", "human"):
                    continue  # protected: never overwrite curated/CSV summaries
                # else: source='generated' → regenerate (delete + insert) on re-ingest
            result = _summarize(text, doc["title"] or doc["external_id"], lang, settings.worker_llm_model)
            for kind in ("long", "short"):
                row = existing_summary(conn, document_id, lang, kind)
                if row is not None and row["source"] in ("external", "human"):
                    continue
                if row is not None:
                    conn.execute("DELETE FROM document_summaries WHERE document_id=%s AND language=%s AND kind=%s",
                                 (document_id, lang, kind))
                conn.execute("""INSERT INTO document_summaries (document_id, language, kind, text, source, model_version)
                               VALUES (%s,%s,%s,%s,'generated',%s)""",
                             (document_id, lang, kind, result[kind], settings.worker_llm_model))
```
(Add a `title_en` set for English docs too — see Task B8 / NEW-P2-8: set `title_en = COALESCE(title_en, title)` for ALL docs, not just non-EN.)

- [ ] **Step 4: Run → PASS.** (The embed stage rebuilds the summary chunk from the regenerated long summary automatically — `embed.py:91-93` already re-reads `document_summaries`.)

- [ ] **Step 5: Commit** — `git commit -m "fix(worker): summarize regenerates generated summaries on re-ingest (no stale); generates native when slot empty"`

---

### Task B3: Worker withdrawn-guard consistency (parse needs_review writes + embed) (N-W4, NEW-P2-5)

**Files:**
- Modify: `search-service/worker/stages/parse.py:69,74` (guard the two `needs_review` writes); `search-service/worker/stages/embed.py` (add a withdrawn guard before the DELETE+INSERT); `search-service/worker/stages/publish.py:43-47` (NEW-P2-4: return `None` not `"needs_review"` when the withdrawn guard no-ops).

- [ ] **Step 1: Failing tests** (test_worker_stages.py) — (a) a withdrawn doc, run parse with no-text; assert status stays `withdrawn`; (b) run embed; assert chunks unchanged; (c) run publish with low confidence on a withdrawn doc; assert job ends `done` not `needs_review`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — add `AND status <> 'withdrawn'` to the two parse `needs_review` UPDATEs; in `embed.py` after `fetch_document`, `if doc["status"] == "withdrawn": return None`; in `publish.py:47` change `return "needs_review"` to `if cur.rowcount == 0: return None` then `return "needs_review"`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(worker): consistent withdrawn-guard across parse/embed/publish (never overwrite a takedown)"`

---

### Task B4: Worker `_build_nodes_for_doc` parity with migration (R3) + zh page attribution (R4)

**Files:**
- Modify: `search-service/worker/stages/embed.py:74-88` (title source = Publication Title; full authors; file_path = CSV `file_path` not `s3_key`); `:106-108` + the boundary computation (recompute boundaries on the normalized Simplified text, or compute `start` against the original Traditional text).

- [ ] **Step 1: Failing test** (test_worker_stages.py) — a doc whose `Article Title != Publication Title`; run embed; assert `node_metadata.title == Publication Title`, `node_metadata.authors == full All authors` (not truncated to 100), `node_metadata.file_path == CSV file_path`. Plus a multi-page zh doc with a length-changing OpenCC phrase; assert chunk `page` values are correct (not drifted).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — in `_build_nodes_for_doc`, set `title` from `src.get("Publication Title") or src.get("Article Title") or doc["title"]`; `authors` = full `src.get("All authors")` (no `[:100]`); `file_path` = `(doc["source_metadata"] or {}).get("file_path") or doc["s3_key"]`. For zh: compute `start = full_text.find(node.text[:100])` against the **original** text ( Traditional) before conversion, OR recompute boundaries from the Simplified text. Cleanest: keep `boundaries` in Traditional-space and compute `start` from `full_text_original.find(node.text_original)`. Since `parser` already split on Simplified, the minimal correct fix is: in `embed.py`, normalize boundaries AFTER conversion — recompute `boundaries` by walking the Simplified text. (Implement the recompute; add the test asserting multi-page zh pages.)

- [ ] **Step 4: Run → PASS** (`./venv/bin/python -m pytest tests/test_worker_stages.py tests/test_worker_pipeline.py -v`).

- [ ] **Step 5: Commit** — `git commit -m "fix(worker): node_metadata parity with migration (title/authors/file_path) + zh OpenCC page attribution"`

---

### Task B5: Worker queue `next_stage` bounds + classify dead import + intake pagination (NEW-P2-6, NEW-P2-11, NEW-P2-9)

**Files:**
- Modify: `search-service/worker/queue.py:98` (bounds check), `search-service/worker/stages/classify.py:11` (remove unused `Jsonb` import + misleading comment), `search-service/worker/intake_s3.py:61,66` (pagination loop + delete non-PDF objects).

- [ ] **Step 1: Failing tests** — `next_stage("publish")` raises a clear `RuntimeError("already at terminal stage")` (not `IndexError`); `_sweep_s3` with >50 intake objects processes all (uses `ContinuationToken`); a non-PDF object in `intake/` is deleted.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — `next_stage`: `if completed_stage == STAGE_ORDER[-1]: raise RuntimeError("already at terminal stage 'publish'")`. `_sweep_s3`: wrap the `list_objects_v2` in a `while` with `ContinuationToken`; for non-PDF keys, `s3.delete_object` + continue (don't leave orphaned).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(worker): next_stage bounds check, remove dead Jsonb import, intake pagination + non-PDF cleanup"`

---

### Task C1: Public PDF route — S3-backed via `doc.s3Key` (kills R5 boot-sync gap) (P1-9/R5)

**Files:**
- Modify: `src/app/api/pdf/[filename]/route.ts` (look up the doc by `external_id` from the filename, serve from S3 via `doc.s3Key` — or a signed redirect)
- Create: `src/db/queries/getDocumentForPdf.ts` (lookup by external_id, return s3_key + status)
- Modify: `src/lib/s3.ts` if needed for a `getSignedUrl` helper
- Test: `src/__tests__/pdf-route.db.test.ts` (new) + `src/__tests__/pdf-route.test.ts` (pure)

**Interfaces:**
- Produces: `GET /api/pdf/[filename]` serves the PDF for a `searchable` doc from S3 via `doc.s3Key` (works under any `DOCUMENTS_S3_PREFIX`); 404 for withdrawn/nonexistent.

- [ ] **Step 1: Failing test** — `pdf-route.db.test.ts`: a searchable doc with `s3_key="documents/foo.pdf"`; mock S3 (MinIO local); GET `/api/pdf/foo.pdf` → 200 with PDF bytes (or 302 to a signed URL). A withdrawn doc → 404. (Use the local MinIO bucket with a seeded object.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — rewrite the route: `initializeDatabase()` → look up by `external_id = filename without .pdf` → if not found or `status='withdrawn'` → 404 → else stream from S3 via `doc.s3Key` (or signed-URL redirect). Keep the local-fallback path for `DOCUMENTS_LOCAL_DIR` if set (dev). Add the `getDocumentForPdf` query.

- [ ] **Step 4: Run → PASS** (`npx jest pdf-route --runInBand`). Verify live: `curl -s -o /dev/null -w "%{http_code}" localhost:3000/api/pdf/2021_accelerating-innovation-in-urban-service-delivery_1054.pdf` → `200` (currently 404 because `/tmp/askWRI_docs` is empty for migrated bare keys — this fix resolves it).

- [ ] **Step 5: Commit** — `git commit -m "fix(pdf): serve public PDFs from S3 via doc.s3Key (status-aware); removes R5 boot-sync gap"`

---

### Task C2: Catalog route — `postgres` as the default/required source (P1-10)

**Files:**
- Modify: `src/app/api/catalog/route.ts:144` (default to postgres; remove the CSV fallback or gate it behind an explicit `CATALOG_SOURCE=csv`)
- Test: `src/__tests__/catalog-route.test.ts` (extend)

- [ ] **Step 1: Failing test** — with no `CATALOG_SOURCE` set, `GET /api/catalog` returns `source: 'postgres'` and 169 items (against the live DB).

- [ ] **Step 2: Run → FAIL** (currently defaults to CSV fallback).

- [ ] **Step 3: Fix** — flip the branch: `if (process.env.CATALOG_SOURCE === 'csv')` → CSV fallback; else → postgres (default). Keep the CSV path for the legacy `legacy` retrieval backend only.

- [ ] **Step 4: Run → PASS.** Verify live: `curl -s localhost:3000/api/catalog | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['source'], d['count'])"` → `postgres 169` (or 170 incl canary — confirm searchable filter).

- [ ] **Step 5: Commit** — `git commit -m "fix(catalog): postgres is the default source (CSV fallback only on explicit CATALOG_SOURCE=csv)"`

---

### Task C3: Citation export — drop the "AI generated" mislabel + don't propagate truncated short (P0-2, P2-10)

**Files:**
- Modify: `src/app/components/results/ResultsTable.tsx:37` (drop or correct the "AI generated" tag for `source='external'` summaries); `src/app/utils/exportCitationsCsv.ts:86-92` (use the long summary, not the truncated short; fix the mislabeled header)
- Test: `src/__tests__/export-citations.test.ts` (new)

- [ ] **Step 1: Failing test** — the export's "Summary" column contains the full long summary (not a 240-truncated short); the header doesn't claim "not part of the metadata".

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — `exportCitationsCsv.ts`: prefer `row?.summary` (the long summary via catalog) over `row?.shortSummary`; drop the `slice(0,237)+'...'`; fix the header. `ResultsTable.tsx`: only show "AI generated" when the summary source is `generated` (the catalog returns `source`? — if not, drop the tag entirely to stop the mislabel; the summaries are CSV-curated, not AI).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(ui): stop showing truncated short summaries as 'AI generated'; export uses the long summary"`

> **Wave 1 checkpoint:** run `npm run test:db && npm test && cd search-service && ./venv/bin/python -m pytest tests/ -v && npx next build --webpack` — all green before Wave 2.
>
> **Wave 1 verification (2026-07-07, parent-run):** Wave 1 code is sound (9 commits: A1/A2, B1-B5, C1/C2/C3). 3 test failures found are **stale-count test-debt** (tests hardcode `169`; the live DB now has 171 after reproducing the upload bug — see §I), NOT Wave 1 regressions: `test_pg_store.py:32` (`assert len(meta)==169`), `catalog-items.db.test.ts:45` (`toHaveLength(169)`), `catalog-route.db.test.ts:54` (`toBe(169)`). Fix in Task G1: make corpus-size assertions count-agnostic (≥169, or equals live `SELECT count(*)`).

---

## Wave 1.5 — NEW P0 (uploads vanish): worker-health + upload UX (2026-07-07, top priority)

Reproduced live (see master issues §I): uploads to `/admin/upload` vanish because the intake route only drops files in S3 `intake/` and the **worker must be running** to register them — but there's no health signal, the UI promises "~10s" regardless, and there's no e2e test. This is the partner's F6-1 + F6-2 plus a new operational gap.

### Task I1: Worker-health endpoint + upload-page real status + upload e2e test (P0)

**Files:**
- Create: `src/app/api/admin/worker-health/route.ts` (GET — worker liveness heuristic: most-recent `ingestion_jobs.updated_at` within `WORKER_POLL_SECONDS*3`, queue depth, last-processed-at)
- Create: `src/db/queries/workerHealth.ts`
- Modify: `src/app/admin/upload/page.tsx` (show real worker status; per-file progress polling; link to review queue; no more fixed "~10s" lie)
- Create: `search-service/tests/test_upload_e2e.py` (upload 2 PDFs → worker --once loop → assert searchable + chunks + summaries + done job)
- Modify (test-debt): `search-service/tests/test_pg_store.py:32`, `src/__tests__/catalog-items.db.test.ts:45`, `src/__tests__/catalog-route.db.test.ts:54` — make corpus-size assertions count-agnostic

- [ ] **Step 1: Failing test** — `test_upload_e2e.py`: 2 canary PDFs in `intake/`, run worker `--once` until both jobs `done`, assert both docs `searchable` with chunks + summaries. (This is also the F6-2 / Task G1 e2e — fold them.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the worker-health endpoint + upload-page status polling; fix the 3 stale-count assertions.
- [ ] **Step 4: Run → PASS** (`npm run test:db && cd search-service && ./venv/bin/python -m pytest tests/test_upload_e2e.py -v`).
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): worker-health endpoint + upload-page real status + upload e2e test (fixes vanishing uploads)"`

---

---

## Wave 2 — App-tier API (depends on Wave 1 columns; fan out 2 tracks)

Tracks D (import API), E (admin API) share `documentsAdmin.ts`/`importDocuments.ts` minimally → D and E touch different files mostly; sequence E after D if they overlap on `EDITABLE_FIELDS`.

---

### Task D1: Import API — map all 14 CSV keys (doi/article_type/office + authors/url/date_published), atomic job creation, `s3_key` validation, audit actor, role gate (P1-8, D2, D3, D5)

**Files:**
- Modify: `src/db/queries/importDocuments.ts` (`mapRowToDocument` add `doi`/`articleType`/`wriPrimaryOffice`/`authors`/`url`/`datePublished`; `classifyUpsert` include them; `OPEN_STATUSES` drop `needs_review`; atomic `ON CONFLICT` job insert; `s3_key` validation = `.pdf` basename under `documents_s3_prefix`); `src/app/api/import-documents/route.ts` (pass `identity` to `importDocuments`; require admin role).
- Test: `src/__tests__/import-documents.test.ts` (extend — 41 existing tests)

- [ ] **Step 1: Failing tests** — (a) import a row with `DOI`/`article_type`/`wri_primary_office`/authors/url/date → columns populated; (b) import a row with `file_path:"eval-data/secret.pdf"` → rejected with 400; (c) import when a `needs_review` job exists → creates a new queued job; (d) audit row has `actor_user_id`; (e) a non-admin editor POSTing → 403.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — extend `mapRowToDocument`; add an `s3_key` sanitizer (basename + prefix); switch job creation to the `ON CONFLICT (document_id) WHERE status IN ('queued','running') DO NOTHING RETURNING` pattern (drop `needs_review` from open-set); pass `identity` → write `actor_user_id` + `source: human|system`; `requireIdentity(req, 'admin')` on the route.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(import): map all CSV keys to columns, validate s3_key, atomic job insert, audit actor, admin-only"`

---

### Task E1: Admin API — promote restriction (#4), remove abstract from whitelist, add authors/url/datePublished to whitelist + validation, search by author/DOI, language filter `@>`, transactional audit, DELETE tags endpoint (N-C, N-B, N-J, P2-27, search/filter)

**Files:**
- Modify: `src/db/queries/documentsAdmin.ts` (`EDITABLE_FIELDS`: drop `abstract`, add `authors`/`url`/`datePublished`; `setDocumentStatus`: restrict promote to `fromStatus='needs_review'`; search ILIKE add `authors`/`doi`/`url`; language filter `languages @> ARRAY[$1]`; wrap mutations+audit in `AppDataSource.transaction`); `src/app/api/admin/documents/[id]/tags/[tagId]/route.ts` (add `DELETE` handler); `src/db/queries/tagsAdmin.ts` (`removeDocumentTag`).
- Test: `src/__tests__/admin-documents.db.test.ts` (extend), `src/__tests__/admin-tags.db.test.ts` (extend)

- [ ] **Step 1: Failing tests** — (a) promote a `draft` doc → 403; promote a `needs_review` doc → 200; (b) PATCH `abstract` → ignored (not in whitelist); PATCH `authors`/`url`/`datePublished` → saved; (c) search "Dhindaw" → finds the doc by author; (d) filter language=`es` → returns the `{en,es}` doc; (e) `DELETE …/tags/[tagId]` → row removed; (f) a mutation whose audit INSERT fails → whole thing rolls back (simulate with a bad jsonb).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — implement per the test. Promote: `if (toStatus==='searchable' && fromStatus !== 'needs_review') return { error: 'can only promote needs_review → searchable' }`. Language filter: `languages @> ARRAY[$1]::text[]`. Transactional: `await AppDataSource.transaction(async (em) => { await em.save(...); await em.getRepository(AuditLog).insert(...) })`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(admin): restrict promote to needs_review, editable authors/url/date, author/DOI search, language @> filter, transactional audit, DELETE tag"`

---

### Task E2: Admin API — file route S3-signed/redirect, bearer case-insensitive, intake partial-failure audit, last-admin atomic guard, createTag facet validation (D3-file, N-G, N-K, N-L, NEW-1..9)

**Files:**
- Modify: `src/app/api/admin/documents/[id]/file/route.ts` (sanitize `s3_key` to basename under prefix; signed-URL redirect; no 1h cache on withdrawn); `src/proxy.ts:38` + `src/lib/auth/identity.ts:26` (case-insensitive Bearer); `src/app/api/admin/intake/route.ts` (audit per-file or wrap in try/finally so a mid-batch failure still audits the partial batch; reject same-basename); `src/app/api/admin/users/[id]/route.ts` (last-admin guard as a single atomic `UPDATE ... WHERE (SELECT count ...) >= 1`); `src/app/api/admin/tags/route.ts` (validate `facet` ∈ canonical set OR explicitly allow new facets via a flag); `src/db/queries/users.ts`.

- [ ] **Step 1: Failing tests** for each.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** per test. Bearer: `timingSafeStringEqual(bearer.toLowerCase(), \`bearer \${apiToken}\.toLowerCase())` — actually compare scheme case-insensitively then the token exactly.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "fix(admin): file route signed-url, case-insensitive bearer, atomic last-admin guard, intake audit, tag facet validation"`

---

### Task E3: IngestionJob entity `onDelete` → CASCADE (D1)

**Files:**
- Modify: `src/db/entities/IngestionJob.entity.ts:18` (`onDelete: 'CASCADE'`)
- Test: `src/__tests__/admin-entities.db.test.ts` (extend — `migration:generate` produces no diff for the FK)

- [ ] **Step 1: Failing test** — `AppDataSource.driver.getDifferences()` for `ingestion_jobs` FK → no `SET NULL` expected.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — `onDelete: 'CASCADE'`.

- [ ] **Step 4: Run → PASS** + `npm run migration:generate -- -d src/db/data-source.ts` (dry-run; assert no spurious migration emitted). **Do NOT commit any generated migration** — just confirm the entity now matches the DB.

- [ ] **Step 5: Commit** — `git commit -m "fix(entity): IngestionJob onDelete CASCADE (matches migration 178130; prevents spurious migration:generate)"`

> **Wave 2 checkpoint:** `npm run test:db && npm test && npx next build --webpack` green.

---

## Wave 3 — Admin UI + CI/tests + docs/branding (depends on Wave 2 API)

The admin UI is the contention point (many fixes touch `page.tsx`). Do the editor page as ONE task (single agent) to avoid conflicts. The other pages are independent.

---

### Task F1: Admin editor page — add authors/url/datePublished fields, remove abstract, render source_metadata read-only, summaries editable, layout/divider fix (P1-7, P2-4, F3-3)

**Files:**
- Modify: `src/app/admin/documents/[id]/page.tsx` (EDITABLE list: drop abstract, add authors/url/datePublished with `type:'date'`/textarea; extend the type union to `'number' | 'date' | 'textarea'`; render branch; add a read-only `source_metadata` JSON view section; add edit controls to the Summaries panel; fix the divider/footer CSS).

- [ ] **Step 1: Failing test** (jsdom) — the editor renders an "Authors" textarea, a "URL" input, a "Date published" date input; no "Abstract" field; a "Source metadata (read-only)" section is present.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Fix** — extend `EDITABLE` type union; add the fields; render `source_metadata` in a `<details><pre>` block; add edit/save to the summaries panel (new PATCH endpoint `PATCH /api/admin/documents/[id]/summaries` — add in Task E1's commit or a small E4); fix the bottom divider (wrap the table in a container with `paddingBottom` so the last row's border doesn't collide with the footer).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `git commit -m "feat(admin): editable authors/url/date_published, source_metadata view, editable summaries, layout fix"`

---

### Task F2: Documents list page — add author/DOI/year/tag filters, pagination, collection guidance (F3-2, P2-34, N-Doc1)

**Files:**
- Modify: `src/app/admin/documents/page.tsx` (add year dropdown, tag dropdown (from `/api/admin/tags`), pagination; add a "Collections" explainer tooltip); `src/db/queries/documentsAdmin.ts` (add `yearPublished` + `tagId` filter branches already exist for tagId; add pagination `LIMIT/OFFSET` + `total`).
- Test: `src/__tests__/admin-documents.db.test.ts` (extend)

- [ ] **Step 1..5:** TDD → implement → commit `feat(admin): documents list filters (year/tag), pagination, collection guidance`.

---

### Task F3: Review page — redesign with guidance + corpus-health dashboard (F2-1, §H.4 health dashboard)

**Files:**
- Modify: `src/app/admin/review/page.tsx` (clear instructions; per-doc context (job error/confidence); action affordances with explanations; add a corpus-health summary: counts by status/language, review-queue depth, missing-renditions/missing-`title_en` counts — queries via a new `GET /api/admin/review-queue` extension or a new `/api/admin/corpus-health`).
- Create: `src/db/queries/corpusHealth.ts` + `src/app/api/admin/corpus-health/route.ts`.
- Test: `src/__tests__/admin-review-queue.db.test.ts` (extend), `src/__tests__/corpus-health.db.test.ts` (new)

- [ ] **Step 1..5:** TDD → the health view surfaces exactly the multilingual gaps (docs with no native summary, no `title_en`, etc.) → commit `feat(admin): review page redesign + corpus-health dashboard (missing renditions, title_en, queue depth)`.

---

### Task F4: Tags page — add-tag redesign + editable facets (admin-only) + divider fix (F5-1..F5-5)

**Files:**
- Modify: `src/app/admin/tags/page.tsx` (add-tag form: explicit facet dropdown with canonical facets + a clear "create new facet" flow; facet/value editable for admins — rename with audit; fix divider); `src/app/api/admin/tags/[id]/route.ts` (add PATCH to rename a tag value/facet); `src/db/queries/tagsAdmin.ts`.

- [ ] **Step 1..5:** TDD → commit `feat(admin): tags add-tag redesign, editable facets (admin), divider fix`.

---

### Task F5: Collections page — explainer + slug-on-rename (F4-1, N-D)

**Files:**
- Modify: `src/app/admin/collections/page.tsx` (add a collections explainer); `src/db/queries/collectionsAdmin.ts` (`updateCollection` regenerate slug on rename).

- [ ] **Step 1..5:** TDD → commit `feat(admin): collections explainer + slug regen on rename`.

---

### Task F6: Upload page — redesign with CTAs/guidance/post-upload status (F6-1)

**Files:**
- Modify: `src/app/admin/upload/page.tsx` (clear CTA buttons, file requirements, post-upload status: "your document is queued for ingestion; track it in the Review queue").

- [ ] **Step 1..5:** TDD (jsdom render) → commit `feat(admin): upload page redesign with guidance and post-upload status`.

---

### Task F7: Branding + layout + documentation/tooltips across admin (F1-1, F1-2, F1-3)

**Files:**
- Modify: `src/app/admin/layout.tsx` (AskWRI branding — header/logo/colors/footer); add a `src/app/admin/components/Tooltip.tsx` + `HelpHint` and apply field-level tooltips across the editor, documents, collections, tags, upload, review pages; add a `docs/admin-guide.md` (or an in-app help page).

- [ ] **Step 1..5:** TDD (jsdom) → commit `feat(admin): branding, layout polish, field-level tooltips, admin guide`.

---

### Task G1: CI — add excluded pytest modules + postgres service for `*.db.test.ts` + upload e2e (P2-60..63, F6-2)

**Files:**
- Modify: `.github/workflows/pr-check.yml` (add `test_sparse_retriever`, `test_worker_pipeline`, `test_pg_store`, `test_query_e2e`, `test_startsh_sync`, `test_config`, `test_config_env_local`, `test_env_loading` to the pytest selection; add a `postgres: pgvector/pgvector:pg16` service to the Node `test` job + `DATABASE_URL` + `REQUIRE_DB_TESTS=1` so the `*.db.test.ts` run); create `search-service/tests/test_upload_e2e.py` (upload → intake → worker `--once` loop → assert `searchable` + chunks).
- Test: the workflow itself (validate via `act` or a dry-run; or run the suites locally to confirm they pass in CI-equivalent env).

- [ ] **Step 1:** Run all the excluded pytest modules locally to confirm they pass against the live DB: `cd search-service && ./venv/bin/python -m pytest tests/test_sparse_retriever.py tests/test_worker_pipeline.py tests/test_pg_store.py tests/test_query_e2e.py tests/test_startsh_sync.py tests/test_config.py -v` → all green (if any fail, that's a finding — fix before adding to CI).

- [ ] **Step 2:** Add the upload e2e test (TDD).

- [ ] **Step 3:** Edit `pr-check.yml` — add the modules to the pytest line; add the postgres service + env to the Node job.

- [ ] **Step 4:** Verify locally that the `*.db.test.ts` run with `DATABASE_URL` set (they already do via `npm run test:db`).

- [ ] **Step 5: Commit** — `git commit -m "ci: add sparse/worker/pg_store/query/startsh/config tests + postgres service for *.db.test.ts + upload e2e"`.

---

### Task H1: Docs reconciliation (N-Doc1, N-Doc2, P2-66, P2-67, P2-68, CLAUDE.md write-ownership)

**Files:**
- Modify: `docs/document-management.md` (§11.5 API map — remove non-existent endpoints, add the new ones; §11.1 JWT — correct to "deactivation is near-immediate via DB revalidation"; §3 write-ownership — match Scope decision #4; §10.4 — correct the "Phase 0-identical chunking" overstatement per R3); `CLAUDE.md` (write-ownership rule); `docs/runbooks/phase0-cutover.md` (seed-admin discrepancy).

- [ ] **Step 1..5:** Edit the docs to match the shipped code (post-fixes) → commit `docs: reconcile doc-mgmt docs with shipped code (API map, JWT, write-ownership, seed-admin, chunking parity)`.

---

## Self-Review (run after all waves)

- [ ] **Spec coverage:** every P0/P1 from the master issues doc has a task. Every F1-1..F6-2 item has a task. The multilingual-renditions workstream (P1-1/2/3/#3/#6) is covered by A1+B1+B2.
- [ ] **Design alignment:** §7.5 native+English summaries (A1 relabel + B2 regenerate); §7.4 language set preserved (B1); §6 title_en always populated (A1 backfill); §11.311 review gating (#4/E1); §11.317 corpus-health dashboard (F3); §20 fixed-columns interim (#2/A1+D1).
- [ ] **Placeholder scan:** no TBD/TODO in any task.
- [ ] **Type consistency:** `authors`/`url`/`datePublished` named consistently across entity/migration/whitelist/UI; `languages @>` filter consistent.
- [ ] **No contract change:** `/query` untouched (retrieval tuning out of scope).

## Execution

Fanning out Wave 1 (Tracks A, B, C) in parallel — disjoint file sets. Then Wave 2 (D, E), then Wave 3 (F, G, H). After all waves: a full code review (reviewer subagent + self-review) against design intent, then run the full test suites.

---

## Wave 4 — Post-review partner requests (2026-07-07)

### Task J1: Automated metadata extraction on ingest (worker parse stage)
**Decisions LOCKED:** extract all fields (title, authors, DOI, year) best-effort from the PDF; fill-only-empty (precedence human > external > llm — never clobber a CSV-imported or human-edited value); all fields remain editable.
**Files:** `search-service/worker/stages/parse.py` (extract title/authors/DOI/year from PDF metadata + first-page front-matter; UPDATE documents SET title=..., authors=..., doi=..., year_published=... WHERE <col> IS NULL — fill-only-empty); `search-service/worker/stages/embed.py` (`_build_nodes_for_doc` already uses `doc.title` for the summary node — once parse sets a real title, the summary node picks it up on re-ingest).
**TDD:** `search-service/tests/test_worker_stages.py` — (a) a PDF with embedded metadata (Title/Author) → columns populated from metadata; (b) a PDF with no metadata but a clear first-page title → title extracted from page 1 (not the slug); (c) a doc with a pre-existing CSV `title` (source='external') → NOT overwritten (fill-only-empty); (d) DOI/year extracted when present.
**Commit:** `feat(worker): extract title/authors/DOI/year from PDF on ingest (fill-only-empty)`

### Task J2: Hard delete a document (admin-only, audit tombstone, no reason)
**Decisions LOCKED:** `DELETE /api/admin/documents/[id]` admin-only; permanently removes the `documents` row (CASCADE to document_texts/chunks/summaries/tags/collections/ingestion_jobs) + the S3 object; audit tombstone (id, title, actor, time — no reason per partner); distinct from withdraw (soft/reversible). A "Delete" button in the editor lifecycle panel (admin-only, confirm dialog).
**Files:** `src/app/api/admin/documents/[id]/route.ts` (add DELETE handler); `src/db/queries/documentsAdmin.ts` (add `purgeDocument` — DELETE the S3 object via sanitized basename, DELETE the documents row (CASCADE), write audit tombstone); `src/app/admin/documents/[id]/page.tsx` (add a Delete button, admin-only, confirm dialog); `src/lib/s3.ts` if needed.
**TDD:** `src/__tests__/admin-documents.db.test.ts` — (a) DELETE a doc → row + children gone, S3 object deleted, audit tombstone written (id/title/actor); (b) non-admin → 403; (c) DELETE a withdrawn doc → works; (d) DELETE nonexistent → 404.
**Commit:** `feat(admin): hard delete a document (admin-only, audit tombstone, S3 cleanup)`

### Task J3: CSV metadata import UI page (`/admin/import`)
**Decisions LOCKED:** the API exists (`POST /api/import-documents`, admin-only, dryRun, validated). Build the UI: upload a CSV, dry-run preview (per-row decisions: created/updated/skipped + which fields would fill), then apply. Admin-only. Matches design §7.1a/§10.310 ("dry-run preview").
**Files:** `src/app/admin/import/page.tsx` (new — CSV upload, dry-run preview table, apply button); `src/app/admin/layout.tsx` (add an "Import" nav link, admin-only).
**TDD (jsdom):** `src/__tests__/admin-import-page.test.tsx` — renders a file upload, a dry-run preview table (after a mocked POST with dryRun:true), and an Apply button that POSTs without dryRun.
**Commit:** `feat(admin): CSV metadata import page with dry-run preview (admin-only)`
