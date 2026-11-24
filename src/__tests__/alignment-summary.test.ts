import { buildAlignmentSummary } from '@/app/utils/utils'

const doc = (id: string, relevance_tier?: string, score = 0.75) =>
  ({ doc_id: id, title: `title ${id}`, score, relevance_tier, kps: [] }) as any

it('counts the tiers the results table shows, not its own score bands', () => {
  const summary = buildAlignmentSummary('urban heat', [
    doc('a', 'strong', 0.72),
    doc('b', 'strong', 0.95),
    doc('c', 'partial', 0.4),
    doc('d', 'weak', 0.12),
  ])
  expect(summary).toContain('Results: 4. Strong: 2. Partial: 1. Weak: 1.')
  expect(summary).not.toContain('Untiered')
  // The old bands: a 0.72 result is Strong in the UI but was not "highly
  // relevant" at 0.8, and a 0.4 partial was not "moderate" at 0.5.
  expect(summary).not.toContain('Highly relevant')
  expect(summary).not.toContain('Moderately')
})

it('reports documents with no tier as untiered instead of folding them into weak', () => {
  const summary = buildAlignmentSummary('urban heat', [
    doc('a', 'strong'),
    doc('b', undefined, 0.85),
    doc('c', undefined, 0.6),
  ])
  expect(summary).toContain('Results: 3. Strong: 1. Partial: 0. Weak: 0.')
  expect(summary).toContain('Untiered: 2.')
})
