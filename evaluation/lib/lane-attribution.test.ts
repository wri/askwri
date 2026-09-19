// evaluation/lib/lane-attribution.test.ts
import { classifyDisplacement, FusedNode } from './lane-attribution'

const node = (
  node_id: string,
  url: string,
  fused_rank: number,
  lanes: Record<string, number | null>,
): FusedNode => ({ node_id, doc_id: null, url, fused_rank, lanes })

const GOLDEN = 'https://www.wri.org/research/golden-doc'

describe('classifyDisplacement', () => {
  it('flags a golden doc outside the window with variant-only nodes inside', () => {
    const fused = [
      node('v1', 'https://www.wri.org/research/noise-a', 1, {
        dense: null,
        sparse: null,
        alias_sparse: 1,
      }),
      node('g1', GOLDEN, 3, { dense: 40, sparse: null, alias_sparse: null }),
    ]
    const out = classifyDisplacement([GOLDEN], fused, ['v1'])
    expect(out).toEqual([
      {
        expected_url: GOLDEN,
        status: 'displaced_by_variant_lane',
        best_fused_rank: 3,
        variant_only_in_window: 1,
      },
    ])
  })

  it('below_window when nothing variant-only sits in the window', () => {
    const fused = [
      node('o1', 'https://www.wri.org/research/noise-b', 1, {
        dense: 1,
        sparse: 2,
        alias_sparse: null,
      }),
      node('g1', GOLDEN, 5, { dense: 90, sparse: null, alias_sparse: null }),
    ]
    const out = classifyDisplacement([GOLDEN], fused, ['o1'])
    expect(out[0].status).toBe('below_window')
  })

  it('in_window_not_returned when the golden doc made the window', () => {
    const fused = [
      node('g1', GOLDEN, 1, { dense: 1, sparse: 1, alias_sparse: null }),
    ]
    const out = classifyDisplacement([GOLDEN], fused, ['g1'])
    expect(out[0].status).toBe('in_window_not_returned')
  })

  it('never_retrieved when no lane surfaced the doc at all', () => {
    const out = classifyDisplacement([GOLDEN], [], [])
    expect(out[0].status).toBe('never_retrieved')
  })
})
