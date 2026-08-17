# Issue #323 — Topic Taxonomy Management & Auto-Tagging (Design)

- **Issue:** [wri/askwri#323](https://github.com/wri/askwri/issues/323) — "Add topic taxonomy and make it easy to edit / update"
- **Branch:** `feature/topic-taxonomy-323`
- **Worktree:** `.worktrees/feature-topic-taxonomy-323`
- **Scope:** A (taxonomy management UI + data model) + B (topical auto-tagging). Both in the document-management workstream.
- **Out of scope (deferred, separate workstreams):** C (retrieval integration — `/query` contract preserved exactly), D (frontend tag filters + query topic sensing), retrieval tuning, parallel taxonomy versioning.

## 1. Goal

A topic-taxonomy management feature that handles 755+ topic tags (the WRI global topics list, extensible), plus worker auto-tagging that attaches the top-5 most relevant topic tags to each document, overrideable by editors, with on-demand re-classify after taxonomy edits. The data model, API, and UI are designed so adding the other facets (`program`, `office`, `doc_type`) later is a configuration change, not a rewrite.

## 2. Background — current state

- **`tags`** (`src/db/entities/Tag.entity.ts`): `id`, `facet`, `value_id`, `taxonomy_version` (hardcoded `'v1'`). Flat — no hierarchy, aliases, or descriptions. Facet set `['program','office','topic','doc_type']` is **hardcoded** in `tagsAdmin.ts` (`CANONICAL_FACETS`).
- **`document_tags`**: `document_id`, `tag_id`, `source ∈ {human, llm, external}`, `confidence`, `model_version`, `status ∈ {accepted, suggested, rejected}`. Two-writer: app owns human rows; worker owns `source='llm'` rows and never overwrites `human`/`external` (precedence, design §8).
- **Admin tags page** (`src/app/admin/tags/page.tsx`): one flat table with add/delete/rename. Unusable at 755+ tags.
- **Worker classify** (`search-service/worker/stages/classify.py`): one LLM call/doc with the **entire** vocab as a JSON-schema `enum`. Degrades at 755 topic values (large prompt, poor accuracy, higher cost). Writes `source='llm'` rows, preserves human/external.
- **Retrieval** (`search-service/app/main.py`): `QueryRequest` has year/program/keyword filters but **no tag filters**. `document_tags` is unused in `/query`. This work does **not** change that.
- **Embeddings**: doc chunks use Cohere `cohere-embed-v4` (1536-dim) via Bedrock (`search-service/app/bedrock_embed.py`). Tag embeddings must use the same model so doc↔tag cosine similarity is meaningful.
- **Worker queue**: `ingestion_jobs` (one job = one doc through all stages, `FOR UPDATE SKIP LOCKED` claim in `worker/queue.py`). Re-classify is classify-only, so it gets its own queue (`reclassify_jobs`) rather than re-running the whole pipeline.

## 3. Architecture & ownership

| Component | Owner tier | What it does |
|---|---|---|
| Taxonomy management UI | app (`src/app/admin/topics/`) | Rich topic UI (tree + search + inline edit drawer + CSV import/export + bulk ops). Rendered as the **Topic** tab inside the `/admin/tags` page; also reachable at `/admin/topics` (deep-link). |
| Taxonomy API | app (`/api/admin/topics/*`) | CRUD tags/aliases/description/parent, merge, bulk import, trigger re-classify |
| Data model | app (relational) + python (vectors) | `tags` extended, new `tag_aliases`, new `tag_embeddings` (python-owned) |
| Classify stage | python worker (`worker/stages/classify.py`) | Retrieve-then-classify: top-N candidate tags by cosine sim → LLM picks top-5 |
| Tag embedder | python worker (`worker/stages/embed_tags.py`) | Builds/maintains `tag_embeddings` from `label + aliases + description` |
| Re-classify job | app enqueues, python worker claims | Bulk or scoped re-tagging, classify-only, preserves human overrides |

**Two-writer ownership (per `CLAUDE.md`):**
- **App tier owns** `tags` (extended), `tag_aliases`, `reclassify_jobs` — all relational, all have TypeORM entities.
- **Python worker owns** `tag_embeddings` (pgvector, raw SQL, **no TypeORM entity** — same pattern as `document_chunks`/`keyword_vocab`). The migration creates the table (DDL is app-owned infra); all row I/O is python.
- **Coordination** via `tags.needs_reembed` flag: app sets `true` on any label/alias/description edit; worker clears after re-embedding. App never calls Bedrock; worker never uses the app's entities for `tag_embeddings`.

**Scope decisions:**
1. In-place edits to `taxonomy_version='v1'` + `audit_log`, not parallel v1/v2 coexistence. The audit log + on-demand re-classify delivers the "remap after review" capability.
2. Topic facet only gets the new management UI + retrieve-then-classify now; schema/API/UI extend to other facets later.
3. `/query` contract untouched — no tag fields added to `QueryRequest`/`QueryResponse` (that's workstream C).

## 4. Data model

All schema changes in **one new migration** `src/db/migrations/<epoch>-TopicTaxonomy.ts` (raw SQL via `queryRunner.query`; `synchronize` stays false).

### 4.1 Extend `tags` (app-owned) — 3 new columns

```sql
ALTER TABLE "tags"
  ADD COLUMN "parent_tag_id" uuid REFERENCES "tags"("id") ON DELETE SET NULL,
  ADD COLUMN "description" text,
  ADD COLUMN "needs_reembed" boolean NOT NULL DEFAULT false;

CREATE INDEX "idx_tags_parent" ON "tags" ("parent_tag_id");
CREATE INDEX "idx_tags_facet_needs_reembed"
  ON "tags" ("facet") WHERE "needs_reembed" = true;
```

- `parent_tag_id` — self-referential; `ON DELETE SET NULL` orphans children to root. **Cycle prevention is app-level**: a CTE walks ancestors inside the parent-set transaction (see §6.1). The existing `UQ_tags_facet_value_version` unique and `taxonomy_version='v1'` default are untouched.
- `description` — nullable; classify + retrieval signal.
- `needs_reembed` — app sets `true` on any label/alias/description edit; worker clears after re-embedding. The partial index makes the worker's "find pending tags" sweep a cheap index scan.

`Tag.entity.ts` gets matching fields (snake_case via `name:` options); `parent_tag_id` is a nullable self-relation.

### 4.2 New `tag_aliases` (app-owned)

```sql
CREATE TABLE "tag_aliases" (
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "alias" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_tag_aliases" PRIMARY KEY ("tag_id", "alias")
);
CREATE INDEX "idx_tag_aliases_alias" ON "tag_aliases" ("alias");
```

- Composite PK: uniqueness per tag; the same alias on *different* tags is allowed (both tags' embeddings will be near it — fine for retrieve-then-classify).
- New `TagAlias.entity.ts`. Admin UI edits aliases as a list per tag.

### 4.3 New `tag_embeddings` (python-owned, pgvector, NO TypeORM entity)

```sql
CREATE TABLE "tag_embeddings" (
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "embedding_model" text NOT NULL,
  "dimension" integer NOT NULL,
  "embedding" vector NOT NULL,
  "embedded_text" text,            -- label + aliases + description, for audit/debug
  "embedded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_tag_embeddings" PRIMARY KEY ("tag_id", "embedding_model")
);
CREATE INDEX "idx_tag_embeddings_hnsw" ON "tag_embeddings"
  USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
  WHERE embedding_model = 'cohere-embed-v4';
```

- **Mirrors `document_chunks` exactly**: per-row `embedding_model`/`dimension`, HNSW index scoped by model with a fixed `vector(1536)` cast. PK `(tag_id, embedding_model)` supports a future model migration without dropping old vectors.
- **Per `CLAUDE.md`**: no TypeORM entity maps this table; the app tier never reads/writes it. The worker (psycopg, raw SQL) owns all row I/O.

### 4.4 New `reclassify_jobs` (app-owned)

```sql
CREATE TABLE "reclassify_jobs" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "scope_tag_id" uuid REFERENCES "tags"("id") ON DELETE SET NULL,  -- null = full corpus
  "status" text NOT NULL DEFAULT 'queued',   -- queued|running|done|error
  "attempts" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_reclassify_jobs" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reclassify_jobs_one_open_per_doc"
  ON "reclassify_jobs" ("document_id") WHERE "status" IN ('queued','running');
CREATE INDEX "idx_reclassify_jobs_claim" ON "reclassify_jobs" ("status", "created_at");
```

- **Separate from `ingestion_jobs`** — re-classify runs *only* the classify stage; reusing the ingest queue would re-run parse→embed→summarize. A dedicated queue with a ~10-line `FOR UPDATE SKIP LOCKED` claim loop (mirrors `worker/queue.py`) keeps the ingestion pipeline untouched.
- `reclassify_jobs_one_open_per_doc` — idempotent enqueue, same partial-unique-index pattern as `ingestion_jobs_one_open_per_doc`.
- `scope_tag_id` — null for full-corpus runs; set to a topic tag for scoped runs. Bookkeeping; the doc list is computed at enqueue time.
- New `ReclassifyJob.entity.ts` (app enqueues + reads status; worker claims + updates via raw SQL).

### 4.5 What does not change

- `document_tags` — untouched. Existing `source`/`status` semantics hold; classify keeps protecting `source IN ('human','external')`.
- `taxonomy_version` — stays `'v1'`; no parallel-version tables.
- `/query` contract — no tag fields added.

## 5. Classify algorithm (worker)

Rewrite `search-service/worker/stages/classify.py` from full-enum to **retrieve-then-classify**, topic-facet only (top-5). Non-topic facets keep the existing zero-or-more enum path (small vocabs).

### 5.1 Topic-facet flow (new), per document

1. Load doc basis: title + long summary (preferred), else first 8000 chars of full_text. *(unchanged from today)*
2. Build candidate topic tags:
   - Embed the doc basis text once with one Bedrock `cohere-embed-v4` call (sub-cent). *(No doc-level summary embedding exists today; a fresh basis-text embed is simplest and cheapest. If one is added later, reuse is a follow-up.)*
   - `SELECT t.id, t.value_id AS label, t.description, (SELECT array_agg(alias) FROM tag_aliases WHERE tag_id = t.id) AS aliases FROM tag_embeddings te JOIN tags t ON t.id = te.tag_id WHERE t.facet='topic' AND t.taxonomy_version='v1' AND te.embedding_model='cohere-embed-v4' ORDER BY te.embedding <=> $doc_embedding LIMIT $tag_candidate_top_n` (default 20). Aliases are fetched via a correlated subquery (one round-trip).
3. LLM call — small enum (the ~20 candidates), structured output:
   - schema: `{ picks: [{ value: <enum of candidate labels>, confidence: number }] }`
   - system: "Pick the top topic tags that clearly apply. 0–5 values, each with confidence in [0,1]. Be conservative."
   - user: title + summary/content + candidate list (label + aliases + description).
   - model `settings.worker_llm_model` (gpt-5-mini), `max_tokens=600`.
4. Resolve each pick to a `tag_id` (label→id from the candidate set).
5. Protected rows: `SELECT tag_id FROM document_tags WHERE document_id=$1 AND source IN ('human','external')`. *(unchanged)*
6. For each picked `tag_id` not in protected:
   - `conf = clamp(pick.confidence, 0, 1)`
   - `status = 'accepted' if conf >= settings.tag_confidence_accept (0.7) else 'suggested'`
   - `INSERT INTO document_tags (...) VALUES (..., 'llm', conf, model, status) ON CONFLICT (document_id, tag_id) DO NOTHING` — human rows safe.

**Preserved from today**: `source='human'/'external'` precedence protection; confidence→status split at 0.7; `ON CONFLICT DO NOTHING`; cost-estimate log line before the LLM call.

**New config** (`search-service/app/config.py`, env-overridable):
- `tag_candidate_top_n: int = 20` — candidate-set size.
- `tag_reclassify_concurrency: int = 4` — worker parallelism for re-classify.
- `tag_embed_batch_size: int = 100` — batch the one-time 755-topic embed build.
- `classify_topic_only: bool = false` — restrict a run to just the topic facet (default `true` for `reclassify_jobs` claims).

### 5.2 Non-topic facets

Tiny vocabs → keep the existing enum-over-whole-vocab, zero-or-more path. The stage loops facets and dispatches: `facet == 'topic'` → §5.1; others → existing enum path.

### 5.3 Tag embedding maintenance (`worker/stages/embed_tags.py`, new)

```
embed_tag(tag_id):
  text = label
  if aliases: text += " | " + " | ".join(aliases)
  if description: text += " — " + description
  vec = bedrock_embed_one(text)        # reuse bedrock_embed.py; model = cohere-embed-v4
  UPSERT INTO tag_embeddings (tag_id, embedding_model, dimension, embedding, embedded_text, embedded_at)
    VALUES (..., 'cohere-embed-v4', 1536, $vec, $text, now())
    ON CONFLICT (tag_id, embedding_model) DO UPDATE SET embedding=..., embedded_text=..., embedded_at=now()
  UPDATE tags SET needs_reembed = false WHERE id = $tag_id
```

**Re-embed sweep**: a worker tick claims `SELECT id FROM tags WHERE needs_reembed AND facet='topic' ORDER BY ... LIMIT $batch` (uses the partial index), embeds each, clears the flag. Triggered opportunistically at the start of any classify run, and as a standalone worker tick / admin "rebuild tag embeddings" action.

**Initial 755-topic build**: a one-time admin action iterates all topic tags with no row in `tag_embeddings`, batched at `tag_embed_batch_size=100`. Sub-cent; logged with a cost estimate.

### 5.4 Auditability

The classify stage logs the candidate set (`tag_id`, label, cosine sim) for each doc. **Log-only for v1** — no `document_tag_candidates` table unless editors ask "why was topic X suggested." The log line + the `embedded_text` audit on `tag_embeddings` give a debug trail.

### 5.5 Cost

- One-time 755-topic embed: sub-cent.
- Per-doc classify: ~$0.0008 (vs ~$0.0017 today — the huge enum was the expensive part).
- Full-corpus re-classify (~203 docs): ~$0.15–0.20.
- Scoped re-classify (docs tagged with topic X, ~10–50 docs): $0.008–0.04.

## 6. Re-classify job lifecycle

### 6.1 Triggers (admin-initiated from the taxonomy UI)

| Trigger | Scope | Enqueue |
|---|---|---|
| "Re-classify all docs" | full corpus | `INSERT INTO reclassify_jobs (document_id) SELECT id FROM documents WHERE status='ready'` |
| "Re-classify docs tagged with topic X" (per-tag) | scoped | `INSERT INTO reclassify_jobs (document_id, scope_tag_id) SELECT dt.document_id, $tag_id FROM document_tags dt WHERE dt.tag_id=$tag_id AND dt.source='llm'` |
| Tag merge (bulk op) | scoped | auto-enqueue re-classify for the docs moved by the merge (now on the target tag) |
| CSV import with "reclassify after" | full or scoped | enqueue after import applies |

`status='ready'` filter avoids re-classifying draft/ingesting docs. The partial unique index makes enqueue idempotent.

### 6.2 Worker claim loop (`worker/stages/reclassify.py`, new; hooked in `worker/main.py`)

```sql
UPDATE reclassify_jobs
SET status='running', updated_at=now()
WHERE id = (
  SELECT id FROM reclassify_jobs WHERE status='queued'
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
)
RETURNING id, document_id, scope_tag_id
```

On claim:
1. Run `classify.run(document_id)` with `topic_only=True` (skip non-topic facets; `scope_tag_id` is bookkeeping).
2. Success → `status='done'`.
3. Error → `attempts += 1`; if `< MAX_ATTEMPTS` (2) → back to `queued`; else `status='error', error=$msg`.

A worker tick polls `reclassify_jobs` **before** `ingestion_jobs` (re-classify is lower-volume and editor-triggered). Configurable: `settings.reclassify_poll_first: bool = True`.

### 6.3 Concurrency & backpressure

- `tag_reclassify_concurrency=4` workers claim in parallel; SKIP LOCKED is the arbiter.
- No global lock with ingestion: different tables, short transactions. A doc mid-ingest is excluded from full-corpus enqueue by `status='ready'`.
- Full-corpus re-classify ~203 calls (gpt-5-mini) at concurrency 4 — under any OpenAI rate limit. UI shows a confirmation with estimated doc count + cost before enqueue.

### 6.4 Status & observability (admin UI)

A "Re-classify jobs" panel:
```
Re-classify in progress: 47/203 docs done (23%)   [refresh]
Recent runs: [full corpus — 203 docs — $0.17 — 2m ago]
            [scoped: "Coal" — 12 docs — $0.01 — 1h ago]
Errors: 0
```

Backed by `SELECT status, count(*) FROM reclassify_jobs GROUP BY status` + recent rows. Per-run cost: the worker writes an `audit_log` row (action `'reclassify_run'`, doc count + cost) via `writeAudit`-equivalent on the python side. No new metrics infra.

### 6.5 Failure modes

| Failure | Behavior |
|---|---|
| LLM call fails for a doc | `attempts` bumps; retried once; then `status='error'` with message. Other docs unaffected. |
| Tag embeddings stale (tag edited, not yet re-embedded) | Opportunistic sweep (§5.3) runs before classify; stale-but-functional; next re-classify self-heals. |
| Admin triggers full re-classify while one is running | Idempotent enqueue; already-queued docs skipped; running docs finish. No duplicate work. |
| `scope_tag_id` topic later deleted | `ON DELETE SET NULL`; cosmetic. |

## 7. Taxonomy management API + UI

### 7.1 API surface (app tier, all under `/api/admin/topics/*`)

Every route: `runtime='nodejs'`, `dynamic='force-dynamic'`, calls `initializeDatabase()`, uses `requireIdentity` (admin-only for writes, reviewer-ok for reads).

| Method | Path | Action |
|---|---|---|
| GET | `/api/admin/topics` | List topic tags with counts + parent + aliases + description (one query, tree-buildable) |
| GET | `/api/admin/topics/:id` | Single tag with full detail (edit drawer) |
| POST | `/api/admin/topics` | Create (label, description, aliases[], parent_id) — sets `needs_reembed=true` |
| PATCH | `/api/admin/topics/:id` | Edit label/description/aliases/parent — sets `needs_reembed=true`; cycle-check before commit |
| DELETE | `/api/admin/topics/:id` | Delete if unused (extends `deleteTagIfUnused` to warn if it has children) |
| POST | `/api/admin/topics/:id/merge` | Body `{ into_tag_id }` — move `document_tags` to target, delete this tag, enqueue scoped re-classify on target |
| POST | `/api/admin/topics/import` | CSV upload; `?dry_run=true` returns diff; apply enqueues re-classify if `?reclassify=true` |
| GET | `/api/admin/topics/export` | Stream current taxonomy as CSV |
| POST | `/api/admin/topics/reclassify` | Body `{ scope: 'all' | tag_id }` — enqueue `reclassify_jobs`; returns estimated count + cost |
| GET | `/api/admin/topics/reclassify/status` | Aggregate counts + recent runs (UI panel) |
| POST | `/api/admin/topics/embeddings/rebuild` | One-time/force rebuild of `tag_embeddings` (admin only) |

**Query module**: new `src/db/queries/topicsAdmin.ts` (sibling to `tagsAdmin.ts`), typed functions, reuses `writeAudit` + `auditActor` for every mutation (audit actions: `tag_create`, `tag_update`, `tag_merge`, `tag_import`, `reclassify_enqueue`, `tag_embeddings_rebuild`). Existing `tagsAdmin.ts` stays for legacy routes + non-topic facets.

**Cycle prevention** (PATCH parent) — ancestor-walk CTE inside the update transaction:
```sql
WITH ancestors AS (
  SELECT id FROM tags WHERE id = $new_parent
  UNION ALL
  SELECT t.id FROM tags t JOIN ancestors a ON t.parent_tag_id = a.id
)
SELECT 1 FROM ancestors WHERE id = $tag_id   -- if any row, reject (cycle)
```

### 7.2 CSV format (richer, separate from the WRI CSV)

| Column | Required | Notes |
|---|---|---|
| `label` | yes | The `value_id` (topic name) |
| `description` | no | Nullable |
| `aliases` | no | Pipe-delimited: `WASH\|Sanitation` |
| `parent` | no | Parent topic's label (resolved by label→id on import; empty = root) |
| `facet` | no | Defaults to `topic`; allows the format to extend to other facets later |
| `id` | no | UUID on export; on import, if present and matches, update; else match by `label` |

**Import semantics** (`?dry_run=true` first):
- Match by `id` if present, else by `label`.
- Dry run returns `{ added, updated, unchanged, conflicts }` (conflicts = bad parent ref, duplicate labels, etc.). UI shows the diff; admin confirms.
- Apply: transactional — all changes commit or none. Aliases diffed per tag. After commit, if `?reclassify=true`, enqueue `reclassify_jobs`. Every changed tag gets `needs_reembed=true`.
- **Does not delete** tags absent from the CSV. Deletion is an explicit admin action.

**Export**: `GET /api/admin/topics/export` streams this format. Used for backups + offline editing.

### 7.3 Management UI (rich topic UI at `/admin/tags` → Topic tab, also `/admin/topics`)

A facet-tabbed page at the existing `/admin/tags` route (single nav entry, per the brainstorm). The page renders a facet tab strip — **Topic** (default) → the rich UI below; **Program** / **Office** / **Doc type** → today's simple table. The rich topic UI also resolves at `/admin/topics` (deep-linkable). Chakra UI (matches the admin app). Layout:

```
┌─ Topic Taxonomy ──────────────────────────────────────────────┐
│ [Search topics...]  [Facet: topic ▾]  [Has parent ▾] [⌕]      │
│ [+ New topic] [Import CSV] [Export CSV] [Rebuild embeddings]  │
│                                                                │
│ Re-classify: [All docs] [Scoped…▾]      [Re-classify panel ▾] │
│ ──────────────────────────────────────────────────────────────│
│ Topic tree / flat list (depending on parents)                 │
│  ▾ Coal                       12 docs   [edit] [merge] [del]   │
│     • Coal Combustion          3 docs   [edit] [merge] [del]   │
│     • Coal Decommission        0 docs   [edit] [merge] [del]   │
│  ▸ Climate                    45 docs   ...                   │
│  • Accessibility               0 docs   ...                   │
│ ─────────────────────────────────────────────────────────────│
│ [n tags, showing m]                                           │
└───────────────────────────────────────────────────────────────┘
```

**The six capabilities:**
- **(a) Search + filter** — client-side over a loaded page of tags (progressive render at 755+); filters: facet (topic), has-parent, doc-count range, `needs_reembed`. Search matches label + aliases + description.
- **(b) Tree view** — collapsible; roots (parent=null) expanded by default; children indented. When no parents exist, renders as a flat sorted list (no tree chrome). All 755 loaded in one fetch (a few KB). The facet tab strip above the tree switches to the small-facet simple tables for Program/Office/Doc type.
- **(c) Inline edit** — click a row → right-side drawer with fields: label, description, aliases (tag-input), parent (combobox over topic labels, with cycle-check inline error). Save → PATCH; flash + row refresh. No page reload.
- **(d) CSV import/export** — import opens file picker → POST `/import?dry_run=true` → diff modal (added/updated/conflicts) → "Apply" → `?reclassify=true` checkbox → enqueue. Export hits `/export` and downloads.
- **(e) Bulk ops** — multi-select checkboxes → toolbar: **Merge** (pick target; merges the rest into it), **Re-parent** (set a new parent for the selected subtree), **Delete unused** (only deletes selected tags with 0 docs, surfaces which can't be deleted).
- **(f) Per-tag audit** — edit drawer "History" tab pulling `audit_log` rows for `entityType='tag', entityId=:id` (action/actor/when + before/after diffs).

**Performance at 755+ rows**: initial load is one query (a few KB). Progressive rendering (first N rows, `IntersectionObserver`-load more) — **no new dep** (no virtualization library in `package.json`; Chakra 3.31). Search/filter is client-side. No per-row fetches.

## 8. Error handling

| Layer | Failure | Handling |
|---|---|---|
| API | Invalid body / missing field | 400 `{ ok:false, error }` (existing `api-error` pattern) |
| API | Non-admin attempts write | 403 via `requireIdentity` |
| API | Cycle on parent-set | 409 `{ error:'cycle' }` — client shows inline error, no save |
| API | Merge into self / target missing | 409 with message |
| API | Import conflict (bad parent ref, dup label) | Dry-run returns conflicts; **apply is blocked until conflicts = 0** — a POST with unresolved conflicts returns 409 with the conflict list (transaction rolled back, nothing applied). No partial apply. |
| API | Re-classify enqueue while DB down | 500 via `internalError`; UI flash, no enqueue |
| Worker | LLM call fails for a doc | `attempts` → retried once → `status='error'` with message; other docs unaffected. Errors fold into the run row in the UI (click “1 error” to expand); per-doc retry button. |
| Worker | Embedding API (Bedrock) down | `needs_reembed` stays `true`; sweep retries next tick; classify runs with existing (stale) embeddings |
| Worker | No topic tags embedded yet (empty `tag_embeddings`) | Logs `no candidate tags — skipping topic classify`, skips topic facet (non-topic facets still run); surfaces in re-classify status panel as "0 docs tagged — embeddings not built" |
| Worker | `scope_tag_id` deleted mid-run | `ON DELETE SET NULL`; cosmetic |
| UI | Search/filter on 755+ rows | Progressive render; no perf cliff |
| UI | CSV upload parse error | Inline error before dry-run; no request sent |

**Invariants re-asserted (must hold after this work):**
- `source='human'` / `source='external'` `document_tags` rows are never overwritten by the worker.
- `taxonomy_version` stays `'v1'`.
- `/query` contract untouched.
- Two-writer ownership: app never touches `tag_embeddings` rows; `tag_embeddings` has no TypeORM entity (enforced by absence).

## 9. Testing

### 9.1 App tier (Jest, jsdom — `npm test`)

Follow the existing `*.db.test.ts` pattern in `src/__tests__/` (e.g. `admin-tags.db.test.ts`): `@jest-environment node`, `const hasDb = !!process.env.DATABASE_URL; const d = hasDb ? describe : describe.skip`, fixtures in `beforeAll`, cleanup in `afterAll`.

| File | Tests |
|---|---|
| `src/__tests__/admin-topics.db.test.ts` (new) | create/edit/merge/delete happy path; cycle prevention (A→B→A rejected); delete-with-children warning; delete-in-use blocked; aliases add/remove/dedup; audit rows written; `needs_reembed` set on edit; CSV import dry-run diff (added/updated/conflicts); CSV import apply (transactional, `needs_reembed` set); export round-trips through import unchanged |
| API route tests | auth (non-admin 403), validation (400), cycle (409), merge (200 + scoped re-classify enqueued), reclassify enqueue (200 + count/cost estimate), import dry_run vs apply |

No dedicated migration-test harness exists; the new migration is implicitly covered by db tests running against a migrated schema.

### 9.2 Python tier (pytest — `npm run test:python`)

| File | Tests |
|---|---|
| `search-service/tests/test_classify_topic.py` (new) | retrieve-then-classify: candidate set from `tag_embeddings`; top-5 with confidence; `source='human'` not overwritten; `status='accepted'` ≥ 0.7 else `'suggested'`; `ON CONFLICT DO NOTHING` preserves existing; empty `tag_embeddings` → skips topic facet, runs others; candidate set logged |
| `search-service/tests/test_embed_tags.py` (new) | `embed_tag` builds `label \| aliases — description`; UPSERT on `tag_embeddings`; `needs_reembed` cleared; batch build of N tags; cost-estimate log line present |
| `search-service/tests/test_reclassify.py` (new) | claim loop with `FOR UPDATE SKIP LOCKED` (two workers, one doc → only one claims); `attempts` retry-then-error; `scope_tag_id` set on scoped rows; `topic_only=True` skips non-topic facets; idempotent enqueue (partial unique index) |
| `search-service/tests/test_worker_stages.py` (existing) | update: classify schema change reflected; non-topic facets still pass existing assertions |

**Fixture**: a small topic taxonomy (5–10 tags, 2 with aliases, one parent→child pair) + a handful of `tag_embeddings` rows + 3–5 docs with known expected topic tags. Reused across the Python tests.

## 10. Scope, non-goals, risks

### 10.1 In scope (this spec, A + B)
- Data model: extend `tags`; add `tag_aliases`, `tag_embeddings`, `reclassify_jobs`.
- Topic-taxonomy management UI + API: tree, search/filter, inline edit, CSV import/export with dry-run, bulk merge/re-parent/delete-unused, per-tag audit.
- Worker: retrieve-then-classify (top-5 topic tags); non-topic facets keep existing enum; tag-embedding builder + `needs_reembed` sweep.
- On-demand bulk/scoped re-classify (classify-only, override-preserving).
- Cost estimates in the UI before enqueue; run cost to `audit_log`.
- Tests: app `*.db.test.ts` for `topicsAdmin` + routes; python pytest for classify/embed_tags/reclassify.

### 10.2 Non-goals (deferred)
- **C — Retrieval integration.** No tag fields in `QueryRequest`/`QueryResponse`; `search-service/app` doesn't read `document_tags`. `/query` preserved exactly. (Future workstream; data model enables it.)
- **D — Frontend tag filters + query topic sensing.** (Future workstream.)
- **Retrieval tuning** (RRF weights, rerankers, thresholds) — separate workstream per `CLAUDE.md`.
- **Parallel taxonomy versioning** (v1/v2 coexistence). In-place edits + audit + on-demand re-classify deliver "remap after review" now.
- **Auto-trigger re-classify on every edit.** Re-classify is admin-initiated (explicit cost control).
- **WRI CSV as the import format.** The richer managed-CSV is the import path; the raw WRI CSV loads once into the managed format (seed step).
- **Non-topic facets in the new management UI.** They stay on the existing `/admin/tags` page for now.

### 10.3 Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 755-topic embedding shortlist misses a relevant topic (recall) | Med | Med | `tag_candidate_top_n=20` is generous; admin can raise; scoped re-classify after adding a topic recovers; LLM validate is the precision guard |
| LLM picks a topic not in the candidate set | Low | Low | Schema enum is the candidate set only → model can't return out-of-set (structured output, `strict:true`) |
| Cycle on `parent_tag_id` corrupts the tree | Low | High | App-level ancestor-walk CTE inside the update transaction; test covers A→B→A |
| Tag embeddings stale after a rename → wrong candidates | Med | Low | `needs_reembed` + opportunistic sweep before classify; stale-but-functional; next re-classify self-heals |
| Bulk re-classify cost surprise | Low | Low | UI shows count + $ estimate with confirm; scoped path default; full-corpus is the rare explicit button |
| `tag_embeddings` pgvector DDL error in migration | Low | High | Mirror `document_chunks` DDL exactly (proven); db tests catch shape regressions |
| Windowed UI jank at 755 rows | Low | Low | Progressive render (`IntersectionObserver`); no new dep; tested with a 1000-row fixture |
| Two-writer boundary violation (app writing `tag_embeddings`) | Low | High | `tag_embeddings` has no TypeORM entity; app can't map it; enforced by absence |
| Re-classify races a live ingest of the same doc | Low | Med | `status='ready'` filter on enqueue; SKIP LOCKED on claim |

### 10.4 Sequencing (for the implementation plan)
1. Migration + entities (data model) — foundation.
2. `topicsAdmin.ts` queries + API routes — backend before UI.
3. Worker: `embed_tags` + tag-embedding build → classify rewrite → `reclassify` claim loop.
4. Management UI (search/tree/inline-edit first; CSV import/export; bulk ops; audit; re-classify panel).
5. Tests alongside each layer; full baseline run before finish.

## 11. Open questions for review

- (none — all decisions captured in §3–§10)
