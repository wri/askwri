import { facetSignals } from '../lib/facet-signals'

describe('facetSignals', () => {
  it('returns nulls for a target that predates the signals', () => {
    expect(facetSignals(undefined)).toEqual({
      facetMode: null,
      excludedDocIds: null,
      boostedDocIds: null,
    })
    expect(facetSignals({})).toEqual({
      facetMode: null,
      excludedDocIds: null,
      boostedDocIds: null,
    })
  })

  it('passes the arm and the two id lists through', () => {
    expect(
      facetSignals({
        facet_mode: 'boost',
        excluded_doc_ids: ['a'],
        boosted_doc_ids: ['b', 'c'],
      }),
    ).toEqual({
      facetMode: 'boost',
      excludedDocIds: ['a'],
      boostedDocIds: ['b', 'c'],
    })
  })

  it('refuses an unknown mode rather than recording it as an arm', () => {
    // A mislabelled arm is worse than a missing one: the report would claim a
    // comparison that never ran.
    expect(facetSignals({ facet_mode: 'boos' }).facetMode).toBeNull()
  })
})
