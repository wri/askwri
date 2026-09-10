# Author Name Format Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `documents.authors` converge on the `Family, Given; Family, Given` convention: tidy+flag at CSV import, repair existing `external` and `llm` rows with a dry-run-by-default script, and ship a canonical author key for future aggregation consumers.

**Architecture:** One pure module (`src/lib/authorFormat.ts`) owns all string logic (parse, tidy, keys, repair planning). The CSV import path calls `tidyAuthorsField()` and stamps/clears a `metadata_source.authors_format` flag. A thin tsx script (`scripts/repair-author-formats.ts`) queries candidates + evidence from the DB, delegates every decision to the pure planner, applies guarded UPDATEs, and writes audit rows. No migrations — `metadata_source` is free-form jsonb.

**Tech Stack:** TypeScript (Next.js repo, TypeORM 0.3), Jest (jsdom) for tests, ts-node for the script, Postgres.

**Spec:** `docs/superpowers/specs/2026-09-09-author-name-format-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/authorFormat.ts` (create) | Pure author-string logic: split, parse, format, tidy, keys, evidence index, repair planner |
| `src/__tests__/author-format.test.ts` (create) | Unit tests for everything in the module |
| `src/db/queries/importDocuments.ts` (modify) | Tidy authors at mapping; stamp/clear `authors_format`; preview warnings |
| `src/__tests__/author-import-tidy.test.ts` (create) | Unit tests for the mapping/tidy integration (pure parts) |
| `src/db/queries/audit.ts` (modify) | Add `'author_format_repair'` to `AuditAction` |
| `scripts/repair-author-formats.ts` (create) | IO shell: query, plan, report, guarded apply, audit |
| `package.json` (modify) | `repair:author-formats` script |
| `docs/document-management.md` (modify) | Format contract + runbook section |

Branch: `fix/author-name-formats` (already checked out; PR targets `qa` — **never `main`**, a push there deploys production).

---

### Task 1: Pure module — parse, tidy, keys

**Files:**
- Create: `src/lib/authorFormat.ts`
- Test: `src/__tests__/author-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/author-format.test.ts`:

```ts
import {
  splitAuthorsField,
  parseAuthorName,
  formatAuthorName,
  tidyAuthorsField,
  canonicalAuthorKey,
  strictAuthorKey,
} from '../lib/authorFormat'

describe('splitAuthorsField', () => {
  it('splits on semicolons, trims, and drops empties', () => {
    expect(splitAuthorsField('Mahendra, Anjali; Pai, Madhav')).toEqual([
      'Mahendra, Anjali',
      'Pai, Madhav',
    ])
    expect(splitAuthorsField('A;; B ;')).toEqual(['A', 'B'])
    expect(splitAuthorsField('  Anjali  Mahendra  ')).toEqual(['Anjali Mahendra'])
    expect(splitAuthorsField('')).toEqual([])
  })
})

describe('parseAuthorName', () => {
  it('splits on the FIRST comma and collapses whitespace', () => {
    expect(parseAuthorName('Amos,Albert')).toEqual({
      family: 'Amos',
      given: 'Albert',
      hasComma: true,
      isSplittable: true,
    })
    expect(parseAuthorName('  Mahendra ,   Anjali ')).toEqual({
      family: 'Mahendra',
      given: 'Anjali',
      hasComma: true,
      isSplittable: true,
    })
  })

  it('treats comma-less multi-token names as family = last token', () => {
    expect(parseAuthorName('Anjali Mahendra')).toEqual({
      family: 'Mahendra',
      given: 'Anjali',
      hasComma: false,
      isSplittable: true,
    })
    expect(parseAuthorName('Adriazola-Steil Claudia')).toEqual({
      family: 'Adriazola-Steil',
      given: 'Claudia',
      hasComma: false,
      isSplittable: true,
    })
  })

  it('single tokens and empty families are not splittable', () => {
    expect(parseAuthorName('Cheng')).toEqual({
      family: 'Cheng',
      given: '',
      hasComma: false,
      isSplittable: false,
    })
    expect(parseAuthorName(', Albert')).toEqual({
      family: '',
      given: 'Albert',
      hasComma: true,
      isSplittable: false,
    })
  })
})

describe('formatAuthorName', () => {
  it('renders Family, Given for splittable names', () => {
    expect(
      formatAuthorName({ family: 'Amos', given: 'Albert', hasComma: true, isSplittable: true }),
    ).toBe('Amos, Albert')
    expect(
      formatAuthorName({ family: 'Smith', given: '', hasComma: true, isSplittable: true }),
    ).toBe('Smith')
  })

  it('returns the family unchanged for non-splittable names', () => {
    expect(
      formatAuthorName({ family: 'Cheng', given: '', hasComma: false, isSplittable: false }),
    ).toBe('Cheng')
  })
})

describe('tidyAuthorsField', () => {
  it('reformats comma spacing and separators', () => {
    expect(tidyAuthorsField('Amos,Albert')).toEqual({
      value: 'Amos, Albert',
      changed: true,
      unverified: false,
    })
    expect(tidyAuthorsField('A;B')).toEqual({ value: 'A; B', changed: true, unverified: false })
    expect(tidyAuthorsField('Mahendra, Anjali;  Pai , Madhav ')).toEqual({
      value: 'Mahendra, Anjali; Pai, Madhav',
      changed: true,
      unverified: false,
    })
  })

  it('keeps comma-less names verbatim and flags the field', () => {
    expect(tidyAuthorsField('Anjali Mahendra')).toEqual({
      value: 'Anjali Mahendra',
      changed: false,
      unverified: true,
    })
    expect(tidyAuthorsField('Coalition for Urban Transitions')).toEqual({
      value: 'Coalition for Urban Transitions',
      changed: false,
      unverified: true,
    })
    expect(tidyAuthorsField('Amos, Albert; Anjali Mahendra')).toEqual({
      value: 'Amos, Albert; Anjali Mahendra',
      changed: false,
      unverified: true,
    })
  })

  it('keeps non-splittable comma fragments verbatim and flags them', () => {
    expect(tidyAuthorsField(', Albert')).toEqual({
      value: ', Albert',
      changed: false,
      unverified: true,
    })
  })

  it('is idempotent', () => {
    const once = tidyAuthorsField('Amos,Albert; Anjali Mahendra')
    const twice = tidyAuthorsField(once.value)
    expect(twice).toEqual(once)
    expect(twice.changed).toBe(false)
  })
})

describe('canonicalAuthorKey', () => {
  it('folds to family + given initials', () => {
    expect(canonicalAuthorKey('Mahendra, Anjali')).toBe('mahendra|a')
    expect(canonicalAuthorKey('Mahendra, A.')).toBe('mahendra|a')
    expect(canonicalAuthorKey('Anjali Mahendra')).toBe('mahendra|a')
  })

  it('folds diacritics and keeps hyphens', () => {
    expect(canonicalAuthorKey('Muñoz, Ana')).toBe('munoz|a')
    expect(canonicalAuthorKey('Adriazola-Steil, Claudia')).toBe('adriazola-steil|c')
  })

  it('handles multi-token given names and empty givens', () => {
    expect(canonicalAuthorKey('Garcia, Claudia Maria')).toBe('garcia|cm')
    expect(canonicalAuthorKey('WHO')).toBe('who|')
  })
})

describe('strictAuthorKey', () => {
  it('uses the full given name — initials would merge distinct people', () => {
    expect(strictAuthorKey('Li, Xiangyi')).toBe('li|xiangyi')
    expect(strictAuthorKey('Li, Xiaoyi')).toBe('li|xiaoyi')
    expect(strictAuthorKey('Li, Xiangyi')).not.toBe(strictAuthorKey('Li, Xiaoyi'))
  })

  it('strips periods and matches order-swapped spellings of the same person', () => {
    expect(strictAuthorKey('Mahendra, A.')).toBe('mahendra|a')
    expect(strictAuthorKey('A. Mahendra')).toBe('mahendra|a')
  })

  it('treats differently-spaced givens as distinct (conservative)', () => {
    expect(strictAuthorKey('Li, Xiang Yi')).toBe('li|xiang yi')
    expect(strictAuthorKey('Li, Xiangyi')).not.toBe(strictAuthorKey('Li, Xiang Yi'))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/author-format.test.ts`
Expected: FAIL — `Cannot find module '../lib/authorFormat'`

- [ ] **Step 3: Implement `src/lib/authorFormat.ts`**

```ts
/**
 * Author name format utilities (issue #411).
 *
 * Format contract: documents.authors is a semicolon-delimited string; each
 * person is "Family, Given". Organizations and unverified names are free
 * text. CSV-imported values may arrive in any order; the repair script flips
 * a comma-less "Given Family" name ONLY when a comma'd sibling for the same
 * person exists somewhere in the corpus.
 *
 * Pure module — safe to import from server code and scripts; no I/O.
 * CONSUMERS THAT GROUP BY AUTHOR (future admin filters, /experts) MUST:
 *   1. group on canonicalAuthorKey(name), never the raw string;
 *   2. skip or down-weight documents whose metadata_source.authors_format
 *      is 'unverified';
 *   3. split fields with splitAuthorsField (semicolons only, never commas).
 * The Python side (search-service, where /experts will live) must port these
 * functions exactly: family = diacritic-folded (NFD, combining marks
 * stripped), lowercased, hyphens kept; given reduced to initials (first
 * character of each whitespace-separated token, periods stripped), joined
 * with no separator; key = `${family}|${initials}`.
 */

export interface ParsedAuthorName {
  family: string
  given: string
  hasComma: boolean
  isSplittable: boolean
}

export interface TidyResult {
  value: string
  changed: boolean
  unverified: boolean
}

/** Collapse internal whitespace runs to single spaces and trim. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Lowercase and strip diacritics; keeps hyphens and letters. */
function foldToken(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function splitAuthorsField(raw: string): string[] {
  return (raw || '')
    .split(';')
    .map((v) => collapseWhitespace(v))
    .filter(Boolean)
}

export function parseAuthorName(name: string): ParsedAuthorName {
  const trimmed = collapseWhitespace(name)
  if (trimmed.includes(',')) {
    const idx = trimmed.indexOf(',')
    const family = collapseWhitespace(trimmed.slice(0, idx))
    const given = collapseWhitespace(trimmed.slice(idx + 1))
    return { family, given, hasComma: true, isSplittable: family.length > 0 }
  }
  const tokens = trimmed.split(' ').filter(Boolean)
  if (tokens.length >= 2) {
    return {
      family: tokens[tokens.length - 1],
      given: tokens.slice(0, -1).join(' '),
      hasComma: false,
      isSplittable: true,
    }
  }
  // Single token: an organization or a mononym — not guessable.
  return { family: trimmed, given: '', hasComma: false, isSplittable: false }
}

/** "Family, Given" for splittable names; the family (unchanged) otherwise. */
export function formatAuthorName(parsed: ParsedAuthorName): string {
  if (!parsed.isSplittable) return parsed.family
  return parsed.given ? `${parsed.family}, ${parsed.given}` : parsed.family
}

/**
 * Import-path tidying: comma'd names are reformatted to "Family, Given"
 * (fixes "Amos,Albert", "A , B", double spaces); separator whitespace is
 * normalized ("A;B" -> "A; B"). Comma-less names are kept verbatim (order is
 * never guessed here) and set `unverified: true` when any name lacks a comma.
 */
export function tidyAuthorsField(raw: string): TidyResult {
  const segments = (raw || '').split(';')
  const out: string[] = []
  let unverified = false
  for (const segment of segments) {
    const collapsed = collapseWhitespace(segment)
    if (collapsed.length === 0) continue
    const parsed = parseAuthorName(collapsed)
    if (parsed.hasComma && parsed.isSplittable) {
      out.push(formatAuthorName(parsed))
    } else {
      out.push(collapsed)
      unverified = true
    }
  }
  const value = out.join('; ')
  return { value, changed: value !== raw, unverified }
}

/**
 * Aggregation key collapsing residual variants: "Mahendra, Anjali" and
 * "Mahendra, A." both -> "mahendra|a". Collapses distinct people sharing a
 * family name and first initial — acceptable for ranking aggregation, where
 * dedup matters more than splitting. Consumers should skip fields flagged
 * authors_format='unverified'.
 */
export function canonicalAuthorKey(name: string): string {
  const parsed = parseAuthorName(name)
  const initials = parsed.given
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => foldToken(t).replace(/\./g, '').charAt(0))
    .join('')
  return `${foldToken(parsed.family)}|${initials}`
}

/**
 * Full-precision key for repair matching: "mahendra|anjali". Initials would
 * merge distinct people (Li, Xiangyi vs Li, Xiaoyi -> li|x). Differently
 * spaced givens ("Xiang Yi" vs "Xiangyi") stay distinct — conservative.
 */
export function strictAuthorKey(name: string): string {
  const parsed = parseAuthorName(name)
  return `${foldToken(parsed.family)}|${foldToken(parsed.given).replace(/\./g, '')}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/author-format.test.ts`
Expected: PASS (all suites)

- [ ] **Step 5: Commit**

```bash
git add src/lib/authorFormat.ts src/__tests__/author-format.test.ts
git commit -m "feat(authors): pure author-format module — parse, tidy, keys (issue #411)"
```

---

### Task 2: Pure repair planner + evidence index

**Files:**
- Modify: `src/lib/authorFormat.ts` (append)
- Test: `src/__tests__/author-format.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — put the new imports at the TOP of `src/__tests__/author-format.test.ts`, the `EVIDENCE` constant and describe blocks at the bottom:

```ts
import {
  planAuthorRepairs,
  buildEvidenceIndex,
  type CandidateDoc,
} from '../lib/authorFormat'

const EVIDENCE = new Map<string, string>([
  ['mahendra|anjali', 'Mahendra, Anjali'],
  ['pai|madhav', 'Pai, Madhav'],
])

describe('buildEvidenceIndex', () => {
  it('normalizes comma'd evidence forms and dedupes identical people', () => {
    const idx = buildEvidenceIndex([
      { src: 'llm', canonical: 'Amos,Albert' },
      { src: 'external', canonical: 'Amos, Albert' },
    ])
    expect(idx.get('amos|albert')).toBe('Amos, Albert')
  })

  it('breaks true conflicts by source quality: human > external > llm', () => {
    const idx = buildEvidenceIndex([
      { src: 'llm', canonical: 'Meneses, Sandra' },
      { src: 'human', canonical: 'meneses, Sandra' }, // case variant: same strict key
    ])
    expect(idx.get('meneses|sandra')).toBe('meneses, Sandra')
  })
})

describe('planAuthorRepairs', () => {
  const doc = (authors: string, provenance: 'external' | 'llm' = 'external'): CandidateDoc => ({
    id: '11111111-1111-1111-1111-111111111111',
    externalId: 'doc-1',
    authors,
    provenance,
  })

  it('flips an external comma-less name with strict-key evidence', () => {
    const [plan] = planAuthorRepairs([doc('Anjali Mahendra')], EVIDENCE)
    expect(plan.ops[0]).toEqual({
      type: 'flip',
      before: 'Anjali Mahendra',
      after: 'Mahendra, Anjali',
      key: 'mahendra|anjali',
    })
    expect(plan.finalAuthors).toBe('Mahendra, Anjali')
    expect(plan.authorsChanged).toBe(true)
    expect(plan.stillUnverified).toBe(false)
  })

  it('flips llm rows under the same evidence rule', () => {
    const [plan] = planAuthorRepairs([doc('Madhav Pai', 'llm')], EVIDENCE)
    expect(plan.ops[0].type).toBe('flip')
    expect(plan.finalAuthors).toBe('Pai, Madhav')
  })

  it('flags unconfirmed external comma-less names; whitespace-tidies them only', () => {
    const [plan] = planAuthorRepairs([doc('  Xyz   Abc ')], EVIDENCE)
    expect(plan.ops[0]).toEqual({ type: 'flag-unverified', before: 'Xyz Abc', after: 'Xyz Abc' })
    expect(plan.stillUnverified).toBe(true)
    expect(plan.authorsChanged).toBe(true) // whitespace collapsed
    expect(plan.finalAuthors).toBe('Xyz Abc')
  })

  it('drops llm docs whose names have no evidence (no-op)', () => {
    expect(planAuthorRepairs([doc('Xyz Abc', 'llm')], EVIDENCE)).toEqual([])
  })

  it('flags single-token external names and drops single-token llm names', () => {
    expect(planAuthorRepairs([doc('Cheng')], EVIDENCE)[0].stillUnverified).toBe(true)
    expect(planAuthorRepairs([doc('Cheng', 'llm')], EVIDENCE)).toEqual([])
  })

  it('fixes comma spacing on both provenances without evidence', () => {
    for (const provenance of ['external', 'llm'] as const) {
      const [plan] = planAuthorRepairs([doc('Amos,Albert', provenance)], EVIDENCE)
      expect(plan.ops[0].type).toBe('fix-spacing')
      expect(plan.finalAuthors).toBe('Amos, Albert')
    }
  })

  it('handles mixed ops in one doc with one plan', () => {
    const [plan] = planAuthorRepairs(
      [doc('Anjali Mahendra; Amos,Albert; Cheng; Pai, Madhav')],
      EVIDENCE,
    )
    expect(plan.ops.map((o) => o.type)).toEqual([
      'flip',
      'fix-spacing',
      'flag-unverified',
      'none',
    ])
    expect(plan.finalAuthors).toBe('Mahendra, Anjali; Amos, Albert; Cheng; Pai, Madhav')
    expect(plan.stillUnverified).toBe(true)
  })

  it('drops external docs that are already tidy and need no flag', () => {
    expect(planAuthorRepairs([doc('Pai, Madhav')], EVIDENCE)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/author-format.test.ts`
Expected: FAIL — `planAuthorRepairs` / `buildEvidenceIndex` not exported

- [ ] **Step 3: Implement the planner** (append to `src/lib/authorFormat.ts`)

```ts
// ---------------------------------------------------------------------------
// Repair planning (pure — the script owns all I/O)
// ---------------------------------------------------------------------------

export type RepairOpType = 'fix-spacing' | 'flip' | 'flag-unverified' | 'none'

export interface RepairOp {
  type: RepairOpType
  before: string
  after: string
  /** strictAuthorKey used for a flip. */
  key?: string
}

export interface CandidateDoc {
  id: string
  externalId: string
  authors: string
  provenance: 'external' | 'llm'
}

export interface RepairDocPlan {
  documentId: string
  externalId: string
  provenance: 'external' | 'llm'
  originalAuthors: string
  ops: RepairOp[]
  finalAuthors: string
  authorsChanged: boolean
  /** External only: comma-less names remain, so authors_format must be set. */
  stillUnverified: boolean
}

/**
 * Plan repairs for candidate documents. Rules (spec 2026-09-09 §3):
 * - comma'd but badly spaced -> fix-spacing (no evidence needed, both rows)
 * - comma-less with a strict-key match in the evidence index -> flip (both rows)
 * - comma-less, no match, external -> flag-unverified (name untouched apart
 *   from whitespace collapsing; the flag marks values that cannot self-heal)
 * - comma-less, no match, llm -> untouched, no flag (the worker may rewrite
 *   the field at any re-ingest; llm no-match docs are dropped entirely)
 * External docs are planned when authors change OR the flag must be set; llm
 * docs only when authors change.
 */
export function planAuthorRepairs(
  candidates: CandidateDoc[],
  evidence: ReadonlyMap<string, string>,
): RepairDocPlan[] {
  const plans: RepairDocPlan[] = []
  for (const doc of candidates) {
    const ops: RepairOp[] = splitAuthorsField(doc.authors).map((name) => {
      const parsed = parseAuthorName(name)
      if (parsed.hasComma && parsed.isSplittable) {
        const after = formatAuthorName(parsed)
        return {
          type: (after === name ? 'none' : 'fix-spacing') as RepairOpType,
          before: name,
          after,
        }
      }
      const canonical = evidence.get(strictAuthorKey(name))
      if (canonical) {
        return { type: 'flip' as const, before: name, after: canonical, key: strictAuthorKey(name) }
      }
      if (doc.provenance === 'external') {
        return { type: 'flag-unverified' as const, before: name, after: collapseWhitespace(name) }
      }
      return { type: 'none' as const, before: name, after: name }
    })
    const finalAuthors = ops.map((op) => op.after).join('; ')
    const authorsChanged = finalAuthors !== doc.authors
    const stillUnverified = ops.some((op) => op.type === 'flag-unverified')
    const needsWrite =
      doc.provenance === 'external' ? authorsChanged || stillUnverified : authorsChanged
    if (!needsWrite) continue
    plans.push({
      documentId: doc.id,
      externalId: doc.externalId,
      provenance: doc.provenance,
      originalAuthors: doc.authors,
      ops,
      finalAuthors,
      authorsChanged,
      stillUnverified,
    })
  }
  return plans
}

// ---------------------------------------------------------------------------
// Evidence index (pure — the script feeds it query rows)
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  /** metadata_source->>'authors' of the row the comma'd name came from. */
  src: string
  /** A comma'd name as stored, e.g. "Amos,Albert" or "Mahendra, Anjali". */
  canonical: string
}

const SOURCE_PRIORITY: Record<string, number> = { human: 0, external: 1, llm: 2 }

/**
 * strictAuthorKey -> tidy canonical "Family, Given". Collisions on distinct
 * normalized spellings are broken by source quality: human > external > llm.
 */
export function buildEvidenceIndex(rows: EvidenceRow[]): Map<string, string> {
  const best = new Map<string, { value: string; rank: number }>()
  for (const row of rows) {
    const value = formatAuthorName(parseAuthorName(row.canonical))
    const key = strictAuthorKey(value)
    const rank = SOURCE_PRIORITY[row.src] ?? 3
    const existing = best.get(key)
    if (!existing) {
      best.set(key, { value, rank })
    } else if (existing.value !== value && rank < existing.rank) {
      best.set(key, { value, rank })
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.value]))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/author-format.test.ts`
Expected: PASS (all suites, including Task 1's)

- [ ] **Step 5: Commit**

```bash
git add src/lib/authorFormat.ts src/__tests__/author-format.test.ts
git commit -m "feat(authors): pure repair planner + evidence index (issue #411)"
```

---

### Task 3: CSV import integration

**Files:**
- Modify: `src/db/queries/importDocuments.ts`
- Test: `src/__tests__/author-import-tidy.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/author-import-tidy.test.ts`:

```ts
import {
  mapFlatRowToDocument,
  mapRowToDocument,
  computeOverwriteChanges,
  type FlatImportRow,
} from '../db/queries/importDocuments'
import type { Document } from '../db/entities/Document.entity'

describe('import mapping tidies authors', () => {
  it('flat rows: comma spacing fixed, no flag', () => {
    const mapped = mapFlatRowToDocument({ authors: 'Amos,Albert', file_path: 'x.pdf' })
    expect(mapped.authors).toBe('Amos, Albert')
    expect(mapped.authorsUnverified).toBe(false)
  })

  it('flat rows: comma-less value kept verbatim and flagged', () => {
    const mapped = mapFlatRowToDocument({ authors: 'Anjali Mahendra', file_path: 'x.pdf' })
    expect(mapped.authors).toBe('Anjali Mahendra')
    expect(mapped.authorsUnverified).toBe(true)
  })

  it('legacy rows: column tidied; sourceMetadata keeps the raw archival blob', () => {
    const mapped = mapRowToDocument({
      file_path: 'x.pdf',
      metadata: { 'All authors': 'Anjali Mahendra; Amos,Albert' },
    })
    expect(mapped.authors).toBe('Anjali Mahendra; Amos, Albert')
    expect(mapped.authorsUnverified).toBe(true)
    // source_metadata is the raw import record for legacy rows — NOT tidied.
    expect(mapped.sourceMetadata.metadata['All authors']).toBe('Anjali Mahendra; Amos,Albert')
  })

  it('null authors stay null and unflagged', () => {
    const mapped = mapFlatRowToDocument({ file_path: 'x.pdf' } as FlatImportRow)
    expect(mapped.authors).toBeNull()
    expect(mapped.authorsUnverified).toBe(false)
  })
})

describe('computeOverwriteChanges flags unverified authors', () => {
  const existing = {
    authors: 'Old Author',
    title: 'T',
    language: 'en',
    languages: ['en'],
    yearPublished: 2020,
    publicationTitle: null,
    doi: null,
    articleType: null,
    wriPrimaryOffice: null,
    url: null,
    datePublished: null,
  } as unknown as Document

  it('warns when overwriting authors with an unverified value', () => {
    const mapped = mapFlatRowToDocument({
      authors: 'Anjali Mahendra',
      file_path: 'x.pdf',
    })
    const { warnings } = computeOverwriteChanges(existing, mapped, {})
    expect(warnings).toContain("⚠ authors: \"Old Author\" → \"Anjali Mahendra\" (overwrite)")
    expect(warnings).toContain('⚠ authors: format unverified (name without comma)')
  })

  it('does not warn on verified overwrites', () => {
    const mapped = mapFlatRowToDocument({ authors: 'Amos, Albert', file_path: 'x.pdf' })
    const { warnings } = computeOverwriteChanges(existing, mapped, {})
    expect(warnings).not.toContain('⚠ authors: format unverified (name without comma)')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/author-import-tidy.test.ts`
Expected: FAIL — `authorsUnverified` missing on `MappedDocument`; the unverified warning never fires

- [ ] **Step 3: Modify `src/db/queries/importDocuments.ts`**

3a. Add the import at the top (after the `PROVENANCE_KEY` import):

```ts
import { tidyAuthorsField } from '../../lib/authorFormat'
```

3b. Extend `MappedDocument` (add one property after `authors: string | null`):

```ts
  authors: string | null
  /** True when any author name lacked a comma (tidyAuthorsField). */
  authorsUnverified: boolean
```

3c. In `mapRowToDocument` (legacy), replace the `authors` line:

```ts
    authors: (raw['All authors'] as string | undefined) || null,
```

with:

```ts
    authors: legacyTidy?.value ?? null,
    authorsUnverified: legacyTidy?.unverified ?? false,
```

and add just before the `return {` of `mapRowToDocument`:

```ts
  const rawAuthors = (raw['All authors'] as string | undefined) || null
  const legacyTidy = rawAuthors ? tidyAuthorsField(rawAuthors) : null
```

3d. In `mapFlatRowToDocument`, replace:

```ts
  const authors = resolveField(row, 'authors', 'All authors') || null
```

with:

```ts
  const authorsRaw = resolveField(row, 'authors', 'All authors') || null
  const authorsTidy = authorsRaw ? tidyAuthorsField(authorsRaw) : null
  const authors = authorsTidy?.value ?? null
```

and in that function's `return {` block replace:

```ts
    authors,
```

with:

```ts
    authors,
    authorsUnverified: authorsTidy?.unverified ?? false,
```

(The `sourceMetadata` mirror already builds `'All authors': authors` from the same variable, so it now stores the tidied value — consistent with the flat path's existing reconstruction.)

3e. In `computeOverwriteChanges`, inside the field loop, extend the overwrite-warning branch. Replace:

```ts
    if (isOverwrite) {
      warnings.push(`⚠ ${field}: "${existingStr}" → "${mappedStr}" (overwrite)`)
    }
```

with:

```ts
    if (isOverwrite) {
      warnings.push(`⚠ ${field}: "${existingStr}" → "${mappedStr}" (overwrite)`)
      if (field === 'authors' && mapped.authorsUnverified) {
        warnings.push('⚠ authors: format unverified (name without comma)')
      }
    }
```

3f. In `importDocuments`, the CREATED path — extend `createdDecision` so unverified authors surface in the dry-run preview. Replace:

```ts
      const createdDecision = {
        externalId: mapped.externalId,
        action: 'created' as const,
        matchKey: mapped.doi
          ? `doi:${mapped.doi}`
          : `external_id:${mapped.externalId}`,
      }
```

with:

```ts
      const createdDecision = {
        externalId: mapped.externalId,
        action: 'created' as const,
        matchKey: mapped.doi
          ? `doi:${mapped.doi}`
          : `external_id:${mapped.externalId}`,
        warnings: mapped.authorsUnverified
          ? ['⚠ authors: format unverified (name without comma)']
          : undefined,
      }
```

3g. In the same CREATED path, after the existing metadata_source stamp block (`if (hasMetadataSource && mapped.isFlat) { ... }`), add the flag stamp (covers both row shapes — the legacy create path stamps nothing today, and this only adds the flag, never `'external'`):

```ts
          // authors_format flag: marks CSV values that cannot self-heal
          // (external provenance shields them from the worker's rewrite).
          // Legacy-seed fills leave provenance NULL — worker-overwritable,
          // so they self-heal and get no flag.
          if (hasMetadataSource && mapped.authorsUnverified) {
            await AppDataSource.query(
              `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
              [insertedId, JSON.stringify({ authors_format: 'unverified' })],
            ).catch(() => {})
          }
```

3h. In the FLAT overwrite apply block, the flag must follow the authors field. After `metaUpdates` is built (inside `for (const c of changes) { ... }` loop's closing brace, before the `if (Object.keys(updates).length > 0) {`), add:

```ts
            const authorsWritten = 'authors' in metaUpdates
            if (authorsWritten && mapped.authorsUnverified) {
              metaUpdates.authors_format = 'unverified'
            }
```

and replace the metadata_source UPDATE inside that block:

```ts
              if (hasMetadataSource) {
                await AppDataSource.query(
                  `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
                  [existing.id, JSON.stringify(metaUpdates)],
                ).catch(() => {})
              }
```

with:

```ts
              if (hasMetadataSource) {
                // A verified authors overwrite clears a stale flag; the flag
                // is otherwise written iff authors is written (human-
                // protected authors never reach metaUpdates, so protection
                // is inherited).
                const clearFlag = authorsWritten && !mapped.authorsUnverified
                await AppDataSource.query(
                  clearFlag
                    ? `UPDATE documents SET metadata_source = (metadata_source - 'authors_format') || $2::jsonb WHERE id = $1`
                    : `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
                  [existing.id, JSON.stringify(metaUpdates)],
                ).catch(() => {})
              }
```

(Leave the legacy fill-only-empty branch untouched — it writes authors with NULL provenance, which the worker can overwrite, so it self-heals and needs no flag.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/author-import-tidy.test.ts src/__tests__/author-format.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full existing test suite (regression)**

Run: `npm test`
Expected: PASS — no existing test asserts on raw un-tidied author values (if one does, update it to the tidied expectation; that is the intended behavior change)

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/importDocuments.ts src/__tests__/author-import-tidy.test.ts
git commit -m "feat(import): tidy authors and stamp/clear authors_format flag (issue #411)"
```

---

### Task 4: Repair script

**Files:**
- Modify: `src/db/queries/audit.ts` (one line)
- Create: `scripts/repair-author-formats.ts`
- Modify: `package.json` (one line)

- [ ] **Step 1: Extend the audit action union**

In `src/db/queries/audit.ts`, change:

```ts
  | 'collection_change'
  | 'import'
```

to:

```ts
  | 'collection_change'
  | 'import'
  | 'author_format_repair'
```

(`audit_log.action` is a plain `text` column with no CHECK constraint — DDL at `src/db/migrations/1781280000000-Migration.ts:170`.)

- [ ] **Step 2: Create `scripts/repair-author-formats.ts`**

```ts
import 'reflect-metadata'
import { AppDataSource } from '../src/db/data-source'
import { writeAudit } from '../src/db/queries/audit'
import {
  buildEvidenceIndex,
  planAuthorRepairs,
  type CandidateDoc,
  type EvidenceRow,
} from '../src/lib/authorFormat'

/**
 * One-off repair for mixed author name formats (issue #411; spec
 * docs/superpowers/specs/2026-09-09-author-name-format-design.md).
 *
 * Dry-run by default; pass --apply to commit. Idempotent: external docs
 * already flagged authors_format='unverified' and fully-comma'd docs are
 * never re-planned, so a rerun after --apply performs no writes.
 *
 * Ownership note: this script writes llm-provenanced authors — a deliberate,
 * bounded exception to one-owner-per-domain (evidence-gated flips only,
 * provenance left 'llm' so the worker can still supersede on re-ingest).
 * Every written doc gets an audit row recording that rationale.
 *
 * Run against an environment:
 *   ./scripts/with-remote-env.sh qa         npm run repair:author-formats
 *   ./scripts/with-remote-env.sh qa         npm run repair:author-formats -- --apply
 *   ./scripts/with-remote-env.sh production npm run repair:author-formats -- --apply
 */

const CANDIDATE_SQL = `
  SELECT DISTINCT d.id::text AS id, d.external_id, d.authors,
         d.metadata_source->>'authors' AS provenance
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND d.metadata_source->>'authors' IN ('external', 'llm')
    AND NOT EXISTS (
      SELECT 1 FROM ingestion_jobs j
      WHERE j.document_id = d.id AND j.status IN ('queued', 'running')
    )
    AND NOT (d.metadata_source ? 'authors_format')
    AND (
      position(',' in trim(u.nm)) = 0
      OR trim(u.nm) <> regexp_replace(regexp_replace(trim(u.nm), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ')
    )
`

const EVIDENCE_SQL = `
  SELECT d.metadata_source->>'authors' AS src, trim(u.nm) AS canonical
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND position(',' in trim(u.nm)) > 0
    AND trim(u.nm) <> ''
`

async function main() {
  const apply = process.argv.includes('--apply')
  await AppDataSource.initialize()
  try {
    const evidenceRows = (await AppDataSource.query(EVIDENCE_SQL)) as Array<{
      src: string | null
      canonical: string
    }>
    const evidence = buildEvidenceIndex(
      evidenceRows.map((r): EvidenceRow => ({ src: r.src ?? 'llm', canonical: r.canonical })),
    )

    const candidateRows = (await AppDataSource.query(CANDIDATE_SQL)) as Array<{
      id: string
      external_id: string
      authors: string
      provenance: 'external' | 'llm'
    }>
    const candidates: CandidateDoc[] = candidateRows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      authors: r.authors,
      provenance: r.provenance,
    }))

    const plans = planAuthorRepairs(candidates, evidence)

    const counts = { 'fix-spacing': 0, flip: 0, 'flag-unverified': 0 }
    for (const plan of plans) {
      for (const op of plan.ops) {
        if (op.type in counts) counts[op.type as keyof typeof counts]++
      }
    }

    console.log(`Author format repair — ${apply ? 'APPLY' : 'DRY RUN'}`)
    console.log(
      `Evidence keys: ${evidence.size} | Candidates: ${candidates.length} docs -> ${plans.length} planned`,
    )
    console.log(
      `Ops: fix-spacing=${counts['fix-spacing']} flip=${counts.flip} flag-unverified=${counts['flag-unverified']}`,
    )
    const untouchedLlm = candidates.filter(
      (c) => c.provenance === 'llm' && !plans.some((p) => p.documentId === c.id),
    ).length
    if (untouchedLlm > 0) {
      console.log(
        `LLM no-op (comma-less, no verified sibling — untouched): ${untouchedLlm} docs`,
      )
    }
    for (const plan of plans) {
      const summary = plan.ops
        .filter((op) => op.type !== 'none')
        .map((op) =>
          op.before === op.after
            ? `${op.type}: '${op.before}'`
            : `${op.type}: '${op.before}' -> '${op.after}'`,
        )
        .join('; ')
      console.log(`  [${plan.provenance}] ${plan.externalId}: ${summary}`)
    }

    if (!apply) {
      console.log('Dry run — rerun with --apply to commit these changes.')
      return
    }

    let applied = 0
    let dropped = 0
    for (const plan of plans) {
      const flagJson = JSON.stringify(
        plan.provenance === 'external' && plan.stillUnverified
          ? { authors_format: 'unverified' }
          : {},
      )
      const result = await AppDataSource.transaction(async (tm) => {
        const updated =
          plan.provenance === 'external'
            ? await tm.query(
                `UPDATE documents
                 SET authors = $2,
                     metadata_source = (metadata_source - 'authors_format') || $3::jsonb
                 WHERE id = $1::uuid AND metadata_source->>'authors' = 'external'
                 RETURNING id`,
                [plan.documentId, plan.finalAuthors, flagJson],
              )
            : await tm.query(
                `UPDATE documents
                 SET authors = $2
                 WHERE id = $1::uuid AND metadata_source->>'authors' = 'llm'
                 RETURNING id`,
                [plan.documentId, plan.finalAuthors],
              )
        if (updated.length === 0) return false
        await writeAudit(
          {
            actorUserId: null,
            source: 'system',
            action: 'author_format_repair',
            entityType: 'documents',
            entityId: plan.documentId,
            before: { authors: plan.originalAuthors },
            after: {
              authors: plan.finalAuthors,
              provenance: plan.provenance,
              ops: plan.ops.filter((o) => o.type !== 'none').map((o) => o.type),
              rationale:
                'issue #411 one-off: evidence-gated author format repair; ' +
                'llm rows keep provenance so the worker may supersede on re-ingest',
            },
          },
          tm,
        )
        return true
      })
      if (result) {
        applied++
      } else {
        dropped++
        console.log(`  DROPPED (guard missed — provenance changed concurrently?): ${plan.externalId}`)
      }
    }
    console.log(`Applied: ${applied} | Dropped: ${dropped}`)
  } finally {
    await AppDataSource.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

- [ ] **Step 3: Add the npm script** — in `package.json`, insert a new entry alongside the other seed scripts (e.g. right after the `"seed:tag-aliases"` line), preserving valid JSON (mind the trailing comma):

```json
    "repair:author-formats": "ts-node --project tsconfig.typeorm.json -r ./scripts/load-env.js scripts/repair-author-formats.ts",
```

- [ ] **Step 4: Typecheck the script**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors (the script is included via path aliasing; if tsconfig excludes `scripts/`, run `npx tsc --noEmit --skipLibCheck --module commonjs --target es2020 --esModuleInterop --resolveJsonModule scripts/repair-author-formats.ts` instead and fix what it reports)

- [ ] **Step 5: Smoke the dry run locally (optional; needs the local docker DB from `./scripts/local-bootstrap.sh`)**

Run: `npm run repair:author-formats`
Expected: report prints with `DRY RUN`, zero rows applied, exit 0. (Local counts will differ from QA.)

- [ ] **Step 6: Commit**

```bash
git add scripts/repair-author-formats.ts src/db/queries/audit.ts package.json
git commit -m "feat(repair): author format repair script — dry-run default, guarded apply, audit (issue #411)"
```

---

### Task 5: Docs + full gates

**Files:**
- Modify: `docs/document-management.md`

- [ ] **Step 1: Add the format contract + runbook section** — append to `docs/document-management.md`:

```markdown
## Author name format (issue #411)

`documents.authors` is a semicolon-delimited string; each person is
`Family, Given` (e.g. `Mahendra, Anjali; Pai, Madhav`). The ingest worker
writes this format; CSV imports may deliver any order.

- **CSV imports** tidy comma spacing on arrival and mark values that still
  contain a comma-less name with `metadata_source.authors_format =
  'unverified'` — these are CSV-sourced (`external`) values the worker is
  forbidden from rewriting, so they cannot self-heal. A later CSV import with
  a fully comma'd value clears the flag.
- **`scripts/repair-author-formats.ts`** repairs existing rows. It flips a
  comma-less `Given Family` name to the `Family, Given` form only when a
  comma'd spelling of the same person (strict key: family + full given name,
  diacritic-folded) exists elsewhere in the corpus; unconfirmed external
  names are left in place and flagged `unverified`; llm rows are flipped
  under the same evidence rule (provenance stays `llm`, so a future re-ingest
  supersedes the script's value). Human-edited rows are never touched. The
  script is dry-run by default; `--apply` commits, writes one
  `author_format_repair` audit row per changed document, and is idempotent.

Run it (manual ops action — deploys nothing):

    ./scripts/with-remote-env.sh qa         npm run repair:author-formats          # dry run
    ./scripts/with-remote-env.sh qa         npm run repair:author-formats -- --apply
    ./scripts/with-remote-env.sh production npm run repair:author-formats -- --apply

Read the report top-down: op counts, then one line per document with each
`before -> after`. `DROPPED` lines mean the provenance guard missed at write
time (a concurrent edit) — rerun the dry run to re-plan. Consumers that group
by author (e.g. a future /experts mode) must group on
`canonicalAuthorKey()` from `src/lib/authorFormat.ts` and skip fields flagged
`unverified`.
```

- [ ] **Step 2: Run the full gates**

Run: `npm test && npm run lint && npm run format:check`
Expected: all PASS

Run: `npx next build --webpack`
Expected: build succeeds (Turbopack panics on the search-service venv symlink — use the webpack variant per CLAUDE.md)

- [ ] **Step 3: Commit**

```bash
git add docs/document-management.md
git commit -m "docs: author format contract + repair runbook (issue #411)"
```

---

## Post-merge (manual ops, not CI)

1. Dry-run against QA: `./scripts/with-remote-env.sh qa npm run repair:author-formats`
2. Eyeball the report (expected on QA: ~40 llm flips with evidence, 10 external entries — 8 org names + 2 bare surnames get flagged `unverified`, 0 confirmed external flips remaining).
3. `--apply` on QA; spot-check one flipped document in the admin UI + its `audit_log` row.
4. Repeat dry-run → `--apply` on production.
5. Open PR from `fix/author-formats` to `qa` (never `main`).
