# Translation Pairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link non-English originals to their official English translations so the original is the only cited/counted identity, translations stop double-counting, and the DMS can manage pairs.

**Architecture:** A `document_relations` table holds directed edges (translation → original) with a suggested → confirmed/rejected lifecycle. The worker inserts suggestions at end of ingestion (title similarity primary, embedding similarity secondary); the app tier confirms/rejects via admin UI. Retrieval applies confirmed edges as query-time filters behind a default-off flag: answer mode excludes translation chunks; cite mode collapses a pair to the original's identity.

**Tech Stack:** TypeORM 0.3 raw-SQL migration, Next.js 16 App Router admin routes/pages, psycopg worker code, FastAPI search service, pgvector.

**Spec:** `docs/superpowers/specs/2026-08-13-issue-325-translation-pairs-design.md`

## Global Constraints

- Edge direction is fixed: `document_id` = translation (rendition), `related_document_id` = original. The original always wins.
- Only `status='confirmed'` edges affect retrieval. Suggestions and rejections change nothing.
- The worker only INSERTs `source='system', status='suggested'` rows and never modifies human-reviewed rows (document_tags precedence pattern).
- `/query` request/response shapes unchanged; new keys go inside the existing `metadata` dict only.
- Retrieval filtering is gated on `translation_pairs_enabled` (search-service Settings), default `False`. Rollback = flag off.
- No fusion/rerank/threshold tuning (CLAUDE.md out-of-scope rule).
- Migrations: raw SQL via `queryRunner.query`, snake_case columns, `synchronize` false.
- One command per Bash call; `npm test` for Jest; `cd search-service && ./venv/bin/python -m pytest tests/ -v` for Python.
- DB-backed Jest tests follow the `*.db.test.ts` pattern: skip when `DATABASE_URL` unset; clean up all rows they insert.

---

### Task 1: `document_relations` migration + entity

**Files:**
- Create: `src/db/migrations/1786579200000-Migration.ts`
- Create: `src/db/entities/DocumentRelation.entity.ts`
- Modify: `src/db/data-source.ts` (register entity in the `entities` array, following how `DocumentTag` is registered)
- Test: `src/__tests__/document-relations.db.test.ts`

**Interfaces:**
- Produces: table `document_relations` with columns `id uuid PK`, `document_id uuid FK`, `related_document_id uuid FK`, `relation_type text default 'translation_of'`, `status text default 'suggested'`, `source text`, `confidence numeric null`, `signals jsonb default '{}'`, `created_at timestamptz`, `reviewed_by text null`, `reviewed_at timestamptz null`. Entity class `DocumentRelation` exported from `src/db/entities/DocumentRelation.entity.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('document_relations schema', () => {
  const ext = `docrel_test_${Date.now()}`
  let docA: string
  let docB: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const rows = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status) VALUES
       ($1, $2, 'Rel Test A', 'searchable'),
       ($3, $4, 'Rel Test B', 'searchable') RETURNING id`,
      [`${ext}_a`, `documents/${ext}_a.pdf`, `${ext}_b`, `documents/${ext}_b.pdf`],
    )
    docA = rows[0].id
    docB = rows[1].id
  })

  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id IN ($1, $2) OR related_document_id IN ($1, $2)`,
      [docA, docB],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id IN ($1, $2)`, [docA, docB])
    await AppDataSource.destroy()
  })

  it('inserts a suggested edge with defaults', async () => {
    const [row] = await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, source, confidence, signals)
       VALUES ($1, $2, 'system', 0.9, '{"trigger":"title"}') RETURNING *`,
      [docA, docB],
    )
    expect(row.relation_type).toBe('translation_of')
    expect(row.status).toBe('suggested')
  })

  it('rejects the same pair in either direction', async () => {
    await expect(
      AppDataSource.query(
        `INSERT INTO document_relations (document_id, related_document_id, source)
         VALUES ($1, $2, 'system')`,
        [docB, docA],
      ),
    ).rejects.toThrow(/duplicate key|UQ_document_relations_pair/)
  })

  it('rejects a self-edge', async () => {
    await expect(
      AppDataSource.query(
        `INSERT INTO document_relations (document_id, related_document_id, source)
         VALUES ($1, $1, 'human')`,
        [docA],
      ),
    ).rejects.toThrow(/CHK_document_relations_not_self|check constraint/)
  })

  it('allows only one confirmed translation_of per translation doc', async () => {
    await AppDataSource.query(
      `UPDATE document_relations SET status = 'confirmed' WHERE document_id = $1`,
      [docA],
    )
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Rel Test C', 'searchable') RETURNING id`,
      [`${ext}_c`, `documents/${ext}_c.pdf`],
    )
    try {
      await expect(
        AppDataSource.query(
          `INSERT INTO document_relations (document_id, related_document_id, source, status)
           VALUES ($1, $2, 'human', 'confirmed')`,
          [docA, row.id],
        ),
      ).rejects.toThrow(/duplicate key|UQ_document_relations_confirmed/)
    } finally {
      await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [row.id])
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- document-relations.db.test.ts`
Expected: FAIL — `relation "document_relations" does not exist` (with a local DB up via `./scripts/local-bootstrap.sh`).

- [ ] **Step 3: Write the migration**

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * document_relations: directed edges between documents (issue #325).
 * document_id = the translation/rendition; related_document_id = the original.
 * Lifecycle: suggested -> confirmed | rejected. Rejected rows persist as
 * don't-re-suggest memory. Only confirmed edges affect retrieval.
 */
export class Migration1786579200000 implements MigrationInterface {
  name = 'Migration1786579200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_relations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "related_document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "relation_type" text NOT NULL DEFAULT 'translation_of',
        "status" text NOT NULL DEFAULT 'suggested',
        "source" text NOT NULL,
        "confidence" numeric,
        "signals" jsonb NOT NULL DEFAULT '{}',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "reviewed_by" text,
        "reviewed_at" timestamptz,
        CONSTRAINT "CHK_document_relations_not_self" CHECK ("document_id" <> "related_document_id")
      )`)
    // One row per undirected pair: a reverse-direction duplicate is the same pair.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_document_relations_pair" ON "document_relations"
      (LEAST("document_id"::text, "related_document_id"::text),
       GREATEST("document_id"::text, "related_document_id"::text),
       "relation_type")`)
    // A translation has at most one confirmed original.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_document_relations_confirmed" ON "document_relations"
      ("document_id") WHERE "status" = 'confirmed' AND "relation_type" = 'translation_of'`)
    await queryRunner.query(`
      CREATE INDEX "idx_document_relations_status" ON "document_relations" ("status")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_relations"`)
  }
}
```

- [ ] **Step 4: Write the entity**

```typescript
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

/** Directed edge: documentId is the translation, relatedDocumentId the original. */
@Entity('document_relations')
export class DocumentRelation {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('uuid', { name: 'document_id' })
  documentId!: string

  @Column('uuid', { name: 'related_document_id' })
  relatedDocumentId!: string

  @Column('text', { name: 'relation_type', default: 'translation_of' })
  relationType!: string

  @Column('text', { default: 'suggested' })
  status!: string

  @Column('text')
  source!: string

  @Column('numeric', { nullable: true })
  confidence!: string | null

  @Column('jsonb', { default: () => "'{}'" })
  signals!: Record<string, unknown>

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @Column('text', { name: 'reviewed_by', nullable: true })
  reviewedBy!: string | null

  @Column('timestamptz', { name: 'reviewed_at', nullable: true })
  reviewedAt!: Date | null
}
```

Register `DocumentRelation` in `src/db/data-source.ts`'s `entities` array (import it next to `DocumentTag`).

- [ ] **Step 5: Run the migration locally**

Run: `npm run migration:run`
Expected: `Migration1786579200000` applied without error.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- document-relations.db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/1786579200000-Migration.ts src/db/entities/DocumentRelation.entity.ts src/db/data-source.ts src/__tests__/document-relations.db.test.ts
git commit -m "feat: document_relations table for translation pairs (#325)"
```

---

### Task 2: app-tier queries for relations

**Files:**
- Create: `src/db/queries/documentRelations.ts`
- Test: `src/__tests__/document-relations-queries.db.test.ts`

**Interfaces:**
- Consumes: `document_relations` table (Task 1).
- Produces:
  - `listRelations(status?: string): Promise<RelationRow[]>`
  - `reviewRelation(id: string, action: 'confirm' | 'reject' | 'flip', reviewer: string): Promise<RelationRow | null>`
  - `unlinkRelation(id: string, reviewer: string): Promise<RelationRow | null>` (confirmed → rejected; memory kept)
  - `createManualRelation(translationDocId: string, originalDocId: string, reviewer: string): Promise<RelationRow>`
  - `RelationRow` = `{ id, documentId, relatedDocumentId, relationType, status, source, confidence: number | null, signals, createdAt, reviewedBy, reviewedAt, translation: {externalId, title, language}, original: {externalId, title, language} }` where each doc's `title` is `COALESCE(title_en, title)`.
- Every state change writes an `audit_log` row: `source='human'`, `action='relation_review'`, `entity_type='document_relation'`, `entity_id=<relation id>`, `before`/`after` = `{status, document_id, related_document_id}`.

- [ ] **Step 1: Write the failing test** — same fixture shape as Task 1's test (two documents, cleanup in `afterAll`; also delete `audit_log` rows where `entity_id` is the created relation id). Cases:

```typescript
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  listRelations,
  reviewRelation,
  unlinkRelation,
  createManualRelation,
} from '@/db/queries/documentRelations'

// fixtures as in Task 1 (docA = translation, docB = original), then:

it('createManualRelation inserts a confirmed human edge', async () => {
  const rel = await createManualRelation(docA, docB, 'tester')
  expect(rel.status).toBe('confirmed')
  expect(rel.source).toBe('human')
  expect(rel.original.externalId).toContain('_b')
})

it('listRelations filters by status and joins both docs', async () => {
  const confirmed = await listRelations('confirmed')
  expect(confirmed.some((r) => r.documentId === docA)).toBe(true)
})

it('flip swaps direction and stamps reviewer', async () => {
  const [row] = await AppDataSource.query(
    `SELECT id FROM document_relations WHERE document_id = $1`, [docA])
  const flipped = await reviewRelation(row.id, 'flip', 'tester')
  expect(flipped!.documentId).toBe(docB)
  expect(flipped!.relatedDocumentId).toBe(docA)
  expect(flipped!.reviewedBy).toBe('tester')
})

it('unlink turns confirmed into rejected', async () => {
  const [row] = await AppDataSource.query(
    `SELECT id FROM document_relations WHERE related_document_id = $1`, [docA])
  const rel = await unlinkRelation(row.id, 'tester')
  expect(rel!.status).toBe('rejected')
})

it('review writes an audit row', async () => {
  const rows = await AppDataSource.query(
    `SELECT count(*)::int AS n FROM audit_log
     WHERE entity_type = 'document_relation' AND action = 'relation_review'`)
  expect(rows[0].n).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- document-relations-queries.db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `documentRelations.ts`**

```typescript
import { AppDataSource } from '../data-source'

export interface RelationDocSummary {
  externalId: string
  title: string | null
  language: string | null
}

export interface RelationRow {
  id: string
  documentId: string
  relatedDocumentId: string
  relationType: string
  status: string
  source: string
  confidence: number | null
  signals: Record<string, unknown>
  createdAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  translation: RelationDocSummary
  original: RelationDocSummary
}

const SELECT = `
  SELECT r.id, r.document_id AS "documentId", r.related_document_id AS "relatedDocumentId",
         r.relation_type AS "relationType", r.status, r.source,
         r.confidence::float AS confidence, r.signals,
         r.created_at AS "createdAt", r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt",
         dt.external_id AS "tExternalId", COALESCE(dt.title_en, dt.title) AS "tTitle", dt.language AS "tLanguage",
         do_.external_id AS "oExternalId", COALESCE(do_.title_en, do_.title) AS "oTitle", do_.language AS "oLanguage"
    FROM document_relations r
    JOIN documents dt ON dt.id = r.document_id
    JOIN documents do_ ON do_.id = r.related_document_id`

function toRow(r: any): RelationRow {
  return {
    id: r.id,
    documentId: r.documentId,
    relatedDocumentId: r.relatedDocumentId,
    relationType: r.relationType,
    status: r.status,
    source: r.source,
    confidence: r.confidence ?? null,
    signals: r.signals ?? {},
    createdAt: r.createdAt,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    translation: { externalId: r.tExternalId, title: r.tTitle, language: r.tLanguage },
    original: { externalId: r.oExternalId, title: r.oTitle, language: r.oLanguage },
  }
}

async function audit(relationId: string, reviewer: string, before: object, after: object) {
  await AppDataSource.query(
    `INSERT INTO audit_log (source, actor_user_id, action, entity_type, entity_id, before, after)
     VALUES ('human', NULL, 'relation_review', 'document_relation', $1, $2, $3)`,
    [relationId, JSON.stringify({ ...before, reviewer }), JSON.stringify(after)],
  )
}

export async function listRelations(status?: string): Promise<RelationRow[]> {
  const where = status ? ` WHERE r.status = $1` : ''
  const rows = await AppDataSource.query(
    `${SELECT}${where} ORDER BY r.created_at DESC`,
    status ? [status] : [],
  )
  return rows.map(toRow)
}

async function getRaw(id: string) {
  const rows = await AppDataSource.query(
    `SELECT id, document_id, related_document_id, status FROM document_relations WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

export async function reviewRelation(
  id: string,
  action: 'confirm' | 'reject' | 'flip',
  reviewer: string,
): Promise<RelationRow | null> {
  const before = await getRaw(id)
  if (!before) return null
  if (action === 'flip') {
    await AppDataSource.query(
      `UPDATE document_relations
          SET document_id = related_document_id, related_document_id = document_id,
              reviewed_by = $2, reviewed_at = now()
        WHERE id = $1`,
      [id, reviewer],
    )
  } else {
    await AppDataSource.query(
      `UPDATE document_relations
          SET status = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1`,
      [id, action === 'confirm' ? 'confirmed' : 'rejected', reviewer],
    )
  }
  const after = await getRaw(id)
  await audit(id, reviewer, before, after)
  const rows = await AppDataSource.query(`${SELECT} WHERE r.id = $1`, [id])
  return rows.length ? toRow(rows[0]) : null
}

export async function unlinkRelation(id: string, reviewer: string): Promise<RelationRow | null> {
  const before = await getRaw(id)
  if (!before || before.status !== 'confirmed') return null
  await AppDataSource.query(
    `UPDATE document_relations SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
      WHERE id = $1`,
    [id, reviewer],
  )
  const after = await getRaw(id)
  await audit(id, reviewer, before, after)
  const rows = await AppDataSource.query(`${SELECT} WHERE r.id = $1`, [id])
  return rows.length ? toRow(rows[0]) : null
}

export async function createManualRelation(
  translationDocId: string,
  originalDocId: string,
  reviewer: string,
): Promise<RelationRow> {
  const [row] = await AppDataSource.query(
    `INSERT INTO document_relations
       (document_id, related_document_id, source, status, reviewed_by, reviewed_at)
     VALUES ($1, $2, 'human', 'confirmed', $3, now())
     RETURNING id`,
    [translationDocId, originalDocId, reviewer],
  )
  await audit(row.id, reviewer, {}, { status: 'confirmed', document_id: translationDocId, related_document_id: originalDocId })
  const rows = await AppDataSource.query(`${SELECT} WHERE r.id = $1`, [row.id])
  return toRow(rows[0])
}
```

Note on `flip`: a single UPDATE swaps both columns atomically (SQL reads the pre-update values), and the LEAST/GREATEST pair index is direction-agnostic so the swap cannot conflict. Verify the `audit_log` column list against an existing writer (e.g. the tags audit in `src/db/queries/tagsAdmin.ts`) and match it exactly — if `audit_log` has no `actor_user_id`, drop that column from the INSERT.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- document-relations-queries.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/documentRelations.ts src/__tests__/document-relations-queries.db.test.ts
git commit -m "feat: relation review queries (confirm/reject/flip/unlink/manual) (#325)"
```

---

### Task 3: admin API routes for relations

**Files:**
- Create: `src/app/api/admin/relations/route.ts` (GET list, POST manual create)
- Create: `src/app/api/admin/relations/[id]/route.ts` (PATCH review)
- Test: `src/__tests__/admin-relations-routes.db.test.ts`

**Interfaces:**
- Consumes: Task 2 functions.
- Produces:
  - `GET /api/admin/relations?status=suggested` → `{ ok: true, relations: RelationRow[] }`
  - `POST /api/admin/relations` body `{ translationDocId, originalDocId }` → `{ ok: true, relation }`
  - `PATCH /api/admin/relations/[id]` body `{ action: 'confirm' | 'reject' | 'flip' | 'unlink' }` → `{ ok: true, relation }`; 404 when unknown id; 400 on bad action.

- [ ] **Step 1: Write the failing test** — follow `src/__tests__/admin-auth-routes.test.ts` / existing route-test conventions: import the route handlers directly, stub `requireIdentity` the way existing admin route tests do (check how `admin-intake.test.ts` mocks identity and copy that mechanism), use fixture docs as in Task 2. Cases: GET returns seeded suggestion; PATCH confirm returns confirmed row; PATCH bad action → 400; PATCH unknown uuid → 404; POST creates confirmed manual link.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- admin-relations-routes.db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement both routes** (pattern copied from `src/app/api/admin/intake/duplicate/route.ts`):

```typescript
// src/app/api/admin/relations/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listRelations, createManualRelation } from '../../../../db/queries/documentRelations'
import { requireIdentity } from '../../../../lib/auth/identity'
import { internalError } from '../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response, identity } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const status = req.nextUrl.searchParams.get('status') ?? undefined
    const relations = await listRelations(status)
    return NextResponse.json({ ok: true, relations })
  } catch (err) {
    return internalError(err)
  }
}

export async function POST(req: NextRequest) {
  const { response, identity } = await requireIdentity(req)
  if (response) return response
  try {
    const body = await req.json()
    if (!body?.translationDocId || !body?.originalDocId) {
      return NextResponse.json({ ok: false, error: 'translationDocId and originalDocId are required' }, { status: 400 })
    }
    await initializeDatabase()
    const relation = await createManualRelation(
      body.translationDocId, body.originalDocId, identityName(identity))
    return NextResponse.json({ ok: true, relation })
  } catch (err) {
    return internalError(err)
  }
}
```

```typescript
// src/app/api/admin/relations/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { reviewRelation, unlinkRelation } from '../../../../../db/queries/documentRelations'
import { requireIdentity } from '../../../../../lib/auth/identity'
import { internalError } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ACTIONS = new Set(['confirm', 'reject', 'flip', 'unlink'])

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { response, identity } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const body = await req.json()
    if (!ACTIONS.has(body?.action)) {
      return NextResponse.json({ ok: false, error: 'action must be confirm|reject|flip|unlink' }, { status: 400 })
    }
    await initializeDatabase()
    const reviewer = identityName(identity)
    const relation = body.action === 'unlink'
      ? await unlinkRelation(id, reviewer)
      : await reviewRelation(id, body.action, reviewer)
    if (!relation) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, relation })
  } catch (err) {
    return internalError(err)
  }
}
```

`identityName(identity)`: check what `requireIdentity` returns (`src/lib/auth/identity.ts`) and use the same username/label field other admin writers record as reviewer; if a helper already exists for this, use it instead of writing one. Check the `params` shape (Promise vs plain) against another existing `[id]` route (e.g. `src/app/api/admin/documents/[id]/status/route.ts`) and match it exactly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- admin-relations-routes.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/relations src/__tests__/admin-relations-routes.db.test.ts
git commit -m "feat: admin relations API (list/review/manual-link) (#325)"
```

---

### Task 4: corpus-health counts

**Files:**
- Modify: `src/db/queries/corpusHealth.ts`
- Modify: `src/app/admin/review/page.tsx` (CorpusHealth interface only — display lands with Task 5)
- Test: extend `src/__tests__/corpus-health.db.test.ts`

**Interfaces:**
- Produces: `CorpusHealth.pendingRelationSuggestions: number`, `CorpusHealth.confirmedTranslationPairs: number`.

- [ ] **Step 1: Extend the existing corpus-health db test** with a seeded suggested relation (fixtures per Task 1) asserting both new counts are `>= 1` after seeding one suggested + one confirmed row.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- corpus-health.db.test.ts`
Expected: FAIL — property undefined.

- [ ] **Step 3: Implement** — add to `getCorpusHealth()`:

```typescript
const [relRow] = await AppDataSource.query(`
  SELECT
    count(*) FILTER (WHERE status = 'suggested')::int AS "pendingRelationSuggestions",
    count(*) FILTER (WHERE status = 'confirmed' AND relation_type = 'translation_of')::int AS "confirmedTranslationPairs"
  FROM document_relations
`)
```

Add both fields to the `CorpusHealth` interface (here and in `review/page.tsx`) and to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- corpus-health.db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries/corpusHealth.ts src/app/admin/review/page.tsx src/__tests__/corpus-health.db.test.ts
git commit -m "feat: corpus health counts for relation suggestions (#325)"
```

---

### Task 5: review-queue UI section + document-page relations panel

**Files:**
- Create: `src/app/admin/components/RelationsPanel.tsx`
- Modify: `src/app/admin/review/page.tsx` (add "Translation suggestions" section under the existing queue)
- Modify: `src/app/admin/documents/[id]/page.tsx` (mount `<RelationsPanel docId={id} />`)
- Test: `src/__tests__/relations-panel.test.tsx`

**Interfaces:**
- Consumes: Task 3 endpoints via `adminFetch` (`src/app/admin/lib/api.ts`).
- Produces: `RelationsPanel({ docId?: string })` — with `docId`, shows that doc's confirmed/suggested relations plus a manual-link form; without `docId`, shows all pending suggestions (review-queue usage).

- [ ] **Step 1: Write the failing component test** — follow `src/__tests__/admin-review-page.test.tsx` conventions (jsdom, mock `adminFetch`). Cases: renders a suggestion row with both titles, languages, and signal chips (`title 0.98`, `embed 0.72`, `language mismatch`); clicking Confirm PATCHes `{action:'confirm'}`; clicking "Not a pair" PATCHes `{action:'reject'}`; clicking the direction arrow PATCHes `{action:'flip'}`; confirmed row shows Unlink.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- relations-panel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RelationsPanel`** (client component, same styling primitives as `review/page.tsx`: `cell`, `actionButton`, `StatusChip`, `Flash`):

Layout per suggestion row:

```
[zh] 抓住中国城市机遇… (2021_seizing…_00015)   ← original
  ⇅ flip
[en] Seizing China's Urban Opportunity (2021_seizing…_9025)   ← translation
signals: title 0.98 · embed 0.73 · language mismatch (stamped zh, text en)
[Confirm pair] [Not a pair]        suggested by system · confidence 0.98
```

Behavior: load with `adminFetch<{relations: RelationRow[]}>('/api/admin/relations?status=suggested')` (plus `status=confirmed` filtered client-side by `docId` when mounted on a doc page); each action PATCHes then refetches; errors surface through `Flash` exactly like the review page's `act()` handler. The manual-link form (doc page only) is a text input for the counterpart's external id + "Link as translation of this document" / "Link as original of this document" radio, POSTing to `/api/admin/relations` (resolve external id → uuid via the existing admin documents search endpoint used by `admin/documents/page.tsx`; check its path there).

Orphan warning (spec §6): when the panel's doc is the **original** of a confirmed edge, render a persistent note above the relation list — `Withdrawing this document also removes its linked translation from results (the pair is one work).` — so the withdraw decision is made with the link in view. Add a test case asserting the note renders for originals with a confirmed edge and not otherwise.

In `review/page.tsx`, under the existing queue table add:

```tsx
<Heading as="h2" size="md" mt={8} mb={2}>Translation suggestions</Heading>
<RelationsPanel />
```

and show `health.pendingRelationSuggestions` / `health.confirmedTranslationPairs` alongside the existing health stats.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- relations-panel.test.tsx`
Expected: PASS. Also run `npm test -- admin-review-page.test.tsx` — the existing page test must still pass (mock the new fetch).

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/components/RelationsPanel.tsx src/app/admin/review/page.tsx "src/app/admin/documents/[id]/page.tsx" src/__tests__/relations-panel.test.tsx
git commit -m "feat: translation-pair review UI (#325)"
```

---

### Task 6: worker suggestion module `relate.py`

**Files:**
- Create: `search-service/worker/relate.py`
- Modify: `search-service/app/config.py` (thresholds)
- Test: `search-service/tests/test_relate.py`

**Interfaces:**
- Consumes: `document_relations` (Task 1), `worker.stages.language.detect(text: str) -> str`, summary chunks (`document_chunks.unit_type = 'summary'`).
- Produces:
  - `normalize_title(s: str | None) -> str`
  - `title_similarity(a, b) -> float`
  - `score_pair(doc_a: dict, doc_b: dict, embed_sim: float | None, title_thr: float, embed_thr: float) -> dict | None` — pure; returns the signals dict (with `trigger`, `title_similarity`, `embedding_similarity`, `language_disagreement`, `direction_proposed`) or None if no trigger fires. Each doc dict: `{id, external_id, title_en, title, language, metadata_source, detected_language}`.
  - `suggest_for_document(conn, document_id) -> int` — inserts suggested rows for one doc against the active corpus; returns rows inserted.
- Config: `relation_title_threshold: float = 0.75`, `relation_embed_threshold: float = 0.85` in `Settings`.

- [ ] **Step 1: Write the failing tests** (pure functions — no DB):

```python
from worker.relate import normalize_title, title_similarity, score_pair


def _doc(ext, title_en, lang, detected, msrc=None):
    return {"id": ext, "external_id": ext, "title": title_en, "title_en": title_en,
            "language": lang, "metadata_source": msrc or {}, "detected_language": detected}


def test_normalize_title_strips_punctuation_and_case():
    assert normalize_title("Seizing China’s Urban Opportunity!") == normalize_title("seizing chinas urban opportunity")


def test_title_similarity_exact_after_normalization():
    assert title_similarity("Motorcycle Safety: Urban Road Design", "motorcycle safety — urban road design") == 1.0


def test_title_trigger_fires_and_directs_non_english_as_original():
    a = _doc("en_doc", "Rail Plus Property Development in China", "en", "en")
    b = _doc("zh_doc", "Rail Plus Property Development in China", "zh", "zh")
    s = score_pair(a, b, embed_sim=0.66, title_thr=0.75, embed_thr=0.85)
    assert s["trigger"] == "title"
    assert s["direction_proposed"] is True
    assert s["translation_id"] == "en_doc" and s["original_id"] == "zh_doc"


def test_same_detected_language_proposes_no_direction():
    a = _doc("a", "Assessing Low-Carbon Strategies", "zh", "en")
    b = _doc("b", "Assessing Low-Carbon Strategies", "zh", "en")
    s = score_pair(a, b, embed_sim=0.7, title_thr=0.75, embed_thr=0.85)
    assert s["direction_proposed"] is False


def test_embed_trigger_fires_without_title_match():
    a = _doc("a", "Dataset of School Bus Depots", "en", "en")
    b = _doc("b", "Completely Different Name", "en", "en")
    s = score_pair(a, b, embed_sim=0.95, title_thr=0.75, embed_thr=0.85)
    assert s["trigger"] == "embedding"


def test_no_trigger_returns_none():
    a = _doc("a", "Urban Water Report", "en", "en")
    b = _doc("b", "Forest Finance Study", "en", "en")
    assert score_pair(a, b, embed_sim=0.4, title_thr=0.75, embed_thr=0.85) is None


def test_language_disagreement_recorded():
    a = _doc("a", "Seizing China's Urban Opportunity", "zh", "en",
             msrc={"language": "human"})
    b = _doc("b", "Seizing China's Urban Opportunity", "zh", "zh")
    s = score_pair(a, b, embed_sim=0.72, title_thr=0.75, embed_thr=0.85)
    assert s["language_disagreement"] == [{"external_id": "a", "stamped": "zh", "detected": "en"}]
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_relate.py -v`
Expected: FAIL — ModuleNotFoundError.

- [ ] **Step 3: Implement `worker/relate.py`**

```python
"""Translation-pair suggestion generation (issue #325).

Directed edges: document_id = translation/rendition, related_document_id =
original. This module only INSERTs source='system', status='suggested' rows
and never touches human-reviewed rows (document_tags precedence pattern).
Trigger priority measured on qa 2026-08-13: title similarity is primary
(known pairs' embedding cosines 0.63-0.76 sit BELOW related-but-distinct
docs at 0.85-0.95, so embedding alone cannot distinguish a translation from
a revised edition — it is the secondary, high-bar trigger only).
"""
import logging
import re
from difflib import SequenceMatcher

from psycopg.types.json import Jsonb

from app.config import get_settings

logger = logging.getLogger(__name__)

_NORM_RE = re.compile(r"[^a-z0-9一-鿿]+")


def normalize_title(s):
    return " ".join(_NORM_RE.sub(" ", (s or "").lower()).split())


def title_similarity(a, b):
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()


def _disagreements(*docs):
    out = []
    for d in docs:
        stamped = d.get("language")
        detected = d.get("detected_language")
        human = (d.get("metadata_source") or {}).get("language") == "human"
        if human and stamped and detected and stamped != detected:
            out.append({"external_id": d["external_id"], "stamped": stamped, "detected": detected})
    return out


def score_pair(doc_a, doc_b, embed_sim, title_thr, embed_thr):
    """Pure scoring: returns the signals dict for a suggestion, or None."""
    t = title_similarity(doc_a.get("title_en") or doc_a.get("title"),
                         doc_b.get("title_en") or doc_b.get("title"))
    e = embed_sim if embed_sim is not None else 0.0
    if t >= title_thr:
        trigger = "title"
    elif e >= embed_thr:
        trigger = "embedding"
    else:
        return None

    la, lb = doc_a.get("detected_language"), doc_b.get("detected_language")
    if la == "en" and lb and lb != "en":
        translation, original, directed = doc_a, doc_b, True
    elif lb == "en" and la and la != "en":
        translation, original, directed = doc_b, doc_a, True
    else:
        translation, original, directed = doc_a, doc_b, False

    return {
        "trigger": trigger,
        "title_similarity": round(t, 4),
        "embedding_similarity": round(e, 4) if embed_sim is not None else None,
        "language_disagreement": _disagreements(doc_a, doc_b),
        "direction_proposed": directed,
        "translation_id": translation["id"],
        "original_id": original["id"],
    }
```

DB half (same file):

```python
_ACTIVE_DOCS_SQL = """
    SELECT d.id, d.external_id, d.title, d.title_en, d.language, d.metadata_source
    FROM documents d
    WHERE d.status <> 'withdrawn' AND d.id <> %s
"""

_EMBED_SIM_SQL = """
    SELECT db.id,
           1 - (sa.embedding::vector(1536) <=> sb.embedding::vector(1536)) AS sim
    FROM document_chunks sa
    JOIN documents da ON da.id = sa.document_id
    JOIN document_chunks sb ON sb.unit_type = 'summary'
                           AND sb.embedding_model = sa.embedding_model
    JOIN documents db ON db.id = sb.document_id
    WHERE sa.document_id = %s AND sa.unit_type = 'summary'
      AND db.id <> %s AND db.status <> 'withdrawn'
"""

_PAIR_EXISTS_SQL = """
    SELECT 1 FROM document_relations
    WHERE LEAST(document_id::text, related_document_id::text) = LEAST(%s::text, %s::text)
      AND GREATEST(document_id::text, related_document_id::text) = GREATEST(%s::text, %s::text)
"""


def _detected_language(conn, document_id):
    row = conn.execute(
        "SELECT full_text FROM document_texts WHERE document_id = %s", (document_id,)
    ).fetchone()
    if row is None or not row[0]:
        return None
    from worker.stages.language import detect
    return detect(row[0])


def suggest_for_document(conn, document_id) -> int:
    settings = get_settings()
    me_row = conn.execute(
        """SELECT id, external_id, title, title_en, language, metadata_source
           FROM documents WHERE id = %s""", (document_id,)).fetchone()
    if me_row is None:
        return 0
    cols = ["id", "external_id", "title", "title_en", "language", "metadata_source"]
    me = dict(zip(cols, me_row))
    me["detected_language"] = _detected_language(conn, document_id)

    sims = {r[0]: float(r[1]) for r in conn.execute(_EMBED_SIM_SQL, (document_id, document_id))}
    others = [dict(zip(cols, r)) for r in conn.execute(_ACTIVE_DOCS_SQL, (document_id,))]

    inserted = 0
    for other in others:
        # Cheap pre-screen: only detect the counterpart's text language when a
        # trigger could fire (title close or embedding high).
        t = title_similarity(me.get("title_en") or me.get("title"),
                             other.get("title_en") or other.get("title"))
        e = sims.get(other["id"])
        if t < settings.relation_title_threshold and (e or 0.0) < settings.relation_embed_threshold:
            continue
        if conn.execute(_PAIR_EXISTS_SQL,
                        (me["id"], other["id"], me["id"], other["id"])).fetchone():
            continue
        other["detected_language"] = _detected_language(conn, other["id"])
        signals = score_pair(me, other, e,
                             settings.relation_title_threshold,
                             settings.relation_embed_threshold)
        if signals is None:
            continue
        translation_id = signals.pop("translation_id")
        original_id = signals.pop("original_id")
        confidence = max(signals["title_similarity"], signals["embedding_similarity"] or 0.0)
        conn.execute(
            """INSERT INTO document_relations
               (document_id, related_document_id, source, status, confidence, signals)
               VALUES (%s, %s, 'system', 'suggested', %s, %s)
               ON CONFLICT DO NOTHING""",
            (translation_id, original_id, confidence, Jsonb(signals)))
        inserted += 1
    return inserted
```

Add to `Settings` in `app/config.py` (next to `sparse_en_handles`):

```python
    # Translation-pair suggestion thresholds (issue #325). Title is the primary
    # trigger; embedding is a high-bar secondary for retitled near-duplicates.
    # Measured on qa 2026-08-13: known pairs' embedding cosines span 0.63-0.76
    # while revised editions/country series reach 0.85-0.95.
    relation_title_threshold: float = 0.75
    relation_embed_threshold: float = 0.85
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_relate.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add search-service/worker/relate.py search-service/app/config.py search-service/tests/test_relate.py
git commit -m "feat: worker translation-pair suggestion scoring (#325)"
```

---

### Task 7: publish-stage hook

**Files:**
- Modify: `search-service/worker/stages/publish.py`
- Test: extend `search-service/tests/test_worker_stages.py`

**Interfaces:**
- Consumes: `relate.suggest_for_document(conn, document_id)` (Task 6).

- [ ] **Step 1: Write the failing test** — in `test_worker_stages.py`, following its existing publish-stage test setup (fake/monkeypatched conn): assert `worker.relate.suggest_for_document` is called once with the document id during a successful publish run, and that a raised exception from it does NOT fail the stage (monkeypatch it to raise; publish still returns its normal value).

- [ ] **Step 2: Run to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v -k relate`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `publish.py` `run()`, after the `audit_system_event(...)` call and before the confidence-gate returns (so suggestions exist even for docs parked at needs_review):

```python
        try:
            from worker import relate
            n = relate.suggest_for_document(conn, document_id)
            if n:
                logger.info(f"{doc['external_id']}: {n} translation-pair suggestion(s) queued")
        except Exception:  # noqa: BLE001 — suggestions are advisory, never a pipeline invariant
            logger.warning(f"{doc['external_id']}: relation suggestions failed (non-fatal)", exc_info=True)
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_worker_stages.py -v`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add search-service/worker/stages/publish.py search-service/tests/test_worker_stages.py
git commit -m "feat: suggest translation pairs at end of ingestion (#325)"
```

---

### Task 8: corpus sweep script

**Files:**
- Create: `search-service/scripts/sweep_translation_pairs.py`
- Test: `search-service/tests/test_sweep_translation_pairs.py`

**Interfaces:**
- Consumes: `relate.suggest_for_document` (Task 6).
- Produces: `python -m scripts.sweep_translation_pairs` (dry-run default, `--execute` to write). Re-runnable: existing pairs are skipped inside `suggest_for_document`.

- [ ] **Step 1: Write the failing test** — mirror `tests/test_backfill_content_hash_script.py`'s structure: monkeypatch `get_pool`/DB access; assert dry-run calls score paths but performs no INSERT; assert `--execute` iterates every active doc id through `suggest_for_document`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sweep_translation_pairs.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** — same skeleton as `scripts/backfill_content_hash.py` (env loading, argparse, dry-run default, `--limit`):

```python
"""Sweep the corpus for translation-pair suggestions (issue #325).

Idempotent: pairs with ANY existing document_relations row (suggested,
confirmed, or rejected) are skipped, so re-running after threshold changes
only surfaces new candidates. DRY RUN IS THE DEFAULT; pass --execute to
write suggestion rows.

Run: cd search-service && ./venv/bin/python -m scripts.sweep_translation_pairs
     cd search-service && ./venv/bin/python -m scripts.sweep_translation_pairs --execute
"""
import argparse
import logging

from app.env import load_env

load_env()

from app.db import get_pool  # noqa: E402
from worker import relate  # noqa: E402

logger = logging.getLogger(__name__)


def run(execute=False, limit=None) -> int:
    with get_pool().connection() as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT id FROM documents WHERE status <> 'withdrawn' ORDER BY created_at")]
    if limit:
        ids = ids[:limit]
    total = 0
    with get_pool().connection() as conn:
        for doc_id in ids:
            if execute:
                total += relate.suggest_for_document(conn, doc_id)
                conn.commit()
            else:
                total += relate.count_candidates(conn, doc_id)
    verb = "inserted" if execute else "would suggest (dry run; --execute to write)"
    print(f"{len(ids)} documents swept; {total} suggestion(s) {verb}")
    return total
```

Add `count_candidates(conn, document_id) -> int` to `relate.py`: identical loop to `suggest_for_document` but returns the would-insert count instead of executing INSERTs (factor the shared candidate iteration into a private `_candidates(conn, me)` generator both call, so the two cannot drift).

`main()`/`_parse_args` copied from `backfill_content_hash.py` with the `--ids` flag dropped and `--execute`/`--limit` kept.

- [ ] **Step 4: Run to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_sweep_translation_pairs.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add search-service/scripts/sweep_translation_pairs.py search-service/tests/test_sweep_translation_pairs.py search-service/worker/relate.py
git commit -m "feat: re-runnable corpus sweep for translation pairs (#325)"
```

---

### Task 9: search-service pairs loader + flag

**Files:**
- Create: `search-service/app/translation_pairs.py`
- Modify: `search-service/app/config.py`
- Test: `search-service/tests/test_translation_pairs.py`

**Interfaces:**
- Produces: `load_confirmed_pairs() -> dict[str, dict]` mapping translation `external_id` → `{"original": <original external_id>, "original_title": <COALESCE(title_en,title)>, "original_searchable": bool}`. Returns `{}` when the flag is off or the table is empty.
- Config: `translation_pairs_enabled: bool = False`.

- [ ] **Step 1: Write the failing test** — follow `tests/test_pg_store.py`'s DB-fake conventions (monkeypatch `get_pool`): flag off → `{}` without querying; flag on → returns the mapped dict from a faked result set; original with `status='withdrawn'` → `original_searchable` False.

- [ ] **Step 2: Run to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_translation_pairs.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

```python
"""Confirmed translation-pair lookup for query-time filtering (issue #325).

Only status='confirmed', relation_type='translation_of' edges matter.
Queried per request when translation_pairs_enabled — one indexed SELECT on a
tiny table — so a DMS confirm/unlink takes effect on the next query with no
reindex. Flag off (the default) short-circuits to {} with zero DB work.
"""
import logging

from app.config import get_settings
from app.db import get_pool

logger = logging.getLogger(__name__)

_PAIRS_SQL = """
    SELECT dt.external_id, do_.external_id,
           COALESCE(do_.title_en, do_.title),
           do_.status = 'searchable'
    FROM document_relations r
    JOIN documents dt ON dt.id = r.document_id
    JOIN documents do_ ON do_.id = r.related_document_id
    WHERE r.status = 'confirmed' AND r.relation_type = 'translation_of'
"""


def load_confirmed_pairs() -> dict:
    if not get_settings().translation_pairs_enabled:
        return {}
    out = {}
    with get_pool().connection() as conn:
        for t_ext, o_ext, o_title, o_searchable in conn.execute(_PAIRS_SQL):
            out[t_ext] = {"original": o_ext, "original_title": o_title,
                          "original_searchable": bool(o_searchable)}
    return out
```

Config addition (next to the Task 6 thresholds):

```python
    # Query-time translation-pair filtering (issue #325). OFF by default:
    # activation is eval-gated (#333) — run cite+answer evals flag-off then
    # flag-on on the same harness before enabling in any environment.
    # Rollback is flag off; no reindex either way.
    translation_pairs_enabled: bool = False
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_translation_pairs.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add search-service/app/translation_pairs.py search-service/app/config.py search-service/tests/test_translation_pairs.py
git commit -m "feat: confirmed-pairs loader behind translation_pairs_enabled flag (#325)"
```

---

### Task 10: answer-mode filter

**Files:**
- Modify: `search-service/app/main.py` (the `/query` handler, next to the existing `cite_doc_ids` filter at ~line 1023)
- Test: `search-service/tests/test_translation_pairs_filter.py`

**Interfaces:**
- Consumes: `load_confirmed_pairs()` (Task 9). Node doc identity is `node.node.metadata["doc_id"]` (= documents.external_id), the same key the `cite_doc_ids` filter uses.

- [ ] **Step 1: Write the failing test** — follow `tests/test_cite_doc_ids_filter.py`'s approach (it exercises this exact filtering region; reuse its request/node fixtures): with pairs `{"t1": {"original": "o1", ...}}` monkeypatched into `app.main.load_confirmed_pairs`, an answer-mode query's fused results drop every node with `doc_id == "t1"` and keep `o1` nodes; with the flag off (loader returns `{}`), nothing is dropped.

- [ ] **Step 2: Run to verify it fails**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_translation_pairs_filter.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** — in the `/query` handler, immediately after the `cite_doc_ids` filter block:

```python
        # Translation pairs (#325): confirmed edges only, flag-gated (Task 9
        # loader returns {} when off). Answer mode: a translation's chunks can
        # never be legitimately cited (citations come from originals), so drop
        # them before rerank. Cite mode consumes the same map at assembly.
        translation_pairs = load_confirmed_pairs()
        if request.mode == "answer" and translation_pairs:
            before_tp = len(stage1_results)
            stage1_results = [n for n in stage1_results
                              if n.node.metadata.get("doc_id") not in translation_pairs]
            logger.info(f"Answer mode: translation-pair filter ({before_tp} -> {len(stage1_results)})")
```

Import at the top of `main.py`: `from app.translation_pairs import load_confirmed_pairs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_translation_pairs_filter.py tests/test_cite_doc_ids_filter.py -v`
Expected: PASS (new + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_translation_pairs_filter.py
git commit -m "feat: answer mode excludes confirmed translations' chunks (#325)"
```

---

### Task 11: cite-mode collapse

**Files:**
- Modify: `search-service/app/main.py` (the cite-mode `doc_groups` block at ~lines 1086-1091)
- Test: extend `search-service/tests/test_translation_pairs_filter.py`

**Interfaces:**
- Consumes: `translation_pairs` local from Task 10.
- Produces (inside existing `metadata` dict only): `has_english_translation: true` on collapsed results; `excerpt_from_translation: true` when the shown text came from the translation.

- [ ] **Step 1: Write the failing tests.** Cases (cite mode, pairs `{"t1": {"original": "o1", "original_title": "Original Title", "original_searchable": True}}`):
  1. Both members hit → one result, `doc_id == "o1"`, original's own text shown even when t1's chunk scored higher, `has_english_translation` true, `excerpt_from_translation` absent.
  2. Only translation hits → one result with `doc_id == "o1"`, `title == "Original Title"`, `excerpt_from_translation` true.
  3. Original withdrawn (`original_searchable` False) and only translation hits → no result for the pair.
  4. Flag off → t1 and o1 appear as two separate results (current behavior preserved).

- [ ] **Step 2: Run to verify they fail**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_translation_pairs_filter.py -v`
Expected: new cases FAIL.

- [ ] **Step 3: Implement** — replace the grouping loop:

```python
            # Group chunks by document and take best scoring chunk per document.
            # Translation pairs (#325): a hit on a confirmed translation is
            # credited to its ORIGINAL. Originals win: when the original also
            # matched, its own best chunk is shown; a translation-only hit is
            # substituted via a COPIED node (legacy in-memory mode shares node
            # objects across requests — never mutate doc_id/title in place).
            doc_groups = {}
            translation_best = {}
            for node in stage2_results:
                # Stale-flag hygiene for shared nodes (same reason as the
                # relevance_tier pop below).
                node.node.metadata.pop("has_english_translation", None)
                node.node.metadata.pop("excerpt_from_translation", None)
                doc_id = node.node.metadata.get("doc_id")
                pair = translation_pairs.get(doc_id)
                if pair is not None:
                    canon = pair["original"]
                    cur = translation_best.get(canon)
                    if cur is None or node.score > cur.score:
                        translation_best[canon] = node
                    continue
                if doc_id not in doc_groups or node.score > doc_groups[doc_id].score:
                    doc_groups[doc_id] = node

            originals_of = {p["original"]: p for p in translation_pairs.values()}
            for canon, tnode in translation_best.items():
                pair = originals_of[canon]
                if canon in doc_groups:
                    doc_groups[canon].node.metadata["has_english_translation"] = True
                    continue
                if not pair["original_searchable"]:
                    continue  # withdrawn original: the work is off the site
                sub = TextNode(
                    id_=tnode.node.node_id,
                    text=tnode.node.text,
                    metadata={**tnode.node.metadata,
                              "doc_id": canon,
                              "title": pair["original_title"],
                              "has_english_translation": True,
                              "excerpt_from_translation": True},
                )
                doc_groups[canon] = NodeWithScore(node=sub, score=tnode.score)
```

(`TextNode` and `NodeWithScore` are already imported in `main.py` via llama_index; verify and add imports if not.) Note: for a substituted node the passage-context lookup falls back to raw chunk text (its text is not in the original's `full_text`) — that is the accepted behavior for translation-only hits.

- [ ] **Step 4: Run to verify they pass**

Run: `cd search-service && ./venv/bin/python -m pytest tests/test_translation_pairs_filter.py tests/test_summary_substitution.py tests/test_query_e2e.py -v`
Expected: PASS (new + the pre-existing cite-assembly tests).

- [ ] **Step 5: Commit**

```bash
git add search-service/app/main.py search-service/tests/test_translation_pairs_filter.py
git commit -m "feat: cite mode collapses translation pairs to the original (#325)"
```

---

### Task 12: clone/parity scripts carry relations

**Files:**
- Modify: `scripts/clone-corpus.sh` (add `document_relations` to `TABLES` after `documents`)
- Modify: `scripts/verify-corpus-parity.sh` (add the table to its comparison set, following how it treats `document_tags`)

**Interfaces:**
- Consumes: the scripts' existing table-at-a-time `pg_dump --data-only` pattern. Document ids are preserved wholesale by the clone, so no external-id remapping is needed. Update the spec's "matched by external_id" sentence in `docs/superpowers/specs/2026-08-13-issue-325-translation-pairs-design.md` §5 to say ids are carried by the wholesale clone.

- [ ] **Step 1: Edit both scripts** — in `clone-corpus.sh`, add `document_relations` to the `TABLES` array directly after `document_summaries` (it references only `documents`, which loads earlier). Mirror the same addition in `verify-corpus-parity.sh`'s table list.

- [ ] **Step 2: Verify by dry run**

Run: `./scripts/clone-corpus.sh qa production --dry-run`
Expected: the table listing now includes `document_relations` with a row count; no writes happen.

- [ ] **Step 3: Commit**

```bash
git add scripts/clone-corpus.sh scripts/verify-corpus-parity.sh docs/superpowers/specs/2026-08-13-issue-325-translation-pairs-design.md
git commit -m "feat: clone/parity scripts carry document_relations (#325)"
```

---

### Task 13: docs + rollout runbook

**Files:**
- Modify: `docs/document-management.md` (new "Translation pairs" section; amend the line-37 "one paper = one original document" note to point at it)
- Modify: `docs/runbooks/qa-push-deploy.md` (rollout steps)

**Interfaces:** none — documentation of Tasks 1-12 as built.

- [ ] **Step 1: Write the document-management.md section.** Cover, in this order, in the file's established terse style: the `document_relations` table and direction convention; the suggested → confirmed/rejected lifecycle and two-writer precedence; suggestion triggers with the measured qa numbers (title ≥ 0.75 primary, embedding ≥ 0.85 secondary, thresholds in Settings); the two mode filters and the `translation_pairs_enabled` flag (default off, no reindex either way); the sweep script invocation; the DMS review surfaces; ownership note (worker inserts suggestions, app tier reviews).

- [ ] **Step 2: Write the rollout steps in qa-push-deploy.md.** Sequence: (1) deploy + `npm run migration:run` (table is inert); (2) run `python -m scripts.sweep_translation_pairs` dry-run then `--execute` on qa; (3) review queue worked in `/admin/review` — the two #332 pairs go to the zh reviewer; (4) eval gate: `npm run eval:cite` and `npm run eval:answer-retrieval` with flag off, then `TRANSLATION_PAIRS_ENABLED=true`, same harness, compare before enabling in the task definition (#333 records the deltas); (5) rollback = unset the flag.

- [ ] **Step 3: Run the full test suites once (cross-cutting check)**

Run: `npm test`
Run: `cd search-service && ./venv/bin/python -m pytest tests/ -v`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add docs/document-management.md docs/runbooks/qa-push-deploy.md
git commit -m "docs: translation pairs as-built + rollout runbook (#325)"
```
