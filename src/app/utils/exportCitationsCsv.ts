import { DocMeta } from '@/lib/llamacloud'
import {
  firstSentence,
  urlFrom,
  matchCatalogRow,
  buildCatalogIndex,
  titleFrom,
  authorsFrom,
  LANGUAGE_NAMES,
  languageNameFromCode,
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
  language,
  versionExternalId,
}: {
  docs: DocMeta[]
  selectedIds: string[]
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
  origin?: string
  /** The language selected in the dropdown. */
  language?: string
  /** Exact document version to match if the user chose a translated row. */
  versionExternalId?: string
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
    const defaultRow = index ? matchCatalogRow(doc, index) : undefined
    const exactRow =
      versionExternalId && index
        ? index.byDocId.get(versionExternalId)
        : undefined
    const row = exactRow || defaultRow
    const selectedVersionMatchesLanguage =
      !!language &&
      !!row?.language &&
      languageNameFromCode(row.language).toLowerCase() ===
        languageNameFromCode(language).toLowerCase()
    const title =
      selectedVersionMatchesLanguage && row?.nativeTitle
        ? row.nativeTitle
        : titleFrom(doc, row)
    const authors = authorsFrom(doc, row).join('; ')
    // documents.date_published first (row.dateAccepted carries it since the
    // DMS catalog landed); the CSV key remains a fallback for legacy rows.
    let datePublished = ''
    if (row?.dateAccepted) {
      datePublished = formatDate(row.dateAccepted)
    } else if (row?.raw?.['date published']) {
      datePublished = formatDate(row.raw['date published'])
    }
    const type = row?.articleType || ''
    // documents.languages, not the stale CSV `languages` column (issue #306).
    let langs = ''
    if (row?.languages?.length) {
      langs = row.languages
        .map((code) => LANGUAGE_NAMES[code] ?? code)
        .join('; ')
    } else if (typeof row?.raw?.languages === 'string') {
      langs = row.raw.languages
        .split(/;|,/)
        .map((l: string) => l.trim())
        .filter(Boolean)
        .join('; ')
    } else if (Array.isArray(row?.raw?.languages)) {
      langs = row.raw.languages.join('; ')
    }
    const doi = row?.doi || row?.raw?.doi || ''
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
      (selectedVersionMatchesLanguage ? row?.nativeSummary : undefined) ||
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
  language,
  versionExternalId,
}: {
  docs: DocMeta[]
  selectedIds: string[]
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
  /** Optional language label used to select the file and metadata. */
  language?: string
  /** Exact document version this export should match. */
  versionExternalId?: string
}) {
  const csvContent = buildCitationsCsv({
    docs,
    selectedIds,
    index,
    docSummary,
    language,
    versionExternalId,
    origin: window.location.origin,
  })
  const blob = new Blob([csvContent], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = language
    ? `askwri-citations-${slugifyLanguage(language)}.csv`
    : 'askwri-citations.csv'
  a.click()
  URL.revokeObjectURL(url)
}

/** Lowercase, hyphenated filename fragment for a language label
 *  ("Bahasa Indonesia" → "bahasa-indonesia", "Chinese (original)" → "chinese"). */
function slugifyLanguage(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/\(.*?\)/g, '')
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'citations'
  )
}
