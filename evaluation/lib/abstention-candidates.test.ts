import { candidatesFor, STOP_WORDS } from './abstention-candidates'

/**
 * The mirror must match the service's documented policy exactly — these
 * cases pin it, including the two extraction modes observed for d9 (issue
 * #402) and the q6 flip that refuted the naive stop-word filter.
 */
describe('abstention candidate policy (mirror of core_topic_in_corpus)', () => {
  it('empty or blank topic -> no candidates (cannot abstain)', () => {
    expect(candidatesFor('')).toEqual([])
    expect(candidatesFor('   ')).toEqual([])
  })

  it('single-word topic matches as itself, no 2-grams', () => {
    expect(candidatesFor('hydrogen')).toEqual(['hydrogen'])
  })

  it('two-word topic: the full phrase is the only candidate', () => {
    expect(candidatesFor('vertical farming')).toEqual(['vertical farming'])
  })

  it('long topic: full phrase plus each contiguous 2-gram', () => {
    expect(candidatesFor('zero-emission heavy-duty truck adoption')).toEqual([
      'zero-emission heavy-duty truck adoption',
      'zero-emission heavy-duty',
      'heavy-duty truck',
      'truck adoption',
    ])
  })

  it('single words are never candidates for multi-word topics', () => {
    const cands = candidatesFor('urban vertical farming')
    expect(cands).not.toContain('urban')
    expect(cands).not.toContain('vertical')
    expect(cands).not.toContain('farming')
  })

  describe('stopword-filtered policy', () => {
    it("drops framing fragments like 'in cities' (the d9 collision)", () => {
      const cands = candidatesFor(
        'urban vertical farming or rooftop agriculture in cities',
        'stopword-filtered',
      )
      expect(cands).toEqual([
        'urban vertical',
        'vertical farming',
        'rooftop agriculture',
      ])
    })

    it('can leave a topic with NO candidates - the q6 flip (this is why the filter was refuted)', () => {
      expect(
        candidatesFor('bike-sharing in china', 'stopword-filtered'),
      ).toEqual([])
    })

    it('current policy keeps the framing fragments (mirrors the deployed service)', () => {
      expect(candidatesFor('bike-sharing in china')).toEqual([
        'bike-sharing in china',
        'bike-sharing in',
        'in china',
      ])
    })

    it('stop words are lowercase-only matches', () => {
      expect(STOP_WORDS.has('In')).toBe(false)
      expect(STOP_WORDS.has('in')).toBe(true)
    })
  })
})
