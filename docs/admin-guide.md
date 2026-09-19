# AskWRI Admin — System & Operational Reference

**Audience:** engineers and operators working on the admin subsystem, the
taxonomy, or the ingestion/classification pipeline.
**User-facing help (in-app):** [`/admin/guide`](../src/app/admin/guide/page.tsx)
— the end-user Admin Guide rendered in the app so it can't drift from the UI.
**Document management as-built (Phases 0–2):** [document-management.md](document-management.md).
**Topic taxonomy design record:** [docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md](superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md).
**Repo orientation & conventions:** [CLAUDE.md](../CLAUDE.md).

This document is the system reference for the admin app: data model, admin API
surface, the classify/embed/re-classify pipeline, and the operational caveats
that aren't obvious from the code. It complements — does not duplicate — the
in-app user guide and the design spec.

---

## 1. Tiers and write-ownership

Three tiers share one RDS Postgres:

| Tier | Stack | Owns (writes) |
|---|---|---|
| Web app + admin | `src/` (Next.js 16 App Router, TypeORM 0.3) | `documents`, `document_summaries`, `tags`, `tag_aliases`, `document_tags`, `collections`, `document_collections`, `ingestion_jobs`, `reclassify_jobs`, `users`, `audit_log` |
| Retrieval + ingestion worker | `search-service/` (FastAPI + LlamaIndex, Python 3.12) | `document_chunks`, `document_texts`, `keyword_vocab`, `tag_embeddings` (pgvector, raw SQL — no TypeORM entity) |
| Eval harness | `evaluation/` (tsx) | read-only over the public QA gateway |

**Two-writer boundary (per CLAUDE.md):** the app tier never calls Bedrock and
never writes `tag_embeddings`; the worker never uses the app's TypeORM
entities. Tables with two writers (`documents`, `document_tags`,
`ingestion_jobs`, `audit_log`) are coordinated by precedence invariants — the
worker writes `document_tags` only with `source='llm'`; `human`/`external` rows
are protected and never overwritten by automation.

---

## 2. Tags, topics, and the taxonomy

Tags are the controlled vocabulary, partitioned into facets: `program`,
`office`, `topic`, `document_type`. Every tag row carries a `taxonomy_version`
(currently `v1`); the Topic facet is the first to get a full management surface
(issue #323).

### 2.1 Data model

- **`tags`** — extended (migration `1787160000000`) with `parent_tag_id`
  (self-ref tree, `ON DELETE SET NULL`), `description`, `needs_reembed`
  (flag the worker clears after embedding). Unique on
  `(facet, value_id, taxonomy_version)`.
- **`tag_aliases`** — synonyms per tag (app-owned). The classifier composes
  `label | aliases — description` as the embedding text.
- **`tag_embeddings`** — python-owned pgvector table (no TypeORM entity; raw
  SQL in `search-service/worker/stages/embed_tags.py`, mirroring
  `document_chunks`). One row per `(tag_id, embedding_model)`; the classify
  stage ranks candidates by cosine similarity against the document embedding.
  HNSW index scoped to `cohere-embed-v4` with a `vector(1536)` cast.
- **`reclassify_jobs`** — classify-only re-run queue (separate from
  `ingestion_jobs`); `run_id` groups one enqueue's jobs into a run for the
  status panel. A partial unique index
  (`reclassify_jobs_one_open_per_doc`, `status IN ('queued','running')`) makes
  enqueue idempotent — one open job per document.
- **`document_tags`** — assignments; `source` ∈ `{human, external, llm}`,
  `status` ∈ `{accepted, suggested}`.

Migration `1787160000000-TopicTaxonomy.ts` creates all of the above. See §4
for the deploy caveat that just bit QA.

### 2.2 Admin API surface

All under `/api/admin/topics/*` (app tier, `runtime: 'nodejs'`,
`dynamic: 'force-dynamic'`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/topics` | List topic tags with aliases + accepted/suggested counts |
| POST | `/api/admin/topics` | Create a topic (sets `needs_reembed`) |
| GET / PATCH / DELETE | `/api/admin/topics/:id` | Get / edit (cycle-guarded) / delete-if-unused |
| POST | `/api/admin/topics/:id/merge` | Merge into a target (preserves human tags, moves aliases/children, enqueues scoped re-classify) |
| GET | `/api/admin/topics/:id/history` | Audit log for a tag |
| POST | `/api/admin/topics/import` | CSV import; `?dry_run=true` returns diff; `?reclassify=true` enqueues after apply |
| GET | `/api/admin/topics/export` | Stream current taxonomy as CSV |
| POST | `/api/admin/topics/reclassify` | Enqueue re-classify (`{ scope: 'all' \| tag_id }`); returns estimate + cost |
| GET | `/api/admin/topics/reclassify/status` | Aggregate counts + recent runs |
| GET / POST | `/api/admin/topics/embeddings/rebuild` | GET = sweep progress `{ total, embedded, pending }`; POST = re-flag unembedded tags for the worker |

Authentication: `requireIdentity(req)` — a valid session cookie (editor or
admin) or a bearer token matching `ADMIN_API_TOKEN`. Mutations require admin
role. Every mutation writes an `audit_log` row (`tag_create`, `tag_update`,
`tag_merge`, `tag_import`, `reclassify_enqueue`, `tag_embeddings_rebuild`).

### 2.3 CSV import format

Managed format (spec §7.2), header `label,description,aliases,parent,facet,id`:

| Column | Required | Notes |
|---|---|---|
| `label` | yes | The `value_id` (topic name) |
| `description` | no | Nullable |
| `aliases` | no | Pipe-delimited: `WASH\|Sanitation` |
| `parent` | no | Parent topic's label (resolved label→id on import; empty = root) |
| `facet` | no | Defaults to `topic` |
| `id` | no | UUID on export; on import, if present and matches, update; else match by `label` |

Import is a dry-run diff first (`?dry_run=true` → `{ added, updated,
unchanged, conflicts }`), then an atomic apply. Conflicts: empty label,
non-topic facet, duplicate label/id, bad parent reference, unknown topic id,
label owned by another topic. Apply enqueues re-classify if `?reclassify=true`.
Import does **not** delete topics absent from the CSV — deletion is an
explicit admin action.

**WRI keyword CSV (one-time seed):** a raw WRI keyword file is headerless
(`Access Rights,,,`) and is **not** this format. Convert it first, then
import the result:

```bash
npm run --silent convert:wri-keywords -- DETagKeywords.csv > topics.managed.csv
```

This is the documented seed step (spec §10.2). The converter
(`scripts/convert-wri-keywords-csv.ts`) is quote-aware (handles keywords with
embedded commas like `"Water, Sanitation, and Hygiene"`, CRLF, blank lines)
and adds no dependencies.

---

## 3. The classify / embed / re-classify pipeline

### 3.1 Classify (worker, `search-service/worker/stages/classify.py`)

The Topic facet is **retrieve-then-classify**, per document:

1. Embed the document basis (en/long summary, else first 8000 chars of
   `full_text`) with `cohere-embed-v4`.
2. Find the top-N (`tag_candidate_top_n`, default 20) candidate topic tags by
   cosine similarity to the document embedding in `tag_embeddings`.
3. One LLM call (enum-constrained to the candidate labels only, structured
   output) picks up to 5 topics with confidence.
4. Insert `accepted` (confidence ≥ `tag_confidence_accept`, default 0.7) or
   `suggested` rows; never overwrite protected (`human`/`external`) rows.

Non-topic facets (program/office/doc_type) use a full-enum LLM call (small
vocabs) — one call over the whole vocabulary per facet.

**Self-healing embeddings:** before the topic classify query, the stage runs
`sweep_pending()` — it embeds any `needs_reembed` tags right there. So a
reclassify job fired the instant after an import embeds pending tags as part
of its own flow, then retrieves candidates. The main worker loop also runs
`_embed_sweep_tick()` (`sweep_pending` + `build_all_embeddings`) on every
poll tick (`worker_poll_seconds`, default 10s), so pending tags drain
continuously.

### 3.2 Tag embedding maintenance (`search-service/worker/stages/embed_tags.py`)

Builds `label + " | " + aliases + " — " + description`, embeds with
`cohere-embed-v4` (1536-dim, `input_type=search_document` to match document
chunk embeddings), UPSERTs into `tag_embeddings`, clears `needs_reembed`.
Two entry points: `sweep_pending` (drains flagged tags, batched by
`tag_embed_batch_size`, default 100) and `build_all_embeddings` (backstops
any topic tag with no `tag_embeddings` row).

### 3.3 Re-classify lifecycle

Admin-initiated from the taxonomy UI. `enqueueReclassify` inserts
`reclassify_jobs` rows (idempotent via the partial unique index) under one
shared `run_id` per enqueue. The worker's `reclassify.py` claims jobs in
batches (`tag_reclassify_concurrency`, default 4), classifies the topic facet
only (`topic_only=True`), and preserves protected rows. The status panel
(`reclassifyStatus`) shows counts by status plus up to 20 recent runs with
per-run total/done/error and cost. `retryReclassifyRun` resets terminal
errors from one run preserving the original run ID.

**Cost:** ~$0.0008 per document (`EST_PER_DOC_COST`, gpt-5-mini classify) —
surfaced as an estimate before enqueue and tracked per run.

---

## 4. Operational caveats

### 4.1 Deploys do not run migrations

`.github/workflows/deploy-qa.yml` and `deploy-production.yml` contain **no
migration step** — they run lint/test/build, build and push Docker images,
`terraform apply`, and `aws ecs update-service --force-new-deployment`. Any PR
carrying a migration will ship broken unless the migration is applied to RDS
first, in the order the runbooks prescribe.

Check pending and apply against a deployed environment:

```bash
./scripts/with-remote-env.sh qa npm run typeorm -- migration:show -d src/db/migration-data-source.ts
./scripts/with-remote-env.sh qa npm run migration:run
```

See [runbooks/qa-push-deploy.md](runbooks/qa-push-deploy.md) for the ordering
(migrate → sparse backfill → push) and why it matters. (This is exactly what
caused the `/api/admin/topics` 500 on QA after PR #337: the image shipped with
migration `1787160000000` pending.)

### 4.2 pgvector and the `vector` extension

`tag_embeddings.embedding` is typed `vector` (not a fixed dimension in DDL);
the HNSW index is scoped to `cohere-embed-v4` with a `vector(1536)` cast. The
`vector` extension must be available (it already is on QA/prod for
`document_chunks`). Fixture/test inserts into `tag_embeddings` must supply a
1536-dim vector or the column rejects them.

### 4.3 Embeddings are async, worker-driven

The app tier sets `needs_reembed=true` on edits/imports; the ingestion worker
builds embeddings on its sweep. There is a window between "import applied" and
"sweep finished" where new topics are not yet classification candidates. The
admin UI surfaces this: the "Embeddings: embedded/total (pending N)"
indicator on the Tags page polls `GET /api/admin/topics/embeddings/rebuild`
every 5s and shows settle progress.

### 4.4 Re-classify candidate window

`sweep_pending` is batched (`tag_embed_batch_size`, default 100). If
reclassify jobs are claimed faster than the sweep builds embeddings, early
jobs in a run see a partial candidate set and may produce narrower tag
assignments than later jobs. It self-heals (later jobs see more), but for a
large import followed immediately by re-classify-all, consider letting the
embeddings indicator settle to 0 pending first. A reclassify job with zero
candidate embeddings raises (`require_candidates=topic_only`) rather than
silently skipping — total embedding failure is loud; partial is the quiet
risk.

---

## 5. Testing

- **App tier:** `npm test` (Jest, jsdom). DB-gated suites (`*.db.test.ts`)
  run only with `DATABASE_URL` set — `npm run test:db` runs them against local
  docker Postgres.
- **Python tier:** `npm run test:python` (pytest).
- **Topics suites:** `src/__tests__/admin-topics*.test.ts`,
  `topic-taxonomy-ui.test.tsx`, `convert-wri-keywords-csv.test.ts`,
  `admin-guide-page.test.tsx`; `search-service/tests/test_classify_topic.py`,
  `test_embed_tags.py`, `test_reclassify.py`.

Note: jest's `testPathIgnorePatterns` excludes `.worktrees/`, so run a
worktree's tests with a config that drops that pattern, or from the main
checkout.

---

## 6. See also

- [document-management.md](document-management.md) — Phases 0–2 as-built.
- [runbooks/qa-push-deploy.md](runbooks/qa-push-deploy.md) — deploy ordering.
- [runbooks/local-testing.md](runbooks/local-testing.md) — local stack.
- [runbooks/phase0-cutover.md](runbooks/phase0-cutover.md) — RDS preflight.
- `docs/superpowers/specs/2026-08-17-issue-323-topic-taxonomy-design.md` —
  topic taxonomy design record.
- `CLAUDE.md` — repo orientation, conventions, write-ownership.
