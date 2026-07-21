import { DocMeta } from '@/lib/llamacloud'
import {
  firstSentence,
  urlFrom,
  matchCatalogRow,
  buildCatalogIndex,
  titleFrom,
} from './utils'

/**
 * Build the citations CSV as a string. Extracted from exportCitationsCsv for
 * testability (the download function uses browser APIs — Blob, URL — that
 * aren't available in jsdom/node test envs).
 *
 * Summary selection: prefers the full long summary (row.summary, from the
 * catalog) over the 240-char-truncated short summary (row.shortSummary).
 * The CSV-source short summaries are mid-sentence-truncated upstream; using
 * the long summary avoids propagating garbage to exported citations.
 */
export function buildCitationsCsv({
  docs,
  selectedIds,
  index,
  docSummary,
  origin = 'http://localhost',
}: {
  docs: DocMeta[]
  selectedIds: string[]
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
  origin?: string
}): string {
  const headers = [
    'Title (published title)',
    'Author(s)',
    'Date published online',
    'WRI knowledge product type',
    'Language(s)',
    'DOI (not always available)',
    'URL',
    'WRI Office affiliation (primary)',
    'Summary',
  ]

  function formatDate(dateStr: string) {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    if (!Number.isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0')
      const month = String(d.getMonth() + 1).padStart(2, '0')
      const year = d.getFullYear()
      return `${day}/${month}/${year}`
    }
    if (/\d{2}\/\d{2}\/\d{4}/.test(dateStr)) return dateStr
    return ''
  }

  function csvEscape(val: string) {
    if (val == null) return ''
    const s = String(val)
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }

  const selectedDocs = docs.filter((doc: DocMeta) =>
    selectedIds.includes(doc.doc_id),
  )
  const rows = selectedDocs.map((doc: DocMeta) => {
    const row = index ? matchCatalogRow(doc, index) : undefined
    const title = titleFrom(doc, row)
    const authors = row?.allAuthors || ''
    let datePublished = ''
    if (row?.raw?.['date published']) {
      datePublished = formatDate(row.raw['date published'])
    } else if (row?.dateAccepted) {
      datePublished = formatDate(row.dateAccepted)
    }
    const type = row?.articleType || ''
    let langs = ''
    if (row?.raw?.languages) {
      if (Array.isArray(row.raw.languages)) {
        langs = row.raw.languages.join('; ')
      } else if (typeof row.raw.languages === 'string') {
        langs = row.raw.languages
          .split(/;|,/)
          .map((l: string) => l.trim())
          .filter(Boolean)
          .join('; ')
      }
    }
    const doi = row?.raw?.doi || ''
    const relativeOrAbsoluteUrl = urlFrom(doc, row)
    const url = relativeOrAbsoluteUrl
      ? new URL(relativeOrAbsoluteUrl, origin).toString()
      : ''
    const office = row?.office || ''

    // Prefer the full long summary (row.summary) over the truncated short
    // (row.shortSummary, which is 240-char-truncated mid-sentence in the
    // CSV source). Fall back to docSummary, then firstSentence of the best
    // snippet. No artificial 240-char truncation — the long summary is
    // already a complete sentence.
    const summary =
      row?.summary ||
      docSummary[doc.doc_id] ||
      row?.shortSummary ||
      firstSentence(doc.kps?.[0]?.snippet ?? '')

    return [
      title,
      authors,
      datePublished,
      type,
      langs,
      doi,
      url,
      office,
      summary,
    ]
      .map(csvEscape)
      .join(',')
  })

  return [headers.map(csvEscape).join(','), ...rows].join('\r\n')
}

export function exportCitationsCsv({
  docs,
  selectedIds,
  index,
  docSummary,
}: {
  docs: DocMeta[]
  selectedIds: string[]
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
}) {
  const csvContent = buildCitationsCsv({
    docs,
    selectedIds,
    index,
    docSummary,
    origin: window.location.origin,
  })
  const blob = new Blob([csvContent], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'askwri-citations.csv'
  a.click()
  URL.revokeObjectURL(url)
}
