// src/lib/experts/__tests__/authorKey.test.ts
import {
  buildAuthorIndex,
  isOrganization,
  resolveAuthor,
} from '@/lib/experts/authorKey'

// The 25 variant pairs from wri/askwri#411 reduce to this shape: a CSV row
// stores `Given Family`, a worker row stores `Family, Given`.
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

  it('keys on family + first given token', () => {
    expect(resolveAuthor('Beard, Victoria A.', index).key).toBe(
      'beard, victoria',
    )
  })

  it('resolves a compound family name through its comma-form sibling', () => {
    const a = resolveAuthor('Nicolás García Córdoba', index)
    expect(a.key).toBe('garcía córdoba, nicolás')
    expect(a.name).toBe('García Córdoba, Nicolás')
    expect(a.unverified).toBeFalsy()
  })

  it('flags an unsplit name with no sibling as unverified and keeps it as stored', () => {
    const a = resolveAuthor('Hellen Njoki Wanjohi-Opil', index)
    expect(a.org).toBe(false)
    expect(a.unverified).toBe(true)
    expect(a.name).toBe('Hellen Njoki Wanjohi-Opil')
    expect(a.key).toBe('wanjohi-opil, hellen')
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
})
