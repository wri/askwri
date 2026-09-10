// src/lib/experts/authorKey.ts
// Experts mode author identity (spec §6). Stopgap until wri/askwri#411
// normalizes stored values; kept afterwards because residual variants exist.
import type { AuthorRef } from './types'

const ORG_RE =
  /\b(institute|center|centre|council|coalition|bank|ministry|agency|university|programme|program|initiative|partnership|association|foundation|wri|world resources|group|network|alliance)\b/i

export function isOrganization(raw: string): boolean {
  const s = clean(raw)
  return !s.includes(',') && ORG_RE.test(s)
}

/** Trim, collapse whitespace, and put a space after a bare comma ("Amos,Albert"). */
export function clean(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .trim()
}

interface CommaForm {
  raw: string
  family: string // as stored, case preserved
  givenFirst: string // lowercased first given token
}

export interface AuthorIndex {
  /** Every `Family, Given` string seen, for sibling lookup. */
  commaForms: CommaForm[]
  /** key -> preferred display name (the Family, Given form). */
  display: Map<string, string>
}

function keyOf(family: string, givenFirst: string): string {
  return givenFirst
    ? `${family.toLowerCase()}, ${givenFirst}`
    : family.toLowerCase()
}

function splitComma(s: string): { family: string; givenFirst: string } {
  const i = s.indexOf(',')
  const family = s.slice(0, i).trim()
  const given = s.slice(i + 1).trim()
  // Split the given part on whitespace OR a further comma: "Smith, John, Jr."
  // is family "Smith", given "John", suffix "Jr." — taking the first
  // whitespace token would key it "smith, john," (trailing comma), which also
  // fails KEY_RE in evaluation/experts/validate.ts.
  return {
    family,
    givenFirst: (given.split(/[\s,]+/)[0] || '').toLowerCase(),
  }
}

export function buildAuthorIndex(raws: string[]): AuthorIndex {
  const commaForms: CommaForm[] = []
  const display = new Map<string, string>()
  for (const raw of raws) {
    const s = clean(raw)
    if (!s || !s.includes(',')) continue
    const { family, givenFirst } = splitComma(s)
    if (!family) continue
    commaForms.push({ raw: s, family, givenFirst })
    const k = keyOf(family, givenFirst)
    if (!display.has(k)) display.set(k, s)
  }
  return { commaForms, display }
}

export function resolveAuthor(raw: string, index: AuthorIndex): AuthorRef {
  const s = clean(raw)
  if (s.includes(',')) {
    const { family, givenFirst } = splitComma(s)
    const key = keyOf(family, givenFirst)
    return { key, name: index.display.get(key) ?? s, org: false }
  }
  if (isOrganization(s)) {
    return { key: s.toLowerCase(), name: s, org: true }
  }
  const tokens = s.split(' ')
  if (tokens.length === 1) {
    return { key: s.toLowerCase(), name: s, org: false }
  }
  // Unsplit personal name. Do not guess the family/given boundary: adopt a
  // sibling whose family name is a suffix of this string and whose first
  // given token is this string's first token (spec §6 step 4).
  const first = tokens[0].toLowerCase()
  const lower = s.toLowerCase()
  const sibling = index.commaForms.find(
    (c) =>
      c.givenFirst === first && lower.endsWith(' ' + c.family.toLowerCase()),
  )
  if (sibling) {
    const key = keyOf(sibling.family, sibling.givenFirst)
    return { key, name: index.display.get(key) ?? sibling.raw, org: false }
  }
  const family = tokens[tokens.length - 1]
  return { key: keyOf(family, first), name: s, org: false, unverified: true }
}
