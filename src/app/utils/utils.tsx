import { DocMeta, LlamaCloudDebug } from '@/lib/llamacloud'
import { estimateCostUSD } from '@/config/costs'
import { estimateEnergyGCO2e } from '@/config/energy'
import { Usage } from '../components/AnswerMode/types'

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
  publicationTitle?: string
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
  shortSummary?: string
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
    titleSlug: slug(meta['publication title']) || undefined,
    articleTitle: meta['article title'] || undefined,
    publicationTitle: meta['publication title'] || undefined,
    allAuthors: meta['all authors'] || undefined,
    sourceUrl:
      meta['source url'] || meta['other weblink (not doi)'] || undefined,
    articleType: meta['article type'] || meta.article_type || undefined,
    subTag: meta['sub-tag'] || undefined,
    yearAccepted: toYear(String(meta['year accepted'] ?? meta.year)),
    dateAccepted: meta['date accepted'] || undefined,
    office:
      meta['wri office affiliation (primary)'] ||
      meta.wri_primary_office ||
      undefined,
    summary: r.meta?.summary || undefined, // Preserve the CSV summary field
    shortSummary:
      r.meta?.short_summary ||
      meta['short_summary'] ||
      meta['short summary'] ||
      undefined,
    raw: meta,
  }
}
/** Language label for a result row, from the client-side catalog's raw CSV
 *  metadata ('languages' key survives parseMetaJSON's norm()). Empty for
 *  English-only or unknown — the badge renders only when it informs. */
export function languageLabel(raw?: Record<string, any>): string {
  const v = String(raw?.['languages'] ?? '').trim()
  if (!v || v.toLowerCase() === 'english') return ''
  return v
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
  const t = row?.publicationTitle || doc.title || row?.articleTitle || ''
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
  return doc?.year ?? row?.yearAccepted ?? toYear(row?.dateAccepted ?? '')
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

export function buildAlignmentSummary(query: string, docs: any[]) {
  const reviewedCount = docs.length
  const highlyRelevant = docs.filter((d) => d.score >= 0.8).length
  const moderatelyRelevant = docs.filter(
    (d) => d.score >= 0.5 && d.score < 0.8,
  ).length

  const topDocs = [...docs]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5)

  const passages = topDocs
    .map(
      (d, i) =>
        `${i + 1}. ${d.title || d.doc_id || 'Untitled'} (relevance: ${d.score?.toFixed(2) ?? 'N/A'})`,
    )
    .join(' ')

  const resultsSummaryForAlignment = `Query: ${query}. Results: ${reviewedCount}. Highly relevant: ${highlyRelevant}. Moderately: ${moderatelyRelevant}. Sample passages: ${passages}`

  return resultsSummaryForAlignment
}

export const calculateEmbeddingCost = (
  query: string,
  docs: DocMeta[],
  usage: Usage,
  debug: LlamaCloudDebug,
  promptVersion: string = 'CITEv1.3',
) => {
  // Retrieval is vector search + BM25 — no LLM tokens consumed.
  // Only count the small embedding cost; alignment LLM cost is added later.
  const citeEmbeddingTokens = debug?.estimated_embedding_tokens ?? 50
  const citeEmbeddingCost =
    estimateCostUSD({
      model: 'openai/text-embedding-3-small',
      prompt_tokens: citeEmbeddingTokens,
      completion_tokens: 0,
    }) ?? 0.001
  const citeEmbeddingEnergy =
    estimateEnergyGCO2e({
      model: 'text-embedding-3-small',
      prompt_tokens: citeEmbeddingTokens,
      completion_tokens: 0,
    }) ?? 0.01

  return {
    index_version: 'v1.0',
    prompt_version: promptVersion,
    cost_usd: citeEmbeddingCost,
    energy_gco2e: citeEmbeddingEnergy,
  }
}

export const formatCost = (usd: number | null | undefined): string => {
  const value = usd ?? 0
  if (!Number.isFinite(value)) return ''
  if (value >= 1) return `$${value.toFixed(2)}`
  const cents = value * 100
  if (cents < 0.01) return '< 0.01¢'
  return `${parseFloat(cents.toPrecision(2))}¢`
}

export const formatCO2 = (gco2e: number | null | undefined): string => {
  const value = gco2e ?? 0
  if (!Number.isFinite(value)) return ''
  if (value >= 1) return `${value.toPrecision(3)} g CO2e`
  const mg = value * 1000
  return `${Math.round(mg)} mg CO2e`
}
