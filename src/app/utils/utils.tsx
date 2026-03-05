/* eslint-disable no-underscore-dangle */
/* eslint-disable no-restricted-syntax */

import { DocMeta } from '@/lib/llamacloud'

export interface CatalogMeta {
  file_path?: string
  metadata?: string
  summary?: string
  [key: string]: any
}

// Catalog row type for catalog helpers
export interface RawCatalogInput {
  file_id: string
  external_file_id: string
  file_name: string
  meta: CatalogMeta
}

export interface CatalogRow {
  articleTitle?: string
  allAuthors?: string
  baseName?: string
  noExt?: string
  titleSlug?: string
  sourceUrl?: string
  articleType?: string
  subTag?: string
  yearAccepted?: number
  dateAccepted?: string
  office?: string
  summary?: string
  raw?: Record<string, any>
  fileName?: string
  meta?: CatalogMeta
}

/* ---------- general helpers ---------- */
export const norm = (s?: string) => (s || '').trim().toLowerCase()
export const firstSentence = (t?: string) => {
  const m = (t || '').match(/[^.!?]*[.!?]/)
  return m ? m[0].trim() : t || ''
}
const basename = (s?: string) => {
  if (!s) return ''
  const p = s.split('?')[0]
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}
const stripExt = (s: string) => s.replace(/\.[a-z0-9]+$/i, '')
const titleCase = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase())
const slug = (s?: string) =>
  norm(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
export const parseAuthors = (csv?: string) =>
  (csv || '')
    .split(/;|,/)
    .map((v) => v.trim())
    .filter(Boolean)
const toYear = (x: string) => {
  const n = Number(x)
  if (Number.isFinite(n)) return n
  if (typeof x === 'string') {
    const m = x.match(/\b(20\d{2}|19\d{2})\b/)
    if (m) return Number(m[1])
  }
  return undefined
}

/* ---------- catalog parsing (same as before) ---------- */
function parseMetaJSON(metaStr?: string): CatalogMeta {
  try {
    const obj = metaStr ? JSON.parse(metaStr) : {}
    const out: CatalogMeta = {}
    for (const [k, v] of Object.entries(obj || {})) out[norm(k)] = v
    if (out['sub-tag (clean1)'] && !out['sub-tag'])
      out['sub-tag'] = out['sub-tag (clean1)']
    return out
  } catch {
    return {}
  }
}
export function normalizeCatalogRow(r: RawCatalogInput): CatalogRow {
  const fileName = r.file_name || r.external_file_id || r.meta?.file_path || ''
  const baseName = basename(fileName)
  const noExt = stripExt(baseName)
  const meta = parseMetaJSON(r.meta?.metadata)
  return {
    fileName,
    baseName: baseName.toLowerCase(),
    noExt: noExt.toLowerCase(),
    titleSlug: slug(meta['article title']) || undefined,
    articleTitle: meta['article title'] || undefined,
    allAuthors: meta['all authors'] || undefined,
    sourceUrl:
      meta['source url'] || meta['other weblink (not doi)'] || undefined,
    articleType: meta['article type'] || undefined,
    subTag: meta['sub-tag'] || undefined,
    yearAccepted: toYear(String(meta['year accepted'] ?? meta.year)),
    dateAccepted: meta['date accepted'] || undefined,
    office: meta['wri office affiliation (primary)'] || undefined,
    summary: r.meta?.summary || undefined, // Preserve the CSV summary field
    raw: meta,
  }
}
export function buildCatalogIndex(items: CatalogRow[]) {
  const byBase = new Map<string, CatalogRow>() // basename + noExt
  const bySlug = new Map<string, CatalogRow>() // title slug
  for (const r of items) {
    if (r.baseName) byBase.set(r.baseName, r)
    if (r.noExt) byBase.set(r.noExt, r)
    if (r.titleSlug) bySlug.set(r.titleSlug, r)
  }
  return { byBase, bySlug }
}

export function matchCatalogRow(
  doc: DocMeta,
  index: {
    byBase: Map<string, CatalogRow>
    bySlug: Map<string, CatalogRow>
  } | null,
): CatalogRow | undefined {
  if (!index) return undefined
  const chunk = (doc.meta as any)?.raw?.chunk || {}
  const candidates = [
    doc._url,
    chunk.file_path,
    chunk.file_name,
    chunk.external_file_id,
    doc.title,
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    const base = stripExt(basename(c).toLowerCase())
    const full = norm(c)
    const s = slug(c)
    if (index.byBase.has(base)) return index.byBase.get(base)
    if (index.byBase.has(full)) return index.byBase.get(full)
    if (s && index.bySlug.has(s)) return index.bySlug.get(s)
  }
  const s2 = slug(doc.title)
  if (s2 && index.bySlug.has(s2)) return index.bySlug.get(s2)
  return undefined
}
export function titleFrom(doc: DocMeta, row?: CatalogRow) {
  const t = row?.articleTitle || doc.title || ''
  if (t) return t
  const fromName =
    row?.baseName || stripExt(basename(doc._url || '')) || '(untitled)'
  return titleCase(fromName.replace(/[_-]+/g, ' ').trim())
}
export function authorsFrom(doc: DocMeta, row?: CatalogRow) {
  if (row?.allAuthors && row.allAuthors !== '—' && row.allAuthors !== '-')
    return parseAuthors(row.allAuthors)
  const fn = row?.raw?.['wri lead author - first name']
  const ln = row?.raw?.['wri lead author - last name']
  if (fn || ln) return [`${fn || ''} ${ln || ''}`.trim()]
  return (doc.authors || []).filter(Boolean)
}
export function yearFrom(doc: DocMeta, row?: CatalogRow) {
  return (
    row?.yearAccepted ??
    toYear(row?.dateAccepted ?? '') ??
    (typeof doc.year === 'number' ? doc.year : undefined)
  )
}
export function typeFrom(row?: CatalogRow) {
  return row?.articleType || 'Report'
}
export function urlFrom(doc: DocMeta, row?: CatalogRow) {
  if (row?.sourceUrl) return row.sourceUrl
  const fn =
    row?.fileName ||
    (doc.meta as any)?.raw?.chunk?.file_name ||
    (doc.meta as any)?.raw?.chunk?.external_file_id
  return fn ? `/api/pdf/${basename(fn)}` : doc._url || null
}
export const chicagoFull = (doc: DocMeta, row?: CatalogRow) => {
  const authors = authorsFrom(doc, row).join('; ') || '(author unknown)'
  const title = `"${titleFrom(doc, row)}"`
  const cityPub = 'Washington, DC: WRI'
  const year = yearFrom(doc, row) ?? ''
  return `${authors}. ${title}. ${cityPub}, ${year}.`
}

export function formatChicagoCitation(doc: DocMeta): string {
  const authorsArray = doc.authors ?? []
  const year = doc.year ?? ''
  const title = doc.title ?? ''

  function formatAuthors(authors: string[]): string {
    if (authors.length === 0) return ''

    const formatted = authors.map((fullName, index) => {
      const nameParts = fullName.trim().split(' ')
      const lastName = nameParts.pop()
      const firstNames = nameParts.join(' ')

      if (!lastName) return fullName

      // First author inverted
      if (index === 0) {
        return `${lastName}, ${firstNames}`
      }

      return `${firstNames} ${lastName}`
    })

    if (formatted.length === 1) return formatted[0]
    if (formatted.length === 2) return formatted.join(' and ')
    return `${formatted.slice(0, -1).join(', ')}, and ${formatted.at(-1)}`
  }

  const authors = formatAuthors(authorsArray)

  let citation = ''

  if (authors) citation += `${authors}. `
  if (year) citation += `${year}. `
  if (title) citation += `${title}. `

  return citation.trim()
}
