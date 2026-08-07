import { DocMeta, LlamaCloudDebug } from '@/lib/llamacloud'
import { estimateCostUSD } from '@/config/costs'
import { estimateEnergyGCO2e } from '@/config/energy'
import { Usage } from '../components/AnswerMode/types'

export interface CatalogMeta {
  file_path?: string
  metadata?: string
  summary?: string
  dms?: CatalogDmsMeta
  [key: string]: any
}

/** Mirror of CatalogDms in src/db/queries/getCatalogItems.ts (serialized over
 *  /api/catalog). Absent when the catalog is served from the legacy CSV. */
export interface CatalogDmsMeta {
  doc_id?: string
  title?: string | null
  title_en?: string | null
  authors?: string | null
  year_published?: number | null
  date_published?: string | null
  publication_title?: string | null
  article_type?: string | null
  wri_primary_office?: string | null
  doi?: string | null
  url?: string | null
  language?: string | null
  languages?: string[] | null
  summary_en?: string | null
  short_summary_en?: string | null
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
  /** Document-management fields — authoritative over everything above. */
  docId?: string
  titleEn?: string
  nativeTitle?: string
  language?: string
  languages?: string[]
  doi?: string
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
/** Split an author list on SEMICOLONS ONLY.
 *
 *  Both `documents.authors` and the legacy CSV `All authors` use
 *  "Last, First; Last, First" — the comma belongs to the name. Splitting on
 *  commas too turned "Qiu, Shiyong; Liu, Daizong" into four "authors" and
 *  mangled single-author rows like "Lazer, Leah" into "Lazer" and "Leah". */
export const parseAuthors = (csv?: string) =>
  (csv || '')
    .split(';')
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
  const dms = r.meta?.dms ?? {}
  return {
    fileName,
    baseName: baseName.toLowerCase(),
    noExt: noExt.toLowerCase(),
    titleSlug:
      slug(dms.title_en ?? undefined) ||
      slug(dms.title ?? undefined) ||
      slug(meta['publication title']) ||
      undefined,
    articleTitle: meta['article title'] || undefined,
    publicationTitle:
      dms.publication_title || meta['publication title'] || undefined,
    allAuthors: dms.authors || meta['all authors'] || undefined,
    // Deliberately NOT dms.url: that is the publication's landing page, while
    // sourceUrl feeds urlFrom, whose consumers (Open document, the preview
    // iframe) need the in-app /api/pdf route.
    sourceUrl:
      meta['source url'] || meta['other weblink (not doi)'] || undefined,
    articleType:
      dms.article_type ||
      meta['article type'] ||
      meta.article_type ||
      undefined,
    subTag: meta['sub-tag'] || undefined,
    yearAccepted:
      dms.year_published ?? toYear(String(meta['year accepted'] ?? meta.year)),
    dateAccepted: dms.date_published || meta['date accepted'] || undefined,
    office:
      dms.wri_primary_office ||
      meta['wri office affiliation (primary)'] ||
      meta.wri_primary_office ||
      undefined,
    summary: dms.summary_en || r.meta?.summary || undefined,
    shortSummary:
      dms.short_summary_en ||
      r.meta?.short_summary ||
      meta['short_summary'] ||
      meta['short summary'] ||
      undefined,
    docId: dms.doc_id || undefined,
    titleEn: dms.title_en || undefined,
    nativeTitle: dms.title || undefined,
    language: dms.language || undefined,
    languages: dms.languages ?? undefined,
    doi: dms.doi || undefined,
    raw: meta,
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese',
  fr: 'French',
  id: 'Bahasa Indonesia',
  hi: 'Hindi',
}

/** Badge label for a result row: the document's own language, from the
 *  document-management `language` column. Empty for English (and for rows with
 *  no DMS record) — the badge renders only when it informs.
 *
 *  It deliberately ignores the legacy CSV `languages` field, which is stale:
 *  three English documents in the corpus carry `languages='Chinese'` there,
 *  which is what made English-only docs render a Chinese badge (issue #306). */
export function languageLabel(row?: CatalogRow): string {
  const code = String(row?.language ?? '')
    .trim()
    .toLowerCase()
  if (!code || code === 'en') return ''
  return LANGUAGE_NAMES[code] ?? code.toUpperCase()
}

export function buildCatalogIndex(items: CatalogRow[]) {
  const byBase = new Map<string, CatalogRow>() // basename + noExt
  const bySlug = new Map<string, CatalogRow>() // title slug
  const byDocId = new Map<string, CatalogRow>() // documents.external_id
  for (const r of items) {
    if (r.baseName) byBase.set(r.baseName, r)
    if (r.noExt) byBase.set(r.noExt, r)
    if (r.titleSlug) bySlug.set(r.titleSlug, r)
    if (r.docId) byDocId.set(r.docId, r)
  }
  return { byBase, bySlug, byDocId }
}

export function matchCatalogRow(
  doc: DocMeta,
  index: {
    byBase: Map<string, CatalogRow>
    bySlug: Map<string, CatalogRow>
    byDocId?: Map<string, CatalogRow>
  } | null,
): CatalogRow | undefined {
  if (!index) return undefined
  // Exact match first: /query's metadata.doc_id IS documents.external_id
  // (search-service worker/stages/embed.py:100), so this is exact where the
  // filename/title heuristics below are only best-effort.
  const byDocId = index.byDocId?.get(doc.doc_id)
  if (byDocId) return byDocId
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
/** The English title, always. `doc.title` comes from chunk node_metadata,
 *  which is built from the frozen CSV `Publication Title` and is bilingual for
 *  documents imported before issue #303 split the pair — so the DMS
 *  `title_en` column wins over it (issues #305, #306). */
export function titleFrom(doc: DocMeta, row?: CatalogRow) {
  const t =
    row?.titleEn ||
    row?.publicationTitle ||
    doc.title ||
    row?.articleTitle ||
    row?.nativeTitle ||
    ''
  if (t) return t
  const fromName =
    row?.baseName || stripExt(basename(doc._url || '')) || '(untitled)'
  return titleCase(fromName.replace(/[_-]+/g, ' ').trim())
}
/** Authors, transliterated to Latin script. `documents.authors` is written by
 *  the parse stage's extraction, which transliterates (issue #303); the
 *  node_metadata fallback is empty for worker-ingested docs, which is what
 *  rendered "Unknown author" / "(author unknown)". */
export function authorsFrom(doc: DocMeta, row?: CatalogRow) {
  if (row?.allAuthors && row.allAuthors !== '—' && row.allAuthors !== '-')
    return parseAuthors(row.allAuthors)
  const fn = row?.raw?.['wri lead author - first name']
  const ln = row?.raw?.['wri lead author - last name']
  if (fn || ln) return [`${fn || ''} ${ln || ''}`.trim()]
  return (doc.authors || []).filter(Boolean)
}
export function yearFrom(doc: DocMeta, row?: CatalogRow) {
  return row?.yearAccepted ?? doc?.year ?? toYear(row?.dateAccepted ?? '')
}
export function typeFrom(row?: CatalogRow) {
  return row?.articleType || 'Report'
}
/** Publisher for the citation: the WRI office that produced the document
 *  (issue #305). Only WRI's global office is in Washington, DC — regional
 *  offices have no city recorded, so the office name stands alone. */
export function publisherFrom(row?: CatalogRow) {
  const office = (row?.office || '').trim()
  if (!office || /^wri\s*(global|hq|headquarters)?$/i.test(office))
    return 'Washington, DC: WRI'
  return office
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
  const publisher = publisherFrom(row)
  const year = yearFrom(doc, row) ?? ''
  return `${authors}. ${title}. ${publisher}, ${year}.`
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
