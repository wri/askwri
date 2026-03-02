import { DocMeta } from '@/lib/llamacloud'
import { parseAuthors, firstSentence, urlFrom, matchCatalogRow } from './utils'

export function exportCitationsCsv({
  docs,
  selectedIds,
  index,
  docSummary,
}: {
  docs: DocMeta[]
  selectedIds: string[]
  index: any
  docSummary: Record<string, string>
}) {
  const headers = [
    'Title (published title)',
    'Author(s)',
    'Date published online',
    'WRI knowledge product type',
    'Language(s)',
    'DOI',
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
    const title = row?.articleTitle || doc.title || ''
    let authorsArr: string[] = []
    if (row?.allAuthors && row.allAuthors !== '—' && row.allAuthors !== '-') {
      authorsArr = parseAuthors(row.allAuthors)
    } else if (doc.authors && doc.authors.length) {
      authorsArr = doc.authors.filter(Boolean)
    }
    const authors = authorsArr.join('; ')
    let datePublished = ''
    if (row?.raw?.['date published online']) {
      datePublished = formatDate(row.raw['date published online'])
    } else if (row?.dateAccepted) {
      datePublished = formatDate(row.dateAccepted)
    }
    const type = row?.articleType || ''
    let langs = ''
    if (row?.raw?.language) {
      if (Array.isArray(row.raw.language)) {
        langs = row.raw.language.join('; ')
      } else if (typeof row.raw.language === 'string') {
        langs = row.raw.language
          .split(/;|,/)
          .map((l: string) => l.trim())
          .filter(Boolean)
          .join('; ')
      }
    }
    const doi = row?.raw?.doi || ''
    const url = `${window.location.origin}/${urlFrom(doc, row)}`
    const office = row?.office || ''
    let summary =
      docSummary[doc.doc_id] || firstSentence(doc.kps?.[0]?.snippet ?? '')
    if (summary.length > 240) summary = `${summary.slice(0, 237)}...`

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

  const csvContent = [headers.join(','), ...rows].join('\r\n')
  const blob = new Blob([csvContent], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'askwri-citations.csv'
  a.click()
  URL.revokeObjectURL(url)
}
