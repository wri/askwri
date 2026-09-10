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
