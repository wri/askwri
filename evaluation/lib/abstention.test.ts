import { isAbstained, isFalseAbstention } from './abstention'

/**
 * Issue #354: the abstention guardrail must score the shipped signal. These
 * truth-table cases pin the contract — including the two states the old
 * `retrieved.length === 0` definition got wrong.
 */
describe('abstention contract (#354)', () => {
  describe('isAbstained', () => {
    it('0 docs, no flag → abstained (the floor-only path)', () => {
      expect(isAbstained(0, false)).toBe(true)
    })

    it('docs under the flag → abstained (the banner contract; d8 returns 25 docs flagged)', () => {
      expect(isAbstained(25, true)).toBe(true)
    })

    it('0 docs under the flag → abstained', () => {
      expect(isAbstained(0, true)).toBe(true)
    })

    it('docs, no flag → NOT abstained (the broken state this issue fixes)', () => {
      expect(isAbstained(25, false)).toBe(false)
    })
  })

  describe('isFalseAbstention', () => {
    it('positive case flagged → true (banner on a query the corpus answers)', () => {
      expect(isFalseAbstention('positive', true)).toBe(true)
    })

    it('positive case unflagged → false', () => {
      expect(isFalseAbstention('positive', false)).toBe(false)
    })

    it('negative case flagged → false (that is the abstention working)', () => {
      expect(isFalseAbstention('negative', true)).toBe(false)
    })
  })
})
