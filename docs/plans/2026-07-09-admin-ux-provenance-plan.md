# Admin UX Explainers + Metadata-Provenance Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two metadata-provenance bugs (human edits never stamped; Node/Python key-convention mismatch) and make the admin UI self-explanatory for a non-technical SME (status glossary, field tooltips, provenance badges, plain-language copy, working in-app guide).

**Architecture:** A tiny pure module (`src/lib/metadataProvenance.ts`) becomes the single source of truth for entity-property → `metadata_source` key mapping, consumed by the query layer (stamping/reading) and the editor UI (badges). All provenance keys canonicalize on **snake_case DB column names** (what the Python worker already uses); a migration renames any camelCase keys written by the earlier import code. UI work is copy + small reusable components (StatusChip), no new dependencies, no new state management.

**Tech Stack:** Next.js 16 App Router (client components, inline styles), TypeORM 0.3 raw SQL migrations, Jest (jsdom + `*.db.test.ts` against docker pg).

---

## Context for the implementer (read first)

**Repo conventions you must follow (executors do NOT inherit CLAUDE.md — these are restated here):**

- React components are **arrow functions** (`const Foo = () => …; export default Foo`) — the `react/function-component-definition` eslint rule enforces this.
- Admin pages use plain inline styles + Chakra `Box/Heading/Text` only; `adminFetch` from `src/app/admin/lib/api.ts` for API calls. Match this; don't introduce new UI libraries.
- Entities use snake_case column names via `name:` options. Migrations are raw SQL via `queryRunner.query`, named `src/db/migrations/<epoch_ms>-Migration.ts`.
- Run `npx prettier --write` on touched files before every commit; `npm run lint` must stay clean.
- **Never add Co-Authored-By trailers to commit messages.**
- DB tests: `npm run test:db` (needs the local docker `askwri-pg`; the script hardcodes `DATABASE_URL`). Targeted jsdom tests: `npm test -- --testPathPattern='<name>'`.
- Local prod build check is `npx next build --webpack` (plain `next build` panics on the `search-service/venv` symlink).

**The provenance system (background):** `documents.metadata_source` is a jsonb map `{ <field>: 'human' | 'external' | 'llm' }` added in migration `1781330000000`. Writers:

- Python worker parse stage (`search-service/worker/stages/parse.py`) — stamps `'llm'` using **snake_case column names** (`title`, `authors`, `doi`, `year_published`, `article_type`, `wri_primary_office`); only overwrites a field whose source is NULL or `'llm'`.
- Node CSV import (`src/db/queries/importDocuments.ts`) — stamps `'external'` but currently uses **entity property names** (`yearPublished`, `articleType`, …), and reads the same camelCase keys in `computeOverwriteChanges`.
- Node admin editor (`src/db/queries/documentsAdmin.ts:updateDocumentFields`) — currently stamps **nothing**.

**Bug 1:** because the editor never stamps `'human'`, a re-ingest lets the worker's LLM extraction overwrite a person's correction, and CSV import doesn't show 🔒 protection for it.
**Bug 2:** because import stamps camelCase while the worker checks snake_case, the worker treats CSV-imported `year_published`/`article_type`/`wri_primary_office` as unprotected and overwrites them on re-ingest.

**Canonical decision:** `metadata_source` keys are **snake_case DB column names**, matching the worker and the flat-CSV headers. Node code changes to match; Python does not change.

**Auth note:** there is no `src/middleware.ts`; admin pages are client components that redirect on API 401s. The new `/admin/guide` page is static content and therefore reachable without login — that is acceptable (it contains no data, only documentation).

---

### Task 1: Shared provenance map (`src/lib/metadataProvenance.ts`)

**Files:**
- Create: `src/lib/metadataProvenance.ts`
- Test: `src/__tests__/metadata-provenance.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/metadata-provenance.test.ts
import { PROVENANCE_KEY, PROVENANCE_LABEL } from '../lib/metadataProvenance'

describe('metadataProvenance', () => {
  it('maps every editable entity property to its snake_case column', () => {
    expect(PROVENANCE_KEY.title).toBe('title')
    expect(PROVENANCE_KEY.titleEn).toBe('title_en')
    expect(PROVENANCE_KEY.yearPublished).toBe('year_published')
    expect(PROVENANCE_KEY.publicationTitle).toBe('publication_title')
    expect(PROVENANCE_KEY.articleType).toBe('article_type')
    expect(PROVENANCE_KEY.wriPrimaryOffice).toBe('wri_primary_office')
    expect(PROVENANCE_KEY.datePublished).toBe('date_published')
    expect(PROVENANCE_KEY.languages).toBe('languages')
  })

  it('has a plain-language label for every provenance source', () => {
    expect(PROVENANCE_LABEL.human).toMatch(/person/i)
    expect(PROVENANCE_LABEL.external).toMatch(/import/i)
    expect(PROVENANCE_LABEL.llm).toMatch(/AI/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPattern='metadata-provenance'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// src/lib/metadataProvenance.ts
/**
 * Single source of truth for documents.metadata_source key naming.
 *
 * metadata_source is a jsonb map { <snake_case column>: 'human'|'external'|'llm' }.
 * The Python worker (worker/stages/parse.py) reads/writes snake_case column
 * names; all Node writers/readers MUST use the same keys via this map.
 * Pure module — safe to import from both server (db/queries) and client (admin UI).
 */
export const PROVENANCE_KEY: Record<string, string> = {
  title: 'title',
  titleEn: 'title_en',
  doi: 'doi',
  language: 'language',
  languages: 'languages',
  yearPublished: 'year_published',
  publicationTitle: 'publication_title',
  articleType: 'article_type',
  wriPrimaryOffice: 'wri_primary_office',
  authors: 'authors',
  url: 'url',
  datePublished: 'date_published',
}

export const PROVENANCE_LABEL: Record<string, string> = {
  human: 'Edited by a person — protected; never overwritten by imports or AI',
  external: 'Imported from CSV — protected from AI overwrite; a new CSV import can change it',
  llm: 'AI-extracted from the PDF — may be refreshed on re-ingest',
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPattern='metadata-provenance'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadataProvenance.ts src/__tests__/metadata-provenance.test.ts
git commit -m "feat(admin): shared metadata_source key map (snake_case canonical)"
```

---

### Task 2: Stamp `'human'` provenance on editor metadata saves

**Files:**
- Modify: `src/db/queries/documentsAdmin.ts:144-188` (`updateDocumentFields`)
- Test: `src/__tests__/admin-documents.db.test.ts`

- [ ] **Step 1: Read the existing test file**

Open `src/__tests__/admin-documents.db.test.ts` and study how it creates fixture documents and calls query functions (it gates on `DATABASE_URL` and skips otherwise — copy that pattern exactly, including any `--runInBand` assumptions).

- [ ] **Step 2: Write the failing test** (adapt fixture creation to the file's existing helpers)

```ts
it('stamps metadata_source=human (snake_case keys) for every edited field', async () => {
  // create a fixture doc via the file's existing helper / repository insert
  const res = await updateDocumentFields(
    doc.id,
    { title: 'Corrected Title', yearPublished: 2020, wriPrimaryOffice: 'WRI Ross Center' },
    identity, // the file's existing AdminIdentity fixture
  )
  expect(res).toEqual({ updated: expect.arrayContaining(['title', 'yearPublished', 'wriPrimaryOffice']) })
  const [row] = await AppDataSource.query(
    `SELECT metadata_source FROM documents WHERE id = $1`, [doc.id],
  )
  expect(row.metadata_source).toMatchObject({
    title: 'human',
    year_published: 'human',      // snake_case — matches the worker's keys
    wri_primary_office: 'human',
  })
})

it('does not stamp provenance for fields that did not change', async () => {
  await updateDocumentFields(doc.id, { title: doc.title }, identity) // no-op patch
  const [row] = await AppDataSource.query(
    `SELECT metadata_source FROM documents WHERE id = $1`, [doc.id],
  )
  expect(row.metadata_source.title).toBeUndefined() // assert on the field actually in the no-op patch
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:db -- --testPathPattern='admin-documents'`
Expected: FAIL — `metadata_source` is `{}`.

- [ ] **Step 4: Implement the stamping**

In `updateDocumentFields`, import the map and extend the existing transaction (the mutation + audit already commit atomically — the stamp joins them):

```ts
import { PROVENANCE_KEY } from '../../lib/metadataProvenance'
```

```ts
  await AppDataSource.transaction(async (em) => {
    await em.getRepository(Document).save(doc)
    // Record field-level provenance so the worker's LLM extraction and CSV
    // imports never overwrite a human correction (keys are snake_case column
    // names — the convention the Python worker reads).
    const stamp = Object.fromEntries(updated.map((f) => [PROVENANCE_KEY[f] ?? f, 'human']))
    await em.query(
      `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(stamp)],
    )
    await em.query(
      `INSERT INTO audit_log (actor_user_id, source, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, 'update', 'document', $3, $4, $5)`,
      [auditActor(identity).actorUserId, auditActor(identity).source, id, before, after],
    )
  })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:db -- --testPathPattern='admin-documents'`
Expected: PASS (all suites in the file).

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/documentsAdmin.ts src/__tests__/admin-documents.db.test.ts
git commit -m "fix(admin): stamp metadata_source='human' on editor metadata saves (protects edits from LLM/CSV overwrite)"
```

---

### Task 3: Fix CSV import to read/write snake_case provenance keys

**Files:**
- Modify: `src/db/queries/importDocuments.ts` (three sites: `computeOverwriteChanges` ~line 447, the create-path stamp ~line 553-560, the update-path stamp ~line 606-617)
- Test: `src/__tests__/import-documents.test.ts` (unit), `src/__tests__/import-documents.db.test.ts` (integration)

- [ ] **Step 1: Write the failing unit test** (add to the existing `computeOverwriteChanges` describe block, ~line 490)

```ts
it('protects a multi-word field via its snake_case provenance key', () => {
  const mapped = { ...existing, yearPublished: 2030, isFlat: true } as any
  const { changes } = computeOverwriteChanges(existing, mapped, { year_published: 'human' })
  const change = changes.find((c) => c.field === 'yearPublished')
  expect(change!.protected).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPattern='import-documents.test'`
Expected: the new test FAILS (`protected` is `false` — the code looked up `metadataSource['yearPublished']`).

- [ ] **Step 3: Implement**

In `importDocuments.ts`, import the map:

```ts
import { PROVENANCE_KEY } from '../../lib/metadataProvenance'
```

Three changes:

```ts
// computeOverwriteChanges (~line 447)
const sourceForField = metadataSource[PROVENANCE_KEY[field] ?? field]
```

```ts
// create path (~line 556)
for (const f of OVERWRITABLE_FIELDS) {
  if (mapped[f] !== null && mapped[f] !== undefined) fields[PROVENANCE_KEY[f] ?? f] = 'external'
}
```

```ts
// update path (~line 606)
metaUpdates[PROVENANCE_KEY[field] ?? field] = 'external'
```

Note on the two `SET metadata_source = $2::jsonb` statements: the update path already merges in JS (`{ ...metaSource, ...metaUpdates }`) before replacing, so worker-stamped `'llm'` keys survive; the create path replaces outright, which is fine on a fresh row. Optionally switch both to `metadata_source || $2::jsonb` for defense in depth, but it is not required for correctness.

- [ ] **Step 4: Add an integration assertion** — in `import-documents.db.test.ts`, find the flat-import test that updates an existing doc and add:

```ts
const [row] = await AppDataSource.query(
  `SELECT metadata_source FROM documents WHERE id = $1`, [docId],
)
expect(row.metadata_source.year_published).toBe('external') // snake_case, not yearPublished
```

- [ ] **Step 5: Run both suites**

Run: `npm test -- --testPathPattern='import-documents.test'` → PASS
Run: `npm run test:db -- --testPathPattern='import-documents'` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/importDocuments.ts src/__tests__/import-documents.test.ts src/__tests__/import-documents.db.test.ts
git commit -m "fix(import): use snake_case metadata_source keys (matches worker; CSV values now survive re-ingest)"
```

---

### Task 4: Migration — normalize any existing camelCase provenance keys

Any DB that ran the old import code has camelCase keys. Cheap, idempotent rename.

**Files:**
- Create: `src/db/migrations/1781340000000-Migration.ts`

- [ ] **Step 1: Write the migration**

```ts
import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Normalize documents.metadata_source keys written by the pre-fix CSV import
 * (camelCase entity-property names) to the canonical snake_case column names
 * that the Python worker reads. Idempotent: only touches rows holding the
 * old key.
 */
const RENAMES: [string, string][] = [
  ['yearPublished', 'year_published'],
  ['publicationTitle', 'publication_title'],
  ['articleType', 'article_type'],
  ['wriPrimaryOffice', 'wri_primary_office'],
  ['datePublished', 'date_published'],
  ['titleEn', 'title_en'],
]

export class Migration1781340000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    for (const [from, to] of RENAMES) {
      await q.query(
        `UPDATE documents
         SET metadata_source = (metadata_source - $1) || jsonb_build_object($2::text, metadata_source -> $1)
         WHERE metadata_source ? $1`,
        [from, to],
      )
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [from, to] of RENAMES) {
      await q.query(
        `UPDATE documents
         SET metadata_source = (metadata_source - $2) || jsonb_build_object($1::text, metadata_source -> $2)
         WHERE metadata_source ? $2`,
        [from, to],
      )
    }
  }
}
```

- [ ] **Step 2: Run it against the local DB**

Run: `npm run migration:run`
Expected: `Migration1781340000000` executes successfully.

- [ ] **Step 3: Sanity-check by hand**

```bash
docker exec askwri-pg psql -U askwri -d qa -c "SELECT count(*) FROM documents WHERE metadata_source ?| array['yearPublished','articleType','wriPrimaryOffice','publicationTitle','datePublished','titleEn']"
```

Expected: `0`.

- [ ] **Step 4: Verify no spurious entity drift**

Run: `npm run test:db`
Expected: all pass (the migration is data-only; no schema change, so no entity updates needed).

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/1781340000000-Migration.ts
git commit -m "fix(db): normalize camelCase metadata_source keys to snake_case"
```

---

### Task 5: StatusChip component (status glossary everywhere)

**Files:**
- Create: `src/app/admin/components/StatusChip.tsx`
- Test: `src/__tests__/admin-status-chip.test.tsx`
- Modify: `src/app/admin/documents/page.tsx:332` (status cell), `src/app/admin/review/page.tsx:205` (status cell), `src/app/admin/documents/[id]/page.tsx:494` (lifecycle status row)

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/admin-status-chip.test.tsx
import { render, screen } from '@testing-library/react'
import { StatusChip } from '../app/admin/components/StatusChip'

describe('StatusChip', () => {
  it('renders the status with a plain-language tooltip', () => {
    render(<StatusChip status='needs_review' />)
    const chip = screen.getByText('needs_review')
    expect(chip.closest('[title]')!.getAttribute('title')).toMatch(/review/i)
  })

  it('renders unknown statuses without a tooltip crash', () => {
    render(<StatusChip status='weird' />)
    expect(screen.getByText('weird')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPattern='admin-status-chip'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```tsx
'use client'

/**
 * StatusChip — a document lifecycle status with a plain-language hover
 * explanation. Use everywhere a raw status string would otherwise appear.
 */
export const STATUS_META: Record<string, { color: string; bg: string; help: string }> = {
  // exported: the /admin/guide page (Task 10) renders this map as the status glossary table
  draft: {
    color: '#555', bg: '#eee',
    help: 'Registered but not yet processed by the ingestion pipeline. Not publicly searchable.',
  },
  processing: {
    color: '#0050C8', bg: '#e6f0ff',
    help: 'The ingestion pipeline is currently working on this document.',
  },
  needs_review: {
    color: '#B7791F', bg: '#fdf3e0',
    help: 'Held for human review — the PDF may not have parsed cleanly. Not publicly searchable until a person promotes it.',
  },
  searchable: {
    color: '#0A6640', bg: '#e4f2ea',
    help: 'Live in the public search corpus — users can find and read it.',
  },
  withdrawn: {
    color: '#C11101', bg: '#fdeaea',
    help: 'Removed from public search by an admin. The document still exists and an admin can restore it.',
  },
  error: {
    color: '#C11101', bg: '#fdeaea',
    help: 'Ingestion failed after retries. Open the document to see the error, then re-ingest.',
  },
}

export const StatusChip = ({ status }: { status: string }) => {
  const meta = STATUS_META[status]
  return (
    <span
      title={meta?.help}
      style={{
        background: meta?.bg ?? '#eee',
        color: meta?.color ?? '#555',
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 12,
        fontWeight: 600,
        cursor: meta ? 'help' : 'default',
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  )
}

export default StatusChip
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPattern='admin-status-chip'`
Expected: PASS

- [ ] **Step 5: Adopt it in the three pages**

- `documents/page.tsx` line ~332: `<td style={cell}>{doc.status}</td>` → `<td style={cell}><StatusChip status={doc.status} /></td>` (+ import).
- `review/page.tsx` line ~205: same replacement for `{item.status}`.
- `documents/[id]/page.tsx` lifecycle table Status row: `{doc.status}` → `<StatusChip status={doc.status} />` (+ import).

- [ ] **Step 6: Run the touched suites + lint**

Run: `npm test -- --testPathPattern='admin-editor|page'` → PASS (fix any text-matcher assertions that relied on bare status text — the chip preserves the text content, so failures are unlikely).
Run: `npm run lint` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/components/StatusChip.tsx src/__tests__/admin-status-chip.test.tsx src/app/admin/documents/page.tsx src/app/admin/review/page.tsx 'src/app/admin/documents/[id]/page.tsx'
git commit -m "feat(admin): StatusChip with plain-language status glossary, adopted across list/review/editor"
```

---

### Task 6: Document editor — tooltips, provenance badges, language dropdown, lifecycle guardrails

**Files:**
- Modify: `src/app/admin/documents/[id]/page.tsx`
- Test: `src/__tests__/admin-editor.test.tsx` (extend existing)

The document detail API already returns `document.metadataSource` (the entity is serialized whole), so no API change is needed. After Tasks 2–4 its keys are snake_case.

- [ ] **Step 1: Read `src/__tests__/admin-editor.test.tsx`** to learn its fetch-mocking pattern; the new tests below must reuse it (add `metadataSource: { title: 'llm', authors: 'human' }` to the mocked document fixture). Note: the file's document fixture is a shared module-level const with `status: 'searchable'` — parameterize the fetch-mock setup to accept a per-test document override for the draft/withdrawn cases, and add `fireEvent` to the `@testing-library/react` import (it isn't imported there yet).

- [ ] **Step 2: Write failing tests** (adapt to the file's helpers)

```tsx
it('shows a provenance badge for AI-extracted and human-edited fields', async () => {
  // fixture: metadataSource = { title: 'llm', authors: 'human' }
  render(<DocumentEditorPage />)
  expect(await screen.findByText('AI')).toBeInTheDocument()      // title badge
  expect(screen.getByText('person')).toBeInTheDocument()          // authors badge
})

it('renders Language as a dropdown of supported languages', async () => {
  render(<DocumentEditorPage />)
  const select = await screen.findByLabelText(/language/i)
  expect(select.tagName).toBe('SELECT')
  expect(select).toHaveDisplayValue(/English/)
})

it('hides Promote for a draft document', async () => {
  // fixture: document.status = 'draft'
  render(<DocumentEditorPage />)
  await screen.findByText('Document editor')
  expect(screen.queryByText('Promote')).not.toBeInTheDocument()
})

it('asks for confirmation before Withdraw', async () => {
  window.confirm = jest.fn(() => false)
  render(<DocumentEditorPage />)
  fireEvent.click(await screen.findByText('Withdraw'))
  expect(window.confirm).toHaveBeenCalled()
})
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npm test -- --testPathPattern='admin-editor'`
Expected: new tests FAIL, existing ones PASS.

- [ ] **Step 4: Implement the editor changes** — all in `documents/[id]/page.tsx`:

**(a) Intro copy** under the `Document editor` heading:

```tsx
<Text style={{ marginBottom: 16, color: '#555' }}>
  Edit this document&apos;s metadata, summaries, tags, and lifecycle. Fields you save here are
  marked &ldquo;edited by a person&rdquo; and are never overwritten by CSV imports or by the AI
  when the document is re-ingested. Saving takes effect immediately.
</Text>
```

**(b) Field help + language dropdown.** Extend `EDITABLE` with a `help` string per field and a `'select'` type for language:

```tsx
const LANGUAGES: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'zh', name: 'Chinese' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'id', name: 'Indonesian' },
]

const EDITABLE: { key: string; label: string; type?: 'number' | 'date' | 'textarea' | 'select'; help: string }[] = [
  { key: 'title', label: 'Title', help: 'The document title as shown in search results (in its original language).' },
  { key: 'titleEn', label: 'Title (EN)', help: 'English version of the title, shown to English-language users. Falls back to the native title if empty.' },
  { key: 'doi', label: 'DOI', help: 'Digital Object Identifier — the permanent link publishers assign (e.g. https://doi.org/10.46830/…). Also used to match rows in CSV imports.' },
  { key: 'authors', label: 'Authors', type: 'textarea', help: 'Author names, separated by semicolons (e.g. "Smith, John; Doe, Jane").' },
  { key: 'url', label: 'URL', help: 'The public landing page for this publication on wri.org.' },
  { key: 'datePublished', label: 'Date published', type: 'date', help: 'Full publication date, if known. Year alone goes in "Year published".' },
  { key: 'language', label: 'Language', type: 'select', help: 'The document’s primary language.' },
  { key: 'yearPublished', label: 'Year published', type: 'number', help: 'Publication year (used by the year filter in the catalog).' },
  { key: 'publicationTitle', label: 'Publication', help: 'The report or series this document belongs to.' },
  { key: 'articleType', label: 'Article type', help: 'The kind of publication (e.g. Report, Working Paper, Technical Note).' },
  { key: 'wriPrimaryOffice', label: 'WRI primary office', help: 'The WRI office or center primarily responsible (e.g. WRI Ross Center).' },
]
```

Render labels with the existing `Tooltip` component (`import { Tooltip } from '../../components/Tooltip'`):

```tsx
<td style={{ ...cell, width: 200, fontWeight: 500 }}>
  <Tooltip help={help}>{label}</Tooltip>
</td>
```

Render the select case (give it `aria-label='Language'` so the test's `findByLabelText` works):

```tsx
{type === 'select' ? (
  <select
    aria-label={label}
    value={form[key] ?? ''}
    onChange={(e) => { formDirty.current = true; setForm((f) => ({ ...f, [key]: e.target.value })) }}
    style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
  >
    <option value=''>—</option>
    {LANGUAGES.map((l) => (
      <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
    ))}
  </select>
) : type === 'textarea' ? ( /* existing */ ) : ( /* existing */ )}
```

**(c) Provenance badges.** Import the shared map and add a third column to the metadata table:

```tsx
import { PROVENANCE_KEY, PROVENANCE_LABEL } from '@/lib/metadataProvenance'

const PROVENANCE_BADGE: Record<string, { text: string; color: string; bg: string }> = {
  human: { text: 'person', color: '#0A6640', bg: '#e4f2ea' },
  external: { text: 'imported', color: '#0050C8', bg: '#e6f0ff' },
  llm: { text: 'AI', color: '#B7791F', bg: '#fdf3e0' },
}
```

```tsx
<td style={{ ...cell, width: 90 }}>
  {(() => {
    const src = doc?.metadataSource?.[PROVENANCE_KEY[key] ?? key]
    const badge = src ? PROVENANCE_BADGE[src] : null
    return badge ? (
      <span
        title={PROVENANCE_LABEL[src] ?? src}
        style={{ background: badge.bg, color: badge.color, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 600, cursor: 'help' }}
      >
        {badge.text}
      </span>
    ) : null
  })()}
</td>
```

**(d) Lifecycle guardrails.** Replace the Promote/Withdraw block:

```tsx
{doc?.status === 'needs_review' && (
  <button onClick={() => setStatus('searchable')} disabled={busy}
    title='Send this document to the public search corpus. Only reviewed documents can be promoted.'
    style={{ textDecoration: 'underline' }}>
    Promote
  </button>
)}
{doc?.status === 'withdrawn' && me.role === 'admin' && (
  <button onClick={() => setStatus('searchable')} disabled={busy}
    title='Put this withdrawn document back in the public search corpus.'
    style={{ textDecoration: 'underline' }}>
    Restore
  </button>
)}
{me.role === 'admin' && doc?.status !== 'withdrawn' && (
  <button
    onClick={() => {
      if (window.confirm('Withdraw this document? It disappears from public search immediately. An admin can restore it later.')) {
        setStatus('withdrawn')
      }
    }}
    disabled={busy}
    title='Remove this document from public search immediately (reversible — admins can restore).'
    style={{ textDecoration: 'underline' }}>
    Withdraw
  </button>
)}
```

Add `title` tooltips to the remaining buttons: Re-ingest (`'Re-run the ingestion pipeline on the same PDF. AI summaries and AI-extracted metadata are regenerated; fields and summaries edited by a person are preserved.'`), Open PDF (`'Open the stored PDF in a new tab.'`), Delete (`'Permanently delete this document, its search index entries, and its PDF. Cannot be undone.'`).

**(e) Source metadata as a table** — replace the `<pre>{JSON.stringify(…)}</pre>` with:

```tsx
<table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
  <tbody>
    {Object.entries(doc.sourceMetadata).map(([k, v]) => (
      <tr key={k}>
        <td style={{ ...cell, width: 220, fontWeight: 500, verticalAlign: 'top' }}>{k}</td>
        <td style={cell}>{typeof v === 'string' ? v : JSON.stringify(v)}</td>
      </tr>
    ))}
  </tbody>
</table>
```

and retitle the `<summary>` to `Original imported metadata (read-only)` with a short explainer line: `These are the values that came with the document when it was first imported — kept for reference, never edited.`

**(f) Tag chips in plain language.** Replace the `{tag.source}/{tag.status}` chip content:

```tsx
const tagChipText = (tag: Detail['tags'][number]) => {
  const source = tag.source === 'llm' ? 'AI' : tag.source === 'human' ? 'person' : 'imported'
  const conf = tag.confidence != null ? ` · ${Math.round(tag.confidence * 100)}%` : ''
  return `${source} · ${tag.status}${conf}`
}
```

with `title` on the chip: `'Who applied this tag and its review state. AI-suggested tags need a person to Accept or Reject them; accepting makes the tag permanent (the AI will never change it again).'` Add `title` tooltips to Accept (`'Keep this tag. It becomes a human decision the AI cannot override.'`) and Reject (`'Remove this suggestion. The AI will not re-suggest it.'`).

**(g) Summaries explainer** under the Summaries heading:

```tsx
<Text style={{ marginBottom: 12, color: '#555', fontSize: 13 }}>
  Each document carries a long and a short summary, in its own language and in English.
  &ldquo;generated&rdquo; summaries were written by the AI and are refreshed on re-ingest;
  once you save an edit, the summary is yours and the AI never overwrites it.
</Text>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --testPathPattern='admin-editor'`
Expected: PASS (update any existing assertions broken by the new markup — e.g. tests matching the old `llm/suggested` chip text or the old Promote-visibility rule).

- [ ] **Step 6: Lint + prettier, commit**

```bash
npm run lint
npx prettier --write 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git add 'src/app/admin/documents/[id]/page.tsx' src/__tests__/admin-editor.test.tsx
git commit -m "feat(admin): editor field tooltips, provenance badges, language dropdown, lifecycle guardrails"
```

---

### Task 7: Upload page — duplicate-skip explainer + metric tooltips

**Files:**
- Modify: `src/app/admin/upload/page.tsx`

- [ ] **Step 1: Add the duplicate explainer** — extend the intro `Text` (line ~99):

```tsx
<Text style={{ marginBottom: 16, color: '#555' }}>
  Select one or more PDF files. They will be placed in the intake queue and registered by the
  ingestion worker automatically. <strong>If a file is identical to a document already in the
  system, it is silently skipped as a duplicate</strong> — it will not appear in the catalog a
  second time. To re-process an existing document, use <strong>Re-ingest</strong> on its
  document page instead of uploading the file again.
</Text>
```

- [ ] **Step 2: Add tooltips to the worker metrics** (line ~118) — wrap the two terms with the existing `Tooltip` component:

```tsx
<Text style={{ fontSize: 13, color: '#666' }}>
  <Tooltip help='Documents currently queued or being processed by the pipeline.'>Queue depth</Tooltip>: {health.queueDepth} ·{' '}
  <Tooltip help='Uploaded files the worker has not registered yet. A non-zero backlog right after an upload is normal.'>Intake backlog</Tooltip>: {health.intakeBacklog}
  {health.lastProcessedAt && ` · Last processed: ${new Date(health.lastProcessedAt).toLocaleString()}`}
</Text>
```

- [ ] **Step 3: Verify + commit**

Run: `npm test -- --testPathPattern='upload|worker-health'` → PASS. `npm run lint` → clean.

```bash
git add src/app/admin/upload/page.tsx
git commit -m "feat(admin): upload page explains duplicate skipping; tooltips on worker metrics"
```

---

### Task 8: Import page — plain-language rewrite, preview legend, column reference

**Files:**
- Modify: `src/app/admin/import/page.tsx`
- Test: `src/__tests__/admin-import-page.test.tsx` (update copy assertions if they match replaced text)

- [ ] **Step 1: Replace the two intro paragraphs** (lines ~164-174) with:

```tsx
<Text style={{ marginBottom: 8, color: '#555' }}>
  Update document metadata in bulk from a spreadsheet. Save your sheet as CSV using the column
  names from the template below — each row updates the matching document, or creates a new
  entry if nothing matches. Rows are matched to existing documents by <strong>external_id</strong>{' '}
  first, then by <strong>doi</strong>. Values in your CSV replace what&apos;s in the system
  (you&apos;ll see exactly what changes in the preview) — except fields a person has edited,
  which are protected and never overwritten.
</Text>
<Text style={{ marginBottom: 16, color: '#555', fontStyle: 'italic' }}>
  Always click <strong>Preview</strong> first — it&apos;s a safe dry-run that shows every change
  without writing anything. <strong>Apply</strong> imports for real.
</Text>
```

- [ ] **Step 2: Add a column reference** `<details>` next to the template link:

```tsx
<details style={{ marginBottom: 16, fontSize: 13, color: '#555' }}>
  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Column reference</summary>
  <ul style={{ marginTop: 8, paddingLeft: 20, lineHeight: 1.7 }}>
    <li><strong>external_id</strong> — the document&apos;s unique ID in this system (shown in the catalog). Best way to match an existing document.</li>
    <li><strong>doi</strong> — used to match if external_id is empty.</li>
    <li><strong>file_path</strong> — the PDF filename; only needed when creating a new document entry.</li>
    <li><strong>title, authors, url, publication_title, article_type, wri_primary_office</strong> — plain text. Authors separated by semicolons.</li>
    <li><strong>year_published</strong> — a 4-digit year. <strong>date_published</strong> — a full date, as in the template.</li>
    <li><strong>languages</strong> — full names, comma-separated (e.g. &ldquo;English, Spanish&rdquo;).</li>
    <li><strong>summary, short_summary</strong> — optional descriptive text.</li>
  </ul>
  <Text style={{ marginTop: 4 }}>Leave any cell empty to leave that field alone. Extra columns are ignored.</Text>
</details>
```

- [ ] **Step 3: Add a legend above the dry-run preview table** (inside the `decisions` block, under the `Dry-run preview` heading):

```tsx
<Text style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
  <span style={{ color: '#0A6640' }}>green</span> = fills an empty field ·{' '}
  <span style={{ color: '#B8860B' }}>⚠ amber</span> = replaces an existing value ·{' '}
  <span style={{ color: '#C11101' }}>🔒 red</span> = protected (a person edited this field; the CSV will NOT change it)
</Text>
```

- [ ] **Step 4: Run the page tests; update assertions matching the removed copy**

Run: `npm test -- --testPathPattern='admin-import-page'`
Expected: PASS after updating any stale text matchers (e.g. assertions on "DB column names" / "fill-only-empty").

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/app/admin/import/page.tsx src/__tests__/admin-import-page.test.tsx
git add src/app/admin/import/page.tsx src/__tests__/admin-import-page.test.tsx
git commit -m "feat(admin): import page plain-language copy, column reference, preview legend"
```

---

### Task 9: Review + Tags pages — `pending` worker state, jargon pass, confidence tooltip

**Files:**
- Modify: `src/app/admin/review/page.tsx`, `src/app/admin/tags/page.tsx`

- [ ] **Step 1: Add `pending` to the review page's worker styles** (`review/page.tsx:33`), matching the upload page's semantics:

```tsx
const WORKER_STYLE: Record<string, { color: string; label: string }> = {
  idle: { color: '#0A6640', label: 'running (idle)' },
  processing: { color: '#0050C8', label: 'running (processing)' },
  pending: { color: '#B7791F', label: 'files just dropped — worker should pick them up shortly' },
  stale: { color: '#C11101', label: 'NOT RUNNING — dropped files are not being processed' },
}
```

- [ ] **Step 2: Jargon pass on visible copy** (code comments may keep the § refs):
  - `review/page.tsx` multilingual-gap explainer (~line 160): remove `(design §7.5)` and rephrase: `…have no summary in their own language (only English). A native-language summary helps same-language search find the document. Re-ingesting these documents regenerates the missing summaries.`
  - Empty-state text (~line 179): replace `multilingual-renditions backlog (missing native summaries)` with `documents missing a summary in their own language`.
  - `Missing title_en:` label (~line 150) → `Missing English title:`.
  - `tags/page.tsx` intro (~line 145-154): drop `(design §8)` and `(design §10.7)`; replace the second paragraph with: `Note: tag values are currently the raw imported strings. Admins can rename them; merging duplicate values is planned but not built yet.`

- [ ] **Step 3: Confidence tooltip on the review table header** — replace the `'Confidence'` header entry with a `Tooltip`-wrapped version (import Tooltip; note the header array maps strings, so switch that one cell to render the component):

```tsx
<Tooltip help='How cleanly the PDF text was extracted, from 0 to 1. Below 0.7 the document is held here for human review instead of going public automatically.'>Confidence</Tooltip>
```

- [ ] **Step 4: Verify + commit**

Run: `npm test -- --testPathPattern='admin'` → PASS. `npm run lint` → clean.

```bash
npx prettier --write src/app/admin/review/page.tsx src/app/admin/tags/page.tsx
git add src/app/admin/review/page.tsx src/app/admin/tags/page.tsx
git commit -m "fix(admin): pending worker state on review page; plain-language copy pass (drop design § refs)"
```

---

### Task 10: In-app guide at `/admin/guide`; fix the broken footer link

**Files:**
- Create: `src/app/admin/guide/page.tsx`
- Modify: `src/app/admin/layout.tsx` (nav Help link + footer link + role tooltip)
- Modify: `docs/admin-guide.md` (becomes a pointer stub)
- Test: `src/__tests__/admin-guide-page.test.tsx`

Background: the footer currently links to `/docs/admin-guide.md`, which 404s (`public/` is empty and the Docker runner image only copies `public/`, `.next/`, and `evaluation/` — `docs/` is not served). The guide becomes a JSX page (no markdown dependency; content is bundled). The page is static and reachable without login — acceptable, it contains documentation only.

- [ ] **Step 1: Write the failing test**

```tsx
// src/__tests__/admin-guide-page.test.tsx
import { render, screen } from '@testing-library/react'
import GuidePage from '../app/admin/guide/page'

describe('Admin guide page', () => {
  it('renders the core sections', () => {
    render(<GuidePage />)
    expect(screen.getByRole('heading', { name: /admin guide/i })).toBeInTheDocument()
    expect(screen.getByText(/typical workflow/i)).toBeInTheDocument()
    expect(screen.getByText(/document statuses/i)).toBeInTheDocument()
    expect(screen.getByText(/who last set each field/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --testPathPattern='admin-guide-page'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the guide page.** Structure (arrow-function component, Chakra `Box/Heading/Text`, same styling idiom as other pages). Content sections — write these out fully, in plain SME-facing language, reusing the copy written in Tasks 5–9 so terminology matches:

1. **Heading:** "AskWRI Admin Guide" + one-line purpose.
2. **Typical workflow:** Upload PDFs → the pipeline processes them (parse → detect language → summarize → tag → index → publish) → documents that need attention land in the Review queue → review, fix metadata, accept/reject tags → Promote. Bulk metadata via Import.
3. **Document statuses:** a table of the six statuses reusing `STATUS_META` help text from `StatusChip` (import the component or the map — import the map to render a definition table).
4. **Who last set each field (provenance):** explain the three badges (person / imported / AI) and the overwrite rules: person-edited fields are permanent; imported fields survive re-ingest but a new CSV can change them; AI fields refresh on re-ingest.
5. **Page-by-page:** one short paragraph each for Review queue, Documents, Document editor, Collections, Tags, Upload, Import (admin), Users (admin) — updated from `docs/admin-guide.md`, including the Import page and the Delete action which the old guide lacked.
6. **The ingestion pipeline & re-ingest:** the six stages in plain words; what re-ingest regenerates vs. preserves.
7. **FAQ:** "I uploaded a file and it never appeared" (duplicate skip / worker not running — check the status panel on Upload); "Promote is missing" (only documents in needs_review can be promoted; withdrawn ones need an admin Restore); "What does confidence mean?"; "Who can do what?" (editor vs. admin capability list).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --testPathPattern='admin-guide-page'`
Expected: PASS

- [ ] **Step 5: Wire the links in `layout.tsx`:**
  - Add to `NAV`: `{ href: '/admin/guide', label: 'Help', help: 'The admin guide — what each page does, document statuses, and how the ingestion pipeline works.' }`
  - Footer: change `href='/docs/admin-guide.md'` → `href='/admin/guide'`.
  - Role tooltip: `<div title={me.role === 'admin' ? 'Admin: everything an editor can do, plus withdraw/restore/delete documents, delete tags, CSV import, and user management.' : 'Editor: review, edit metadata and summaries, manage tags and collections, upload PDFs.'}>{me.username} ({me.role})</div>`

- [ ] **Step 6: Replace `docs/admin-guide.md` body with a pointer stub** (keep the file so old links/readers aren't stranded):

```markdown
# AskWRI Admin Guide

The admin guide now lives **inside the app** at `/admin/guide` (linked as
"Help" in the admin sidebar), so it can't drift from the UI.

Source of truth: `src/app/admin/guide/page.tsx`. Edit it there.
```

- [ ] **Step 7: Full verification**

Run: `npm test` → all pass. `npm run lint` → clean. `npx next build --webpack` → green.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/app/admin/guide/page.tsx src/app/admin/layout.tsx docs/admin-guide.md src/__tests__/admin-guide-page.test.tsx
git add src/app/admin/guide/page.tsx src/app/admin/layout.tsx docs/admin-guide.md src/__tests__/admin-guide-page.test.tsx
git commit -m "feat(admin): in-app guide at /admin/guide; fix broken footer guide link; role tooltip"
```

---

### Task 11: Final verification sweep

- [ ] **Step 1: Full suites**

Run, in order:
- `npm test` → expect ~35 suites, 0 failures (count grows with the new test files)
- `npm run test:db` → 0 failures
- `npm run test:python` → all pass, 1 opt-in skip (nothing here touches Python — this is a regression guard for the shared `metadata_source` contract)
- `npm run lint` → clean
- `npm run format:check` → clean
- `npx next build --webpack` → green

- [ ] **Step 2: Manual smoke against the local stack** (`docker start askwri-pg`, search service, `npm run dev`; login `admin`/`admin-local-password`):
  - Edit a field in the editor → badge flips to "person"; re-ingest the doc → the edited field survives, AI fields refresh.
  - `/admin/import` → download template, preview a CSV touching a human-edited field → 🔒 protected row.
  - Hover status chips in catalog/review/editor; open `/admin/guide` from the sidebar and the footer.
- [ ] **Step 3: Fix anything found, amend or add commits, re-run the affected suite.**
