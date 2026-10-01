/**
 * Turns the search route's reply into the text an assistant passes to a person.
 *
 * Carries exactly what the design fixes (§2): title, passage, page, link,
 * relevance label, authors, year — and nothing else. The route's reply is the
 * website's own shape (the document list appears twice, each document carries a
 * raw metadata blob and an internal score), so this is a deliberate trim, not a
 * pass-through.
 */

const TIER_MEANING =
  'Relevance is strong, partial or weak: strong means the passage directly addresses the question, weak means it is tangential.'

const THIN_NOTE =
  'The core topic of this question appears to be absent from this corpus. Treat the passages below as tangential.'

const UNREACHABLE =
  'WRI corpus search could not be reached, so there are no passages to show.'

export function formatSearchResults(
  query: string,
  llamaIndexJson: unknown,
  baseUrl: string,
): string {
  const json = (llamaIndexJson ?? {}) as Record<string, any>
  if (json.ok === false) return UNREACHABLE

  const docs: any[] = Array.isArray(json.docs) ? json.docs : []
  const lines: string[] = []

  if (json.likely_off_topic === true) {
    lines.push(THIN_NOTE)
    lines.push('')
  }

  lines.push(`WRI corpus results for "${query}"`)

  if (docs.length === 0) {
    lines.push('No passages matched this question.')
    return lines.join('\n')
  }

  const noun = docs.length === 1 ? 'passage' : 'passages'
  lines.push(`${docs.length} ${noun}. ${TIER_MEANING}`)

  docs.forEach((doc, index) => {
    lines.push('')
    lines.push(...describe(doc, index + 1, baseUrl))
  })

  return lines.join('\n')
}

function describe(doc: any, position: number, baseUrl: string): string[] {
  const snippet = doc?.kps?.[0]?.snippet
  // The route puts the page beside the passage; a document-level page is the
  // fallback for callers that flatten it.
  const page = doc?.kps?.[0]?.page ?? doc?.page
  const tier = doc?.relevance_tier
  const year = doc?.year
  const out: string[] = []

  const heading: string[] = [`${position}. "${doc?.title ?? 'Untitled'}"`]
  if (year) heading.push(`(${year})`)
  if (tier) heading.push(`[${tier}]`)
  out.push(heading.join(' '))

  if (snippet) out.push(`   Passage: "${snippet}"`)

  if (doc?.doc_id) {
    const link = `${baseUrl}/api/pdf/${doc.doc_id}.pdf`
    out.push(page ? `   Page ${page} — ${link}#page=${page}` : `   ${link}`)
  }

  const authors = authorLine(doc?.authors)
  if (authors) out.push(`   Authors: ${authors}`)

  return out
}

function authorLine(authors: unknown): string {
  if (Array.isArray(authors)) return authors.filter(Boolean).join(', ')
  if (typeof authors === 'string') return authors
  return ''
}
