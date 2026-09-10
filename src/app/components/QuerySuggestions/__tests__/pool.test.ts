import {
  EXPERTS_MODE_SUGGESTION_POOL,
  getRandomSuggestions,
} from '../suggestionPool'

describe('experts suggestion pool', () => {
  it('has at least six people-shaped prompts', () => {
    expect(EXPERTS_MODE_SUGGESTION_POOL.length).toBeGreaterThanOrEqual(6)
    for (const s of EXPERTS_MODE_SUGGESTION_POOL) expect(s).not.toMatch(/\?$/) // topics, not questions
  })
  it('draws from the experts pool', () => {
    const out = getRandomSuggestions(3, 'experts')
    expect(out).toHaveLength(3)
    for (const s of out) expect(EXPERTS_MODE_SUGGESTION_POOL).toContain(s)
  })
})
