/**
 * The text a person or their assistant receives. It carries exactly:
 * title, passage, page, link, relevance label, authors, year — and never
 * the website's plumbing (duplicate document list, raw metadata, raw score).
 */
import { formatSearchResults } from '../mcp/search-results'

function doc(over: Record<string, any> = {}) {
  return {
    doc_id: 'DOC-1234',
    title: 'Cities at the Crossroads',
    year: 2024,
    authors: ['A. Sharma', 'L. Chen'],
    relevance_tier: 'strong',
    score: 0.9137,
    kps: [
      {
        snippet: 'Compact-growth policy shifted toward density bonuses.',
        page: 12,
      },
    ],
    meta: { raw: { secret_internal_field: 'must not leak' } },
    ...over,
  }
}

function reply(docs: any[], over: Record<string, any> = {}) {
  return {
    ok: true,
    docs,
    sources: docs, // the website also returns the list again under this key
    debug: { sourcesCount: docs.length, internal_thing: 'must not leak' },
    usage: { calls: 3, total_usd: 0.004 },
    likely_off_topic: false,
    ...over,
  }
}

const BASE = 'https://askwri.example'

describe('formatSearchResults', () => {
  it('names the query and counts the passages', () => {
    const text = formatSearchResults(
      'compact urban growth',
      reply([doc()]),
      BASE,
    )
    expect(text).toContain('compact urban growth')
    expect(text).toContain('1 passage')
  })

  it('carries the title, passage, page, label, authors and year', () => {
    const text = formatSearchResults('q', reply([doc()]), BASE)
    expect(text).toContain('Cities at the Crossroads')
    expect(text).toContain(
      'Compact-growth policy shifted toward density bonuses.',
    )
    expect(text).toContain('A. Sharma, L. Chen')
    expect(text).toContain('2024')
    expect(text).toContain('[strong]')
  })

  it('builds an absolute link to the page', () => {
    const text = formatSearchResults('q', reply([doc()]), BASE)
    expect(text).toContain(
      'https://askwri.example/api/pdf/DOC-1234.pdf#page=12',
    )
  })

  it('leaks none of the website plumbing', () => {
    const text = formatSearchResults('q', reply([doc()]), BASE)
    expect(text).not.toContain('secret_internal_field')
    expect(text).not.toContain('internal_thing')
    expect(text).not.toContain('0.9137')
    expect(text).not.toContain('raw_score')
  })

  // Review Focus 3
  it('omits the page anchor when there is no page', () => {
    const text = formatSearchResults(
      'q',
      reply([doc({ kps: [{ snippet: 's' }] })]),
      BASE,
    )
    expect(text).toContain('https://askwri.example/api/pdf/DOC-1234.pdf')
    expect(text).not.toContain('#page=')
    expect(text).not.toContain('undefined')
  })

  // Review Focus 2
  it('omits authors and year rather than printing placeholders', () => {
    const text = formatSearchResults(
      'q',
      reply([doc({ authors: undefined, year: undefined })]),
      BASE,
    )
    expect(text).not.toMatch(/undefined|null|n\/a|NaN/)
  })

  // Review Focus 1
  it('keeps several passages from one document in ranked order', () => {
    const text = formatSearchResults(
      'q',
      reply([
        doc({ kps: [{ snippet: 'first passage', page: 3 }] }),
        doc({
          kps: [{ snippet: 'second passage', page: 40 }],
          relevance_tier: 'partial',
        }),
      ]),
      BASE,
    )
    expect(text.indexOf('first passage')).toBeLessThan(
      text.indexOf('second passage'),
    )
    expect(text).toContain('[partial]')
  })

  it('opens with the thin-corpus note when the search says so', () => {
    const text = formatSearchResults(
      'q',
      reply([doc()], { likely_off_topic: true }),
      BASE,
    )
    expect(text.startsWith('The core topic')).toBe(true)
    expect(text).toContain('tangential')
  })

  // Review Focus 5
  it('says plainly when nothing matched', () => {
    const text = formatSearchResults('q', reply([]), BASE)
    expect(text).toContain('No passages')
  })

  // Review Focus 5, continued
  it('asks the search service to return nothing when it fails', () => {
    const text = formatSearchResults('q', { ok: false, error: 'boom' }, BASE)
    expect(text).toContain('could not be reached')
  })
})
