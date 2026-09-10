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
    expect(parseAuthorName('Claudia Adriazola-Steil')).toEqual({
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
    expect(tidyAuthorsField('A;B')).toEqual({ value: 'A; B', changed: true, unverified: true })
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
    expect(twice.value).toBe(once.value)
    expect(twice.unverified).toBe(once.unverified)
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
