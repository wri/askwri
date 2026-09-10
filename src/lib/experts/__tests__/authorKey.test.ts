// src/lib/experts/__tests__/authorKey.test.ts
import {
  buildAuthorIndex,
  isOrganization,
  resolveAuthor,
} from '@/lib/experts/authorKey'

// Spec §6/§10 ask for "the 25 variant pairs listed in #411". #411 states that
// 25 people have two stored spellings but only NAMES SIX of them (its table);
// the query it publishes was re-run here against the local DB, which has 169
// searchable docs and ZERO mixed-format people, so the real 25 are not
// recoverable from this checkout. Provenance of what is below:
//   1-6   the six pairs #411's table names outright.
//   7-9   inherited from the previous fixture (the spec author's QA session;
//         not in the issue text).
//   10-26 constructed to cover the shapes #411 says the key rule must survive,
//         because those are the residual variants that will still exist after
//         the repair script runs: compound family names, hyphenated family and
//         given names, accents, particles (van der / van den / de la / dos /
//         von), and multi-token given names.
// Every pair has the same shape: a CSV row stores `Given Family`, a worker row
// stores `Family, Given`, and both must collapse to one key.
const PAIRS: [string, string][] = [
  ['Anjali Mahendra', 'Mahendra, Anjali'],
  ['Madhav Pai', 'Pai, Madhav'],
  ['Su Song', 'Song, Su'],
  ['Ryan Sclar', 'Sclar, Ryan'],
  ['Claudia Adriazola-Steil', 'Adriazola-Steil, Claudia'],
  ['Xiangyi Li', 'Li, Xiangyi'],
  ['Raj Bhagat Palanichamy', 'Palanichamy, Raj Bhagat'],
  ['David Pérez-Barbosa', 'Pérez-Barbosa, David'],
  ['Alejandra Achury', 'Achury, Alejandra'],
  ['Nicolás García Córdoba', 'García Córdoba, Nicolás'],
  ['Lulu Xue', 'Xue, Lulu'],
  ['Ke Chen', 'Chen, Ke'],
  ['Sebastián Castellanos', 'Castellanos, Sebastián'],
  ['Ben Welle', 'Welle, Ben'],
  ['Robin King', 'King, Robin'],
  ['Leah Lazer', 'Lazer, Leah'],
  ['Thiago Guimarães', 'Guimarães, Thiago'],
  ['Jean-Pierre Dubois', 'Dubois, Jean-Pierre'],
  ['Wee Kean Fong', 'Fong, Wee Kean'],
  ['Wijnand van der Meer', 'van der Meer, Wijnand'],
  ['Rogier van den Berg', 'van den Berg, Rogier'],
  ['Ana de la Cruz', 'de la Cruz, Ana'],
  ['Jan van Leeuwen', 'van Leeuwen, Jan'],
  ['Maria dos Santos', 'dos Santos, Maria'],
  ['Hans von Braun', 'von Braun, Hans'],
  ['Ariadne Samios', 'Samios, Ariadne'],
]

describe('resolveAuthor', () => {
  const index = buildAuthorIndex([
    ...PAIRS.flat(),
    'García Córdoba, Nicolás',
    'Nicolás García Córdoba',
    'Hellen Njoki Wanjohi-Opil',
    'Amos,Albert',
    'Coalition for Urban Transitions',
    'Beard, Victoria A.',
  ])

  it.each(PAIRS)('collapses %s and %s to one key', (given, family) => {
    const a = resolveAuthor(given, index)
    const b = resolveAuthor(family, index)
    expect(a.key).toBe(b.key)
    expect(a.name).toBe(family) // display prefers the Family, Given form
    expect(a.org).toBe(false)
    expect(a.unverified).toBeFalsy()
  })

  it('keys on the folded family plus the WHOLE given name', () => {
    expect(resolveAuthor('Beard, Victoria A.', index).key).toBe(
      'beard, victoria a.',
    )
  })

  it('drops a generational suffix after a second comma', () => {
    // Everything after the FIRST comma is the given part, so "John, Jr."
    // yielded the given token "john," — a key with a trailing comma, which
    // also fails KEY_RE in evaluation/experts/validate.ts.
    const a = resolveAuthor('Smith, John, Jr.', index)
    expect(a.key).toBe('smith, john')
    expect(a.key).toMatch(/^[^,]+, [^,]+$/)
  })

  it('resolves a compound family name through its comma-form sibling', () => {
    const a = resolveAuthor('Nicolás García Córdoba', index)
    expect(a.key).toBe('garcia cordoba, nicolas') // diacritics folded (#411 foldToken)
    expect(a.name).toBe('García Córdoba, Nicolás')
    expect(a.unverified).toBeFalsy()
  })

  it('flags an unsplit name with no sibling as unverified and keeps it as stored', () => {
    const a = resolveAuthor('Hellen Njoki Wanjohi-Opil', index)
    expect(a.org).toBe(false)
    expect(a.unverified).toBe(true)
    expect(a.name).toBe('Hellen Njoki Wanjohi-Opil')
    expect(a.key).toBe('wanjohi-opil, hellen njoki')
  })

  it('repairs a comma without a space', () => {
    expect(resolveAuthor('Amos,Albert', index)).toMatchObject({
      key: 'amos, albert',
      name: 'Amos, Albert',
      org: false,
    })
  })

  it('detects organizations by keyword, never by word count', () => {
    expect(isOrganization('Coalition for Urban Transitions')).toBe(true)
    expect(isOrganization('World Resources Institute')).toBe(true)
    expect(isOrganization('Hellen Njoki Wanjohi-Opil')).toBe(false)
    const o = resolveAuthor('Coalition for Urban Transitions', index)
    expect(o).toEqual({
      key: 'coalition for urban transitions',
      name: 'Coalition for Urban Transitions',
      org: true,
    })
  })

  it('treats a single-token name as its own key', () => {
    expect(resolveAuthor('Madonna', index).key).toBe('madonna')
  })

  // The two cases §6 step 4 explicitly accepts as wrong. Both are recorded
  // here so a future change to the heuristic has to face them.
  it('keys a compound family name WRONG when no sibling exists, and says so', () => {
    // Same person as pair 10, but this index has no `García Córdoba, Nicolás`
    // to adopt. The rule falls back to the last token, which is half the
    // family name. §6 accepts this rather than guessing the split; the
    // unverified flag is what makes it recoverable in the UI.
    const lonely = buildAuthorIndex(['Beard, Victoria A.'])
    const a = resolveAuthor('Nicolás García Córdoba', lonely)
    expect(a.key).toBe('cordoba, nicolas garcia') // wrong: family is 'García Córdoba'
    expect(a.unverified).toBe(true)
    expect(a.name).toBe('Nicolás García Córdoba') // shown as stored
    expect(a.org).toBe(false)
  })

  it('keys a family-first name WRONG when the last token is not the family name', () => {
    // `Fong, Wee Kean` IS in the index, but a row storing the same person in
    // family-first order shares neither the first-token nor the suffix test,
    // so no sibling is adopted and the last token wins.
    const a = resolveAuthor('Fong Wee Kean', index)
    expect(a.key).toBe('kean, fong wee') // wrong: family is 'Fong'
    expect(a.key).not.toBe('fong, wee') // it does NOT merge with the pair form
    expect(a.unverified).toBe(true)
    expect(a.name).toBe('Fong Wee Kean')
  })
})

describe('keying agrees with the #411 format contract where it should (and not where it should not)', () => {
  // src/lib/authorFormat.ts names /experts as a consumer that must group on a
  // shared key rather than a raw string. Measured over the 460 unique author
  // strings in the local corpus, the two schemes disagree in 8 places; these
  // tests pin the direction we chose for each kind, with the real names.
  const index = buildAuthorIndex([
    'Castellanos, Sebastian',
    'Castellanos, Sebastián',
    'Hidalgo, Dario',
    'Hidalgo, Darío',
    'Chen, Yong',
    'Chen, Yidan',
    'Jiang, Hui',
    'Jiang, Hongqiang',
    'López, Segundo',
    'López, Sandra',
    'Hernández, Ana Itzel',
    'Hernández, Ana Milena Quinchara',
  ])
  const k = (s: string) => resolveAuthor(s, index).key

  it('folds diacritics: one person written two ways is one person', () => {
    expect(k('Castellanos, Sebastián')).toBe(k('Castellanos, Sebastian'))
    expect(k('Hidalgo, Darío')).toBe(k('Hidalgo, Dario'))
  })

  it('does NOT reduce the given name to an initial', () => {
    // canonicalAuthorKey would make all of these one key each pair. For a
    // RANKING feature a false merge is the worse error: it invents a composite
    // person and floats them to the top of a list of experts, where a false
    // split merely under-counts someone real.
    expect(k('Chen, Yong')).not.toBe(k('Chen, Yidan'))
    expect(k('Jiang, Hui')).not.toBe(k('Jiang, Hongqiang'))
    expect(k('López, Segundo')).not.toBe(k('López, Sandra'))
  })

  it('keeps the whole given name, not just its first token', () => {
    expect(k('Hernández, Ana Itzel')).not.toBe(
      k('Hernández, Ana Milena Quinchara'),
    )
  })

  it('still produces a key shaped like evaluation/experts/validate.ts KEY_RE', () => {
    for (const n of ['Castellanos, Sebastián', 'Hernández, Ana Itzel'])
      expect(k(n)).toMatch(/^[^,]+, [^,]+$/)
  })
})
