# Author Format Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 19 findings from the 2026-09-09 full-scope review of the issue #411 branch (`fix/author-name-formats`), so the `authors_format` flag invariant actually holds and the repair script cannot lose a concurrent write.

**Architecture:** Fixes land in four layers, innermost first. (1) `src/lib/authorFormat.ts` gains a single shared `isVerifiedForm()` predicate that both the tidy path and the repair planner use, replacing the duplicated `hasComma && isSplittable` test that let `"Cheng,"` masquerade as verified; the evidence index gets a correct rank comparison and a deterministic tie-break. (2) `importDocuments.ts` stops flagging legacy-create rows (the flag now rides the same jsonb merge that asserts `'external'`) and stops treating whitespace-only author differences as overwrites. (3) `documentsAdmin.ts` clears the flag when a human edits authors. (4) `scripts/repair-author-formats.ts` guards its UPDATEs on the planned value and swaps flag-based idempotency for shape-based.

**Tech Stack:** TypeScript, Jest (jsdom + node envs), TypeORM 0.3 raw SQL, Postgres 16 (pgvector image) via `docker-compose.local.yml`, ts-node for the repair script.

**Decisions taken (interactive questions were unavailable; stated as assumptions):**
- **M5** → code fix (suppress whitespace-only author diffs) **and** a runbook ordering note.
- **m13** → documented as a known limitation; no detection heuristic (a heuristic false-positives on `van der Berg, Jan`).
- **M8** → local Postgres is bootstrapped so the new DB tests are actually run, not shipped unproven.
- **m12** → keep spec §3's per-name `fix-spacing` behavior on llm rows, but stop writing llm rows for *separator-only* differences, and correct the audit rationale wording to match. (The review offered "narrow the rule OR amend the wording"; this takes the middle, preserving the approved decision table while removing the purely cosmetic write.)

**Findings covered:** B1, B2, M3, M4, M5, M6, M7, M8, m9, m10, m11, m12, m13, m14, n15, n16, n17, n18, n19.

---

## File Structure

| File | Change | Findings |
|---|---|---|
| `src/lib/authorFormat.ts` | Modify — add `isVerifiedForm`, fix `tidyAuthorsField` / `buildEvidenceIndex` / `planAuthorRepairs` | M6, M7, m11, m12, M4 (planner half), m13 (docstring) |
| `src/__tests__/author-format.test.ts` | Modify — new unit tests | M6, M7, m11, m12, M4 |
| `src/db/queries/importDocuments.ts` | Modify — flag invariant, whitespace-only skip, preview warnings, stamp logging | B2, M5, m9, m10, n16, n17 |
| `src/__tests__/author-import-tidy.test.ts` | Modify — warning text now names the offending author | m10 |
| `src/__tests__/import-documents.db.test.ts` | Modify — flag stamp/clear/protect + legacy-create + re-import coverage | M8, B2, M5 |
| `src/db/queries/documentsAdmin.ts` | Modify — human authors edit clears the flag | M3 |
| `src/__tests__/admin-documents.db.test.ts` | Modify — flag-clearing coverage | M3, M8 |
| `src/app/admin/documents/[id]/page.tsx` | Modify — history verb | n15 |
| `scripts/repair-author-formats.ts` | Modify — value guard, shape-based idempotency, ordering, exit code, audit detail | B1, M4, m14, n18 |
| `docs/document-management.md` | Modify — re-import ordering, comma-delimiter limitation | M5, m13 |
| `docs/superpowers/specs/2026-09-09-author-name-format-design.md` | Modify — errata section | B2, n19 |

Nothing is created; every change is to an existing file. No migration — `metadata_source` stays free-form jsonb.

---

## Task 1: Shared verified-form predicate and evidence-index correctness

**Files:**
- Modify: `src/lib/authorFormat.ts`
- Test: `src/__tests__/author-format.test.ts`

Background for the implementer: `parseAuthorName("Cheng,")` returns `{family:'Cheng', given:'', hasComma:true, isSplittable:true}`, and `formatAuthorName` renders that as the bare string `"Cheng"` — no comma. Two call sites currently ask `parsed.hasComma && parsed.isSplittable` to mean "this is a proper `Family, Given` name", and both get the wrong answer for that input. One shared predicate replaces both.

- [ ] **Step 1: Write the failing tests**

Append these four `describe`/`it` blocks to `src/__tests__/author-format.test.ts`. Put the first one immediately after the existing `describe('tidyAuthorsField', ...)` block (after its closing `})` on the line following the `is idempotent` test), and the rest at the end of the file.

```ts
describe('tidyAuthorsField — degenerate commas (M7)', () => {
  it('treats an empty given as unverified and does not drop the comma', () => {
    expect(tidyAuthorsField('Cheng,')).toEqual({
      value: 'Cheng,',
      changed: false,
      unverified: true,
    })
  })

  it('flags a field whose only defect is a trailing-comma name', () => {
    expect(tidyAuthorsField('Amos, Albert; Cheng,')).toEqual({
      value: 'Amos, Albert; Cheng,',
      changed: false,
      unverified: true,
    })
  })
})

describe('isVerifiedForm', () => {
  const v = (name: string) => isVerifiedForm(parseAuthorName(name))

  it('requires both halves of a Family, Given pair', () => {
    expect(v('Mahendra, Anjali')).toBe(true)
    expect(v('Amos,Albert')).toBe(true)
    expect(v('Cheng,')).toBe(false)
    expect(v(', Albert')).toBe(false)
    expect(v('Anjali Mahendra')).toBe(false)
    expect(v('WHO')).toBe(false)
  })
})

describe('buildEvidenceIndex — rank and determinism (M6, m11)', () => {
  it('keeps the human spelling when a lower-quality row repeated it first', () => {
    const idx = buildEvidenceIndex([
      { src: 'llm', canonical: 'Meneses, Sandra' },
      { src: 'human', canonical: 'Meneses, Sandra' },
      { src: 'external', canonical: 'MENESES, Sandra' },
    ])
    expect(idx.get('meneses|sandra')).toBe('Meneses, Sandra')
  })

  it('breaks same-rank conflicts deterministically, not by row order', () => {
    const rows = [
      { src: 'external', canonical: 'Zeta, Ana' },
      { src: 'external', canonical: 'ZETA, Ana' },
    ]
    const forward = buildEvidenceIndex(rows)
    const reversed = buildEvidenceIndex([...rows].reverse())
    expect(forward.get('zeta|ana')).toBe(reversed.get('zeta|ana'))
  })

  it('rejects degenerate evidence that renders without a comma', () => {
    const idx = buildEvidenceIndex([{ src: 'external', canonical: 'Cheng,' }])
    expect(idx.size).toBe(0)
  })
})

describe('planAuthorRepairs — write rules (M4, m11, m12)', () => {
  const doc = (
    authors: string,
    provenance: 'external' | 'llm' = 'external',
    alreadyFlagged = false,
  ): CandidateDoc => ({
    id: '22222222-2222-2222-2222-222222222222',
    externalId: 'doc-2',
    authors,
    provenance,
    alreadyFlagged,
  })

  it('does not re-flag an external doc that is already flagged', () => {
    expect(planAuthorRepairs([doc('Xyz Abc', 'external', true)], EVIDENCE)).toEqual([])
  })

  it('still repairs an already-flagged external doc when evidence appears', () => {
    const [plan] = planAuthorRepairs(
      [doc('Anjali Mahendra', 'external', true)],
      EVIDENCE,
    )
    expect(plan.finalAuthors).toBe('Mahendra, Anjali')
    expect(plan.ops[0].type).toBe('flip')
  })

  it('flags a single-token external name even when degenerate evidence exists', () => {
    const idx = buildEvidenceIndex([{ src: 'external', canonical: 'Cheng,' }])
    const [plan] = planAuthorRepairs([doc('Cheng')], idx)
    expect(plan.stillUnverified).toBe(true)
    expect(plan.finalAuthors).toBe('Cheng')
  })

  it('leaves a trailing-comma external name in place and flags it', () => {
    const [plan] = planAuthorRepairs([doc('Cheng,')], EVIDENCE)
    expect(plan.ops[0].type).toBe('flag-unverified')
    expect(plan.finalAuthors).toBe('Cheng,')
    expect(plan.stillUnverified).toBe(true)
  })

  it('does not write an llm row for a separator-only difference', () => {
    expect(
      planAuthorRepairs([doc('Pai, Madhav;Amos, Albert', 'llm')], EVIDENCE),
    ).toEqual([])
  })

  it('still writes an llm row when a name itself needs spacing repair', () => {
    const [plan] = planAuthorRepairs([doc('Amos,Albert', 'llm')], EVIDENCE)
    expect(plan.ops[0].type).toBe('fix-spacing')
    expect(plan.finalAuthors).toBe('Amos, Albert')
  })
})
```

Now extend the existing import at the top of the file. Replace the second import block (lines 6-13, the one importing `splitAuthorsField` … `strictAuthorKey`) with:

```ts
import {
  splitAuthorsField,
  parseAuthorName,
  formatAuthorName,
  isVerifiedForm,
  tidyAuthorsField,
  canonicalAuthorKey,
  strictAuthorKey,
} from '../lib/authorFormat'
```

Finally, the existing `doc()` helper inside `describe('planAuthorRepairs', ...)` (around line 228) must gain the new required field. Replace it with:

```ts
  const doc = (
    authors: string,
    provenance: 'external' | 'llm' = 'external',
  ): CandidateDoc => ({
    id: '11111111-1111-1111-1111-111111111111',
    externalId: 'doc-1',
    authors,
    provenance,
    alreadyFlagged: false,
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/author-format.test.ts`

Expected: FAIL. TypeScript reports `isVerifiedForm` is not exported and `alreadyFlagged` is not a property of `CandidateDoc`; the `tidyAuthorsField('Cheng,')` case fails with `{"value":"Cheng","changed":true,"unverified":false}`.

- [ ] **Step 3: Add the shared predicate**

In `src/lib/authorFormat.ts`, insert immediately after `formatAuthorName` (after its closing `}`, before the `tidyAuthorsField` docblock):

```ts
/**
 * True when a parsed name renders as a complete "Family, Given" pair — the
 * verified convention. `hasComma` alone is not enough: "Cheng," parses with an
 * empty given and renders comma-less, so it is NOT verified. Both the import
 * tidy path and the repair planner ask this question; they must ask it the
 * same way or the authors_format flag drifts from the value it describes.
 */
export function isVerifiedForm(parsed: ParsedAuthorName): boolean {
  return parsed.hasComma && parsed.isSplittable && parsed.given.length > 0
}
```

- [ ] **Step 4: Fix `tidyAuthorsField` to use it**

Replace the whole body of `tidyAuthorsField` (keep the existing docblock above it, but replace its last sentence as shown in Step 9) with:

```ts
export function tidyAuthorsField(raw: string): TidyResult {
  const segments = (raw || '').split(';')
  const out: string[] = []
  let unverified = false
  for (const segment of segments) {
    const collapsed = collapseWhitespace(segment)
    if (collapsed.length === 0) continue
    const parsed = parseAuthorName(collapsed)
    if (isVerifiedForm(parsed)) {
      out.push(formatAuthorName(parsed))
    } else {
      // Kept verbatim: order is never guessed at import, and a degenerate
      // comma ("Cheng,") must not be normalized into a value that LOOKS
      // verified — that would let a later import clear the flag.
      out.push(collapsed)
      unverified = true
    }
  }
  const value = out.join('; ')
  return { value, changed: value !== raw, unverified }
}
```

- [ ] **Step 5: Fix `buildEvidenceIndex`**

Replace the whole body of `buildEvidenceIndex` with:

```ts
export function buildEvidenceIndex(rows: EvidenceRow[]): Map<string, string> {
  const best = new Map<string, { value: string; rank: number }>()
  for (const row of rows) {
    const parsed = parseAuthorName(row.canonical)
    // A row that renders comma-less is not evidence of anything. Without this,
    // "Cheng," would index key "cheng|" -> "Cheng" and a bare surname would
    // "flip" to itself, silently dropping out of the plan unflagged.
    if (!isVerifiedForm(parsed)) continue
    const value = formatAuthorName(parsed)
    const key = strictAuthorKey(value)
    const rank = SOURCE_PRIORITY[row.src] ?? 3
    const existing = best.get(key)
    if (
      !existing ||
      rank < existing.rank ||
      // Same-rank conflicts must not depend on the order Postgres returned
      // rows in: the dry run an operator reviews and the --apply that follows
      // are separate queries. Smallest spelling wins, arbitrarily but stably.
      (rank === existing.rank && value < existing.value)
    ) {
      best.set(key, { value, rank })
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.value]))
}
```

Note the deleted `existing.value !== value` condition: it was the bug. It skipped the whole update when a better-ranked row merely *confirmed* the current value, leaving the entry stamped with the worse rank — so a later external row could outrank a human one.

- [ ] **Step 6: Add `alreadyFlagged` to `CandidateDoc`**

Replace the `CandidateDoc` interface with:

```ts
export interface CandidateDoc {
  id: string
  externalId: string
  authors: string
  provenance: 'external' | 'llm'
  /** True when metadata_source already carries an authors_format key. */
  alreadyFlagged: boolean
}
```

- [ ] **Step 7: Fix the planner's per-name branch and write rule**

Inside `planAuthorRepairs`, replace the first two lines of the `.map((name) => {` callback:

```ts
      const parsed = parseAuthorName(name)
      if (parsed.hasComma && parsed.isSplittable) {
```

with:

```ts
      const parsed = parseAuthorName(name)
      if (isVerifiedForm(parsed)) {
```

Then replace the `needsWrite` expression:

```ts
    const needsWrite =
      doc.provenance === 'external'
        ? authorsChanged || stillUnverified
        : authorsChanged
```

with:

```ts
    const needsWrite =
      doc.provenance === 'external'
        ? // Re-flagging an already-flagged doc is a no-op write. Gating on the
          // stored flag (not on excluding the row from the query) keeps the
          // doc eligible for a flip if evidence for its name appears later.
          authorsChanged || (stillUnverified && !doc.alreadyFlagged)
        : // llm rows are not ours to tidy. Write only when a NAME changed —
          // never for a separator-only difference ("A;B" -> "A; B"), which is
          // cosmetic and would make the audit rationale untrue.
          ops.some((op) => op.type !== 'none')
```

- [ ] **Step 8: Update the planner docblock**

Replace the last two lines of the `planAuthorRepairs` docblock:

```ts
 * External docs are planned when authors change OR the flag must be set; llm
 * docs only when authors change.
 */
```

with:

```ts
 * External docs are planned when authors change, or when the flag must be set
 * and is not already stored. LLM docs are planned only when a name changed —
 * separator-only whitespace is left alone.
 */
```

- [ ] **Step 9: Update the module docstring for the tidy contract and the m13 limitation**

In the `tidyAuthorsField` docblock, replace:

```
 * never guessed here) and set `unverified: true` when any name lacks a comma.
```

with:

```
 * never guessed here). `unverified: true` when any name fails isVerifiedForm —
 * i.e. it does not render as a complete "Family, Given" pair.
```

Then, in the module header docblock, insert this paragraph immediately before the line `* Pure module — safe to import from server code and scripts; no I/O.`:

```
 * KNOWN LIMITATION: the field contract is semicolon-delimited, so a value that
 * uses commas as the author separator ("Anjali Mahendra, Madhav Pai") parses as
 * one person and is reported verified. This is not detectable without
 * false-positives on legitimate multi-token families ("van der Berg, Jan"),
 * so it is documented rather than guessed at. CSV sources that delimit authors
 * with commas must be fixed upstream.
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx jest src/__tests__/author-format.test.ts`

Expected: PASS, all tests green (the 22 pre-existing ones plus the 12 new).

- [ ] **Step 11: Lint and format**

Run: `npx eslint src/lib/authorFormat.ts src/__tests__/author-format.test.ts`
Expected: no output.

Run: `npx prettier --write src/lib/authorFormat.ts src/__tests__/author-format.test.ts`
Expected: reformats or reports unchanged.

Run: `npx jest src/__tests__/author-format.test.ts`
Expected: PASS (re-run after the formatter touched the files).

- [ ] **Step 12: Commit**

```bash
git add src/lib/authorFormat.ts src/__tests__/author-format.test.ts
git commit -m "fix(authors): shared verified-form predicate; evidence rank and determinism

- isVerifiedForm() replaces the duplicated hasComma && isSplittable test:
  "Cheng," has a comma but renders comma-less, so tidyAuthorsField reported
  unverified:false and a later import would clear a live authors_format flag.
- buildEvidenceIndex dropped the rank update when a better-ranked row merely
  confirmed the stored value, so human evidence could lose to external; and
  same-rank conflicts followed row order, which differs between the dry run
  and the apply. Both fixed, plus degenerate comma-less evidence is rejected.
- CandidateDoc.alreadyFlagged lets idempotency be shape-based instead of
  excluding flagged rows from repair forever.
- llm rows are no longer rewritten for separator-only whitespace.

Review findings M6, M7, m11, m12, M4 (planner half), m13 (docs).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XvTVB5wSDu9gxDaZbdaRmt"
```

---

## Task 2: Bring up the local Postgres so DB tests can actually run

**Files:** none modified. This is a verification prerequisite for Tasks 3-5.

- [ ] **Step 1: Start the local stack**

Run: `./scripts/local-bootstrap.sh`

Expected: docker containers `pgvector` and MinIO come up, migrations run, corpus seeds, and the script exits 0. It is idempotent, so a partial previous run is fine. This takes a few minutes on first run.

- [ ] **Step 2: Confirm the database answers on the port `test:db` expects**

Run: `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`

Expected: a `pgvector/pgvector:pg16` container listening on `127.0.0.1:5432`. The `npm run test:db` script hardcodes `postgresql://askwri:password@localhost:5432/qa`, which matches `docker-compose.local.yml` (`POSTGRES_USER: askwri`, `POSTGRES_PASSWORD: password`, `POSTGRES_DB: qa`).

- [ ] **Step 3: Confirm the existing DB suite is green before changing anything**

Run: `npm run test:db`

Expected: PASS. Record the suite/test counts — that is the baseline Tasks 3-5 are measured against. If anything fails here, it is pre-existing and must be reported before continuing, not fixed as part of this plan.

- [ ] **Step 4: No commit** — nothing changed.

---

## Task 3: Failing DB tests for the flag invariant

**Files:**
- Test: `src/__tests__/import-documents.db.test.ts`
- Test: `src/__tests__/admin-documents.db.test.ts`

These are written red, against the *current* (unfixed) import and admin code. Three of them must fail; the rest pin behavior that already works and is currently untested (finding M8).

- [ ] **Step 1: Write the failing import tests**

In `src/__tests__/import-documents.db.test.ts`, insert these tests immediately before the final closing `})` of the second `describe` block (i.e. after the `legacy format: does NOT overwrite existing title (fill-only-empty)` test ends, around line 368):

```ts
  // --- authors_format flag invariant (issue #411 review: B2, M5, M8) ---

  it('flat create with a comma-less author stamps authors_format alongside external provenance', async () => {
    const flatRow: FlatImportRow = {
      file_path: `${PREFIX}flag-create.pdf`,
      external_id: `${PREFIX}flag-create`,
      title: 'Flag Create',
      authors: 'Anjali Mahendra',
    }
    await importDocuments([flatRow], { dryRun: false }, adminIdentity)

    const [doc] = await AppDataSource.query(
      `SELECT authors, metadata_source FROM documents WHERE external_id = $1`,
      [`${PREFIX}flag-create`],
    )
    expect(doc.authors).toBe('Anjali Mahendra')
    expect(doc.metadata_source.authors).toBe('external')
    expect(doc.metadata_source.authors_format).toBe('unverified')
  })

  it('legacy create does NOT stamp authors_format (no external provenance to shield it)', async () => {
    const row: ImportRow = {
      file_path: `${PREFIX}legacy-noflag.pdf`,
      metadata: {
        'Article Title': 'Legacy No Flag',
        languages: 'English',
        'All authors': 'Anjali Mahendra',
      },
      summary: '',
    }
    await importDocuments([row], { dryRun: false }, adminIdentity)

    const [doc] = await AppDataSource.query(
      `SELECT authors, metadata_source FROM documents WHERE external_id = $1`,
      [`${PREFIX}legacy-noflag`],
    )
    expect(doc.authors).toBe('Anjali Mahendra')
    // Provenance stays NULL, so the worker may rewrite this on ingest and it
    // self-heals. A flag here could never be cleared by anything.
    expect(doc.metadata_source?.authors).toBeUndefined()
    expect(doc.metadata_source?.authors_format).toBeUndefined()
  })

  it('flat overwrite with a verified author clears a stale authors_format flag', async () => {
    const create: FlatImportRow = {
      file_path: `${PREFIX}flag-clear.pdf`,
      external_id: `${PREFIX}flag-clear`,
      title: 'Flag Clear',
      authors: 'Anjali Mahendra',
    }
    await importDocuments([create], { dryRun: false }, adminIdentity)

    const fixed: FlatImportRow = {
      file_path: `${PREFIX}flag-clear.pdf`,
      external_id: `${PREFIX}flag-clear`,
      title: 'Flag Clear',
      authors: 'Mahendra, Anjali',
    }
    await importDocuments([fixed], { dryRun: false }, adminIdentity)

    const [doc] = await AppDataSource.query(
      `SELECT authors, metadata_source FROM documents WHERE external_id = $1`,
      [`${PREFIX}flag-clear`],
    )
    expect(doc.authors).toBe('Mahendra, Anjali')
    expect(doc.metadata_source.authors_format).toBeUndefined()
  })

  it('human-protected authors block both the value and the flag', async () => {
    const create: FlatImportRow = {
      file_path: `${PREFIX}flag-human.pdf`,
      external_id: `${PREFIX}flag-human`,
      title: 'Flag Human',
      authors: 'Mahendra, Anjali',
    }
    await importDocuments([create], { dryRun: false }, adminIdentity)
    await AppDataSource.query(
      `UPDATE documents SET metadata_source = metadata_source || '{"authors":"human"}'::jsonb
       WHERE external_id = $1`,
      [`${PREFIX}flag-human`],
    )

    const clobber: FlatImportRow = {
      file_path: `${PREFIX}flag-human.pdf`,
      external_id: `${PREFIX}flag-human`,
      title: 'Flag Human Retitled',
      authors: 'Anjali Mahendra',
    }
    await importDocuments([clobber], { dryRun: false }, adminIdentity)

    const [doc] = await AppDataSource.query(
      `SELECT authors, title, metadata_source FROM documents WHERE external_id = $1`,
      [`${PREFIX}flag-human`],
    )
    expect(doc.authors).toBe('Mahendra, Anjali') // protected
    expect(doc.title).toBe('Flag Human Retitled') // unprotected field still written
    expect(doc.metadata_source.authors_format).toBeUndefined()
  })

  it('re-importing an unchanged CSV does not rewrite authors for spacing alone', async () => {
    const create: FlatImportRow = {
      file_path: `${PREFIX}ws-noop.pdf`,
      external_id: `${PREFIX}ws-noop`,
      title: 'Whitespace Noop',
      authors: 'Amos, Albert',
    }
    await importDocuments([create], { dryRun: false }, adminIdentity)
    // Simulate a corpus row stored before tidying shipped.
    await AppDataSource.query(
      `UPDATE documents SET authors = 'Amos,Albert' WHERE external_id = $1`,
      [`${PREFIX}ws-noop`],
    )

    const reimport: FlatImportRow = {
      file_path: `${PREFIX}ws-noop.pdf`,
      external_id: `${PREFIX}ws-noop`,
      title: 'Whitespace Noop',
      authors: 'Amos,Albert',
    }
    const result = await importDocuments(
      [reimport],
      { dryRun: true },
      adminIdentity,
    )
    // A spacing-only difference must not present as an overwrite: applying it
    // would stamp 'external' provenance and enqueue a re-ingest for cosmetics.
    expect(result.decisions![0].action).toBe('skipped')
  })
```

- [ ] **Step 2: Write the failing admin test**

In `src/__tests__/admin-documents.db.test.ts`, insert immediately after the existing `marks edited metadata fields as human provenance ...` test (after its closing `})`, around line 135):

```ts
  it('clears authors_format when a human edits authors (they are the verifier)', async () => {
    await AppDataSource.query(
      `UPDATE documents SET metadata_source = metadata_source || '{"authors_format":"unverified"}'::jsonb
       WHERE id = $1`,
      [docId],
    )
    await updateDocumentFields(docId, { authors: 'Mahendra, Anjali' }, identity)
    const [row] = await AppDataSource.query(
      `SELECT metadata_source FROM documents WHERE id = $1`,
      [docId],
    )
    expect(row.metadata_source.authors).toBe('human')
    expect(row.metadata_source.authors_format).toBeUndefined()
  })
```

- [ ] **Step 3: Run the DB suites to verify the right ones fail**

Run: `npm run test:db`

Expected: FAIL, and exactly these three:
1. `legacy create does NOT stamp authors_format` — fails with `authors_format` = `'unverified'` (finding B2).
2. `re-importing an unchanged CSV does not rewrite authors for spacing alone` — fails with `action` = `'updated'` (finding M5).
3. `clears authors_format when a human edits authors` — fails with `authors_format` = `'unverified'` (finding M3).

The other four import tests should PASS — they pin behavior that already works but had no coverage. If any of those four fails, stop and report: it means an additional undiscovered defect.

- [ ] **Step 4: Commit the red tests**

```bash
git add src/__tests__/import-documents.db.test.ts src/__tests__/admin-documents.db.test.ts
git commit -m "test(authors): DB coverage for the authors_format flag invariant

Three of these fail against current code and pin review findings B2 (legacy
create strands an unclearable flag), M5 (spacing-only diff presents as an
overwrite and enqueues a re-ingest), M3 (a human authors edit leaves the flag
set forever). The other four pin flag stamp/clear/human-protection behavior
that worked but had no coverage at all — the gap that let B2 and M7 through.

Review finding M8.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XvTVB5wSDu9gxDaZbdaRmt"
```

---

## Task 4: Import path — flag invariant, whitespace-only skip, preview warnings

**Files:**
- Modify: `src/db/queries/importDocuments.ts`
- Test: `src/__tests__/author-import-tidy.test.ts`, `src/__tests__/import-documents.db.test.ts` (run only)

- [ ] **Step 1: Update the unit test for the richer warning text**

In `src/__tests__/author-import-tidy.test.ts`, replace the assertion inside `warns when overwriting authors with an unverified value`:

```ts
    expect(warnings).toContain(
      '⚠ authors: format unverified (name without comma)',
    )
```

with:

```ts
    expect(warnings).toContain(
      "⚠ authors: format unverified (name without comma) 'Anjali Mahendra'",
    )
```

And in `does not warn on verified overwrites`, replace:

```ts
    expect(warnings).not.toContain(
      '⚠ authors: format unverified (name without comma)',
    )
```

with:

```ts
    expect(warnings.some((w) => w.includes('format unverified'))).toBe(false)
```

Then add these two tests at the end of the `computeOverwriteChanges flags unverified authors` describe block:

```ts
  it('warns when FILLING a null authors field, not just overwriting', () => {
    const empty = { ...existing, authors: null } as unknown as Document
    const mapped = mapFlatRowToDocument({
      authors: 'Anjali Mahendra',
      file_path: 'x.pdf',
    })
    const { warnings } = computeOverwriteChanges(empty, mapped, {})
    // The apply path stamps authors_format here, so the preview must say so.
    expect(warnings).toContain(
      "⚠ authors: format unverified (name without comma) 'Anjali Mahendra'",
    )
  })

  it('names every offending author, not just the first', () => {
    const mapped = mapFlatRowToDocument({
      authors: 'Anjali Mahendra; Amos, Albert; Madhav Pai',
      file_path: 'x.pdf',
    })
    const { warnings } = computeOverwriteChanges(existing, mapped, {})
    expect(warnings).toContain(
      "⚠ authors: format unverified (name without comma) 'Anjali Mahendra', 'Madhav Pai'",
    )
  })

  it('does not treat a spacing-only authors difference as a change', () => {
    const stored = { ...existing, authors: 'Amos,Albert' } as unknown as Document
    const mapped = mapFlatRowToDocument({
      authors: 'Amos,Albert',
      file_path: 'x.pdf',
    })
    const { changes } = computeOverwriteChanges(stored, mapped, {})
    expect(changes.find((c) => c.field === 'authors')).toBeUndefined()
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/__tests__/author-import-tidy.test.ts`
Expected: FAIL — the warning text lacks the quoted names, the fill case produces no warning, and the spacing-only case produces an `authors` change.

- [ ] **Step 3: Import the new helpers**

In `src/db/queries/importDocuments.ts`, replace the import line:

```ts
import { tidyAuthorsField } from '../../lib/authorFormat'
```

with:

```ts
import {
  isVerifiedForm,
  parseAuthorName,
  splitAuthorsField,
  tidyAuthorsField,
} from '../../lib/authorFormat'
```

- [ ] **Step 4: Add the warning helper and the stamp-failure logger**

Insert both immediately above the `computeOverwriteChanges` docblock (`/** Compute field changes for the overwrite preview (dry-run). */`):

```ts
/**
 * Preview warning naming the names that are not in "Family, Given" form, per
 * spec §2. Without the names a 12-author field gives the reviewer nothing to
 * act on.
 */
function unverifiedAuthorsWarning(authors: string | null): string {
  const bad = splitAuthorsField(authors || '')
    .filter((n) => !isVerifiedForm(parseAuthorName(n)))
    .map((n) => `'${n}'`)
    .join(', ')
  return `⚠ authors: format unverified (name without comma) ${bad}`
}

/**
 * metadata_source stamps degrade gracefully because the column may not exist
 * on an old schema — but authors_format is a correctness marker, so a silent
 * swallow hides a real problem. Log and continue.
 */
function warnStampFailure(stage: string) {
  return (err: unknown) => {
    console.warn(`[import] metadata_source stamp failed (${stage}):`, err)
  }
}
```

- [ ] **Step 5: Fix `computeOverwriteChanges` (findings M5, m9, m10)**

Replace this block inside the `for (const field of OVERWRITABLE_FIELDS)` loop:

```ts
    // Skip if values are the same
    if (existingStr === mappedStr) continue
```

with:

```ts
    // Skip if values are the same
    if (existingStr === mappedStr) continue

    // authors: a spacing-only difference is the repair script's job, not an
    // import overwrite. Treating it as a change would rewrite the value, stamp
    // 'external' provenance over a possibly-'llm' field, and enqueue a
    // re-ingest — for a space after a comma. On a corpus stored before tidying
    // shipped, that fires for most of the corpus on the next re-import.
    if (
      field === 'authors' &&
      existingStr !== null &&
      tidyAuthorsField(existingStr).value === mappedStr
    ) {
      continue
    }
```

Then replace the tail of the same loop:

```ts
    if (isOverwrite) {
      warnings.push(`⚠ ${field}: "${existingStr}" → "${mappedStr}" (overwrite)`)
      if (field === 'authors' && mapped.authorsUnverified) {
        warnings.push('⚠ authors: format unverified (name without comma)')
      }
    }
  }
```

with:

```ts
    if (isOverwrite) {
      warnings.push(`⚠ ${field}: "${existingStr}" → "${mappedStr}" (overwrite)`)
    }
    // Outside the isOverwrite guard on purpose: filling a NULL authors field
    // also stamps authors_format at apply time, so the preview must show it.
    if (field === 'authors' && mapped.authorsUnverified) {
      warnings.push(unverifiedAuthorsWarning(mapped.authors))
    }
  }
```

- [ ] **Step 6: Fix the CREATE path (findings B2, n16, n17)**

Replace this whole region — the `external` provenance stamp and the separate flag stamp that follows it:

```ts
          // Set metadata_source = 'external' for all written fields (graceful if column absent)
          if (hasMetadataSource && mapped.isFlat) {
            const fields: Record<string, string> = {}
            for (const f of OVERWRITABLE_FIELDS) {
              if (mapped[f] !== null && mapped[f] !== undefined)
                fields[PROVENANCE_KEY[f] ?? f] = 'external'
            }
            await AppDataSource.query(
              `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
              [insertedId, JSON.stringify(fields)],
            ).catch(() => {})
          }

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

with:

```ts
          // Set metadata_source = 'external' for all written fields (graceful if column absent)
          if (hasMetadataSource && mapped.isFlat) {
            const fields: Record<string, string> = {}
            for (const f of OVERWRITABLE_FIELDS) {
              if (mapped[f] !== null && mapped[f] !== undefined)
                fields[PROVENANCE_KEY[f] ?? f] = 'external'
            }
            // authors_format rides the SAME merge that asserts 'external'
            // provenance — the spec invariant. The legacy create path stamps no
            // provenance, so its authors stay worker-overwritable and self-heal;
            // flagging them would strand a marker nothing can ever clear (the
            // worker does not clear it, the repair script only sees
            // external/llm rows, and no import overwrites a legacy row).
            if (mapped.authorsUnverified) fields.authors_format = 'unverified'
            await AppDataSource.query(
              `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
              [insertedId, JSON.stringify(fields)],
            ).catch(warnStampFailure('create'))
          }
```

- [ ] **Step 7: Use the richer warning on the create decision (finding m10)**

Replace:

```ts
        warnings: mapped.authorsUnverified
          ? ['⚠ authors: format unverified (name without comma)']
          : undefined,
```

with:

```ts
        warnings: mapped.authorsUnverified
          ? [unverifiedAuthorsWarning(mapped.authors)]
          : undefined,
```

- [ ] **Step 8: Log the overwrite-path stamp failure too (finding n17)**

In the flat-overwrite branch, replace:

```ts
                  [existing.id, JSON.stringify(metaUpdates)],
                ).catch(() => {})
```

with:

```ts
                  [existing.id, JSON.stringify(metaUpdates)],
                ).catch(warnStampFailure('overwrite'))
```

- [ ] **Step 9: Run the unit tests**

Run: `npx jest src/__tests__/author-import-tidy.test.ts src/__tests__/author-format.test.ts src/__tests__/import-documents.test.ts src/__tests__/admin-import-page.test.tsx`

Expected: PASS for `author-import-tidy`, `author-format`, and `admin-import-page`. `import-documents.test.ts` still shows its 4 pre-existing DB-connection failures unless the Task 2 stack is up and `DATABASE_URL` is exported — those are not caused by this change.

- [ ] **Step 10: Run the DB tests — two of Task 3's three reds must now be green**

Run: `npm run test:db`

Expected: `legacy create does NOT stamp authors_format` PASSES (B2 fixed) and `re-importing an unchanged CSV does not rewrite authors for spacing alone` PASSES (M5 fixed). `clears authors_format when a human edits authors` still FAILS — that is Task 5.

- [ ] **Step 11: Lint and format**

Run: `npx eslint src/db/queries/importDocuments.ts src/__tests__/author-import-tidy.test.ts`
Expected: no output.

Run: `npx prettier --write src/db/queries/importDocuments.ts src/__tests__/author-import-tidy.test.ts`

- [ ] **Step 12: Commit**

```bash
git add src/db/queries/importDocuments.ts src/__tests__/author-import-tidy.test.ts
git commit -m "fix(import): honor the authors_format invariant; stop cosmetic overwrites

- The legacy create path stamped authors_format without stamping 'external'
  provenance, so a NULL-provenance row got a marker the worker never clears,
  the repair script cannot see, and no import path can reset. The flag now
  rides the same jsonb merge that asserts 'external', in one UPDATE.
- A spacing-only authors difference no longer presents as an overwrite: it was
  enough to rewrite the value, stamp 'external' over an 'llm' field, and
  enqueue a re-ingest, corpus-wide, on the next unchanged CSV re-import.
- The preview warning now fires when FILLING a null authors field (the apply
  path stamps the flag there too) and names the offending authors, per spec §2.
- metadata_source stamp failures log instead of vanishing.

Review findings B2, M5, m9, m10, n16, n17.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XvTVB5wSDu9gxDaZbdaRmt"
```

---

## Task 5: Human edits clear the flag; history renders the repair action

**Files:**
- Modify: `src/db/queries/documentsAdmin.ts`
- Modify: `src/app/admin/documents/[id]/page.tsx`
- Test: `src/__tests__/admin-documents.db.test.ts` (run only — written in Task 3)

- [ ] **Step 1: Clear the flag on a human authors edit**

In `src/db/queries/documentsAdmin.ts`, inside `updateDocumentFields`'s transaction, replace:

```ts
    if (Object.keys(provenance).length > 0) {
      await em.query(
        `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(provenance)],
      )
```

with:

```ts
    if (Object.keys(provenance).length > 0) {
      // A human editing authors IS the verification the authors_format flag is
      // asking for. Leaving it set would exclude the corrected document from
      // author aggregation forever: consumers skip flagged fields, and nothing
      // else can clear it (the repair script only sees external/llm rows).
      await em.query(
        'authors' in after
          ? `UPDATE documents SET metadata_source = (metadata_source - 'authors_format') || $2::jsonb WHERE id = $1`
          : `UPDATE documents SET metadata_source = metadata_source || $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(provenance)],
      )
```

- [ ] **Step 2: Add the history verb (finding n15)**

In `src/app/admin/documents/[id]/page.tsx`, replace the `HISTORY_VERB` map:

```ts
const HISTORY_VERB: Record<string, string> = {
  update: 'updated',
  lifecycle: 'status',
  tag_decision: 'tag decision',
  collection_change: 'collections',
  import: 'import',
  create: 'created',
  delete: 'deleted',
}
```

with:

```ts
const HISTORY_VERB: Record<string, string> = {
  update: 'updated',
  lifecycle: 'status',
  tag_decision: 'tag decision',
  collection_change: 'collections',
  import: 'import',
  create: 'created',
  delete: 'deleted',
  author_format_repair: 'author format repair',
}
```

- [ ] **Step 3: Run the DB tests**

Run: `npm run test:db`

Expected: PASS — all three of Task 3's reds are now green, and the Task 2 baseline suites are unchanged.

- [ ] **Step 4: Run the jsdom suites that touch the admin page**

Run: `npx jest src/__tests__/admin-documents.test.tsx 2>/dev/null || npx jest --testPathPattern='admin-document'`

Expected: PASS, or "no tests found" for the first form (in which case the second form's result is what counts).

- [ ] **Step 5: Lint and format**

Run: `npx eslint src/db/queries/documentsAdmin.ts "src/app/admin/documents/[id]/page.tsx"`
Expected: no output.

Run: `npx prettier --write src/db/queries/documentsAdmin.ts "src/app/admin/documents/[id]/page.tsx"`

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/documentsAdmin.ts "src/app/admin/documents/[id]/page.tsx"
git commit -m "fix(admin): a human authors edit clears authors_format

The flag marks a value nobody has verified. An admin editing authors is that
verification, but the edit only stamped provenance 'human' and left the marker
set — permanently, since the repair script skips human rows and consumers are
told to skip flagged fields. Also render author_format_repair in the document
history instead of the raw action slug.

Review findings M3, n15.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XvTVB5wSDu9gxDaZbdaRmt"
```

---

## Task 6: Repair script — value guard, shape-based idempotency, deterministic report

**Files:**
- Modify: `scripts/repair-author-formats.ts`

This script has no DB test harness and has never been executed. Verification is a standalone type-check plus the Task 1 unit tests that cover its pure core.

- [ ] **Step 1: Replace `CANDIDATE_SQL` (findings M4, m14)**

```ts
const CANDIDATE_SQL = `
  SELECT DISTINCT d.id::text AS id, d.external_id, d.authors,
         d.metadata_source->>'authors' AS provenance,
         jsonb_exists(d.metadata_source, 'authors_format') AS already_flagged
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND d.metadata_source->>'authors' IN ('external', 'llm')
    AND NOT EXISTS (
      SELECT 1 FROM ingestion_jobs j
      WHERE j.document_id = d.id AND j.status IN ('queued', 'running')
    )
    AND (
      position(',' in trim(u.nm)) = 0
      OR trim(u.nm) <> regexp_replace(regexp_replace(trim(u.nm), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ')
    )
  ORDER BY d.external_id
`
```

Three changes. The `AND NOT (d.metadata_source ? 'authors_format')` clause is gone — it made every import-flagged row permanently ineligible for repair, including rows a later evidence flip could fix; `planAuthorRepairs` now suppresses the no-op write instead, via `already_flagged`. `jsonb_exists(...)` replaces the `?` operator, which some drivers treat as a bind placeholder — worth avoiding in a script that has never run against a real database. `ORDER BY d.external_id` makes the report and the apply loop deterministic.

- [ ] **Step 2: Replace `EVIDENCE_SQL` (finding m14)**

```ts
const EVIDENCE_SQL = `
  SELECT d.metadata_source->>'authors' AS src, trim(u.nm) AS canonical
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND position(',' in trim(u.nm)) > 0
    AND trim(u.nm) <> ''
  ORDER BY d.metadata_source->>'authors', trim(u.nm)
`
```

`buildEvidenceIndex` is now order-independent (Task 1), but an ordered query makes a dry run reproducible line-for-line, which is what an operator diffs against the apply.

- [ ] **Step 3: Carry `already_flagged` into the candidate mapping**

Replace:

```ts
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
```

with:

```ts
    const candidateRows = (await AppDataSource.query(CANDIDATE_SQL)) as Array<{
      id: string
      external_id: string
      authors: string
      provenance: 'external' | 'llm'
      already_flagged: boolean
    }>
    const candidates: CandidateDoc[] = candidateRows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      authors: r.authors,
      provenance: r.provenance,
      alreadyFlagged: r.already_flagged,
    }))
```

- [ ] **Step 4: Fix the O(n·m) no-op count (finding n18)**

Replace:

```ts
    const untouchedLlm = candidates.filter(
      (c) =>
        c.provenance === 'llm' && !plans.some((p) => p.documentId === c.id),
    ).length
```

with:

```ts
    const plannedIds = new Set(plans.map((p) => p.documentId))
    const untouchedLlm = candidates.filter(
      (c) => c.provenance === 'llm' && !plannedIds.has(c.id),
    ).length
```

- [ ] **Step 5: Add the value guard to both UPDATEs (finding B1)**

Replace the whole `const result = await AppDataSource.transaction(...)` block's UPDATE section:

```ts
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
```

with:

```ts
        // The provenance guard alone is not enough. The worker writes authors
        // under exactly the condition it checks —
        // search-service/worker/stages/parse.py:681 updates WHERE
        // metadata_source->>'authors' IS NULL OR = 'llm' — so a parse that
        // lands between the candidate query and this transaction is invisible
        // to a provenance-only guard and gets clobbered by our stale plan. The
        // open-job exclusion in CANDIDATE_SQL closes the window only at query
        // time. Guarding on the value we planned from closes it at write time.
        const updated =
          plan.provenance === 'external'
            ? await tm.query(
                `UPDATE documents
                 SET authors = $2,
                     metadata_source = (metadata_source - 'authors_format') || $3::jsonb
                 WHERE id = $1::uuid
                   AND metadata_source->>'authors' = 'external'
                   AND authors IS NOT DISTINCT FROM $4
                 RETURNING id`,
                [
                  plan.documentId,
                  plan.finalAuthors,
                  flagJson,
                  plan.originalAuthors,
                ],
              )
            : await tm.query(
                `UPDATE documents
                 SET authors = $2
                 WHERE id = $1::uuid
                   AND metadata_source->>'authors' = 'llm'
                   AND authors IS NOT DISTINCT FROM $3
                 RETURNING id`,
                [plan.documentId, plan.finalAuthors, plan.originalAuthors],
              )
```

- [ ] **Step 6: Record the flag transition in the audit row and correct the rationale (findings m12, m14)**

Replace the `after:` object passed to `writeAudit`:

```ts
            after: {
              authors: plan.finalAuthors,
              provenance: plan.provenance,
              ops: plan.ops.filter((o) => o.type !== 'none').map((o) => o.type),
              rationale:
                'issue #411 one-off: evidence-gated author format repair; ' +
                'llm rows keep provenance so the worker may supersede on re-ingest',
            },
```

with:

```ts
            after: {
              authors: plan.finalAuthors,
              provenance: plan.provenance,
              ops: plan.ops.filter((o) => o.type !== 'none').map((o) => o.type),
              authorsFormat:
                plan.provenance !== 'external'
                  ? 'unchanged'
                  : plan.stillUnverified
                    ? 'set'
                    : 'cleared',
              rationale:
                'issue #411 one-off: evidence-gated flips plus per-name comma ' +
                'spacing repair; llm rows keep provenance so the worker may ' +
                'supersede on re-ingest',
            },
```

- [ ] **Step 7: Widen the DROPPED message and set a failing exit code (finding m14)**

Replace:

```ts
        console.log(
          `  DROPPED (guard missed — provenance changed concurrently?): ${plan.externalId}`,
        )
      }
    }
    console.log(`Applied: ${applied} | Dropped: ${dropped}`)
```

with:

```ts
        console.log(
          `  DROPPED (guard missed — authors or provenance changed since the plan): ${plan.externalId}`,
        )
      }
    }
    console.log(`Applied: ${applied} | Dropped: ${dropped}`)
    if (dropped > 0) {
      console.log('Re-run the dry run to re-plan the dropped documents.')
      process.exitCode = 1
    }
```

- [ ] **Step 8: Update the script docstring for the new idempotency story**

Replace:

```ts
 * Dry-run by default; pass --apply to commit. Idempotent: external docs
 * already flagged authors_format='unverified' and fully-comma'd docs are
 * never re-planned, so a rerun after --apply performs no writes.
 *
 * Ownership note: this script writes llm-provenanced authors — a deliberate,
 * bounded exception to one-owner-per-domain (evidence-gated flips only,
 * provenance left 'llm' so the worker can still supersede on re-ingest).
 * Every written doc gets an audit row recording that rationale.
```

with:

```ts
 * Dry-run by default; pass --apply to commit. Idempotent by SHAPE, not by
 * flag: an already-flagged external doc is still queried, but planned only if
 * its authors actually change — so a rerun after --apply performs no writes,
 * while a doc whose name gains a verified sibling later can still be repaired.
 * Writes are guarded on the planned authors value as well as provenance, so a
 * concurrent worker or import write is dropped, never clobbered.
 *
 * Ownership note: this script writes llm-provenanced authors — a deliberate,
 * bounded exception to one-owner-per-domain (evidence-gated flips and per-name
 * comma spacing only, never separator cosmetics; provenance left 'llm' so the
 * worker can still supersede on re-ingest). Every written doc gets an audit
 * row recording that rationale.
```

- [ ] **Step 9: Type-check the script standalone**

Run:

```bash
npx tsc --noEmit --skipLibCheck --module commonjs --moduleResolution node --esModuleInterop --allowSyntheticDefaultImports --experimentalDecorators --emitDecoratorMetadata --target es2021 --strict --resolveJsonModule scripts/repair-author-formats.ts
```

Expected: no output. (This is the same invocation used to verify the script during review; it writes nothing to the repo.)

- [ ] **Step 10: Lint and format**

Run: `npx eslint scripts/repair-author-formats.ts`
Expected: no output.

Run: `npx prettier --write scripts/repair-author-formats.ts`

Then re-run the Step 9 type-check to confirm the formatter changed nothing semantic. Expected: no output.

- [ ] **Step 11: Commit**

```bash
git add scripts/repair-author-formats.ts
git commit -m "fix(repair): guard writes on the planned value; shape-based idempotency

- Both UPDATEs re-checked provenance only. The worker writes authors under the
  same condition (parse.py:681, WHERE provenance IS NULL OR = 'llm'), so a
  parse completing between the candidate query and the apply loop was
  invisible to the guard and lost. Guard on the planned authors value too;
  a concurrent write now falls out as DROPPED, which was already handled.
- Idempotency no longer works by excluding flagged rows, which made every
  import-flagged doc permanently ineligible for a later evidence-based flip.
- jsonb_exists() instead of the ? operator (bind-placeholder hazard),
  ORDER BY on both queries for a reproducible dry run, non-zero exit on
  DROPPED, and the flag transition recorded in each audit row.

Review findings B1, M4, m14, n18.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XvTVB5wSDu9gxDaZbdaRmt"
```

---

## Task 7: Documentation and spec errata

**Files:**
- Modify: `docs/document-management.md`
- Modify: `docs/superpowers/specs/2026-09-09-author-name-format-design.md`

- [ ] **Step 1: Add the re-import ordering note and the comma-delimiter limitation**

In `docs/document-management.md`, in the `## Author name format (issue #411)` section, replace the first bullet:

```markdown
- **CSV imports** tidy comma spacing on arrival and mark values that still
  contain a comma-less name with `metadata_source.authors_format =
  'unverified'` — these are CSV-sourced (`external`) values the worker is
  forbidden from rewriting, so they cannot self-heal. A later CSV import with
  a fully comma'd value clears the flag.
```

with:

```markdown
- **CSV imports** tidy comma spacing on arrival and mark values that still
  contain a comma-less name with `metadata_source.authors_format =
  'unverified'` — these are CSV-sourced (`external`) values the worker is
  forbidden from rewriting, so they cannot self-heal. A later CSV import with
  a fully comma'd value clears the flag, and so does a human editing authors
  in the admin UI (the edit *is* the verification). The flag is written only
  on the flat-CSV paths, which also assert `external` provenance: a legacy
  JSON-blob import leaves provenance NULL, so its authors stay
  worker-overwritable and need no marker.
- **A spacing-only difference is not an overwrite.** If the stored value
  differs from the CSV cell only in comma or separator whitespace, the import
  skips the field rather than rewriting it — otherwise re-importing an
  unchanged CSV over a corpus stored before tidying shipped would stamp
  `external` provenance and enqueue a re-ingest for most of the corpus.
  Cleaning up stored values is the repair script's job, below.
- **Known limitation:** the field contract is semicolon-delimited. A value
  that uses commas as the author separator (`Anjali Mahendra, Madhav Pai`)
  parses as one person and is reported verified. No heuristic detects this
  without false-positives on legitimate multi-token families
  (`van der Berg, Jan`), so CSV sources that delimit authors with commas must
  be fixed upstream.
```

- [ ] **Step 2: Record the run-ordering guidance**

In the same section, replace:

```markdown
Read the report top-down: op counts, then one line per document with each
`before -> after`. `DROPPED` lines mean the provenance guard missed at write
time (a concurrent edit) — rerun the dry run to re-plan.
```

with:

```markdown
Run the repair script **before** the next CSV re-import of the same corpus, so
the stored values are already canonical and the import has nothing cosmetic to
disagree with.

Read the report top-down: op counts, then one line per document with each
`before -> after` (ordered by `external_id`, so two runs diff cleanly).
`DROPPED` lines mean a guard missed at write time — the document's authors or
provenance changed between the plan and the write, usually a worker re-ingest
or a concurrent import. The script exits non-zero when anything dropped; rerun
the dry run to re-plan.
```

- [ ] **Step 3: Add the spec errata section**

Append to `docs/superpowers/specs/2026-09-09-author-name-format-design.md`:

```markdown
## Errata (2026-09-09, post-implementation review)

The design above is otherwise as-approved. Four corrections, applied in
`docs/superpowers/plans/2026-09-09-author-format-review-fixes.md`:

1. **§2 Create contradicted §2 Invariant.** "merge `authors_format` … for both
   row shapes" cannot hold together with "`authors_format` is written only
   where `authors` is written by a path that also asserts `'external'`
   provenance" — the legacy create path asserts no provenance. The Invariant
   wins: only the flat-CSV paths write the flag. A flag on a NULL-provenance
   row is unclearable by every writer in the system, which is the stale-marker
   hazard §3 already cites as the reason llm no-match rows go unflagged.

2. **§3 idempotency.** "External rows already flagged … are skipped by the
   candidates query" also skips them forever, including after evidence for
   their names appears. Idempotency is now shape-based: flagged rows are still
   queried, but planned only when their authors actually change.

3. **§3 apply guards.** "provenance re-checked at write time" is insufficient
   for llm rows — the worker writes under the same provenance condition
   (`parse.py:681`). Both UPDATEs also guard on the authors value the plan was
   built from.

4. **§3 command block.** The shipped entry point is
   `npm run repair:author-formats` (ts-node), not `npx tsx scripts/…`. See
   `docs/document-management.md` for the current invocation.

§3's per-name decision table stands, with one narrowing: llm rows are not
written for separator-only whitespace differences, only for changes to a name
itself. The ownership-exception wording is amended accordingly.
```

- [ ] **Step 4: Fix the stale command block (finding n19)**

In the same spec file, replace the §3 command block:

```
./scripts/with-remote-env.sh qa         npx tsx scripts/repair-author-formats.ts          # dry run
./scripts/with-remote-env.sh qa         npx tsx scripts/repair-author-formats.ts --apply
./scripts/with-remote-env.sh production npx tsx scripts/repair-author-formats.ts --apply
```

with:

```
./scripts/with-remote-env.sh qa         npm run repair:author-formats          # dry run
./scripts/with-remote-env.sh qa         npm run repair:author-formats -- --apply
./scripts/with-remote-env.sh production npm run repair:author-formats -- --apply
```

- [ ] **Step 5: Format**

Run: `npx prettier --write docs/document-management.md docs/superpowers/specs/2026-09-09-author-name-format-design.md`
Expected: reformats or reports unchanged.

- [ ] **Step 6: Commit**

```bash
git add docs/document-management.md docs/superpowers/specs/2026-09-09-author-name-format-design.md
git commit -m "docs(authors): flag-clearing paths, re-import ordering, spec errata

Records where authors_format is written and cleared (flat CSV paths and human
edits only), why a spacing-only difference is not an overwrite, and the
semicolon-delimiter limitation. Spec gains an errata section: §2 Create
contradicted §2 Invariant, §3 idempotency permanently excluded flagged rows,
§3 apply guards were insufficient against the worker, and the command block
was stale.

Review findings M5, m13, n19, plus the B2 spec defect.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XvTVB5wSDu9gxDaZbdaRmt"
```

---

## Task 8: Full-gate verification

**Files:** none modified.

- [ ] **Step 1: Unit suites**

Run: `npm test`

Expected: the same 24 DB-connection suite failures as the pre-existing baseline **only if the Task 2 stack has been stopped**. With the local stack up and `DATABASE_URL` unset (which is how `npm test` runs — it does not export one), the baseline is unchanged: 24 failing suites, ~224 tests, byte-identical to `origin/qa`. No *new* failures. Compare against the baseline recorded before this work.

- [ ] **Step 2: DB suites**

Run: `npm run test:db`

Expected: PASS, including all seven tests added in Task 3.

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: 0 errors, 15 pre-existing warnings in untouched files.

- [ ] **Step 4: Format check**

Run: `npm run format:check`

Expected: PASS.

- [ ] **Step 5: Build**

Run: `npx next build --webpack`

Expected: compiles clean, then fails type-check on the two PRE-EXISTING route errors (`answer/route.ts` exports `resolveSynthesisConfig`; `llamaindex/route.ts` exports `FORWARDABLE_FIELDS`). These fail identically on `origin/qa` and are out of scope. Any *other* type error is a regression from this work and must be fixed.

- [ ] **Step 6: Confirm the diff is only what was intended**

Run: `git diff --stat origin/qa..HEAD`

Expected: the 6 original files plus `src/db/queries/documentsAdmin.ts`, `src/app/admin/documents/[id]/page.tsx`, `src/__tests__/import-documents.db.test.ts`, `src/__tests__/admin-documents.db.test.ts`, and this plan.

- [ ] **Step 7: Tear down the local stack**

Run: `docker compose -f docker-compose.local.yml down`

Expected: containers stop. (Skip if you want to keep the stack for further work.)

---

## Self-Review

**Spec coverage** — every review finding maps to a task: B1→T6, B2→T3/T4, M3→T3/T5, M4→T1/T6, M5→T3/T4/T7, M6→T1, M7→T1, M8→T3, m9→T4, m10→T4, m11→T1, m12→T1/T6, m13→T1/T7, m14→T6, n15→T5, n16→T4, n17→T4, n18→T6, n19→T7. Nothing is unassigned.

**Placeholder scan** — no TBDs. Every code step shows the exact before/after text. Every command step gives the command and its expected output.

**Type consistency** — `isVerifiedForm(parsed: ParsedAuthorName): boolean` is defined in Task 1 Step 3 and used in Task 1 (Steps 4, 5, 7), Task 4 (Step 4). `CandidateDoc.alreadyFlagged: boolean` is added in Task 1 Step 6, produced by the SQL alias `already_flagged` in Task 6 Step 1, mapped in Task 6 Step 3, and consumed in Task 1 Step 7. `unverifiedAuthorsWarning(authors: string | null): string` and `warnStampFailure(stage: string)` are both defined in Task 4 Step 4 before their uses in Steps 5 and 6-8. The existing `doc()` test helper is updated for the new required field in Task 1 Step 1 so the pre-existing `planAuthorRepairs` tests still compile.

**Ordering constraint** — Task 1 must land before Tasks 4 and 6 (they import `isVerifiedForm` and rely on `alreadyFlagged`). Task 2 must precede Tasks 3, 4 Step 10, 5 Step 3, and 8 Step 2. Task 3 must precede Tasks 4 and 5 so the red-then-green transition is observable.
