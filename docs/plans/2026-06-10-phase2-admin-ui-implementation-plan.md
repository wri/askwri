# Phase 2 — Admin UI + Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Non-engineers can log in, review documents the ingestion worker flagged (`needs_review` + errored jobs), accept/reject suggested LLM tags with provenance, edit document metadata, withdraw/restore documents (with the BM25 `/reindex` refresh handled), organize documents into collections, and curate the tag taxonomy — all from `/admin` in the existing Next.js app.

**Architecture:** Everything is app-tier (Next.js App Router + TypeORM) per the write-ownership rule — the app owns relational CRUD; the search-service is only POSTed to `/reindex` (existing endpoint). Auth is username/password against the existing `users` table: bcryptjs password hashes, jose-signed JWT in an httpOnly cookie, gated by `src/proxy.ts` (Next 16 middleware convention). New admin API routes live under `/api/admin/*`; pages under `/admin/*`. Every mutation writes an `audit_log` row. **No new migrations** — the Phase 0 schema already has every table this phase needs.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts`), TypeORM 0.3 (new entities for existing tables), `bcryptjs` + `jose` (new deps), Chakra UI v3 + `@worldresources/wri-design-systems` (existing UI stack), Jest (node-env API tests + DATABASE_URL-gated DB tests).

**Spec:** design doc §9 (collections), §13 (admin experience), §17 Phase 2, §18.5 (auth resolved), §20 (lean-core cut) — `docs/plans/2026-06-09-askwri-document-management-design.md`. As-built reference: `docs/document-management.md` (§4 BM25 gotcha, §10 worker semantics, §10.7 taxonomy gate).

---

## Scope decisions (read first)

1. **Auth = real login** against the existing `users` table (admin|editor roles, `password_hash`). Rationale: design §18.5 already resolved this (username/password, no SSO, swappable later); **no lighter gateway exists to hide behind** (no middleware/proxy file in the repo, no ALB auth, `IsQA.tsx` is a cosmetic badge); and `/api/import-documents` is currently an unauthenticated mutation route that needs protection regardless. Implementation: `bcryptjs` (pure JS — no native build step in the Docker image) + `jose` HS256 JWT session cookie. An optional `ADMIN_API_TOKEN` bearer fallback keeps scripted use of `/api/import-documents` working without a browser session.
2. **Collections = minimal IN.** Create/rename/list collections, add/remove documents (from the document editor and bulk from catalog selection), filter the admin catalog by collection. **Deferred:** per-collection bulk ops (re-tag/re-embed/regenerate), language-policy and embedding-model-version editors, visibility/permissions, nested collections, export. The tables exist and one collection is already seeded; plain CRUD is cheap and gives the "manage" value. Bulk ops have no Phase 2 consumer.
3. **Review queue** lists documents with `status IN ('needs_review','error')` plus documents whose latest `ingestion_jobs` row is `status='error'`. Suggested-tag review (accept/reject) lives in the **document editor**, not only the queue — the publish stage promotes docs to `searchable` on extraction confidence alone, so `suggested` LLM tags can exist on searchable documents too.
4. **Trimmed out of Phase 2** (per design §20 + lean-core challenge): hard purge (destructive, needs S3 deletion — defer to Phase 3 lifecycle work), CSV/JSON export, corpus-health dashboard, audit-history **UI** (audit **rows** are written from day one), summary editing/regeneration (display-only in the editor). The drag-drop **upload page is the last task and explicitly cuttable** — S3/local intake drop and the CSV import API already provide intake paths.
5. **Taxonomy curation = capability without the owner decision.** The tags page lists facets/values with usage counts, adds new values (controlled vocabulary grows), and deletes unused values (admin-only). **Rename, merge, and taxonomy-version bumps are deferred until the curation owner is assigned** (open todo, design §18.6 / as-built §10.7) — those operations change retrieval-visible tag semantics and need a policy decision.
6. **BM25 `/reindex` gotcha is handled in both directions.** The BM25 lane is hydrated at boot/`/reindex` from `status='searchable'` rows only; the dense lane filters per-query. So **withdraw** (doc lingers in BM25 until reindex) **and promote** (doc absent from BM25 until reindex) both trigger a best-effort `POST {SEARCH_SERVICE_URL}/reindex` after the status change, mirroring the worker's publish stage. The API response reports whether reindex succeeded; the UI shows an explicit warning on failure ("document remains in/missing from keyword results until reindex or restart").
7. **Tag decision provenance:** accepting/rejecting an LLM tag sets `status` AND `source='human'` (keeping `confidence`/`model_version` from the LLM run, with the full prior row in the audit `before`). Rationale: the worker's classify stage only guarantees it never touches `source='human'|'external'` rows — leaving `source='llm'` would let a future re-classify overwrite a human decision. "Human decisions are immutable to automation" (design §4.6) wins over raw origin-tracking; origin is preserved in `audit_log` and `model_version`.
8. **Role split:** `editor` can do review-queue promote, metadata edits, tag decisions, add accepted human tags, collections CRUD/membership, taxonomy add, upload. `admin` additionally: **withdraw** (takedown ≈ delete per design §13's "no delete" for editors), taxonomy value deletion, and user management. `ADMIN_API_TOKEN` bearer calls act as admin with `audit_log.source='system'`, `actor_user_id=NULL`.
9. **No schema changes.** All six new TypeORM entities map tables created in migration `1781280000000`. No new indexes at 169-doc scale.
10. **`/query` contract untouched.** Nothing in `search-service/` changes.

## Human gates (proceed with defaults, flag in PR)

- **`SESSION_SECRET`** (≥32 chars) must be generated and added to `.env` locally and to the app-tier secret JSON (GitHub secret → `app_secret_environment_variables`) before deploy. Same for optional `ADMIN_API_TOKEN`.
- **First admin user** is seeded by `npm run seed:admin -- <username> <password>` (Task 6) — an operator step, not a migration.
- **Taxonomy owner still unassigned** — the UI ships add/list/delete-unused only (decision 5).

## Key facts (verified — do not re-derive)

| Fact | Value |
|---|---|
| `users` schema | `id uuid, username text UNIQUE NOT NULL, email text, password_hash text NOT NULL, role text DEFAULT 'editor', active bool DEFAULT true, last_login timestamptz, created_at` |
| `tags` schema | `id uuid, facet text, value_id text, taxonomy_version text DEFAULT 'v1'`, UNIQUE `(facet, value_id, taxonomy_version)` |
| `document_tags` schema | PK `(document_id, tag_id)`, `source text NOT NULL`, `confidence numeric`, `model_version text`, `status text DEFAULT 'accepted'`, `created_at` |
| `collections` schema | `id, name, slug UNIQUE, description, owner, visibility DEFAULT 'internal', language_policy jsonb, embedding_model_version, created_at, updated_at` |
| `audit_log` schema | `id bigserial, actor_user_id uuid NULL, source, action, entity_type, entity_id uuid NULL, before jsonb, after jsonb, at DEFAULT now()` |
| Worker classify semantics | writes `document_tags` `source='llm'`; `status='accepted'` if confidence ≥ 0.7 else `'suggested'`; never touches `source='human'|'external'` rows |
| Worker publish gate | `extraction_confidence < 0.7` → doc `needs_review`; else `searchable` + best-effort `POST /reindex` |
| `/reindex` | existing search-service endpoint; synchronous; postgres mode re-reads chunks + rebuilds BM25 (no re-embedding) |
| Next 16 middleware | file is `src/proxy.ts`, must export function named `proxy` (or default); `middleware.ts` still works but is the deprecated name. Route-handler `params` are Promises; `cookies()` is async |
| Existing route pattern | `route.ts` → `initializeDatabase()` → fn in `src/db/queries/*` → `NextResponse.json({ ok, ... })`; errors `{ ok:false, error }` |
| Entity registration | add each entity to `entities:[...]` in **both** `src/db/data-source.ts` and `src/db/migration-data-source.ts` |
| Test pattern | `/** @jest-environment node */`; pure-function unit tests + DB integration tests gated on `process.env.DATABASE_URL` (`describe.skip` style of `import-documents.test.ts`); `npm run test:db` points at local docker |
| UI idiom | `'use client'` components; Chakra primitives (`Heading`, `Card`, `Text`) + `@worldresources/wri-design-systems` (`Button`, `Toast`, `AlertBanner`); inline styles; plain HTML where convenient |
| PDF serving today | `/api/pdf/[filename]` reads local `/tmp/askWRI_docs` only — worker-ingested docs live in S3, hence the new admin file route (Task 13) |
| App-tier S3 pattern | `src/lib/eval-storage.ts`: `new S3Client({})` with ambient credentials |
| Local DB state (docker `askwri-pg`, db `qa`) | 169 docs / 30,526 chunks, **1 collection, 0 users, 0 needs_review docs, 0 suggested tags, 0 jobs** → manual QA needs the fixture in the Appendix |
| Deploy env plumbing | app env vars from `var.app_environment_variables` / secret JSON in `terraform/infrastructure/ecs.tf` — adding `SESSION_SECRET` is a secret-JSON change, **no terraform code change** |
| Branch | work on `phase2-admin-ui` off local `qa`; do **not** push `qa` |

## File map

**Create — entities/queries/lib:**
`src/db/entities/{User,Tag,DocumentTag,Collection,DocumentCollection,AuditLog}.entity.ts`,
`src/db/queries/{users,audit,reviewQueue,documentsAdmin,tagsAdmin,collectionsAdmin}.ts`,
`src/lib/auth/{session,identity}.ts`, `src/lib/search-reindex.ts`, `src/proxy.ts`, `scripts/seed-admin.ts`

**Create — API routes (`src/app/api/admin/`):**
`auth/login/route.ts`, `auth/logout/route.ts`, `auth/me/route.ts`,
`review-queue/route.ts`,
`documents/route.ts`, `documents/[id]/route.ts`, `documents/[id]/status/route.ts`, `documents/[id]/reingest/route.ts`, `documents/[id]/tags/route.ts`, `documents/[id]/tags/[tagId]/route.ts`, `documents/[id]/file/route.ts`,
`tags/route.ts`, `tags/[id]/route.ts`,
`collections/route.ts`, `collections/[id]/route.ts`, `collections/[id]/documents/route.ts`,
`users/route.ts`, `users/[id]/route.ts`,
`intake/route.ts` *(cuttable Task 19)*

**Create — pages (`src/app/admin/`):**
`layout.tsx`, `lib/api.ts`, `login/page.tsx`, `page.tsx` (redirect), `review/page.tsx`, `documents/page.tsx`, `documents/[id]/page.tsx`, `collections/page.tsx`, `tags/page.tsx`, `users/page.tsx`, `upload/page.tsx` *(cuttable)*

**Create — tests (`src/__tests__/`):**
`admin-session.test.ts`, `admin-identity.test.ts`, `admin-proxy.test.ts`, `admin-auth-routes.test.ts`, `admin-review-queue.db.test.ts`, `admin-documents.db.test.ts`, `admin-tags.db.test.ts`, `admin-collections.db.test.ts`

**Modify:** `package.json` (deps + `seed:admin` script), `.env.example`, `src/db/data-source.ts`, `src/db/migration-data-source.ts`, `docs/document-management.md` (Phase 2 as-built section, Task 20), `docs/runbooks/phase0-cutover.md` (admin setup section, Task 20)

---

### Task 1: Dependencies + env scaffolding

**Files:** Modify `package.json`, `.env.example`.

- [x] **Step 1:** Create the working branch:

```bash
git checkout -b phase2-admin-ui qa
```

- [x] **Step 2:** Install runtime deps (jose for edge-compatible JWT in `proxy.ts`; bcryptjs is pure JS so the Docker build needs no native toolchain):

```bash
npm install bcryptjs jose
```

```bash
npm install --save-dev @types/bcryptjs
```

- [x] **Step 3:** Append to `.env.example`:

```bash
# --- Phase 2 admin UI ---
# Session signing secret for /admin login (>= 32 chars). Generate: openssl rand -hex 32
SESSION_SECRET=
# Optional: bearer token that lets scripts call /api/import-documents and /api/admin/*
# without a browser session (acts as admin, audited as source='system').
ADMIN_API_TOKEN=
```

- [x] **Step 4:** Add the seed script entry to `package.json` `scripts` (script file arrives in Task 6):

```json
"seed:admin": "npx tsx --env-file-if-exists=.env scripts/seed-admin.ts"
```

- [x] **Step 5:** Generate a local `SESSION_SECRET` and add it to your `.env` (not committed):

```bash
openssl rand -hex 32
```

- [x] **Step 6:** Commit:

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add bcryptjs/jose deps and admin env scaffolding (Phase 2)"
```

---

### Task 2: TypeORM entities for the Phase 0 tables

**Files:** Create the six entity files; modify `src/db/data-source.ts`, `src/db/migration-data-source.ts`. Test: `src/__tests__/admin-entities.db.test.ts`.

All tables already exist (migration `1781280000000`) — these entities only map them. Follow `Document.entity.ts` style: snake_case via `name:`, no relations decorators (keep raw FKs as columns; joins are SQL in queries).

- [x] **Step 1:** Create `src/db/entities/User.entity.ts`:

```typescript
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text', { unique: true })
  username!: string

  @Column('text', { nullable: true })
  email!: string | null

  @Column('text', { name: 'password_hash' })
  passwordHash!: string

  @Column('text', { default: 'editor' })
  role!: string

  @Column('boolean', { default: true })
  active!: boolean

  @Column('timestamptz', { name: 'last_login', nullable: true })
  lastLogin!: Date | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
```

- [x] **Step 2:** Create `src/db/entities/Tag.entity.ts`:

```typescript
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('tags')
export class Tag {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text')
  facet!: string

  @Column('text', { name: 'value_id' })
  valueId!: string

  @Column('text', { name: 'taxonomy_version', default: 'v1' })
  taxonomyVersion!: string
}
```

- [x] **Step 3:** Create `src/db/entities/DocumentTag.entity.ts`:

```typescript
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity('document_tags')
export class DocumentTag {
  @PrimaryColumn('uuid', { name: 'document_id' })
  documentId!: string

  @PrimaryColumn('uuid', { name: 'tag_id' })
  tagId!: string

  @Column('text')
  source!: string

  @Column('numeric', { nullable: true })
  confidence!: string | null

  @Column('text', { name: 'model_version', nullable: true })
  modelVersion!: string | null

  @Column('text', { default: 'accepted' })
  status!: string

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date
}
```

- [x] **Step 4:** Create `src/db/entities/Collection.entity.ts`:

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm'

@Entity('collections')
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column('text')
  name!: string

  @Column('text', { unique: true })
  slug!: string

  @Column('text', { nullable: true })
  description!: string | null

  @Column('text', { nullable: true })
  owner!: string | null

  @Column('text', { default: 'internal' })
  visibility!: string

  @Column('jsonb', { name: 'language_policy', nullable: true })
  languagePolicy!: Record<string, any> | null

  @Column('text', { name: 'embedding_model_version', nullable: true })
  embeddingModelVersion!: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date
}
```

- [x] **Step 5:** Create `src/db/entities/DocumentCollection.entity.ts`:

```typescript
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

@Entity('document_collections')
export class DocumentCollection {
  @PrimaryColumn('uuid', { name: 'document_id' })
  documentId!: string

  @PrimaryColumn('uuid', { name: 'collection_id' })
  collectionId!: string

  @Column('text', { name: 'added_by', nullable: true })
  addedBy!: string | null

  @CreateDateColumn({ name: 'added_at', type: 'timestamptz' })
  addedAt!: Date
}
```

- [x] **Step 6:** Create `src/db/entities/AuditLog.entity.ts`:

```typescript
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm'

@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string

  @Column('uuid', { name: 'actor_user_id', nullable: true })
  actorUserId!: string | null

  @Column('text')
  source!: string

  @Column('text')
  action!: string

  @Column('text', { name: 'entity_type' })
  entityType!: string

  @Column('uuid', { name: 'entity_id', nullable: true })
  entityId!: string | null

  @Column('jsonb', { nullable: true })
  before!: Record<string, any> | null

  @Column('jsonb', { nullable: true })
  after!: Record<string, any> | null

  @CreateDateColumn({ name: 'at', type: 'timestamptz' })
  at!: Date
}
```

- [x] **Step 7:** Register all six entities in `src/db/data-source.ts` AND `src/db/migration-data-source.ts` (import each, append to the `entities:` array after `IngestionJob`).

- [x] **Step 8:** Create `src/__tests__/admin-entities.db.test.ts` — a DATABASE_URL-gated smoke test that each entity round-trips against the real schema:

```typescript
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { Tag } from '@/db/entities/Tag.entity'
import { AuditLog } from '@/db/entities/AuditLog.entity'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('admin entities (DB integration)', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('users entity maps the table', async () => {
    const repo = AppDataSource.getRepository(User)
    const u = await repo.save(
      repo.create({ username: `t_${Date.now()}`, passwordHash: 'x', role: 'editor' }),
    )
    expect(u.id).toBeTruthy()
    expect(u.active).toBe(true)
    await repo.delete(u.id)
  })

  it('tags entity reads seeded taxonomy', async () => {
    const tags = await AppDataSource.getRepository(Tag).find({ take: 5 })
    expect(tags.length).toBeGreaterThan(0)
    expect(tags[0].facet).toBeTruthy()
  })

  it('audit_log entity inserts', async () => {
    const repo = AppDataSource.getRepository(AuditLog)
    const row = await repo.save(
      repo.create({
        actorUserId: null,
        source: 'system',
        action: 'create',
        entityType: 'test',
        entityId: null,
        before: null,
        after: { ok: true },
      }),
    )
    expect(row.id).toBeTruthy()
    await repo.delete(row.id)
  })
})
```

- [x] **Step 9:** Run and verify:

```bash
npm run test:db -- --testPathPattern='admin-entities'
```

Expected: 3 passing (against docker `askwri-pg`).

- [x] **Step 10:** Run `npm test` (full suite, db tests skip) and `npm run lint`. Expected: green.

- [x] **Step 11:** Commit:

```bash
git add src/db/entities src/db/data-source.ts src/db/migration-data-source.ts src/__tests__/admin-entities.db.test.ts
git commit -m "feat: TypeORM entities for users/tags/collections/audit_log (Phase 2)"
```

---

### Task 3: Session library (sign/verify JWT cookie)

**Files:** Create `src/lib/auth/session.ts`. Test: `src/__tests__/admin-session.test.ts`.

- [x] **Step 1:** Write the failing test `src/__tests__/admin-session.test.ts`:

```typescript
/** @jest-environment node */
import { signSession, verifySession, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
})

describe('session sign/verify', () => {
  const payload = { userId: 'u-1', username: 'alice', role: 'admin' as const }

  it('round-trips a valid session', async () => {
    const token = await signSession(payload)
    expect(await verifySession(token)).toEqual(payload)
  })

  it('rejects a tampered token', async () => {
    const token = await signSession(payload)
    expect(await verifySession(token.slice(0, -2) + 'xx')).toBeNull()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(payload)
    process.env.SESSION_SECRET = 'another-secret-another-secret-another-00'
    expect(await verifySession(token)).toBeNull()
    process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  })

  it('rejects payloads with unknown roles', async () => {
    const token = await signSession({ ...payload, role: 'root' as any })
    expect(await verifySession(token)).toBeNull()
  })

  it('cookie options are httpOnly + lax', () => {
    const opts = sessionCookieOptions()
    expect(opts.httpOnly).toBe(true)
    expect(opts.sameSite).toBe('lax')
    expect(SESSION_COOKIE).toBe('askwri_session')
  })
})
```

- [x] **Step 2:** Run it; expected FAIL (module not found):

```bash
npm test -- --testPathPattern='admin-session'
```

- [x] **Step 3:** Implement `src/lib/auth/session.ts`:

```typescript
import { SignJWT, jwtVerify } from 'jose'

export interface SessionPayload {
  userId: string
  username: string
  role: 'admin' | 'editor'
}

export const SESSION_COOKIE = 'askwri_session'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and >= 32 chars')
  }
  return new TextEncoder().encode(secret)
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(secretKey())
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey())
    const { userId, username, role } = payload as Record<string, unknown>
    if (typeof userId !== 'string' || typeof username !== 'string') return null
    if (role !== 'admin' && role !== 'editor') return null
    return { userId, username, role }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  }
}
```

- [x] **Step 4:** Run the test again; expected PASS. Commit:

```bash
git add src/lib/auth/session.ts src/__tests__/admin-session.test.ts
git commit -m "feat: jose session sign/verify for admin auth"
```

---

### Task 4: Identity helper for route handlers (cookie session or bearer token)

**Files:** Create `src/lib/auth/identity.ts`. Test: `src/__tests__/admin-identity.test.ts`.

- [x] **Step 1:** Write the failing test:

```typescript
/** @jest-environment node */
import { NextRequest } from 'next/server'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'
import { requireIdentity } from '@/lib/auth/identity'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-api-token'
})

function reqWith(init?: { cookie?: string; bearer?: string }) {
  const headers = new Headers()
  if (init?.cookie) headers.set('cookie', `${SESSION_COOKIE}=${init.cookie}`)
  if (init?.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
  return new NextRequest('http://localhost/api/admin/test', { headers })
}

describe('requireIdentity', () => {
  it('returns 401 with no credentials', async () => {
    const result = await requireIdentity(reqWith())
    expect(result.response?.status).toBe(401)
  })

  it('accepts a valid session cookie', async () => {
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result = await requireIdentity(reqWith({ cookie: token }))
    expect(result.identity).toEqual({ kind: 'user', userId: 'u1', username: 'a', role: 'editor' })
  })

  it('enforces admin role', async () => {
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const result = await requireIdentity(reqWith({ cookie: token }), 'admin')
    expect(result.response?.status).toBe(403)
  })

  it('accepts the bearer token as admin', async () => {
    const result = await requireIdentity(reqWith({ bearer: 'test-api-token' }), 'admin')
    expect(result.identity).toEqual({ kind: 'token', role: 'admin' })
  })

  it('rejects a wrong bearer token', async () => {
    const result = await requireIdentity(reqWith({ bearer: 'nope' }))
    expect(result.response?.status).toBe(401)
  })
})
```

- [x] **Step 2:** Run; expected FAIL. Implement `src/lib/auth/identity.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from './session'

export type AdminIdentity =
  | { kind: 'user'; userId: string; username: string; role: 'admin' | 'editor' }
  | { kind: 'token'; role: 'admin' }

export interface IdentityResult {
  identity?: AdminIdentity
  response?: NextResponse
}

export async function getIdentity(req: NextRequest): Promise<AdminIdentity | null> {
  const apiToken = process.env.ADMIN_API_TOKEN
  const bearer = req.headers.get('authorization')
  if (apiToken && bearer === `Bearer ${apiToken}`) {
    return { kind: 'token', role: 'admin' }
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await verifySession(token)
  if (!session) return null
  return { kind: 'user', ...session }
}

/**
 * Route-handler guard. Usage:
 *   const { identity, response } = await requireIdentity(req, 'admin')
 *   if (response) return response
 */
export async function requireIdentity(
  req: NextRequest,
  role?: 'admin',
): Promise<IdentityResult> {
  const identity = await getIdentity(req)
  if (!identity) {
    return {
      response: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
    }
  }
  if (role === 'admin' && identity.role !== 'admin') {
    return {
      response: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }),
    }
  }
  return { identity }
}

/** Map an identity to audit_log actor fields. */
export function auditActor(identity: AdminIdentity): {
  actorUserId: string | null
  source: 'human' | 'system'
} {
  return identity.kind === 'user'
    ? { actorUserId: identity.userId, source: 'human' }
    : { actorUserId: null, source: 'system' }
}
```

- [x] **Step 3:** Run; expected PASS. Commit:

```bash
git add src/lib/auth/identity.ts src/__tests__/admin-identity.test.ts
git commit -m "feat: requireIdentity route guard (session cookie or bearer token)"
```

---

### Task 5: `src/proxy.ts` — gate /admin pages and admin APIs

**Files:** Create `src/proxy.ts`. Test: `src/__tests__/admin-proxy.test.ts`.

Next 16 convention: the file is `src/proxy.ts` and must export a function named `proxy` (verified in `node_modules/next/dist/build/templates/middleware.js`). It runs before route handlers; jose verification works in this runtime. No DB access here — signature check only; role checks stay in route handlers.

- [x] **Step 1:** Write the failing test:

```typescript
/** @jest-environment node */
import { NextRequest } from 'next/server'
import { signSession, SESSION_COOKIE } from '@/lib/auth/session'
import { proxy } from '@/proxy'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  process.env.ADMIN_API_TOKEN = 'test-api-token'
})

function req(path: string, init?: { cookie?: string; bearer?: string }) {
  const headers = new Headers()
  if (init?.cookie) headers.set('cookie', `${SESSION_COOKIE}=${init.cookie}`)
  if (init?.bearer) headers.set('authorization', `Bearer ${init.bearer}`)
  return new NextRequest(`http://localhost${path}`, { headers })
}

describe('proxy auth gate', () => {
  it('redirects unauthenticated /admin pages to /admin/login', async () => {
    const res = await proxy(req('/admin/review'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/admin/login')
  })

  it('returns 401 JSON for unauthenticated admin APIs', async () => {
    const res = await proxy(req('/api/admin/review-queue'))
    expect(res.status).toBe(401)
  })

  it('lets /admin/login through without a session', async () => {
    const res = await proxy(req('/admin/login'))
    expect(res.status).toBe(200)
  })

  it('lets a valid session through', async () => {
    const token = await signSession({ userId: 'u1', username: 'a', role: 'editor' })
    const res = await proxy(req('/admin/review', { cookie: token }))
    expect(res.status).toBe(200)
  })

  it('lets the bearer token through on /api/import-documents', async () => {
    const res = await proxy(req('/api/import-documents', { bearer: 'test-api-token' }))
    expect(res.status).toBe(200)
  })
})
```

- [x] **Step 2:** Run; expected FAIL. Implement `src/proxy.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

const PUBLIC_PATHS = new Set(['/admin/login', '/api/admin/auth/login'])

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  const apiToken = process.env.ADMIN_API_TOKEN
  if (apiToken && req.headers.get('authorization') === `Bearer ${apiToken}`) {
    return NextResponse.next()
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token && (await verifySession(token))) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/admin/login'
  loginUrl.searchParams.set('next', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*', '/api/import-documents'],
}
```

- [x] **Step 3:** Run the test; expected PASS. Then verify the build accepts the proxy file:

```bash
npm run build
```

Expected: build succeeds and reports the proxy/middleware bundle.

> **Deviation (verified during implementation):** the default Turbopack `npm run build` panics
> locally on the pre-existing `search-service/venv/bin/python` absolute symlink (Turbopack
> refuses symlinks pointing outside the project root while tracing the catalog route's
> directory reference; fails identically on `qa` before Phase 2). Local builds use
> `npx next build --webpack` (official flag) instead — output confirms `ƒ Proxy (Middleware)`.
> CI/Docker builds have no venv, so the default build is unaffected. Also: `jose` v6 is pure
> ESM, so `transpilePackages: ['jose']` was added to `next.config.js` (committed with Task 3)
> to let `next/jest` transform it.

- [x] **Step 4:** Commit:

```bash
git add src/proxy.ts src/__tests__/admin-proxy.test.ts
git commit -m "feat: proxy.ts auth gate for /admin and admin APIs"
```

---

### Task 6: Users queries, login/logout/me routes, seed-admin script

**Files:** Create `src/db/queries/users.ts`, `src/app/api/admin/auth/login/route.ts`, `src/app/api/admin/auth/logout/route.ts`, `src/app/api/admin/auth/me/route.ts`, `scripts/seed-admin.ts`. Test: `src/__tests__/admin-auth-routes.test.ts`.

- [x] **Step 1:** Create `src/db/queries/users.ts`:

```typescript
import { AppDataSource } from '../data-source'
import { User } from '../entities/User.entity'

export async function findActiveUserByUsername(username: string): Promise<User | null> {
  return AppDataSource.getRepository(User).findOne({ where: { username, active: true } })
}

export async function touchLastLogin(id: string): Promise<void> {
  await AppDataSource.getRepository(User).update(id, { lastLogin: new Date() })
}

export interface UserSummary {
  id: string
  username: string
  email: string | null
  role: string
  active: boolean
  lastLogin: Date | null
  createdAt: Date
}

export async function listUsers(): Promise<UserSummary[]> {
  const users = await AppDataSource.getRepository(User).find({ order: { username: 'ASC' } })
  return users.map(({ passwordHash: _ph, ...rest }) => rest)
}

export async function createUser(input: {
  username: string
  email?: string | null
  passwordHash: string
  role: 'admin' | 'editor'
}): Promise<UserSummary> {
  const repo = AppDataSource.getRepository(User)
  const saved = await repo.save(repo.create({ ...input, active: true }))
  const { passwordHash: _ph, ...rest } = saved
  return rest
}

export async function updateUser(
  id: string,
  patch: Partial<{ role: 'admin' | 'editor'; active: boolean; passwordHash: string }>,
): Promise<void> {
  await AppDataSource.getRepository(User).update(id, patch)
}
```

- [x] **Step 2:** Create `src/app/api/admin/auth/login/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase } from '../../../../../db/data-source'
import { findActiveUserByUsername, touchLastLogin } from '../../../../../db/queries/users'
import { signSession, SESSION_COOKIE, sessionCookieOptions } from '../../../../../lib/auth/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { username, password } = (await req.json().catch(() => ({}))) ?? {}
    if (!username || !password) {
      return NextResponse.json(
        { ok: false, error: 'username and password are required' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const user = await findActiveUserByUsername(String(username))
    const ok = user && (await bcrypt.compare(String(password), user.passwordHash))
    if (!ok) {
      return NextResponse.json({ ok: false, error: 'invalid credentials' }, { status: 401 })
    }
    await touchLastLogin(user.id)
    const token = await signSession({
      userId: user.id,
      username: user.username,
      role: user.role as 'admin' | 'editor',
    })
    const res = NextResponse.json({ ok: true, user: { username: user.username, role: user.role } })
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return res
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 3:** Create `src/app/api/admin/auth/logout/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { SESSION_COOKIE } from '../../../../../lib/auth/session'

export const runtime = 'nodejs'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return res
}
```

- [x] **Step 4:** Create `src/app/api/admin/auth/me/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  return NextResponse.json({
    ok: true,
    identity:
      identity!.kind === 'user'
        ? { kind: 'user', username: identity!.username, role: identity!.role }
        : { kind: 'token', role: 'admin' },
  })
}
```

- [x] **Step 5:** Create `scripts/seed-admin.ts`:

```typescript
import 'reflect-metadata'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '../src/db/data-source'
import { User } from '../src/db/entities/User.entity'

async function main() {
  const [username, password] = process.argv.slice(2)
  if (!username || !password) {
    console.error('Usage: npm run seed:admin -- <username> <password>')
    process.exit(1)
  }
  await AppDataSource.initialize()
  const repo = AppDataSource.getRepository(User)
  const passwordHash = await bcrypt.hash(password, 12)
  const existing = await repo.findOne({ where: { username } })
  if (existing) {
    await repo.update(existing.id, { passwordHash, active: true, role: 'admin' })
    console.log(`Reset password and re-activated admin '${username}'`)
  } else {
    await repo.save(repo.create({ username, passwordHash, role: 'admin', active: true }))
    console.log(`Created admin user '${username}'`)
  }
  await AppDataSource.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [x] **Step 6:** Write `src/__tests__/admin-auth-routes.test.ts` — DB-gated end-to-end of seed → login → me:

```typescript
/** @jest-environment node */
import { NextRequest } from 'next/server'
import bcrypt from 'bcryptjs'
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { POST as login } from '@/app/api/admin/auth/login/route'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
})

d('login route (DB integration)', () => {
  const username = `login_test_${Date.now()}`

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const repo = AppDataSource.getRepository(User)
    await repo.save(
      repo.create({
        username,
        passwordHash: await bcrypt.hash('pw-123456', 12),
        role: 'editor',
        active: true,
      }),
    )
  })

  afterAll(async () => {
    await AppDataSource.getRepository(User).delete({ username })
    await AppDataSource.destroy()
  })

  function loginReq(body: unknown) {
    return new NextRequest('http://localhost/api/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  }

  it('sets a verifiable session cookie on success', async () => {
    const res = await login(loginReq({ username, password: 'pw-123456' }))
    expect(res.status).toBe(200)
    const cookie = res.cookies.get(SESSION_COOKIE)?.value
    expect(cookie).toBeTruthy()
    const session = await verifySession(cookie!)
    expect(session?.username).toBe(username)
    expect(session?.role).toBe('editor')
  })

  it('401s on a wrong password', async () => {
    const res = await login(loginReq({ username, password: 'wrong' }))
    expect(res.status).toBe(401)
  })

  it('400s on a missing body', async () => {
    const res = await login(loginReq({}))
    expect(res.status).toBe(400)
  })
})
```

- [x] **Step 7:** Run:

```bash
npm run test:db -- --testPathPattern='admin-auth-routes'
```

Expected: PASS. Then seed your local admin and verify manually once the UI exists:

```bash
npm run seed:admin -- admin admin-local-password
```

- [x] **Step 8:** Commit:

```bash
git add src/db/queries/users.ts src/app/api/admin/auth scripts/seed-admin.ts src/__tests__/admin-auth-routes.test.ts
git commit -m "feat: admin login/logout/me routes and seed-admin script"
```

---

### Task 7: Audit helper + reindex helper

**Files:** Create `src/db/queries/audit.ts`, `src/lib/search-reindex.ts`. Tests included in `src/__tests__/admin-documents.db.test.ts` (Task 9) for audit; reindex tested here with a mocked fetch in `src/__tests__/admin-reindex.test.ts`.

- [x] **Step 1:** Create `src/db/queries/audit.ts`:

```typescript
import { AppDataSource } from '../data-source'
import { AuditLog } from '../entities/AuditLog.entity'

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'tag_decision'
  | 'lifecycle'
  | 'collection_change'
  | 'import'

export interface AuditEntry {
  actorUserId: string | null
  source: 'human' | 'system'
  action: AuditAction
  entityType: string
  entityId: string | null
  before?: Record<string, any> | null
  after?: Record<string, any> | null
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const repo = AppDataSource.getRepository(AuditLog)
  await repo.insert({
    actorUserId: entry.actorUserId,
    source: entry.source,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  })
}
```

- [x] **Step 2:** Create `src/lib/search-reindex.ts`. `/reindex` is synchronous in the search-service (re-reads chunks, rebuilds BM25) — allow up to 120s, never throw:

```typescript
export interface ReindexResult {
  ok: boolean
  error?: string
}

/**
 * Best-effort BM25 refresh after lifecycle changes. The dense lane filters
 * status='searchable' per query; the in-memory BM25 lane only refreshes via
 * POST /reindex (or service restart) — see docs/document-management.md §4.
 */
export async function triggerReindex(): Promise<ReindexResult> {
  const base = process.env.SEARCH_SERVICE_URL || process.env.LLAMAINDEX_SERVICE_URL
  if (!base) return { ok: false, error: 'SEARCH_SERVICE_URL not configured' }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/reindex`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return { ok: false, error: `reindex returned HTTP ${res.status}` }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) }
  }
}
```

- [x] **Step 3:** Write `src/__tests__/admin-reindex.test.ts`:

```typescript
/** @jest-environment node */
import { triggerReindex } from '@/lib/search-reindex'

describe('triggerReindex', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.SEARCH_SERVICE_URL
  })

  it('reports missing configuration', async () => {
    delete process.env.SEARCH_SERVICE_URL
    delete process.env.LLAMAINDEX_SERVICE_URL
    expect((await triggerReindex()).ok).toBe(false)
  })

  it('POSTs to /reindex and reports success', async () => {
    process.env.SEARCH_SERVICE_URL = 'http://search:8000'
    const mock = jest.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = mock as any
    expect((await triggerReindex()).ok).toBe(true)
    expect(mock).toHaveBeenCalledWith('http://search:8000/reindex', expect.objectContaining({ method: 'POST' }))
  })

  it('reports HTTP failures without throwing', async () => {
    process.env.SEARCH_SERVICE_URL = 'http://search:8000'
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    const result = await triggerReindex()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })
})
```

- [x] **Step 4:** Run `npm test -- --testPathPattern='admin-reindex'`; expected PASS. Commit:

```bash
git add src/db/queries/audit.ts src/lib/search-reindex.ts src/__tests__/admin-reindex.test.ts
git commit -m "feat: audit_log writer and best-effort /reindex trigger"
```

---

### Task 8: Review queue query + API route

**Files:** Create `src/db/queries/reviewQueue.ts`, `src/app/api/admin/review-queue/route.ts`. Test: `src/__tests__/admin-review-queue.db.test.ts`.

- [x] **Step 1:** Create `src/db/queries/reviewQueue.ts` (raw SQL — needs a lateral join on the latest job, which the entity layer can't express cleanly):

```typescript
import { AppDataSource } from '../data-source'

export interface ReviewQueueItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  extractionConfidence: number | null
  jobStatus: string | null
  jobError: string | null
  jobAttempts: number | null
  suggestedTagCount: number
  createdAt: string
}

/**
 * Documents needing human attention: status needs_review/error, or whose
 * latest ingestion job errored out (job exhausted retries while the document
 * may still sit in draft/processing).
 */
export async function getReviewQueue(): Promise<ReviewQueueItem[]> {
  return AppDataSource.query(`
    SELECT d.id,
           d.external_id            AS "externalId",
           d.title,
           d.language,
           d.status,
           d.extraction_confidence::float AS "extractionConfidence",
           j.status                 AS "jobStatus",
           j.error                  AS "jobError",
           j.attempts               AS "jobAttempts",
           COALESCE(st.n, 0)        AS "suggestedTagCount",
           d.created_at             AS "createdAt"
    FROM documents d
    LEFT JOIN LATERAL (
      SELECT status, error, attempts
      FROM ingestion_jobs
      WHERE document_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) j ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM document_tags dt
      WHERE dt.document_id = d.id AND dt.status = 'suggested'
    ) st ON true
    WHERE d.status IN ('needs_review', 'error')
       OR j.status = 'error'
    ORDER BY d.created_at DESC
  `)
}
```

- [x] **Step 2:** Create `src/app/api/admin/review-queue/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { getReviewQueue } from '../../../../db/queries/reviewQueue'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const items = await getReviewQueue()
    return NextResponse.json({ ok: true, items })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 3:** Write `src/__tests__/admin-review-queue.db.test.ts` — DB-gated; fabricates a `needs_review` doc + suggested tag inside a transaction-style setup/teardown:

```typescript
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getReviewQueue } from '@/db/queries/reviewQueue'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('getReviewQueue (DB integration)', () => {
  const externalId = `review_test_${Date.now()}`
  let docId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status, extraction_confidence)
       VALUES ($1, $2, 'Review Test Doc', 'needs_review', 0.42) RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = row.id
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, confidence, status)
       SELECT $1, id, 'llm', 0.55, 'suggested' FROM tags LIMIT 1`,
      [docId],
    )
  })

  afterAll(async () => {
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.destroy()
  })

  it('lists the needs_review doc with its suggested-tag count', async () => {
    const items = await getReviewQueue()
    const item = items.find((i) => i.externalId === externalId)
    expect(item).toBeTruthy()
    expect(item!.status).toBe('needs_review')
    expect(item!.extractionConfidence).toBeCloseTo(0.42)
    expect(item!.suggestedTagCount).toBe(1)
  })
})
```

- [x] **Step 4:** Run `npm run test:db -- --testPathPattern='admin-review-queue'`; expected PASS. Commit:

```bash
git add src/db/queries/reviewQueue.ts src/app/api/admin/review-queue src/__tests__/admin-review-queue.db.test.ts
git commit -m "feat: review-queue query and API route"
```

---

### Task 9: Document admin queries + routes (detail, edit, lifecycle, reingest)

**Files:** Create `src/db/queries/documentsAdmin.ts`, `src/app/api/admin/documents/route.ts`, `src/app/api/admin/documents/[id]/route.ts`, `src/app/api/admin/documents/[id]/status/route.ts`, `src/app/api/admin/documents/[id]/reingest/route.ts`. Test: `src/__tests__/admin-documents.db.test.ts`.

- [x] **Step 1:** Create `src/db/queries/documentsAdmin.ts`:

```typescript
import { AppDataSource } from '../data-source'
import { Document } from '../entities/Document.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

// Whitelisted editable metadata fields (entity property -> column handled by TypeORM)
export const EDITABLE_FIELDS = [
  'title',
  'titleEn',
  'doi',
  'abstract',
  'language',
  'yearPublished',
  'publicationTitle',
  'articleType',
  'wriPrimaryOffice',
] as const
export type EditableField = (typeof EDITABLE_FIELDS)[number]

export interface AdminDocumentListItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  yearPublished: number | null
  createdAt: string
}

export interface AdminDocumentFilters {
  status?: string
  language?: string
  collectionId?: string
  tagId?: string
  search?: string
}

export async function listAdminDocuments(
  filters: AdminDocumentFilters,
): Promise<AdminDocumentListItem[]> {
  const where: string[] = ['1=1']
  const params: any[] = []
  const p = (v: any) => {
    params.push(v)
    return `$${params.length}`
  }
  if (filters.status) where.push(`d.status = ${p(filters.status)}`)
  if (filters.language) where.push(`d.language = ${p(filters.language)}`)
  if (filters.search) where.push(`(d.title ILIKE ${p('%' + filters.search + '%')} OR d.external_id ILIKE ${p('%' + filters.search + '%')})`)
  if (filters.collectionId)
    where.push(`EXISTS (SELECT 1 FROM document_collections dc
                WHERE dc.document_id = d.id AND dc.collection_id = ${p(filters.collectionId)})`)
  if (filters.tagId)
    where.push(`EXISTS (SELECT 1 FROM document_tags dt
                WHERE dt.document_id = d.id AND dt.tag_id = ${p(filters.tagId)} AND dt.status = 'accepted')`)
  return AppDataSource.query(
    `SELECT d.id, d.external_id AS "externalId", d.title, d.language, d.status,
            d.year_published AS "yearPublished", d.created_at AS "createdAt"
     FROM documents d
     WHERE ${where.join(' AND ')}
     ORDER BY d.created_at DESC
     LIMIT 500`,
    params,
  )
}

export interface AdminDocumentDetail {
  document: Document
  summaries: { language: string; kind: string; text: string; source: string | null }[]
  tags: {
    tagId: string
    facet: string
    valueId: string
    source: string
    status: string
    confidence: number | null
    modelVersion: string | null
  }[]
  collections: { id: string; name: string; slug: string }[]
  latestJob: { status: string; stage: string | null; error: string | null; attempts: number } | null
}

export async function getAdminDocumentDetail(id: string): Promise<AdminDocumentDetail | null> {
  const document = await AppDataSource.getRepository(Document).findOne({ where: { id } })
  if (!document) return null
  const summaries = await AppDataSource.query(
    `SELECT language, kind, text, source FROM document_summaries
     WHERE document_id = $1 ORDER BY language, kind`,
    [id],
  )
  const tags = await AppDataSource.query(
    `SELECT dt.tag_id AS "tagId", t.facet, t.value_id AS "valueId", dt.source, dt.status,
            dt.confidence::float AS confidence, dt.model_version AS "modelVersion"
     FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
     WHERE dt.document_id = $1
     ORDER BY t.facet, t.value_id`,
    [id],
  )
  const collections = await AppDataSource.query(
    `SELECT c.id, c.name, c.slug
     FROM document_collections dc JOIN collections c ON c.id = dc.collection_id
     WHERE dc.document_id = $1 ORDER BY c.name`,
    [id],
  )
  const jobs = await AppDataSource.query(
    `SELECT status, stage, error, attempts FROM ingestion_jobs
     WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id],
  )
  return { document, summaries, tags, collections, latestJob: jobs[0] ?? null }
}

export async function updateDocumentFields(
  id: string,
  patch: Partial<Record<EditableField, unknown>>,
  identity: AdminIdentity,
): Promise<{ updated: string[] } | null> {
  const repo = AppDataSource.getRepository(Document)
  const doc = await repo.findOne({ where: { id } })
  if (!doc) return null
  const before: Record<string, any> = {}
  const after: Record<string, any> = {}
  for (const field of EDITABLE_FIELDS) {
    if (field in patch && patch[field] !== (doc as any)[field]) {
      before[field] = (doc as any)[field]
      after[field] = patch[field]
      ;(doc as any)[field] = patch[field]
    }
  }
  const updated = Object.keys(after)
  if (updated.length === 0) return { updated }
  await repo.save(doc)
  await writeAudit({
    ...auditActor(identity),
    action: 'update',
    entityType: 'document',
    entityId: id,
    before,
    after,
  })
  return { updated }
}

const ALLOWED_TARGET_STATUSES = new Set(['searchable', 'withdrawn'])

export async function setDocumentStatus(
  id: string,
  toStatus: string,
  identity: AdminIdentity,
): Promise<{ fromStatus: string } | null | { error: string }> {
  if (!ALLOWED_TARGET_STATUSES.has(toStatus)) {
    return { error: `status must be one of: ${[...ALLOWED_TARGET_STATUSES].join(', ')}` }
  }
  const repo = AppDataSource.getRepository(Document)
  const doc = await repo.findOne({ where: { id } })
  if (!doc) return null
  const fromStatus = doc.status
  if (fromStatus === toStatus) return { fromStatus }
  doc.status = toStatus
  await repo.save(doc)
  await writeAudit({
    ...auditActor(identity),
    action: 'lifecycle',
    entityType: 'document',
    entityId: id,
    before: { status: fromStatus },
    after: { status: toStatus },
  })
  return { fromStatus }
}

/** Re-enqueue ingestion for a document unless an open job already exists. */
export async function reenqueueIngestion(
  id: string,
  identity: AdminIdentity,
): Promise<{ jobId: string } | { error: string } | null> {
  const doc = await AppDataSource.getRepository(Document).findOne({ where: { id } })
  if (!doc) return null
  const open = await AppDataSource.query(
    `SELECT id FROM ingestion_jobs
     WHERE document_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
    [id],
  )
  if (open.length > 0) return { error: 'an open ingestion job already exists' }
  const [job] = await AppDataSource.query(
    `INSERT INTO ingestion_jobs (document_id, status) VALUES ($1, 'queued') RETURNING id`,
    [id],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'ingestion_job',
    entityId: job.id,
    after: { documentId: id, status: 'queued' },
  })
  return { jobId: job.id }
}
```

- [x] **Step 2:** Create `src/app/api/admin/documents/route.ts` (GET list with query-param filters):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listAdminDocuments } from '../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    const sp = req.nextUrl.searchParams
    const items = await listAdminDocuments({
      status: sp.get('status') || undefined,
      language: sp.get('language') || undefined,
      collectionId: sp.get('collectionId') || undefined,
      tagId: sp.get('tagId') || undefined,
      search: sp.get('search') || undefined,
    })
    return NextResponse.json({ ok: true, items })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 3:** Create `src/app/api/admin/documents/[id]/route.ts` (GET detail, PATCH metadata):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import {
  getAdminDocumentDetail,
  updateDocumentFields,
} from '../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const detail = await getAdminDocumentDetail(id)
    if (!detail) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, ...detail })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const patch = (await req.json().catch(() => ({}))) ?? {}
    await initializeDatabase()
    const result = await updateDocumentFields(id, patch, identity!)
    if (!result) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true, updated: result.updated })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 4:** Create `src/app/api/admin/documents/[id]/status/route.ts` (POST lifecycle change — **the BM25 gotcha lives here**; withdraw is admin-only, promote is editor-ok):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { setDocumentStatus } from '../../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'
import { triggerReindex } from '../../../../../../lib/search-reindex'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = (await req.json().catch(() => ({}))) ?? {}
  const toStatus = String(body.status || '')
  // Withdraw is a takedown — admin only. Promote (-> searchable) is the
  // review queue's whole purpose and stays editor-accessible.
  const { identity, response } = await requireIdentity(
    req,
    toStatus === 'withdrawn' ? 'admin' : undefined,
  )
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const result = await setDocumentStatus(id, toStatus, identity!)
    if (!result) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
    // Both directions need a BM25 refresh: the in-memory BM25 index only
    // tracks status='searchable' rows as of the last boot//reindex.
    const reindex = await triggerReindex()
    return NextResponse.json({
      ok: true,
      fromStatus: result.fromStatus,
      status: toStatus,
      reindex,
    })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 5:** Create `src/app/api/admin/documents/[id]/reingest/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { reenqueueIngestion } from '../../../../../../db/queries/documentsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const result = await reenqueueIngestion(id, identity!)
    if (!result) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true, jobId: result.jobId })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 6:** Write `src/__tests__/admin-documents.db.test.ts` (DB-gated). Cover: detail returns summaries/tags/collections; `updateDocumentFields` writes only changed fields + an audit row; `setDocumentStatus` enforces the allowlist and writes a `lifecycle` audit row; `reenqueueIngestion` refuses when an open job exists:

```typescript
/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import {
  getAdminDocumentDetail,
  updateDocumentFields,
  setDocumentStatus,
  reenqueueIngestion,
} from '@/db/queries/documentsAdmin'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
const identity = { kind: 'token', role: 'admin' } as const

d('documentsAdmin (DB integration)', () => {
  const externalId = `docadmin_test_${Date.now()}`
  let docId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const [row] = await AppDataSource.query(
      `INSERT INTO documents (external_id, s3_key, title, status)
       VALUES ($1, $2, 'Doc Admin Test', 'needs_review') RETURNING id`,
      [externalId, `documents/${externalId}.pdf`],
    )
    docId = row.id
  })

  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM audit_log WHERE entity_id = $1
       OR entity_id IN (SELECT id FROM ingestion_jobs WHERE document_id = $1)`,
      [docId],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await AppDataSource.destroy()
  })

  it('returns detail for an existing document', async () => {
    const detail = await getAdminDocumentDetail(docId)
    expect(detail?.document.externalId).toBe(externalId)
    expect(Array.isArray(detail?.summaries)).toBe(true)
    expect(Array.isArray(detail?.tags)).toBe(true)
  })

  it('updates whitelisted fields and audits the diff', async () => {
    const result = await updateDocumentFields(
      docId,
      { title: 'Renamed', status: 'searchable' } as any, // status NOT whitelisted
      identity,
    )
    expect(result?.updated).toEqual(['title'])
    const [audit] = await AppDataSource.query(
      `SELECT action, before, after FROM audit_log
       WHERE entity_type='document' AND entity_id=$1 ORDER BY at DESC LIMIT 1`,
      [docId],
    )
    expect(audit.action).toBe('update')
    expect(audit.after).toEqual({ title: 'Renamed' })
  })

  it('promotes needs_review -> searchable with a lifecycle audit row', async () => {
    const result = await setDocumentStatus(docId, 'searchable', identity)
    expect(result).toEqual({ fromStatus: 'needs_review' })
    const [row] = await AppDataSource.query(`SELECT status FROM documents WHERE id=$1`, [docId])
    expect(row.status).toBe('searchable')
  })

  it('rejects disallowed target statuses', async () => {
    const result = await setDocumentStatus(docId, 'draft', identity)
    expect(result).toHaveProperty('error')
  })

  it('re-enqueues ingestion once, then refuses while the job is open', async () => {
    const first = await reenqueueIngestion(docId, identity)
    expect(first).toHaveProperty('jobId')
    const second = await reenqueueIngestion(docId, identity)
    expect(second).toHaveProperty('error')
    // Clean up the job AND its audit row here — afterAll's audit cleanup
    // joins on ingestion_jobs, which would already be empty by then.
    await AppDataSource.query(`DELETE FROM audit_log WHERE entity_id = $1`, [
      (first as { jobId: string }).jobId,
    ])
    await AppDataSource.query(`DELETE FROM ingestion_jobs WHERE document_id = $1`, [docId])
  })
})
```

- [x] **Step 7:** Run `npm run test:db -- --testPathPattern='admin-documents'`; expected PASS. Run `npm run lint`. Commit:

```bash
git add src/db/queries/documentsAdmin.ts src/app/api/admin/documents src/__tests__/admin-documents.db.test.ts
git commit -m "feat: admin document list/detail/edit/lifecycle/reingest APIs"
```

---

### Task 10: Tag queries + routes (taxonomy curation + per-document decisions)

**Files:** Create `src/db/queries/tagsAdmin.ts`, `src/app/api/admin/tags/route.ts`, `src/app/api/admin/tags/[id]/route.ts`, `src/app/api/admin/documents/[id]/tags/route.ts`, `src/app/api/admin/documents/[id]/tags/[tagId]/route.ts`. Test: `src/__tests__/admin-tags.db.test.ts`.

- [x] **Step 1:** Create `src/db/queries/tagsAdmin.ts`:

```typescript
import { AppDataSource } from '../data-source'
import { Tag } from '../entities/Tag.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

export interface TagWithCounts {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string
  acceptedCount: number
  suggestedCount: number
}

export async function listTagsWithCounts(): Promise<TagWithCounts[]> {
  return AppDataSource.query(`
    SELECT t.id, t.facet, t.value_id AS "valueId", t.taxonomy_version AS "taxonomyVersion",
           count(*) FILTER (WHERE dt.status = 'accepted')::int  AS "acceptedCount",
           count(*) FILTER (WHERE dt.status = 'suggested')::int AS "suggestedCount"
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.facet, t.value_id
  `)
}

export async function createTag(
  facet: string,
  valueId: string,
  identity: AdminIdentity,
): Promise<Tag | { error: string }> {
  const repo = AppDataSource.getRepository(Tag)
  const existing = await repo.findOne({ where: { facet, valueId, taxonomyVersion: 'v1' } })
  if (existing) return { error: 'tag already exists' }
  const tag = await repo.save(repo.create({ facet, valueId, taxonomyVersion: 'v1' }))
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'tag',
    entityId: tag.id,
    after: { facet, valueId, taxonomyVersion: 'v1' },
  })
  return tag
}

export async function deleteTagIfUnused(
  id: string,
  identity: AdminIdentity,
): Promise<{ deleted: boolean; error?: string }> {
  const [{ n }] = await AppDataSource.query(
    `SELECT count(*)::int AS n FROM document_tags WHERE tag_id = $1`,
    [id],
  )
  if (n > 0) return { deleted: false, error: `tag is applied to ${n} document(s)` }
  const tag = await AppDataSource.getRepository(Tag).findOne({ where: { id } })
  if (!tag) return { deleted: false, error: 'not found' }
  await AppDataSource.getRepository(Tag).delete(id)
  await writeAudit({
    ...auditActor(identity),
    action: 'delete',
    entityType: 'tag',
    entityId: id,
    before: { facet: tag.facet, valueId: tag.valueId },
  })
  return { deleted: true }
}

/**
 * Accept or reject a tag on a document. Sets source='human' so the worker's
 * classify stage (which skips source='human'|'external' rows) can never
 * overwrite a human decision — Scope decision 7. The prior row is preserved
 * in the audit 'before'.
 */
export async function decideDocumentTag(
  documentId: string,
  tagId: string,
  decision: 'accepted' | 'rejected',
  identity: AdminIdentity,
): Promise<{ ok: true } | { error: string }> {
  const [row] = await AppDataSource.query(
    `SELECT source, status, confidence::float AS confidence, model_version AS "modelVersion"
     FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId],
  )
  if (!row) return { error: 'tag is not on this document' }
  await AppDataSource.query(
    `UPDATE document_tags SET status = $3, source = 'human'
     WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId, decision],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'tag_decision',
    entityType: 'document',
    entityId: documentId,
    before: { tagId, ...row },
    after: { tagId, status: decision, source: 'human' },
  })
  return { ok: true }
}

/** Attach an existing taxonomy tag to a document as an accepted human tag. */
export async function addHumanTag(
  documentId: string,
  tagId: string,
  identity: AdminIdentity,
): Promise<{ ok: true } | { error: string }> {
  const existing = await AppDataSource.query(
    `SELECT 1 FROM document_tags WHERE document_id = $1 AND tag_id = $2`,
    [documentId, tagId],
  )
  if (existing.length > 0) return { error: 'tag already on document — use accept/reject' }
  await AppDataSource.query(
    `INSERT INTO document_tags (document_id, tag_id, source, status)
     VALUES ($1, $2, 'human', 'accepted')`,
    [documentId, tagId],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'tag_decision',
    entityType: 'document',
    entityId: documentId,
    after: { tagId, status: 'accepted', source: 'human' },
  })
  return { ok: true }
}
```

- [x] **Step 2:** Create `src/app/api/admin/tags/route.ts` (GET list+counts for any session; POST create for editors+):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import { listTagsWithCounts, createTag } from '../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, tags: await listTagsWithCounts() })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { facet, valueId } = (await req.json().catch(() => ({}))) ?? {}
    if (!facet || !valueId) {
      return NextResponse.json(
        { ok: false, error: 'facet and valueId are required' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await createTag(String(facet), String(valueId), identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true, tag: result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 3:** Create `src/app/api/admin/tags/[id]/route.ts` (DELETE unused, admin-only):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../db/data-source'
import { deleteTagIfUnused } from '../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const result = await deleteTagIfUnused(id, identity!)
    if (!result.deleted)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 4:** Create `src/app/api/admin/documents/[id]/tags/route.ts` (POST add human tag):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import { addHumanTag } from '../../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const { tagId } = (await req.json().catch(() => ({}))) ?? {}
    if (!tagId) return NextResponse.json({ ok: false, error: 'tagId is required' }, { status: 400 })
    await initializeDatabase()
    const result = await addHumanTag(id, String(tagId), identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 5:** Create `src/app/api/admin/documents/[id]/tags/[tagId]/route.ts` (PATCH accept/reject):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../../db/data-source'
import { decideDocumentTag } from '../../../../../../../db/queries/tagsAdmin'
import { requireIdentity } from '../../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> },
) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id, tagId } = await params
    const { decision } = (await req.json().catch(() => ({}))) ?? {}
    if (decision !== 'accepted' && decision !== 'rejected') {
      return NextResponse.json(
        { ok: false, error: "decision must be 'accepted' or 'rejected'" },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await decideDocumentTag(id, tagId, decision, identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 6:** Write `src/__tests__/admin-tags.db.test.ts` (DB-gated). Cover: counts query shape; create + duplicate-create conflict; delete-unused vs delete-in-use; `decideDocumentTag` flips status AND source to human with audit `before` preserving the llm row; `addHumanTag` inserts and conflicts on re-add. Use a fabricated doc + a fabricated tag (`facet='topic', value_id='__test_value__'`), clean up audit/doc/tag rows in `afterAll` (same pattern as Task 9's test — fabricate with raw INSERTs, delete by id).

- [x] **Step 7:** Run `npm run test:db -- --testPathPattern='admin-tags'`; expected PASS. Commit:

```bash
git add src/db/queries/tagsAdmin.ts src/app/api/admin/tags src/app/api/admin/documents src/__tests__/admin-tags.db.test.ts
git commit -m "feat: taxonomy curation and per-document tag decision APIs"
```

---

### Task 11: Collections queries + routes

**Files:** Create `src/db/queries/collectionsAdmin.ts`, `src/app/api/admin/collections/route.ts`, `src/app/api/admin/collections/[id]/route.ts`, `src/app/api/admin/collections/[id]/documents/route.ts`. Test: `src/__tests__/admin-collections.db.test.ts`.

- [x] **Step 1:** Create `src/db/queries/collectionsAdmin.ts`:

```typescript
import { AppDataSource } from '../data-source'
import { Collection } from '../entities/Collection.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

export interface CollectionWithCount {
  id: string
  name: string
  slug: string
  description: string | null
  documentCount: number
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function listCollectionsWithCounts(): Promise<CollectionWithCount[]> {
  return AppDataSource.query(`
    SELECT c.id, c.name, c.slug, c.description,
           count(dc.document_id)::int AS "documentCount"
    FROM collections c
    LEFT JOIN document_collections dc ON dc.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `)
}

export async function createCollection(
  name: string,
  description: string | null,
  identity: AdminIdentity,
): Promise<Collection | { error: string }> {
  const repo = AppDataSource.getRepository(Collection)
  const slug = slugify(name)
  if (!slug) return { error: 'name must contain letters or numbers' }
  if (await repo.findOne({ where: { slug } })) return { error: 'a collection with this slug exists' }
  const collection = await repo.save(repo.create({ name, slug, description }))
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'collection',
    entityId: collection.id,
    after: { name, slug },
  })
  return collection
}

export async function updateCollection(
  id: string,
  patch: Partial<{ name: string; description: string | null }>,
  identity: AdminIdentity,
): Promise<Collection | null> {
  const repo = AppDataSource.getRepository(Collection)
  const collection = await repo.findOne({ where: { id } })
  if (!collection) return null
  const before: Record<string, any> = {}
  const after: Record<string, any> = {}
  for (const key of ['name', 'description'] as const) {
    if (key in patch && patch[key] !== collection[key]) {
      before[key] = collection[key]
      after[key] = patch[key]
      ;(collection as any)[key] = patch[key]
    }
  }
  if (Object.keys(after).length === 0) return collection
  await repo.save(collection)
  await writeAudit({
    ...auditActor(identity),
    action: 'update',
    entityType: 'collection',
    entityId: id,
    before,
    after,
  })
  return collection
}

/** Add documents to a collection (idempotent); returns how many were newly added. */
export async function addDocumentsToCollection(
  collectionId: string,
  documentIds: string[],
  identity: AdminIdentity,
): Promise<{ added: number } | { error: string }> {
  const collection = await AppDataSource.getRepository(Collection).findOne({
    where: { id: collectionId },
  })
  if (!collection) return { error: 'collection not found' }
  const addedBy = identity.kind === 'user' ? identity.username : 'api-token'
  const result = await AppDataSource.query(
    `INSERT INTO document_collections (document_id, collection_id, added_by)
     SELECT d.id, $1, $2 FROM documents d WHERE d.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING`,
    [collectionId, addedBy, documentIds],
  )
  const added = Array.isArray(result) ? (result[1] ?? 0) : 0
  await writeAudit({
    ...auditActor(identity),
    action: 'collection_change',
    entityType: 'collection',
    entityId: collectionId,
    after: { addedDocumentIds: documentIds },
  })
  return { added: Number(added) }
}

export async function removeDocumentFromCollection(
  collectionId: string,
  documentId: string,
  identity: AdminIdentity,
): Promise<void> {
  await AppDataSource.query(
    `DELETE FROM document_collections WHERE collection_id = $1 AND document_id = $2`,
    [collectionId, documentId],
  )
  await writeAudit({
    ...auditActor(identity),
    action: 'collection_change',
    entityType: 'collection',
    entityId: collectionId,
    before: { removedDocumentId: documentId },
  })
}
```

Note on `added`: TypeORM's raw `query()` for INSERT returns `[rows, rowCount]` for parameterized writes on pg. If the count proves unreliable during implementation, drop it from the response — it's informational only.

- [x] **Step 2:** Create `src/app/api/admin/collections/route.ts` (GET list, POST create) — same shape as the tags route: GET requires any identity and returns `{ ok, collections }`; POST validates `name` (400 if missing), calls `createCollection`, maps `{ error }` to 409.

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../db/data-source'
import {
  listCollectionsWithCounts,
  createCollection,
} from '../../../../db/queries/collectionsAdmin'
import { requireIdentity } from '../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, collections: await listCollectionsWithCounts() })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { name, description } = (await req.json().catch(() => ({}))) ?? {}
    if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })
    await initializeDatabase()
    const result = await createCollection(String(name), description ?? null, identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 409 })
    return NextResponse.json({ ok: true, collection: result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 3:** Create `src/app/api/admin/collections/[id]/route.ts` (PATCH name/description → `updateCollection`, 404 on null) and `src/app/api/admin/collections/[id]/documents/route.ts`:

```typescript
// collections/[id]/documents/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../../../../db/data-source'
import {
  addDocumentsToCollection,
  removeDocumentFromCollection,
} from '../../../../../../db/queries/collectionsAdmin'
import { requireIdentity } from '../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const { documentIds } = (await req.json().catch(() => ({}))) ?? {}
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'documentIds must be a non-empty array' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const result = await addDocumentsToCollection(id, documentIds, identity!)
    if ('error' in result)
      return NextResponse.json({ ok: false, error: result.error }, { status: 404 })
    return NextResponse.json({ ok: true, ...result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    const { documentId } = (await req.json().catch(() => ({}))) ?? {}
    if (!documentId)
      return NextResponse.json({ ok: false, error: 'documentId is required' }, { status: 400 })
    await initializeDatabase()
    await removeDocumentFromCollection(id, String(documentId), identity!)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 4:** Write `src/__tests__/admin-collections.db.test.ts` (DB-gated). Cover: `slugify` (pure — runs ungated), create + slug conflict, add documents idempotently (add same id twice → membership count stays 1), remove, counts in `listCollectionsWithCounts`. Fabricate one doc + one collection, clean up in `afterAll` (delete collection, doc, and audit rows by entity id).

- [x] **Step 5:** Run `npm run test:db -- --testPathPattern='admin-collections'`; expected PASS. Commit:

```bash
git add src/db/queries/collectionsAdmin.ts src/app/api/admin/collections src/__tests__/admin-collections.db.test.ts
git commit -m "feat: collections CRUD and membership APIs"
```

---

### Task 12: User management routes (admin-only)

**Files:** Create `src/app/api/admin/users/route.ts`, `src/app/api/admin/users/[id]/route.ts`. Tests: extend `src/__tests__/admin-auth-routes.test.ts`.

- [x] **Step 1:** Create `src/app/api/admin/users/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase } from '../../../../db/data-source'
import { listUsers, createUser } from '../../../../db/queries/users'
import { requireIdentity, auditActor } from '../../../../lib/auth/identity'
import { writeAudit } from '../../../../db/queries/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, users: await listUsers() })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { username, email, password, role } = (await req.json().catch(() => ({}))) ?? {}
    if (!username || !password || (role !== 'admin' && role !== 'editor')) {
      return NextResponse.json(
        { ok: false, error: 'username, password, and role (admin|editor) are required' },
        { status: 400 },
      )
    }
    if (String(password).length < 12) {
      return NextResponse.json(
        { ok: false, error: 'password must be at least 12 characters' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const user = await createUser({
      username: String(username),
      email: email ?? null,
      passwordHash: await bcrypt.hash(String(password), 12),
      role,
    })
    await writeAudit({
      ...auditActor(identity!),
      action: 'create',
      entityType: 'user',
      entityId: user.id,
      after: { username: user.username, role: user.role },
    })
    return NextResponse.json({ ok: true, user })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 2:** Create `src/app/api/admin/users/[id]/route.ts` — PATCH accepting any of `{ role, active, password }`; hash password with bcryptjs when present; reject unknown roles; write an `update` audit row with the changed keys (`password` audited as `{ password: '<reset>' }`, never the value); 404 when the user id doesn't exist (check with `listUsers`-style repo lookup before update). Admin-only via `requireIdentity(req, 'admin')`. Same try/catch + response shape as every route above.

- [x] **Step 3:** Extend `src/__tests__/admin-auth-routes.test.ts` with a DB-gated describe block: POST creates a user (then login works with the new credentials), short password 400s, PATCH deactivates (login then 401s). Clean up created users in `afterAll`.

- [x] **Step 4:** Run `npm run test:db -- --testPathPattern='admin-auth-routes'`; expected PASS. Commit:

```bash
git add src/app/api/admin/users src/__tests__/admin-auth-routes.test.ts
git commit -m "feat: admin-only user management API"
```

---

### Task 13: Document file route (PDF for the review/editor UI)

**Files:** Create `src/app/api/admin/documents/[id]/file/route.ts`.

The existing `/api/pdf/[filename]` reads `/tmp/askWRI_docs` only — worker-ingested PDFs live in S3 under `documents/`. This route streams by document id: S3 when `DOCUMENTS_S3_BUCKET` is set, local-dir fallback for dev. Follow the `new S3Client({})` ambient-credentials pattern from `src/lib/eval-storage.ts`.

- [x] **Step 1:** Create the route:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { initializeDatabase, AppDataSource } from '../../../../../../db/data-source'
import { Document } from '../../../../../../db/entities/Document.entity'
import { requireIdentity } from '../../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await requireIdentity(req)
  if (response) return response
  try {
    const { id } = await params
    await initializeDatabase()
    const doc = await AppDataSource.getRepository(Document).findOne({ where: { id } })
    if (!doc?.s3Key) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 })

    const filename = basename(doc.s3Key)
    const bucket = process.env.DOCUMENTS_S3_BUCKET

    let body: Uint8Array
    if (bucket) {
      const s3 = new S3Client({})
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: doc.s3Key }))
      body = new Uint8Array(await obj.Body!.transformToByteArray())
    } else {
      const localDir = process.env.ADMIN_PDF_LOCAL_DIR || join('/tmp', 'askWRI_docs')
      const localPath = join(localDir, filename)
      if (!existsSync(localPath)) {
        return NextResponse.json({ ok: false, error: 'file not found locally' }, { status: 404 })
      }
      body = Uint8Array.from(await readFile(localPath))
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 2:** Add `ADMIN_PDF_LOCAL_DIR` to `.env.example` under the Phase 2 block with a comment (`# Local dir for admin PDF preview when DOCUMENTS_S3_BUCKET is unset (dev)`).

- [x] **Step 3:** `npm run lint` + `npm run build`. Commit:

```bash
git add src/app/api/admin/documents .env.example
git commit -m "feat: admin document file route (S3 or local dir)"
```

---

### Task 14: Admin UI shell — layout, API client, login page

**Files:** Create `src/app/admin/layout.tsx`, `src/app/admin/lib/api.ts`, `src/app/admin/login/page.tsx`, `src/app/admin/page.tsx`.

UI ground rules for Tasks 14–19: `'use client'` pages, Chakra layout primitives (`Box`, `Heading`, `Text`) + plain HTML tables/forms with inline styles (matches the existing idiom; avoids guessing Chakra v3 composite APIs), client-side fetching via the shared helper. Styling is intentionally minimal — this is an internal tool.

- [x] **Step 1:** Create `src/app/admin/lib/api.ts`:

```typescript
'use client'

export async function adminFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401) {
    window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname)}`
    throw new Error('unauthorized')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return body
}
```

- [x] **Step 2:** Create `src/app/admin/layout.tsx` — nav + logout; hides the Users link for editors; renders bare children on `/admin/login`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { Box, Heading } from '@chakra-ui/react'

const NAV = [
  { href: '/admin/review', label: 'Review queue' },
  { href: '/admin/documents', label: 'Documents' },
  { href: '/admin/collections', label: 'Collections' },
  { href: '/admin/tags', label: 'Tags' },
  { href: '/admin/upload', label: 'Upload' },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [me, setMe] = useState<{ username?: string; role?: string } | null>(null)
  const isLogin = pathname === '/admin/login'

  useEffect(() => {
    if (isLogin) return
    fetch('/api/admin/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setMe(body?.identity ?? null))
      .catch(() => setMe(null))
  }, [isLogin, pathname])

  if (isLogin) return <>{children}</>

  const logout = async () => {
    await fetch('/api/admin/auth/logout', { method: 'POST' })
    router.push('/admin/login')
  }

  return (
    <Box style={{ display: 'flex', minHeight: '100vh' }}>
      <Box style={{ width: 220, borderRight: '1px solid #ddd', padding: 16 }}>
        <Heading size='md' style={{ marginBottom: 16 }}>
          AskWRI Admin
        </Heading>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{ fontWeight: pathname.startsWith(item.href) ? 700 : 400 }}
            >
              {item.label}
            </Link>
          ))}
          {me?.role === 'admin' && <Link href='/admin/users'>Users</Link>}
        </nav>
        <Box style={{ marginTop: 24, fontSize: 13 }}>
          {me?.username && <div>{me.username} ({me.role})</div>}
          <button onClick={logout} style={{ marginTop: 8, textDecoration: 'underline' }}>
            Log out
          </button>
        </Box>
      </Box>
      <Box style={{ flex: 1, padding: 24, overflowX: 'auto' }}>{children}</Box>
    </Box>
  )
}
```

- [x] **Step 3:** Create `src/app/admin/login/page.tsx`:

```tsx
'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      setError(body.error || 'login failed')
      return
    }
    router.push(searchParams.get('next') || '/admin/review')
  }

  return (
    <Box style={{ maxWidth: 360, margin: '120px auto' }}>
      <Heading size='lg' style={{ marginBottom: 16 }}>
        AskWRI Admin
      </Heading>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          placeholder='Username'
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          style={{ padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <input
          placeholder='Password'
          type='password'
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
        />
        <button
          type='submit'
          disabled={busy || !username || !password}
          style={{ padding: 10, background: '#0A3C5C', color: 'white', borderRadius: 4 }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <Text style={{ color: '#C11101' }}>{error}</Text>}
      </form>
    </Box>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
```

(`useSearchParams` requires the Suspense wrapper in App Router builds.)

- [x] **Step 4:** Create `src/app/admin/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default function AdminIndex() {
  redirect('/admin/review')
}
```

- [x] **Step 5:** Manual check — run `npm run dev`, visit `http://localhost:3000/admin` while logged out → redirected to `/admin/login`; log in with the Task 6 seeded admin → lands on `/admin/review` (404s for now — page arrives next task); nav renders. Then `npm run build` + `npm run lint`. *(deferred to Task 20 QA sweep)*

- [x] **Step 6:** Commit:

```bash
git add src/app/admin
git commit -m "feat: admin shell, login page, client API helper"
```

---

### Task 15: Review queue page

**Files:** Create `src/app/admin/review/page.tsx`.

- [x] **Step 1:** Implement the page — table of queue items with per-row actions. Promote/withdraw call the status route and surface the `reindex` result; row links go to the document editor for tag review:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../lib/api'

interface QueueItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  extractionConfidence: number | null
  jobStatus: string | null
  jobError: string | null
  jobAttempts: number | null
  suggestedTagCount: number
  createdAt: string
}

const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #eee' }

export default function ReviewQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const body = await adminFetch<{ items: QueueItem[] }>('/api/admin/review-queue')
      setItems(body.items)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const act = async (id: string, action: 'promote' | 'reingest') => {
    setBusyId(id)
    setNotice(null)
    setError(null)
    try {
      if (action === 'promote') {
        const body = await adminFetch(`/api/admin/documents/${id}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: 'searchable' }),
        })
        setNotice(
          body.reindex?.ok
            ? 'Promoted to searchable; keyword (BM25) index refreshed.'
            : `Promoted to searchable, but BM25 reindex failed (${body.reindex?.error}). ` +
              'The document is missing from keyword results until /reindex succeeds or the search service restarts.',
        )
      } else {
        await adminFetch(`/api/admin/documents/${id}/reingest`, { method: 'POST' })
        setNotice('Re-queued for ingestion.')
      }
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Box>
      <Heading size='lg' style={{ marginBottom: 8 }}>
        Review queue
      </Heading>
      <Text style={{ marginBottom: 16, color: '#555' }}>
        Documents flagged by the ingestion pipeline (low extraction confidence or errored jobs).
        Open a document to review metadata and suggested tags before promoting.
      </Text>
      {notice && <Text style={{ color: '#0A6640', marginBottom: 12 }}>{notice}</Text>}
      {error && <Text style={{ color: '#C11101', marginBottom: 12 }}>{error}</Text>}
      {items.length === 0 ? (
        <Text>Queue is empty. 🎉</Text>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['Document', 'Lang', 'Status', 'Confidence', 'Job', 'Suggested tags', 'Actions'].map(
                (h) => (
                  <th key={h} style={{ ...cell, textAlign: 'left', background: '#f7f7f7' }}>
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={cell}>
                  <Link href={`/admin/documents/${item.id}`} style={{ textDecoration: 'underline' }}>
                    {item.title || item.externalId}
                  </Link>
                </td>
                <td style={cell}>{item.language ?? '—'}</td>
                <td style={cell}>{item.status}</td>
                <td style={cell}>
                  {item.extractionConfidence != null ? item.extractionConfidence.toFixed(2) : '—'}
                </td>
                <td style={cell} title={item.jobError ?? undefined}>
                  {item.jobStatus ?? '—'}
                  {item.jobError ? ` ⚠ (${item.jobAttempts} attempts)` : ''}
                </td>
                <td style={cell}>{item.suggestedTagCount}</td>
                <td style={cell}>
                  <button
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, 'promote')}
                    style={{ marginRight: 8, textDecoration: 'underline' }}
                  >
                    Promote
                  </button>
                  <button
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, 'reingest')}
                    style={{ textDecoration: 'underline' }}
                  >
                    Re-ingest
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Box>
  )
}
```

- [x] **Step 2:** Manual check with the Appendix fixture applied: queue shows the fabricated doc; Promote moves it out of the queue and shows the reindex notice (search-service running → success message; stopped → the warning message). Restore fixture state afterwards. *(deferred to Task 20 QA sweep)*

- [x] **Step 3:** `npm run lint` + `npm run build`. Commit:

```bash
git add src/app/admin/review
git commit -m "feat: review queue page with promote/re-ingest and reindex feedback"
```

---

### Task 16: Document editor page

**Files:** Create `src/app/admin/documents/[id]/page.tsx`.

One page, four panels: (1) metadata form over the `EDITABLE_FIELDS` whitelist with provenance hints; (2) tags grouped by facet with status/source/confidence badges, accept/reject buttons on `suggested` rows, add-tag select fed by `/api/admin/tags`; (3) summaries read-only (native + English, long + short); (4) lifecycle box (status, promote/withdraw buttons with the same reindex feedback as Task 15, re-ingest, link to `/api/admin/documents/{id}/file` PDF preview in a new tab). Withdraw button renders only for `role==='admin'` (from `/api/admin/auth/me`).

- [x] **Step 1:** Implement the page. Skeleton (state + handlers — the JSX follows the same table/button idiom as Task 15; keep each panel a plain `<section>`):

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Box, Heading, Text } from '@chakra-ui/react'
import { adminFetch } from '../../lib/api'

interface Detail {
  document: Record<string, any>
  summaries: { language: string; kind: string; text: string; source: string | null }[]
  tags: {
    tagId: string
    facet: string
    valueId: string
    source: string
    status: string
    confidence: number | null
  }[]
  collections: { id: string; name: string; slug: string }[]
  latestJob: { status: string; stage: string | null; error: string | null; attempts: number } | null
}

const EDITABLE: { key: string; label: string; type?: 'number' }[] = [
  { key: 'title', label: 'Title' },
  { key: 'titleEn', label: 'Title (EN)' },
  { key: 'doi', label: 'DOI' },
  { key: 'abstract', label: 'Abstract' },
  { key: 'language', label: 'Language (ISO 639-1)' },
  { key: 'yearPublished', label: 'Year published', type: 'number' },
  { key: 'publicationTitle', label: 'Publication' },
  { key: 'articleType', label: 'Article type' },
  { key: 'wriPrimaryOffice', label: 'WRI primary office' },
]

export default function DocumentEditorPage() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [form, setForm] = useState<Record<string, any>>({})
  const [allTags, setAllTags] = useState<{ id: string; facet: string; valueId: string }[]>([])
  const [me, setMe] = useState<{ role?: string }>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const body = await adminFetch<Detail>(`/api/admin/documents/${id}`)
    setDetail(body)
    setForm(Object.fromEntries(EDITABLE.map(({ key }) => [key, body.document[key] ?? ''])))
  }, [id])

  useEffect(() => {
    load().catch((err) => setError(err.message))
    adminFetch<{ tags: any[] }>('/api/admin/tags').then((b) => setAllTags(b.tags))
    fetch('/api/admin/auth/me')
      .then((r) => r.json())
      .then((b) => setMe(b.identity ?? {}))
  }, [load])

  const saveMetadata = async () => {
    const patch: Record<string, any> = {}
    for (const { key, type } of EDITABLE) {
      const raw = form[key]
      patch[key] = raw === '' ? null : type === 'number' ? Number(raw) : raw
    }
    const body = await adminFetch(`/api/admin/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    setNotice(`Saved (${body.updated.length} field(s) changed).`)
    await load()
  }

  const decideTag = async (tagId: string, decision: 'accepted' | 'rejected') => {
    await adminFetch(`/api/admin/documents/${id}/tags/${tagId}`, {
      method: 'PATCH',
      body: JSON.stringify({ decision }),
    })
    await load()
  }

  const addTag = async (tagId: string) => {
    await adminFetch(`/api/admin/documents/${id}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tagId }),
    })
    await load()
  }

  const setStatus = async (status: 'searchable' | 'withdrawn') => {
    const body = await adminFetch(`/api/admin/documents/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
    setNotice(
      body.reindex?.ok
        ? `Status set to ${status}; keyword (BM25) index refreshed.`
        : `Status set to ${status}, but BM25 reindex failed (${body.reindex?.error}). ` +
          'Keyword results are stale until /reindex succeeds or the search service restarts.',
    )
    await load()
  }

  // ...render: error/notice banners, then the four <section> panels described above.
}
```

Render specifics the implementer must include:
- **Metadata panel:** one labeled `<input>` (or `<textarea>` for `abstract`) per `EDITABLE` entry bound to `form`, a Save button calling `saveMetadata`.
- **Tags panel:** group `detail.tags` by `facet`; each row shows `valueId`, a badge `${source}/${status}` (+ `confidence.toFixed(2)` when non-null); when `status === 'suggested'` show Accept/Reject buttons calling `decideTag`; an add-tag `<select>` listing `allTags` entries not already on the document, with an Add button calling `addTag`.
- **Summaries panel:** for each summary row, a heading `${language} · ${kind} (${source ?? 'unknown'})` and the text in a scrollable `<div>` (`maxHeight: 200, overflow: 'auto'`). Read-only.
- **Lifecycle panel:** current `status` + `extractionConfidence`; latest job status/stage/error if present; buttons — Promote (`setStatus('searchable')`, hidden when already searchable), Withdraw (`setStatus('withdrawn')`, rendered only when `me.role === 'admin'`), Re-ingest (POST to the reingest route, same as Task 15), and an `<a href={'/api/admin/documents/' + id + '/file'} target='_blank'>Open PDF</a>` link.
- **Collections panel (small):** list `detail.collections` with a remove button (`DELETE /api/admin/collections/{collectionId}/documents` with `{ documentId: id }`), and a `<select>` of all collections (`GET /api/admin/collections`) with an Add button (`POST .../documents` with `{ documentIds: [id] }`).

- [x] **Step 2:** Manual check (fixture doc): edit a title → audit row appears (`SELECT action, after FROM audit_log ORDER BY at DESC LIMIT 3` in psql); accept a suggested tag → row flips to `human/accepted`; reject → `human/rejected`; withdraw hidden for an editor user, shown for admin; PDF link 404s gracefully when the file isn't present locally. *(deferred to Task 20 QA sweep)*

- [x] **Step 3:** `npm run lint` + `npm run build`. Commit:

```bash
git add src/app/admin/documents
git commit -m "feat: document editor (metadata, tag decisions, lifecycle, collections)"
```

---

### Task 17: Catalog page + collections page

**Files:** Create `src/app/admin/documents/page.tsx`, `src/app/admin/collections/page.tsx`.

- [x] **Step 1:** Implement `src/app/admin/documents/page.tsx` — the admin catalog:
  - Filter bar: status `<select>` (all/draft/processing/needs_review/searchable/withdrawn/error), language `<select>` (en/es/zh/pt/id), collection `<select>` (from `/api/admin/collections`), free-text search `<input>`; every change refetches `/api/admin/documents?{params}` via `adminFetch`.
  - Result table: checkbox column, external id, title (link to `/admin/documents/{id}`), language, status, year. Same `cell` style constant as Task 15.
  - Bulk action bar (visible when ≥1 checked): a collection `<select>` + "Add N docs to collection" button → `POST /api/admin/collections/{id}/documents` with the checked `documentIds`, then a success notice ("Added N documents to <name>") and checkbox reset.
  - State: `items`, `filters`, `selected: Set<string>`, `notice`, `error` — same hooks pattern as Task 15.

- [x] **Step 2:** Implement `src/app/admin/collections/page.tsx`:
  - Table from `/api/admin/collections`: name, slug, description, document count, link "View documents" → `/admin/documents?collectionId={id}` (the catalog page reads `useSearchParams` for an initial filter — wrap in `Suspense` like the login page).
  - Create form: name + description inputs → `POST /api/admin/collections`, refresh on success, surface 409 errors inline.
  - Rename: inline edit button per row → `PATCH /api/admin/collections/{id}` with `{ name }`.

- [x] **Step 3:** Manual check: filter by `needs_review` finds the fixture doc; select two docs, add to the seeded collection; collection page count increments; "View documents" filter round-trips. *(deferred to Task 20 QA sweep)*

- [x] **Step 4:** `npm run lint` + `npm run build`. Commit:

```bash
git add src/app/admin/documents/page.tsx src/app/admin/collections
git commit -m "feat: admin catalog with filters/bulk-add and collections page"
```

---

### Task 18: Tags page + users page

**Files:** Create `src/app/admin/tags/page.tsx`, `src/app/admin/users/page.tsx`.

- [x] **Step 1:** Implement `src/app/admin/tags/page.tsx` (taxonomy curation, Scope decision 5):
  - Table from `/api/admin/tags` grouped by facet: value, accepted count, suggested count, taxonomy version, and (admin only, when both counts are 0) a Delete button → `DELETE /api/admin/tags/{id}` (confirm with `window.confirm`).
  - Add form: facet `<select>` (distinct facets from the loaded list, plus a free-text "new facet" input) + value input → `POST /api/admin/tags`; 409 shown inline.
  - A static note under the heading: *"Taxonomy v1 (raw CSV values). Rename/merge and version bumps are deferred until a curation owner is assigned — see docs/document-management.md §10.7."*

- [x] **Step 2:** Implement `src/app/admin/users/page.tsx` (admin-only — the API already 403s editors; the page shows the error banner if an editor navigates directly):
  - Table from `/api/admin/users`: username, email, role, active, last login.
  - Per row: role `<select>` (admin/editor) → PATCH on change; Activate/Deactivate toggle → PATCH `{ active }`; "Reset password" prompt (`window.prompt`, min 12 chars client-checked) → PATCH `{ password }`.
  - Create form: username, email, password, role → `POST /api/admin/users`.

- [x] **Step 3:** Manual check: create an editor user, log in as them in a private window → Users nav link hidden, `/admin/users` shows the forbidden banner, withdraw button absent in the editor; deactivate the editor → their next request 401s after cookie expiry **(note: JWT sessions outlive deactivation by up to the 7-day TTL — the `active` flag gates new logins; acceptable for an internal tool, noted in the docs task)**. *(deferred to Task 20 QA sweep)*

- [x] **Step 4:** `npm run lint` + `npm run build`. Commit:

```bash
git add src/app/admin/tags src/app/admin/users
git commit -m "feat: taxonomy curation and user management pages"
```

---

### Task 19 (CUTTABLE): Intake upload page

**Files:** Create `src/app/api/admin/intake/route.ts`, `src/app/admin/upload/page.tsx`.

Skip this task entirely if Phase 2 needs trimming — S3/local intake drop and the CSV import API already cover intake. If skipped, remove the Upload link from `src/app/admin/layout.tsx` NAV.

- [x] **Step 1:** Create `src/app/api/admin/intake/route.ts` — accepts `multipart/form-data` PDFs and drops them where the worker watches (S3 `INTAKE_S3_PREFIX` or `INTAKE_LOCAL_DIR` for dev). The worker handles dedup/registration from there (as-built §10.2):

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { writeFile, mkdir } from 'fs/promises'
import { join, basename } from 'path'
import { requireIdentity, auditActor } from '../../../../lib/auth/identity'
import { initializeDatabase } from '../../../../db/data-source'
import { writeAudit } from '../../../../db/queries/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  try {
    const form = await req.formData()
    const files = form.getAll('files').filter((f): f is File => f instanceof File)
    if (files.length === 0) {
      return NextResponse.json({ ok: false, error: 'no files provided' }, { status: 400 })
    }
    const bucket = process.env.DOCUMENTS_S3_BUCKET
    const intakePrefix = process.env.INTAKE_S3_PREFIX || 'intake/'
    const localDir = process.env.INTAKE_LOCAL_DIR
    if (!bucket && !localDir) {
      return NextResponse.json(
        { ok: false, error: 'no intake destination configured (DOCUMENTS_S3_BUCKET or INTAKE_LOCAL_DIR)' },
        { status: 500 },
      )
    }
    const uploaded: string[] = []
    for (const file of files) {
      const name = basename(file.name)
      if (!name.toLowerCase().endsWith('.pdf')) {
        return NextResponse.json({ ok: false, error: `${name}: only PDFs accepted` }, { status: 400 })
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bucket) {
        const s3 = new S3Client({})
        await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: `${intakePrefix}${name}`, Body: bytes }),
        )
      } else {
        await mkdir(localDir!, { recursive: true })
        await writeFile(join(localDir!, name), bytes)
      }
      uploaded.push(name)
    }
    await initializeDatabase()
    await writeAudit({
      ...auditActor(identity!),
      action: 'import',
      entityType: 'intake_upload',
      entityId: null,
      after: { files: uploaded },
    })
    return NextResponse.json({ ok: true, uploaded })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
```

- [x] **Step 2:** Create `src/app/admin/upload/page.tsx` — `<input type='file' multiple accept='.pdf'>` + Upload button POSTing `FormData` (note: do NOT set Content-Type manually — use raw `fetch`, not `adminFetch`, so the browser sets the multipart boundary; still handle 401 → login redirect). On success show "N file(s) dropped into intake — the worker registers them within ~`WORKER_POLL_SECONDS` (10s default); duplicates are skipped by content hash."

- [x] **Step 3:** Manual check (dev): set `INTAKE_LOCAL_DIR=./intake` in `.env`, upload a PDF, confirm the file lands in `./intake/`. If the worker is running (`--once` mode per runbook §"Phase 1 worker — local dev"), confirm a job appears. *(deferred to Task 20 QA sweep)*

- [x] **Step 4:** `npm run lint` + `npm run build`. Commit:

```bash
git add src/app/api/admin/intake src/app/admin/upload
git commit -m "feat: admin multi-file intake upload (cuttable)"
```

---

### Task 20: Docs, runbook, and final verification

**Files:** Modify `docs/document-management.md`, `docs/runbooks/phase0-cutover.md`.

- [x] **Step 1:** Append a `## 11. Phase 2 — Admin UI + review queue (as built)` section to `docs/document-management.md` covering: auth model (session JWT, bcryptjs, roles, `ADMIN_API_TOKEN`, the JWT-outlives-deactivation caveat), the route map (pages + APIs), tag-decision provenance rule (decision 7 — `source` flips to `human`), lifecycle actions + automatic `/reindex` trigger (closing §4's manual gotcha for UI-driven changes), what was deferred (purge, export, dashboard, audit UI, bulk collection ops, taxonomy rename/merge), and update §10.5's "A review UI is planned for Phase 2" sentence to point at the new section.

- [x] **Step 2:** Append an `## Admin UI — local dev` section to `docs/runbooks/phase0-cutover.md`: `SESSION_SECRET` generation, `npm run seed:admin -- <user> <pw>`, the review-queue fixture SQL (copy from the Appendix below), and the deploy note (add `SESSION_SECRET` — and `ADMIN_API_TOKEN` if used — to the app secret JSON; no terraform change).

- [x] **Step 3:** Full verification gate:

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run test:db
```

```bash
npm run build
```

Expected: all green (db suite against docker `askwri-pg`).

> **Result:** lint clean; `npm test` 106/106 (16 suites — DB suites also ran locally because
> `next/jest` loads `.env`'s `DATABASE_URL`); `npm run test:db` 26/26; build green via
> `npx next build --webpack` (see Task 5 deviation — Turbopack panics on the pre-existing
> venv symlink) with all 11 `/admin` pages, 19 `/api/admin` routes, and `ƒ Proxy (Middleware)`
> in the route table.

- [x] **Step 4:** Manual QA sweep (with fixture + seeded users): login/logout both roles → review queue promote with search-service up (success notice) and down (warning notice) → editor: metadata edit, tag accept/reject/add, collection add/remove → admin: withdraw + restore, taxonomy add/delete, user create/deactivate → confirm `audit_log` rows for each mutation class (`SELECT source, action, entity_type, count(*) FROM audit_log GROUP BY 1,2,3`).

> **Result (API-level sweep with the Appendix fixture, both roles):** all passes — login/logout
> both roles; editor metadata edit, tag accept/reject (DB confirms `source` flips to `human`,
> `model_version` retained, untouched rows stay `llm/suggested`), collection remove/re-add
> (`added: 1` count correct); editor withdraw and taxonomy delete both 403; admin withdraw +
> restore, taxonomy add/delete, user create/deactivate (deactivated login 401s) / reactivate;
> unauthenticated APIs 401, pages 307 → `/admin/login?next=…`; audit rows present for every
> mutation class; all 8 admin pages render 200; PDF file route degrades to a clean JSON error
> without local AWS creds (ECS task role provides them in deploy).
>
> **Deviation (reindex duration):** `/reindex` on the full local corpus (169 docs / 30,526
> chunks, postgres backend) takes ~540s — far beyond the 120s client timeout — so the
> promote/withdraw API reports `reindex: { ok: false, error: 'timeout' }` and the UI shows the
> staleness warning. The abort only severs the HTTP wait: the search-service keeps rebuilding
> and completes successfully (verified directly), so keyword results catch up minutes later and
> the warning copy stays accurate. Kept the planned 120s contract; the success-notice path is
> covered by the mocked-fetch unit tests (`admin-reindex.test.ts`). An in-browser click-through
> was not run (headless session); UI role gating (`me.role === 'admin'`) verified in code.

- [x] **Step 5:** Commit docs:

```bash
git add docs/document-management.md docs/runbooks/phase0-cutover.md
git commit -m "docs: Phase 2 as-built section and admin local-dev runbook"
```

- [x] **Step 6:** Merge to local `qa` (no push — same as Phases 0/1):

```bash
git checkout qa
```

```bash
git merge --no-ff phase2-admin-ui -m "Merge phase2-admin-ui: admin UI + review queue (Phase 2)"
```

---

## Appendix: review-queue fixture for local manual QA

The local `qa` db has **zero** `needs_review` docs, suggested tags, or jobs. Two options:

**Option A — SQL fixture (fast, reversible).** Pick a searchable doc and fabricate review state:

```sql
-- Flag one doc for review + give it 3 suggested LLM tags and an errored job:
UPDATE documents SET status='needs_review', extraction_confidence=0.42
WHERE external_id = (SELECT external_id FROM documents WHERE status='searchable' LIMIT 1);

INSERT INTO document_tags (document_id, tag_id, source, confidence, model_version, status)
SELECT d.id, t.id, 'llm', 0.55, 'fixture', 'suggested'
FROM (SELECT id FROM documents WHERE status='needs_review' LIMIT 1) d
CROSS JOIN (SELECT id FROM tags LIMIT 3) t
ON CONFLICT (document_id, tag_id) DO UPDATE SET status='suggested', source='llm', model_version='fixture';

INSERT INTO ingestion_jobs (document_id, stage, status, error, attempts)
SELECT id, 'parse', 'error', 'fixture: simulated parse failure', 3
FROM documents WHERE status='needs_review' LIMIT 1;
```

Revert after QA:

```sql
DELETE FROM ingestion_jobs WHERE error LIKE 'fixture:%';
DELETE FROM document_tags WHERE model_version = 'fixture';
UPDATE documents SET status='searchable', extraction_confidence=NULL WHERE status='needs_review';
DELETE FROM audit_log WHERE at > now() - interval '1 day';  -- optional: clear QA noise
```

**Option B — real pipeline.** Drop a low-text PDF into `INTAKE_LOCAL_DIR` and run the worker with `--once` until the publish stage routes it to `needs_review` (runbook §"Phase 1 worker — local dev"). Higher fidelity, slower; needs `OPENAI_API_KEY`.

## Execution notes

- **Do not push** `qa` or the feature branch; everything stays local (Phase 0/1 precedent).
- **Do not touch** `search-service/` — the `/query` contract and `/reindex` endpoint are consumed as-is.
- Tasks 8–13 (backend) are independent of Tasks 14–19 (UI) except where pages consume routes; Tasks 10 and 11 can run in parallel after Task 9.
- CI note: `pr-check.yml` runs `npm run test:ci` — the new DB-gated suites self-skip there (no `DATABASE_URL`), same as `catalog-items.db.test.ts`.
