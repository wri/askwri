/* eslint-disable no-underscore-dangle */
/* eslint-disable no-restricted-syntax */

import { DocMeta } from '@/lib/llamacloud'

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
const toYear = (x: any) => {
  const n = Number(x)
  if (Number.isFinite(n)) return n
  if (typeof x === 'string') {
    const m = x.match(/\b(20\d{2}|19\d{2})\b/)
    if (m) return Number(m[1])
  }
  return undefined
}

/* ---------- catalog parsing (same as before) ---------- */
function parseMetaJSON(metaStr?: string): Record<string, any> {
  try {
    const obj = metaStr ? JSON.parse(metaStr) : {}
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(obj || {})) out[norm(k)] = v
    if (out['sub-tag (clean1)'] && !out['sub-tag'])
      out['sub-tag'] = out['sub-tag (clean1)']
    return out
  } catch {
    return {}
  }
}
export function normalizeCatalogRow(r: any): any {
  const fileName = r.file_name || r.external_file_id || r.meta?.file_path || ''
  const baseName = basename(fileName)
  const noExt = stripExt(baseName)
  const meta = parseMetaJSON(r.meta?.metadata)
  return {
    fileName,
    baseName: baseName.toLowerCase(),
    noExt: noExt.toLowerCase(),
    titleSlug: slug(meta['article title']),
    articleTitle: meta['article title'] || undefined,
    allAuthors: meta['all authors'] || undefined,
    sourceUrl:
      meta['source url'] || meta['other weblink (not doi)'] || undefined,
    articleType: meta['article type'] || undefined,
    subTag: meta['sub-tag'] || undefined,
    yearAccepted: toYear(meta['year accepted'] ?? meta.year),
    dateAccepted: meta['date accepted'] || undefined,
    office: meta['wri office affiliation (primary)'] || undefined,
    summary: r.meta?.summary || undefined, // Preserve the CSV summary field
    raw: meta,
  }
}
export function buildCatalogIndex(items: any[]) {
  const byBase = new Map<string, any>() // basename + noExt
  const bySlug = new Map<string, any>() // title slug
  for (const r of items) {
    if (r.baseName) byBase.set(r.baseName, r)
    if (r.noExt) byBase.set(r.noExt, r)
    if (r.titleSlug) bySlug.set(r.titleSlug, r)
  }
  return { byBase, bySlug }
}
export function matchCatalogRow(
  doc: DocMeta,
  index: ReturnType<typeof buildCatalogIndex> | null,
): any | undefined {
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
export function titleFrom(doc: DocMeta, row?: any) {
  const t = row?.articleTitle || doc.title || ''
  if (t) return t
  const fromName =
    row?.baseName || stripExt(basename(doc._url || '')) || '(untitled)'
  return titleCase(fromName.replace(/[_-]+/g, ' ').trim())
}
export function authorsFrom(doc: DocMeta, row?: any) {
  if (row?.allAuthors && row.allAuthors !== '—' && row.allAuthors !== '-')
    return parseAuthors(row.allAuthors)
  const fn = row?.raw?.['wri lead author - first name']
  const ln = row?.raw?.['wri lead author - last name']
  if (fn || ln) return [`${fn || ''} ${ln || ''}`.trim()]
  return (doc.authors || []).filter(Boolean)
}
export function yearFrom(doc: DocMeta, row?: any) {
  return (
    row?.yearAccepted ??
    toYear(row?.dateAccepted) ??
    (typeof doc.year === 'number' ? doc.year : undefined)
  )
}
export function typeFrom(row?: any) {
  return row?.articleType || 'Report'
}
export function urlFrom(doc: DocMeta, row?: any) {
  if (row?.sourceUrl) return row.sourceUrl
  const fn =
    row?.fileName ||
    (doc.meta as any)?.raw?.chunk?.file_name ||
    (doc.meta as any)?.raw?.chunk?.external_file_id
  return fn ? `/api/pdf/${basename(fn)}` : doc._url || null
}
export const chicagoFull = (doc: DocMeta, row?: any) => {
  const authors = authorsFrom(doc, row).join(', ') || '(author unknown)'
  const title = `"${titleFrom(doc, row)}"`
  const cityPub = 'Washington, DC: WRI'
  const year = yearFrom(doc, row) ?? ''
  return `${authors}. ${title}. ${cityPub}, ${year}.`
}
