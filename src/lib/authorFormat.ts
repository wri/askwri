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
