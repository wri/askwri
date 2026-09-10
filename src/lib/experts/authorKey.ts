// src/lib/experts/authorKey.ts
// Experts mode author identity (spec §6).
//
// #411 has since landed src/lib/authorFormat.ts, whose header names /experts as
// a consumer that must group on a shared key rather than a raw string. We honor
// that by folding with ITS foldToken, but we deliberately do NOT use its
// canonicalAuthorKey, which reduces the given name to initials. Measured over
// the 460 unique author strings in the local corpus the two disagree 8 times:
// initials correctly merge 4 (Welle Ben/Benjamin, Jacquin C/Céline, and two
// accent pairs) but wrongly merge 3 DIFFERENT researchers (Chen Yong/Yidan,
// Jiang Hui/Hongqiang, López Segundo/Sandra). For a ranking feature a false
// merge is the worse error — it invents a composite person and floats them to
// the top of a list of experts, where a false split only under-counts someone
// real. So the key folds diacritics and keeps the whole given name, which is
// strictAuthorKey's grouping with this module's sibling lookup on top:
// authorFormat's parseAuthorName takes the LAST token as the family for a
// comma-less name, the exact heuristic spec §6's premise check rejected
// ("Nicolás García Córdoba" -> family "Córdoba").
import { foldToken } from '@/lib/authorFormat'
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
  given: string // whole given part, suffix commas normalized to spaces
  givenFirst: string // first given token, for the sibling lookup (spec §6.4)
}

export interface AuthorIndex {
  /** Every `Family, Given` string seen, for sibling lookup. */
  commaForms: CommaForm[]
  /** key -> preferred display name (the Family, Given form). */
  display: Map<string, string>
}

function keyOf(family: string, given: string): string {
  return given ? `${foldToken(family)}, ${foldToken(given)}` : foldToken(family)
}

function splitComma(s: string): {
  family: string
  given: string
  givenFirst: string
} {
  const i = s.indexOf(',')
  const family = s.slice(0, i).trim()
  const rest = s.slice(i + 1).trim()
  // A further comma introduces a SUFFIX, not more given name: "Smith, John,
  // Jr." is family "Smith", given "John", suffix "Jr.". The suffix is dropped —
  // keeping it would both split "Smith, John" from "Smith, John, Jr." and leave
  // a trailing comma in the key, which fails KEY_RE in
  // evaluation/experts/validate.ts.
  const j = rest.indexOf(',')
  const givenPart = (j >= 0 ? rest.slice(0, j) : rest).trim()
  const tokens = givenPart.split(/\s+/).filter(Boolean)
  return {
    family,
    given: tokens.join(' '),
    givenFirst: (tokens[0] || '').toLowerCase(),
  }
}

export function buildAuthorIndex(raws: string[]): AuthorIndex {
  const commaForms: CommaForm[] = []
  const display = new Map<string, string>()
  for (const raw of raws) {
    const s = clean(raw)
    if (!s || !s.includes(',')) continue
    const { family, given, givenFirst } = splitComma(s)
    if (!family) continue
    commaForms.push({ raw: s, family, given, givenFirst })
    const k = keyOf(family, given)
    if (!display.has(k)) display.set(k, s)
  }
  return { commaForms, display }
}

export function resolveAuthor(raw: string, index: AuthorIndex): AuthorRef {
  const s = clean(raw)
  if (s.includes(',')) {
    const { family, given } = splitComma(s)
    const key = keyOf(family, given)
    return { key, name: index.display.get(key) ?? s, org: false }
  }
  if (isOrganization(s)) {
    return { key: foldToken(s), name: s, org: true }
  }
  const tokens = s.split(' ')
  if (tokens.length === 1) {
    return { key: foldToken(s), name: s, org: false }
  }
  // Unsplit personal name. Do not guess the family/given boundary: adopt a
  // sibling whose family name is a suffix of this string and whose first
  // given token is this string's first token (spec §6 step 4).
  // Fold both sides so an accented spelling still finds its sibling.
  const first = foldToken(tokens[0])
  const lower = foldToken(s)
  const sibling = index.commaForms.find(
    (c) =>
      foldToken(c.givenFirst) === first &&
      lower.endsWith(' ' + foldToken(c.family)),
  )
  if (sibling) {
    const key = keyOf(sibling.family, sibling.given)
    return { key, name: index.display.get(key) ?? sibling.raw, org: false }
  }
  const family = tokens[tokens.length - 1]
  return {
    key: keyOf(family, tokens.slice(0, -1).join(' ')),
    name: s,
    org: false,
    unverified: true,
  }
}
