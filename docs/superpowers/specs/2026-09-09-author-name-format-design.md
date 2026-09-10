# Author Name Format Normalization — Design

- **Date:** 2026-09-09
- **Issue:** [wri/askwri#411](https://github.com/wri/askwri/issues/411)
- **Status:** Approved design; implementation plan to follow
- **Branch:** `fix/author-name-formats` (PR targets `qa`)

## Problem

`documents.authors` mixes two conventions for the same people. The DMS
convention — used by the ingest worker and expected by the citation UI — is
`Family, Given`, semicolon-delimited:

```
Mahendra, Anjali; Pai, Madhav
```

The CSV import path (`src/db/queries/importDocuments.ts`) stores the CSV value
verbatim and stamps `metadata_source.authors = 'external'`. That provenance
guard permanently shields the value from the worker's parse stage, which
otherwise rewrites authors in `Family, Given` form. A comma-less `Given
Family` value imported from CSV therefore never repairs itself, and the same
person appears under two names: in admin search, in cite-mode author columns,
and (once built) as duplicate rows in the planned `/experts` ranking.

## Live data (QA RDS, 2026-09-09)

Author entries by provenance and comma presence:

| source   | `Family, Given` | comma-less | total | comma'd % |
|----------|-----------------|------------|-------|-----------|
| external | 699             | 10         | 709   | 98.6%     |
| human    | 61              | 1          | 62    | 98.4%     |
| llm      | 53              | **113**    | 166   | 31.9%     |
| **all**  | **813**         | **124**    | **937** | **86.8%** |

Findings that update the issue text:

1. The issue's 122 external `Given Family` entries are nearly gone on QA —
   editors cleaned them. Of 10 remaining: 8 are `Coalition for Urban
   Transitions` (an organization; comma-less is correct) and 2 are bare
   surnames (`Cheng`, `Burlacu`) that cannot be split without guessing.
2. A batch the issue did not see: **113 llm-stamped `Given Family` person
   names on 21 docs** created 2026-07-27 → 2026-08-07 (the cutover window).
   These self-heal only if those docs are re-ingested; nothing schedules that.
   Measured against every comma'd name in the corpus, **38 of the 105 distinct
   comma-less llm names (36%) have a strict-key `Family, Given` sibling; 67
   have none.** The llm-row flip yield is therefore a minority — roughly 40 of
   the 113 entries — and the remainder can only be fixed by re-ingestion or
   editorial review, never by a rule-governed flip.
3. Production was not inspected from this machine (no `aws` CLI); its numbers
   are unknown. The repair script queries live data for exactly this reason.

`Family, Given` dominates: 87% of all entries, and 98%+ of human- and
CSV-sourced entries.

## Decisions

Settled during design (issue #411 discussion, 2026-09-09):

1. **Scope:** all three parts of the issue's proposed fix, including the
   aggregation key helper now, before any consumer exists.
2. **Flag granularity:** field-level. `metadata_source.authors_format =
   'unverified'` marks a whole authors field containing any comma-less name.
3. **Repair scope:** both `external` and `llm` rows (supersedes the issue's
   external-only suggestion). `human` rows are never touched — repo invariant.
   LLM rows are written directly rather than triggering re-ingestion; bounded
   by the guardrails in §3.
4. **Approach:** TypeScript shared module + thin repair script (not SQL
   migrations, not a Python mirror).

## Design

### 1. Shared module — `src/lib/authorFormat.ts`

Pure functions, no I/O, safe to import from server and client (pattern:
`metadataProvenance.ts`). Format contract, documented in the module:
`documents.authors` is `;`-delimited; each person is `Family, Given`;
organizations and unverified names are free text.

- **`splitAuthorsField(raw: string): string[]`** — split on `;`, trim, drop
  empties. Mirrors `parseAuthors` in `utils.tsx`, which stays untouched.
- **`parseAuthorName(name)`** → `{ family, given, hasComma, isSplittable }`.
  Comma → split on the **first** comma; trim and collapse internal whitespace
  on both sides (handles `Amos,Albert`). No comma, ≥2 tokens → family is the
  last token, given is the rest (`isSplittable: true`); the value is **never
  reordered here** — reordering requires repair-time evidence. Single token
  (`WHO`, `Cheng`) → `isSplittable: false`; an organization or mononym is not
  guessable.
- **`tidyAuthorsField(raw)`** → `{ value, changed, unverified }` — the import
  entry point. Comma'd names reformatted to `Family, Given`; separator
  whitespace normalized (`A;B` → `A; B`); comma-less names kept verbatim;
  `unverified: true` when any name lacks a comma.
- **`canonicalAuthorKey(name)`** → aggregation key such as `mahendra|a`.
  Lowercased family (diacritics folded, hyphens kept), given reduced to
  initials (first letter of each token, periods stripped). Collapses distinct
  people sharing family + first initial — acceptable for ranking aggregation,
  where dedup matters more than splitting. Consumers should skip fields
  flagged `unverified`.
- **`strictAuthorKey(name)`** → `family|full-given`, lowercased. Used only by
  repair matching; initials would merge `Li, Xiangyi` and `Li, Xiaoyi` (both
  `li|x`).

No schema changes and no migration: `metadata_source` is free-form jsonb.

### 2. CSV import — `src/db/queries/importDocuments.ts`

**Mapping.** Both row shapes — legacy JSON-blob (`mapRowToDocument`) and flat
CSV (`mapFlatRowToDocument`) — pass `authors` through `tidyAuthorsField()`.
The tidied value becomes the stored column value. The flat path's
`sourceMetadata` mirror carries the tidied value too (it reconstructs
metadata from parsed fields); the legacy path's `sourceMetadata` keeps the
raw import blob verbatim — it is the archival record.
`MappedDocument` gains `authorsUnverified: boolean`.

**Write paths.**

- *Create:* when authors are unverified, merge `metadata_source.authors_format
  = 'unverified'` in the same jsonb merge that stamps `external`, for both row
  shapes.
- *Flat overwrite:* the flag is written iff the authors field is written, so
  the existing `human`-protection rule is inherited unchanged.
  - Incoming value unverified → `metadata_source = metadata_source ||
    '{"authors_format": "unverified"}'`.
  - Incoming value fully comma'd → `metadata_source = (metadata_source -
    'authors_format') || …` — a verified import clears a stale flag.
  - Authors not written (protected or null) → flag untouched.
- *Legacy fill-only-empty:* unchanged. It writes authors while leaving
  provenance NULL — and NULL-provenance values are worker-overwritable, so
  they self-heal on re-ingest and need no flag. The flag marks exactly the
  values that cannot self-heal: those shielded by `'external'` provenance.

**Import preview.** Dry-run `RowDecision`s gain a warning when incoming
authors are unverified:
`⚠ authors: format unverified (name without comma) 'Anjali Mahendra'`.

**Invariant.** `authors_format` is written only where `authors` is written by
a path that also asserts `'external'` provenance.

### 3. Repair script — `scripts/repair-author-formats.ts`

tsx script, thin IO shell around a pure `planAuthorRepairs()` in
`src/lib/authorFormat.ts` (unit-testable without a database). Dry-run by
default; `--apply` commits.

```
./scripts/with-remote-env.sh qa         npx tsx scripts/repair-author-formats.ts          # dry run
./scripts/with-remote-env.sh qa         npx tsx scripts/repair-author-formats.ts --apply
./scripts/with-remote-env.sh production npx tsx scripts/repair-author-formats.ts --apply
```

**Inputs, queried live (no hardcoded doc lists — counts drift):**

1. *Candidates:* rows where `metadata_source->>'authors'` is `'external'` or
   `'llm'`, authors is not null, and at least one name differs from its
   tidied form (comma-less multi-token, `Amos,Albert`, `Mahendra , Anjali`,
   stray double spaces). No status filter: the guard protects drafts exactly
   as it protects searchable docs. Rows with an open `ingestion_jobs` entry
   (`queued`/`running`) are excluded — closes the race with a running worker.
2. *Evidence index:* every **comma'd** name across all rows (any provenance),
   whitespace-normalized, deduplicated by `strictAuthorKey` → canonical
   `Family, Given` string. If distinct spellings survive normalization for one
   key, source quality breaks the tie: `human` > `external` > `llm`. Note:
   this widens the issue's "llm-sourced sibling" rule; external rows are 98.6%
   comma'd on QA, so restricting evidence to llm rows would sharply limit
   yield at no added safety — a comma'd value asserts the convention
   regardless of who wrote it.

**Per-name operations:**

| Shape | external row | llm row |
|---|---|---|
| comma'd, bad spacing (`Amos,Albert`) | `fix-spacing` → `Amos, Albert` | `fix-spacing` (same) |
| comma-less, strict key matches evidence | `flip` → canonical form from index | `flip` (same rule) |
| comma-less, no match | leave name; set `authors_format='unverified'` | leave untouched, no flag |
| single token | leave name; set `authors_format='unverified'` | leave untouched, no flag |

The field is rebuilt from per-name ops (`; `-joined); one update per doc even
with mixed ops. Flips copy the canonical form verbatim (casing, accents,
spacing from the verified sibling) — not a mechanical token swap.

LLM no-match rows get no flag because the flag is import-scoped semantics and
the worker may rewrite that field at any re-ingest, which would strand a stale
marker.

**Apply.** One guarded UPDATE per doc, provenance re-checked at write time.
Two variants — llm rows do not touch `metadata_source`:

```sql
-- external rows: flag follows the repaired field
UPDATE documents
SET authors = $2,
    metadata_source = (metadata_source - 'authors_format') || $3::jsonb
WHERE id = $1 AND metadata_source->>'authors' = 'external';

-- llm rows: authors only; provenance stays 'llm'
UPDATE documents
SET authors = $2
WHERE id = $1 AND metadata_source->>'authors' = 'llm';
```

If the guard matches zero rows (concurrent edit or provenance change between
plan and apply), the row drops out of the run and is reported. For external
rows, `$3` sets `authors_format: 'unverified'` when names remain comma-less
after repair and omits the key (the `- 'authors_format'` clears it) when the
field becomes fully comma'd. LLM rows keep provenance `'llm'` — deliberately:
the worker's guard treats `'llm'` as overwritable, so a future re-ingest
supersedes our value with a freshly parsed, correctly formatted one. The
repair write is a stopgap the rightful owner can always replace.

**Ownership exception, documented.** The app tier writing llm-provenanced
`authors` is a deliberate, bounded exception to one-owner-per-domain: one-off
script, evidence-gated flips only, guarded writes, worker remains able to
supersede. The runbook and each audit row record this rationale.

**Audit.** `AuditAction` gains `'author_format_repair'` (`audit_log.action` is
a plain text column — no DB constraint). One `writeAudit` row per doc
touched: `source: 'system'`, before/after authors, and the op reasons.

**Idempotency.** External rows already flagged `authors_format='unverified'`
are skipped by the candidates query, so a rerun after `--apply` performs no
writes. LLM flips produce comma'd fields, which drop out of the candidate
query. LLM no-match rows reappear in every dry-run report (as no-ops) — useful
visibility, zero writes.

**Report.** The dry run prints counts per op type and `before → after` lines
per doc, then exits. `--apply` prints the same report and commits.

### 4. Aggregation key — consumer contract

`canonicalAuthorKey()` ships with unit tests; no consumer is wired now.
Documented in the module docstring and `docs/document-management.md`:

- Anything that groups by author (future admin filters, `/experts`) groups on
  `canonicalAuthorKey`, never the raw string.
- Such consumers skip or down-weight fields flagged
  `authors_format='unverified'`.
- Fields are split with `splitAuthorsField` — semicolons only, never commas.
- The docstring pins the exact algorithm (diacritic folding, hyphen handling,
  initial derivation) so the future Python port in `search-service`, where
  `/experts` will live, is mechanical.

Admin search stays ILIKE substring; the cite panel stays as-is. Neither groups.

### 5. Testing

- **`authorFormat` unit tests:** comma-spacing repair; multi-token given
  names; hyphenated family (`Adriazola-Steil`); single tokens; diacritics
  (`Muñoz`); strict-key precision (`Li, Xiangyi` ≠ `Li, Xiaoyi`); messy
  separators (`A;B`); tidy idempotence.
- **`planAuthorRepairs` tests:** flip / no-match / spacing-only / flag-only /
  mixed ops in one doc; already-flagged skip; evidence-index tie-breaking
  (`human` > `external` > `llm`); open-job exclusion.
- **`importDocuments` suite (extended):** tidied value stored in both row
  shapes; flag stamped on create and overwrite; flag cleared on verified
  overwrite; `human` protection still wins; warning lines in dry-run
  decisions.
- Gates: `npm test`, `npm run lint`, `npm run build`.

### 6. Docs and rollout

- `docs/document-management.md` gains: the author format contract, the
  `authors_format` key, and a repair-script runbook entry (dry-run first; how
  to read the report and the audit rows).
- Build order: module → import path → planner → script shell → docs, one PR
  targeting `qa` (never `main` — a push there deploys production).
- After merge: dry-run against QA, review the report, `--apply`; repeat
  dry-run → apply on production once QA results look right. Script runs are
  manual ops actions and deploy nothing.

## Out of scope

- The `/experts` mode itself and any admin UI surfacing of `authors_format`.
- Changes to the worker's parse stage — `_format_authors` already emits the
  correct convention.
- Re-ingestion scheduling for the 21 cutover-window docs; the repair script
  supersedes the need for it for the ~40 entries with verified siblings. Two
  residual notes for the runbook: the remaining ~73 comma-less llm names have
  no verified canonical form and stay as-is; and if a re-ingest cache-hits the
  old parse output, the worker may rewrite the same comma-less names, so
  post-repair re-ingests of these docs should expect a parse-cache miss or a
  re-check afterwards.
