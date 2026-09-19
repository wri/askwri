# Topic Taxonomy Management & Auto-Tagging (Issue #323) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a topic-taxonomy management feature (755+ tags, extensible to other facets) plus worker auto-tagging that attaches the top-5 topic tags per doc, overrideable by editors, with on-demand re-classify after taxonomy edits.

**Architecture:** App tier owns the relational taxonomy (extended `tags`, new `tag_aliases`, new `reclassify_jobs`) and the management UI/API. Python worker owns `tag_embeddings` (pgvector, no TypeORM entity) and a rewritten retrieve-then-classify stage (embedding shortlist → LLM picks top-5). A dedicated `reclassify_jobs` queue drives classify-only re-runs that preserve human overrides. The `/query` retrieval contract is untouched.

**Tech Stack:** Next.js 16 App Router, TypeORM 0.3 (raw SQL migrations, `synchronize=false`), pgvector, Chakra UI 3.31, Jest (jsdom + `*.db.test.ts`); Python 3.12, FastAPI, psycopg, pydantic-settings, Bedrock Cohere `cohere-embed-v4`, OpenAI `gpt-5-mini` structured output.

**Spec:** `docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md`

## Global Constraints

- All schema changes in **one** migration `src/db/migrations/<epoch>-TopicTaxonomy.ts`, raw SQL via `queryRunner.query`; `synchronize` is always false; pgvector columns (`vector`) are raw SQL — no TypeORM entity maps `tag_embeddings`.
- Two-writer ownership: app owns `tags`/`tag_aliases`/`reclassify_jobs` (entities OK); python owns `tag_embeddings` (NO entity — enforced by absence). App never calls Bedrock; app sets `tags.needs_reembed=true` on edits, worker clears after embedding.
- `source='human'`/`source='external'` `document_tags` rows are never overwritten by the worker (classify uses `ON CONFLICT DO NOTHING` + a protected-row SELECT).
- `taxonomy_version` stays `'v1'`; in-place edits + `audit_log`, no parallel versions.
- `/query` contract (`QueryRequest`/`QueryResponse` in `search-service/app/main.py`) is preserved exactly — no tag fields added.
- API routes: `runtime='nodejs'`, `dynamic='force-dynamic'`, call `initializeDatabase()`, use `requireIdentity` (admin-only writes, reviewer-ok reads), `internalError` for 500s. Path alias `@/*` → `src/*`.
- Worker config in `search-service/app/config.py` (pydantic-settings, env-overridable). Python tests: `cd search-service && ./venv/bin/python -m pytest tests/ -v`.
- Every app mutation writes `audit_log` via `writeAudit` + `auditActor` (see `src/db/queries/audit.ts`). Worker audit via `audit_system_event` (`search-service/worker/stages/__init__.py`).
- CSV import is **atomic, all-or-nothing**: any conflict blocks apply; no partial commits.
- No new frontend deps (no virtualization library); use progressive render (`IntersectionObserver`). Chakra 3.31 only.
- Worktree: `.worktrees/feature-topic-taxonomy-323` on branch `feature/topic-taxonomy-323`. Run all commands from there.

---

## File Structure

**App tier (Node/TS):**
- `src/db/migrations/1787160000000-TopicTaxonomy.ts` — NEW migration
- `src/db/entities/Tag.entity.ts` — MODIFY: add `parentTagId`, `description`, `needsReembed`
- `src/db/entities/TagAlias.entity.ts` — NEW
- `src/db/entities/ReclassifyJob.entity.ts` — NEW
- `src/db/queries/topicsAdmin.ts` — NEW: list/get/create/edit/delete/merge/import/export/reclassify + cycle CTE
- `src/app/api/admin/topics/route.ts` (+ `[id]`, `[id]/merge`, `import`, `export`, `reclassify`, `reclassify/status`, `embeddings/rebuild`) — NEW
- `src/app/admin/topics/components/TopicTaxonomyManager.tsx` — NEW: rich UI
- `src/app/admin/tags/page.tsx` — MODIFY: facet tab strip; Topic tab renders `<TopicTaxonomyManager/>`
- `src/app/admin/topics/page.tsx` — NEW: deep-link, renders `<TopicTaxonomyManager/>`
- `src/__tests__/topic-taxonomy-schema.db.test.ts` — NEW
- `src/__tests__/admin-topics.db.test.ts` — NEW
- `src/__tests__/admin-topics-routes.test.ts` — NEW

**Python tier:**
- `search-service/app/config.py` — MODIFY: add 5 settings
- `search-service/app/bedrock_embed.py` — MODIFY: add `embed_one(text)`
- `search-service/worker/stages/embed_tags.py` — NEW
- `search-service/worker/stages/classify.py` — MODIFY: retrieve-then-classify
- `search-service/worker/stages/reclassify.py` — NEW
- `search-service/worker/main.py` — MODIFY: poll reclassify first
- `search-service/tests/test_config.py`, `test_embed_tags.py`, `test_classify_topic.py`, `test_reclassify.py` — NEW
- `search-service/tests/test_worker_stages.py` — MODIFY: update classify assertions

---

## Phase 1 — Data Model

### Task 1: Migration + entities

**Files:**
- Create: `src/db/migrations/1787160000000-TopicTaxonomy.ts`
- Modify: `src/db/entities/Tag.entity.ts`
- Create: `src/db/entities/TagAlias.entity.ts`, `src/db/entities/ReclassifyJob.entity.ts`
- Test: `src/__tests__/topic-taxonomy-schema.db.test.ts`

**Interfaces:**
- Consumes: existing `tags`/`document_tags`/`documents` tables (migration `1781280000000`).
- Produces: `tags.parent_tag_id`/`description`/`needs_reembed`; tables `tag_aliases`, `tag_embeddings`, `reclassify_jobs` (with `run_id` so a single enqueue's jobs group into one "run" for the status panel); entities `Tag` (extended), `TagAlias`, `ReclassifyJob`.

- [ ] **Step 1: Write the failing schema test** — `src/__tests__/topic-taxonomy-schema.db.test.ts`:
```ts
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
d('topic taxonomy schema (DB integration)', () => {
  beforeAll(async () => { if (!AppDataSource.isInitialized) await AppDataSource.initialize() })
  afterAll(async () => { if (AppDataSource.isInitialized) await AppDataSource.destroy() })
  it('tags has parent_tag_id, description, needs_reembed', async () => {
    const rows: any[] = await AppDataSource.query(`SELECT column_name FROM information_schema.columns WHERE table_name='tags' AND column_name IN ('parent_tag_id','description','needs_reembed')`)
    expect(rows.map((r) => r.column_name).sort()).toEqual(['description','needs_reembed','parent_tag_id'])
  })
  it('tag_aliases composite PK exists', async () => {
    const [row]: any[] = await AppDataSource.query(`SELECT conname FROM pg_constraint WHERE conrelid='tag_aliases'::regclass AND contype='p'`)
    expect(row?.conname).toBe('PK_tag_aliases')
  })
  it('tag_embeddings HNSW index exists', async () => {
    const rows: any[] = await AppDataSource.query(`SELECT indexname FROM pg_indexes WHERE tablename='tag_embeddings'`)
    expect(rows.map((r) => r.indexname)).toContain('idx_tag_embeddings_hnsw')
  })
  it('reclassify_jobs idempotent partial unique index', async () => {
    const rows: any[] = await AppDataSource.query(`SELECT indexdef FROM pg_indexes WHERE indexname='reclassify_jobs_one_open_per_doc'`)
    expect(rows.length).toBe(1)
    expect(rows[0].indexdef).toMatch(/status IN \('queued','running'\)/i)
  })
})
```
- [ ] **Step 2: Run test — FAIL** — `npx jest src/__tests__/topic-taxonomy-schema.db.test.ts --runInBand`
- [ ] **Step 3: Write the migration** — `src/db/migrations/1787160000000-TopicTaxonomy.ts` (full `up`/`down` per spec §4.1–4.4: `ALTER TABLE tags ADD parent_tag_id/description/needs_reembed` + 2 indexes; `CREATE TABLE tag_aliases` + index; `CREATE TABLE tag_embeddings` + HNSW index; `CREATE TABLE reclassify_jobs` + 2 indexes). **Add a `run_id uuid NOT NULL DEFAULT uuid_generate_v4()` column to `reclassify_jobs`** (not in spec §4.4 — added to support the status panel's per-run grouping; spec §6.4 shows `[full corpus — 203 docs — $0.17]` which requires grouping jobs by run). Also add `CREATE INDEX "idx_reclassify_jobs_run" ON "reclassify_jobs" ("run_id", "created_at")`.
- [ ] **Step 4: Run migration** — `npm run migration:run`. If `data-source.ts` needs the class registered, add the import per the existing migration-array pattern (check `src/db/data-source.ts`).
- [ ] **Step 5: Update `Tag.entity.ts`** — add `parentTagId` (`@Column('text',{name:'parent_tag_id',nullable:true})`), `description` (`@Column('text',{nullable:true})`), `needsReembed` (`@Column('boolean',{name:'needs_reembed',default:false})`).
- [ ] **Step 6: Create `TagAlias.entity.ts`** — composite PK `tagId` (`@PrimaryColumn('uuid',{name:'tag_id'})`) + `alias` (`@PrimaryColumn('text')`) + `createdAt`.
- [ ] **Step 7: Create `ReclassifyJob.entity.ts`** — `id` (PK), `documentId`, `scopeTagId` (nullable), `status` (default `'queued'`), `attempts` (default 0), `error` (nullable), `createdAt`.
- [ ] **Step 8: Run schema test — PASS** (4 tests)
- [ ] **Step 9: Commit** — `feat(db): topic taxonomy schema — issue #323`

---

## Phase 2 — Backend queries + API

### Task 2: topicsAdmin list + get

**Files:** Create `src/db/queries/topicsAdmin.ts`; Test `src/__tests__/admin-topics.db.test.ts`
**Interfaces:** Produces `listTopicsWithCounts(): Promise<TopicRow[]>`, `getTopic(id): Promise<TopicDetail|null>`. `TopicRow` = `{id,facet,valueId,taxonomyVersion,parentTagId,description,aliases,acceptedCount,suggestedCount}`.

- [ ] **Step 1: Write failing test** — create `src/__tests__/admin-topics.db.test.ts` (pattern: `@jest-environment node`, `hasDb = !!process.env.DATABASE_URL`, `d = hasDb ? describe : describe.skip`). Fixture in `beforeAll`: insert a root topic tag + an alias + a child topic tag (parent=root). Cleanup in `afterAll` (delete aliases, tags). Two tests: `listTopicsWithCounts` returns the rows with aliases + `parentTagId`; `getTopic(childId)` returns aliases `[]` and `parentTagId=rootId`.
- [ ] **Step 2: Run — FAIL** — `npx jest src/__tests__/admin-topics.db.test.ts --runInBand`
- [ ] **Step 3: Implement** — `src/db/queries/topicsAdmin.ts` exporting `TopicRow`, `listTopicsWithCounts` (one query: `tags` LEFT JOIN `document_tags`, correlated subquery for `array_agg(alias)`, GROUP BY, WHERE facet='topic' AND taxonomy_version='v1', ORDER BY value_id), `getTopic` (same shape, WHERE id=$1).
- [ ] **Step 4: Run — PASS** (2 tests)
- [ ] **Step 5: Commit** — `feat(queries): topicsAdmin list/get — issue #323`

### Task 3: create + edit (cycle prevention) + needs_reembed

**Files:** Modify `src/db/queries/topicsAdmin.ts`; append tests
**Interfaces:** `createTopic(input, identity): Promise<Tag | {error}>`; `updateTopic(id, patch, identity): Promise<Tag | null | {error:'cycle'}>`. Cycle on parent-set returns `{error:'cycle'}` via the ancestor-walk CTE in spec §7.1. Both set `needs_reembed=true` on label/description/alias change and write `audit_log` (`tag_create`/`tag_update`).

- [ ] **Step 1: Write failing tests (append)** — `createTopic` sets `needs_reembed=true` + writes alias + audit row; `updateTopic` rejects cycle A→B→A (set root's parent = child); `updateTopic` edits description + replaces aliases + sets `needs_reembed=true`.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `createTopic` (transaction: dup-check, INSERT with `needs_reembed=true`, insert aliases, `writeAudit`); `updateTopic` (transaction: fetch; if `parentTagId` set, run the ancestor CTE → return `{error:'cycle'}` if a row returns; build dynamic SET clause with `needs_reembed=true` when label/description/aliases changed; replace aliases if provided; `writeAudit` with before/after).
- [ ] **Step 4: Run — PASS** (5 tests)
- [ ] **Step 5: Commit** — `feat(queries): topicsAdmin create/update with cycle prevention — issue #323`

### Task 4: delete (children warning) + merge

**Files:** Modify `src/db/queries/topicsAdmin.ts`; append tests
**Interfaces:** `deleteTopicIfUnused(id, identity): Promise<{deleted:true} | {deleted:false; reason:'in_use'|'has_children'|'not_found'; error}>`; `mergeTags(intoId, fromId, identity): Promise<{ok:true; moved:number} | {error}>` (moves `document_tags`, re-parents children of `from` to `into`, deletes `from` + its aliases, audit `tag_merge`).

- [ ] **Step 1: Write failing tests (append)** — `deleteTopicIfUnused` blocks a tag with children (`reason:'has_children'`); `mergeTags` moves a doc tag from child→root, deletes child, returns `{ok:true, moved:1}`.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `deleteTopicIfUnused` (check children count → `has_children`; else transactional `DELETE ... WHERE NOT EXISTS(document_tags) RETURNING` → `in_use` or `deleted`); `mergeTags` (transaction: UPDATE document_tags tag_id=into WHERE tag_id=from AND no conflict; DELETE remaining from-rows; re-parent children; delete aliases; delete from tag; audit). Reject self-merge + missing tags.
- [ ] **Step 4: Run — PASS** (7 tests)
- [ ] **Step 5: Commit** — `feat(queries): topicsAdmin delete + merge — issue #323`

### Task 5: reclassify enqueue + status + cost estimate

**Files:** Modify `src/db/queries/topicsAdmin.ts`; append tests
**Interfaces:** `enqueueReclassify(scope: 'all' | {tagId: string}): Promise<{enqueued:number; estCost:number; runId:string}>` (idempotent via partial unique index; one shared `run_id` per enqueue so the status panel can group jobs into a run); `reclassifyStatus(): Promise<{queued,running,done,error, recent: {runId, scope:'all'|string, total, done, error, estCost, createdAt}[]}>` — `recent` groups by `run_id` (count jobs, sum est cost via `EST_PER_DOC_COST`). `EST_PER_DOC_COST = 0.0008`.

- [ ] **Step 1: Write failing tests (append)** — `enqueueReclassify('all')` returns `{enqueued, estCost}` and is idempotent (second call enqueues 0); `reclassifyStatus` returns `queued` + `recent` fields. (Cleanup: delete reclassify rows for the test docs in `afterAll`.)
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `enqueueReclassify` (resolve docIds: all `status='ready'` docs, or docs with `document_tags` source='llm' for the scope tag; generate ONE `run_id = uuid()` for the whole enqueue; per-doc `INSERT ... ON CONFLICT (document_id) WHERE status IN ('queued','running') DO NOTHING` carrying that `run_id`); `reclassifyStatus` (GROUP BY status for counts; for `recent`, `SELECT run_id, scope_tag_id, count(*) AS total, count(*) FILTER (WHERE status='done') AS done, count(*) FILTER (WHERE status='error') AS error, min(created_at) AS created_at FROM reclassify_jobs GROUP BY run_id, scope_tag_id ORDER BY min(created_at) DESC LIMIT 20` and compute `estCost = total * EST_PER_DOC_COST`).
- [ ] **Step 4: Run — PASS** (9 tests)
- [ ] **Step 5: Commit** — `feat(queries): reclassify enqueue + status — issue #323`

### Task 6: CSV import (dry-run diff + atomic apply) + export

**Files:** Modify `src/db/queries/topicsAdmin.ts`; append tests
**Interfaces:** `parseTopicsCsv(text): ParsedRow[]` (columns label,description,aliases(pipe),parent,facet?,id?); `importTopicsDiff(rows): Promise<{added,updated,unchanged,conflicts}>`; `applyTopicsImport(rows, reclassify): Promise<{applied}>` (throws on any conflict); `exportTopicsCsv(): Promise<string>`.

- [ ] **Step 1: Write failing tests (append)** — `parseTopicsCsv` parses a quoted/pipe row; `importTopicsDiff` flags a bad parent ref as a conflict; `applyTopicsImport` with one good + one conflicting row throws and rolls back (assert the good row was NOT inserted); `exportTopicsCsv` round-trips through `importTopicsDiff` with 0 adds/updates/conflicts.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `parseTopicsCsv` (minimal CSV parser handling quotes + commas, no new dep); `importTopicsDiff` (match by id-or-label, detect duplicate labels + bad parent refs + empty labels); `applyTopicsImport` (transaction: if conflicts → throw; INSERT adds with `needs_reembed=true`; UPDATE changed; replace aliases; if `reclassify`, `enqueueReclassify({tagId})` per affected tag); `exportTopicsCsv` (SELECT with correlated alias/parent, CSV-escape, header `label,description,aliases,parent,facet,id`).
- [ ] **Step 4: Run — PASS** (13 tests)
- [ ] **Step 5: Commit** — `feat(queries): topicsAdmin CSV import (atomic) + export — issue #323`

### Task 7: API routes

**Files:** Create the 8 route files under `src/app/api/admin/topics/`; Test `src/__tests__/admin-topics-routes.test.ts`
**Interfaces:** Endpoints per spec §7.1. All use `requireIdentity`; writes require `identity.role==='admin'` (403).

- [ ] **Step 1: Write failing route test** — `src/__tests__/admin-topics-routes.test.ts`: follow the DB-integration + real-session pattern in `src/__tests__/admin-auth-routes.test.ts` (set `SESSION_SECRET`/`ADMIN_API_TOKEN` in `beforeAll`, seed an admin user, log in to get a session cookie). Assert `GET /api/admin/topics` returns `200` with body `{ ok: true, tags: Array }` (assert `ok === true` and `Array.isArray(tags)` — not merely `status < 500`). Also assert `POST` with a non-admin session returns `403`. Query behavior itself is covered by `admin-topics.db.test.ts`.
- [ ] **Step 2: Run — FAIL** — `npx jest src/__tests__/admin-topics-routes.test.ts --runInBand`
- [ ] **Step 3: Implement routes** —
  - `route.ts`: GET → `listTopicsWithCounts`; POST → `createTopic` (409 on error, 403 non-admin).
  - `[id]/route.ts`: GET → `getTopic` (404 null); PATCH → `updateTopic` (409 cycle, 404 null); DELETE → `deleteTopicIfUnused` (409 in_use/has_children, 404 not_found).
  - `[id]/merge/route.ts`: POST `{intoTagId}` → `mergeTags`; on ok, `enqueueReclassify({tagId: intoTagId})`; 409 on error.
  - `import/route.ts`: POST file → `parseTopicsCsv`; `?dry_run=true` → `importTopicsDiff`; else `applyTopicsImport(rows, reclassify)` (throw → 409 with conflict count).
  - `export/route.ts`: GET → CSV `NextResponse` with `Content-Disposition: attachment`.
  - `reclassify/route.ts`: POST `{scope:'all'} | {tagId}` → `enqueueReclassify` → `{ok,enqueued,estCost}`.
  - `reclassify/status/route.ts`: GET → `reclassifyStatus()`.
  - `embeddings/rebuild/route.ts`: POST (admin) → `UPDATE tags SET needs_reembed=true WHERE facet='topic' AND NOT EXISTS (tag_embeddings)` → `{ok, queued: rowCount}` (worker sweep builds them).
- [ ] **Step 4: Run — PASS** — `npx jest src/__tests__/admin-topics-routes.test.ts src/__tests__/admin-topics.db.test.ts --runInBand`
- [ ] **Step 5: Commit** — `feat(api): /api/admin/topics/* routes — issue #323`

---

## Phase 3 — Worker (Python)

### Task 8: config knobs

**Files:** Modify `search-service/app/config.py`; Test `search-service/tests/test_config.py`
**Interfaces:** Settings `tag_candidate_top_n=20`, `tag_reclassify_concurrency=4`, `tag_embed_batch_size=100`, `classify_topic_only=False`, `reclassify_poll_first=True`.

- [ ] **Step 1: Write failing test** — `test_config.py`: assert all 5 defaults via `get_settings()`.
- [ ] **Step 2: Run — FAIL** — `cd search-service && ./venv/bin/python -m pytest tests/test_config.py -v` (AttributeError).
- [ ] **Step 3: Implement** — add the 5 fields to `Settings` near `tag_confidence_accept`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(worker): config knobs for topic tagging — issue #323`

### Task 9: embed_tags.py + embed_one helper

**Files:** Create `search-service/worker/stages/embed_tags.py`; modify `search-service/app/bedrock_embed.py`; Test `search-service/tests/test_embed_tags.py`
**Interfaces:** `embed_one(text)` (bedrock_embed); `embed_tag(conn, tag_id)`, `sweep_pending(conn, batch_size=None)`, `build_all_embeddings(conn, batch_size=None)`. Embeds `label + " | " + aliases + " — " + description` with `cohere-embed-v4`, UPSERTs `tag_embeddings`, clears `needs_reembed`.

- [ ] **Step 1: Write failing test** — `test_embed_tags.py`: monkeypatch `embed_one` → `[0.1]*1536`; `test_embed_tag_upserts_and_clears_flag` (assert `embedded_text` contains `|`, `needs_reembed=false`); `test_sweep_pending_processes_needs_reembed`. Use a `pg_pool_with_topic` conftest fixture (create topic tag + aliases + description, stash id on conn); skip when no DB.
- [ ] **Step 2: Run — FAIL** — module not found.
- [ ] **Step 3: Implement** — add `embed_one(text)` to `bedrock_embed.py` (thin wrapper over the existing embed path); create `embed_tags.py` with `_compose_text`, `embed_tag`, `sweep_pending` (SELECT `needs_reembed` topic tags LIMIT batch), `build_all_embeddings` (topic tags with no embedding row).
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(worker): embed_tags stage — issue #323`

### Task 10: classify.py rewrite (retrieve-then-classify)

**Files:** Modify `search-service/worker/stages/classify.py`; Tests `search-service/tests/test_classify_topic.py` (new), `search-service/tests/test_worker_stages.py` (update)
**Interfaces:** Entrypoint `@stage("classify") def run(document_id, topic_only: bool = False)` — `topic_only` defaults False (preserves existing ingest callers); when True, skip non-topic facets (used by reclassify jobs). Internal `_classify_topic(conn, doc, basis, protected)` (embed basis → top-N candidates by cosine → one `chat_json` call, enum = candidate labels, top-5) + `_classify_other_facets(...)` (existing full-enum per non-topic facet). `ON CONFLICT DO NOTHING` on inserts; protected rows (`source IN ('human','external')`) never overwritten.

- [ ] **Step 1: Write failing test** — `test_classify_topic.py`: fixture creates topic tags + embeddings + a doc with a known summary; monkeypatch `embed_one` (vector near expected) and `chat_json` (returns expected tag, confidence 0.8). Tests: picks top-5 → `status='accepted'`; does NOT overwrite a pre-existing `source='human'` row; empty `tag_embeddings` → topic facet skipped, no error.
- [ ] **Step 2: Run — FAIL** — current `run` uses full-enum.
- [ ] **Step 3: Implement** — rewrite `classify.py`: `run(document_id)` fetches doc + basis, loads protected rows, calls `sweep_pending(conn)` then `_classify_topic` (if not `classify_topic_only`-skipped) and `_classify_other_facets`; for topic, build candidate set via `SELECT ... FROM tag_embeddings JOIN tags ... ORDER BY embedding <=> $vec LIMIT tag_candidate_top_n`, schema enum = candidate labels, `chat_json` top-5, resolve label→id, `INSERT ... ON CONFLICT DO NOTHING` with status from confidence vs `tag_confidence_accept`; for other facets, keep the existing enum-over-whole-vocab path. Update `test_worker_stages.py` assertions to the new schema/behavior.
- [ ] **Step 4: Run — PASS** — `cd search-service && ./venv/bin/python -m pytest tests/test_classify_topic.py tests/test_worker_stages.py -v`
- [ ] **Step 5: Commit** — `feat(worker): retrieve-then-classify topic stage — issue #323`

### Task 11: reclassify.py claim loop

**Files:** Create `search-service/worker/stages/reclassify.py`; Test `search-service/tests/test_reclassify.py`
**Interfaces:** `claim_job(conn): (id, document_id, scope_tag_id) | None` (`UPDATE ... SET status='running' WHERE id=(SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING`); `process_one_reclassify(): bool` (claim → `classify.run(document_id, topic_only=True)` → mark `done`; on error `attempts+=1` → requeue or `error`). `MAX_ATTEMPTS=2`.

- [ ] **Step 1: Write failing test** — `test_reclassify.py`: two calls to `claim_job` on a single queued row → only the first claims (second returns None); `process_one_reclassify` marks `done` on success (stub `classify.run(document_id, topic_only=True)`); on repeated failure reaches `status='error'`. Assert `classify.run` is called with `topic_only=True`.
- [ ] **Step 2: Run — FAIL** — module not found.
- [ ] **Step 3: Implement** — `reclassify.py`: `claim_job` (SKIP LOCKED), `process_one_reclassify` (claim, run `classify.run` with a thread/flag for `topic_only` — pass via a module-level setting or call the internal `_classify_topic` directly), mark done/error with attempts.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(worker): reclassify claim loop — issue #323`

### Task 12: worker/main.py polls reclassify first

**Files:** Modify `search-service/worker/main.py`; Test `search-service/tests/test_reclassify.py` (append)
**Interfaces:** `main()` loop does, in order each tick: (1) if `settings.reclassify_poll_first`, call `process_one_reclassify()` first; (2) a tag-embed sweep tick — call `sweep_pending(conn)` then `build_all_embeddings(conn)` (both from Task 9's `embed_tags`) so `needs_reembed=true` flags set by the admin "Rebuild embeddings" route (Task 7) actually get built without requiring a classify run (spec §5.3 mandates this standalone tick); (3) the existing intake + `process_one_job()` poll.

- [ ] **Step 1: Write failing test** — append: with `reclassify_poll_first=True` and a queued reclassify job + a queued ingest job, the first processed job is the reclassify one (assert via ordering stubs); and a tick with a `needs_reembed=true` topic tag calls `sweep_pending`/`build_all_embeddings` (assert the tag's flag is cleared and a `tag_embeddings` row appears, with `embed_one` stubbed).
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — in `main()`/poll loop, add `if get_settings().reclassify_poll_first: if process_one_reclassify(): return` before the existing intake/job poll; then add the embed sweep tick: `with get_pool().connection() as conn: sweep_pending(conn); build_all_embeddings(conn)` (wrap so a Bedrock failure logs + continues, never aborts the poll loop). Import `sweep_pending`, `build_all_embeddings` from `worker.stages.embed_tags`.
- [ ] **Step 4: Run — PASS** — `./venv/bin/python -m pytest tests/test_reclassify.py -v`
- [ ] **Step 5: Commit** — `feat(worker): poll reclassify before ingestion — issue #323`

---

## Phase 4 — Management UI

> UI tasks use lightweight Jest render smoke tests (component mounts, calls the list API on load) + manual verification. Logic-heavy pieces (CSV parse, cycle error) are unit-tested at the query layer (Phase 2). Follow the Chakra 3.31 + inline-style patterns in `src/app/admin/tags/page.tsx` and `src/app/admin/layout.tsx`. No new deps — progressive render via `IntersectionObserver`.

### Task 13: TopicTaxonomyManager — list + search + tree + progressive render

**Files:** Create `src/app/admin/topics/components/TopicTaxonomyManager.tsx`; Test `src/__tests__/topic-taxonomy-ui.test.tsx`
**Interfaces:** Renders stats strip (counts), toolbar (search input, Tree/Flat toggle, facet is fixed to topic), and the list. Loads via `GET /api/admin/topics`. Builds a tree from `parentTagId`; renders roots expanded; progressive-renders 200 rows then `IntersectionObserver`-loads more. Search filters client-side by label + aliases + description.

- [ ] **Step 1: Write failing render test** — `topic-taxonomy-ui.test.tsx`: mock `fetch` → returns `{ok,tags:[...]}`; render `<TopicTaxonomyManager/>`; assert the heading "Topic taxonomy" and at least one row label appear.
- [ ] **Step 2: Run — FAIL** — component not found.
- [ ] **Step 3: Implement** — `TopicTaxonomyManager.tsx`: `useEffect` load via `adminFetch('/api/admin/topics')`; build `byId` map + children map; recursive `<TopicRow>` with expand chevron; `IntersectionObserver` sentinel; search state filters the flat array before tree-build. Use Chakra `Box`/`Heading`/`Text` + inline styles matching the admin navy theme.
- [ ] **Step 4: Run — PASS** — `npx jest src/__tests__/topic-taxonomy-ui.test.tsx --runInBand`
- [ ] **Step 5: Commit** — `feat(ui): TopicTaxonomyManager list/tree/search — issue #323`

### Task 14: Edit drawer (label/description/aliases/parent + history)

**Files:** Modify `TopicTaxonomyManager.tsx`; append UI test
**Interfaces:** Click a row → right-side drawer with fields. Save → `PATCH /api/admin/topics/:id`; on 409 `{error:'cycle'}` show inline error on parent field; flash on success + refresh row. "History" tab pulls `audit_log` via `GET /api/admin/audit?entityType=tag&entityId=:id` (reuse existing audit query/route if present; otherwise add a thin `GET /api/admin/topics/:id/history` route wrapping `audit_log`).

- [ ] **Step 1: Write failing test** — drawer opens on row click; saving calls `fetch(PATCH)`; a `cycle` response renders the inline parent error.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — drawer component (label input, description textarea, aliases tag-input, parent combobox over topic labels, tabs Edit/History/Docs). On save, `PATCH`; map 409 `error:'cycle'` to parent field error. History tab fetches audit rows. (If no audit route exists for tags, add `GET /api/admin/topics/[id]/history/route.ts` returning `audit_log` rows for `entityType='tag'`.)
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(ui): topic edit drawer + history — issue #323`

### Task 15: Bulk ops (merge / re-parent / delete-unused)

**Files:** Modify `TopicTaxonomyManager.tsx`; append UI test
**Interfaces:** Row checkboxes; when ≥1 selected, the toolbar swaps to a bulk-actions bar: Merge into… (modal: pick target among selected or any topic → `POST /api/admin/topics/:id/merge` per source), Re-parent… (pick new parent → `PATCH` each), Delete unused (only deletes selected with 0 docs; surface "in use" for the rest).

- [ ] **Step 1: Write failing test** — selecting 2 rows shows the bulk bar with a count; "Merge" opens the modal.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — selection state (Set of ids); bulk bar replaces the toolbar when `selected.size>0`; Merge modal (target picker, preview text of moves, "Merge & re-classify" → calls merge endpoint per source then refreshes); Re-parent (PATCH parent on each); Delete-unused (DELETE each, collect in-use errors).
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(ui): topic bulk ops — issue #323`

### Task 16: CSV import/export with dry-run modal

**Files:** Modify `TopicTaxonomyManager.tsx`; append UI test
**Interfaces:** Import button → file picker → `POST /api/admin/topics/import?dry_run=true` → diff modal (added/updated/conflicts, color-coded) → Apply disabled while conflicts>0 → `?reclassify=true` checkbox → `POST .../import` (apply). Export button → `GET /api/admin/topics/export` → download.

- [ ] **Step 1: Write failing test** — Import button present; after a mocked dry-run response with 1 conflict, the Apply button is disabled.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — file input (hidden) + Import button; read file text; POST dry-run; render diff modal (green add / amber edit / red conflict rows); Apply button disabled unless conflicts.length===0; reclassify checkbox; on Apply POST apply + refresh. Export → anchor download from `/export`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(ui): topic CSV import/export — issue #323`

### Task 17: Re-classify panel + trigger bar + cost confirm

**Files:** Modify `TopicTaxonomyManager.tsx`; append UI test
**Interfaces:** Trigger bar: "Re-classify… (all)" + "Scoped to topic…" buttons → confirm modal showing `{enqueued, estCost}` from `POST /api/admin/topics/reclassify`. Panel: polls `GET /api/admin/topics/reclassify/status` every 5s; shows live progress (done/total %), recent runs, per-doc errors (expandable), retry button.

- [ ] **Step 1: Write failing test** — "Re-classify" button opens a confirm modal showing the estCost from a mocked enqueue response.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — trigger bar above the list; confirm modal (calls `POST /reclassify` with `{scope:'all'}` or `{tagId}`, shows `enqueued` + `estCost`, "Start" enqueues); panel component (5s `setInterval` polling `/reclassify/status`; live progress card; recent-runs list with scope label; errors expandable with per-doc retry → `POST /reclassify {tagId}`).
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(ui): re-classify panel — issue #323`

### Task 18: Wire facet tabs into /admin/tags + /admin/topics deep-link

**Files:** Modify `src/app/admin/tags/page.tsx`; create `src/app/admin/topics/page.tsx`
**Interfaces:** `/admin/tags` renders a facet tab strip (Program / Office / Topic / Doc type); Topic tab renders `<TopicTaxonomyManager/>`; other tabs render the existing simple table. `/admin/topics` renders `<TopicTaxonomyManager/>` directly (deep-link). Nav stays a single "Tags" entry.

- [ ] **Step 1: Write failing test** — `/admin/tags` page renders the Topic tab and, when clicked, renders the manager heading.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — refactor `tags/page.tsx` to a tabbed shell (facet state in URL search param `?facet=topic` default); Topic tab = `<TopicTaxonomyManager/>`; other facets = the existing per-facet table (extract the current table into a small `FacetTable` component); create `topics/page.tsx` rendering `<TopicTaxonomyManager/>` alone.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `feat(ui): facet tabs + /admin/topics deep-link — issue #323`

---

## Phase 5 — Baseline & finish

### Task 19: Full baseline verification

**Files:** none (verification only)
- [ ] **Step 1: App tests** — `npm test` (all Jest, including new `*.db.test.ts` when `DATABASE_URL` set) — expect 0 failures.
- [ ] **Step 2: Python tests** — `cd search-service && ./venv/bin/python -m pytest tests/ -v` — expect 0 failures.
- [ ] **Step 3: Build** — `npx next build --webpack` (Turbopack panics on the venv symlink per CLAUDE.md) — expect success.
- [ ] **Step 4: Lint** — `npm run lint` — expect clean.
- [ ] **Step 5: Manual smoke** — run `./scripts/local-bootstrap.sh` if a local stack isn't up; `npm run dev`; visit `/admin/tags?facet=topic` → verify list/tree/edit drawer/bulk/CSV/reclassify panel render; trigger "Rebuild embeddings" → run the worker (`cd search-service && ./venv/bin/python -m worker.main --once` a few times) → verify `tag_embeddings` rows appear and `needs_reembed` clears.
- [ ] **Step 6: Commit** (if any fixes) — `test: full baseline green — issue #323`

---

## Self-Review (run after writing; fix inline)

**Spec coverage:**
- §3 architecture/ownership → Tasks 1, 9 (python-owned `tag_embeddings`), 2–7 (app-owned rest). ✅
- §4 data model → Task 1. ✅
- §5 classify (retrieve-then-classify, non-topic enum, embed maintenance, audit, cost) → Tasks 9, 10; cost surfaced in UI Task 17. ✅
- §6 re-classify lifecycle (triggers, claim loop, concurrency, status, failure) → Tasks 5, 11, 12, 17. ✅
- §7 API + CSV + UI (six capabilities) → Tasks 2–7, 13–18. ✅
- §8 error handling (cycle 409, atomic import, per-doc errors) → Tasks 3, 6, 11, 17. ✅
- §9 testing (app `*.db.test.ts`, python pytest, fixture) → each task TDD. ✅
- §10 non-goals respected (no `/query` changes, no parallel versioning, no auto-trigger, no WRI-CSV import, no non-topic facets in new UI). ✅
- §10.4 sequencing → Phase order. ✅

**Placeholder scan:** none — all steps name exact files, SQL, signatures, and test assertions. (UI steps 13–18 use render smoke tests + manual verification; logic is tested at the query layer.)

**Type consistency:** `TopicRow` fields (`id,facet,valueId,taxonomyVersion,parentTagId,description,aliases,acceptedCount,suggestedCount`) used identically in Tasks 2, 13. `enqueueReclassify` signature `'all' | {tagId: string}` consistent across Tasks 5, 7, 15, 16, 17. `mergeTags(intoId, fromId, identity)` consistent across Tasks 4, 7, 15. `applyTopicsImport(rows, reclassify)` throws on conflict → Tasks 6, 7, 16 consistent. `claim_job`/`process_one_reclassify` consistent across Tasks 11, 12. `embed_one`/`embed_tag`/`sweep_pending` consistent across Tasks 9, 10.
