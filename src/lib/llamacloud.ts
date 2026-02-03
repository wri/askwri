/* eslint-disable */
import { smartMultiQuerySearch } from './multi-query-strategy'

export type CitationTarget = {
  score: number
  page?: number
  passage_id: string
}
export type KP = {
  kp_relevance: number
  snippet: string
  passage_id: string
  page?: number
  citation_targets: CitationTarget[]
}
export type DocMeta = {
  doc_id: string
  document_id?: string
  ref: string
  title: string
  url?: string
  _url?: string
  host?: string
  authors?: string[]
  year?: number
  source?: string
  summary?: string // Pre-generated summary from CSV
  score?: number
  kps: KP[]
  meta?: any
}
export type LlamaCloudDebug = {
  [k: string]: any
  sourcesCount?: number
  upstreamUniqueDocsCount?: number
}
export type ChatResponse = {
  message: string
  docs: DocMeta[]
  usage?: any
  debug?: LlamaCloudDebug
}

/* ---------------- helpers ---------------- */

function isInBibliographySection(
  snippet: string,
  allSnippets: string[],
  currentIndex: number,
): boolean {
  const text = snippet.toLowerCase().trim()
  const windowSize = 3 // Look at 3 chunks before and after

  // Get surrounding context
  const start = Math.max(0, currentIndex - windowSize)
  const end = Math.min(allSnippets.length, currentIndex + windowSize + 1)
  const contextSnippets = allSnippets
    .slice(start, end)
    .map((s) => s.toLowerCase().trim())

  // Check if any nearby chunk contains bibliography section headers
  const bibHeaders = [
    /^references?\s*$/,
    /^bibliography\s*$/,
    /^works?\s+cited\s*$/,
    /^literature\s+cited\s*$/,
    /^sources?\s*$/,
    /references?\s+and\s+sources?/i,
    /acknowledgments?\s+and\s+references?/i,
  ]

  const hasBibHeader = contextSnippets.some((chunk) =>
    bibHeaders.some((pattern) => pattern.test(chunk)),
  )

  if (hasBibHeader) {
    // We're near a bibliography section, check if this chunk looks citation-like
    const citationIndicators = [
      /^\d+\.\s/, // Numbered list
      /^[a-z]+,?\s+[a-z]+\./i, // "Author, Name."
      /\(\d{4}\)/, // Year in parentheses
      /\b(journal|proceedings|conference|university|press)\b/i,
      /\b(pp?\.|pages?|vol\.|volume|no\.|number)\s*\d+/i,
      /\b(doi|isbn|issn):/i,
      /https?:\/\//, // URLs
      /\b(accessed|retrieved|available)\s+(at|from|on)\b/i,
    ]

    if (citationIndicators.some((pattern) => pattern.test(text))) {
      return true
    }
  }

  // Check for footnote sections by looking for numbered patterns
  const footnoteContext = contextSnippets.some(
    (chunk) =>
      /^(footnotes?|notes?)\s*$/i.test(chunk) ||
      /^\d+\s+[^.]+\.\s*$/.test(chunk),
  )

  if (footnoteContext && /^\d+/.test(text)) {
    return true
  }

  // Check density of citation-like patterns in surrounding context
  const citationDensity = contextSnippets.filter(
    (chunk) =>
      /^[a-z]+,?\s+[a-z]+/i.test(chunk) || // Author names
      /\(\d{4}\)/.test(chunk) || // Years
      /\b(pp?\.|vol\.|doi)/.test(chunk), // Academic indicators
  ).length

  // If 50%+ of surrounding chunks look like citations, this is likely a bib section
  return citationDensity >= contextSnippets.length * 0.5
}

function isFootnoteOrBibliography(
  snippet: string,
  allSnippets?: string[],
  currentIndex?: number,
): boolean {
  const text = snippet.toLowerCase().trim()

  // Skip very short snippets (likely incomplete fragments)
  if (text.length < 15) return true

  // Strong individual patterns (definitive matches)
  const strongBibPatterns = [
    /^references?\s*$/,
    /^bibliography\s*$/,
    /^works?\s+cited\s*$/,
    /^literature\s+cited\s*$/,
    /^sources?\s*$/,
    /^appendix\s+[a-z]?:?\s*(references|bibliography)/i,
  ]

  // Strong footnote patterns
  const strongFootnotePatterns = [
    /^\d+\s+[^.]{5,50}\.?\s*$/, // "1 Some footnote text."
    /^(ibid|op\.?\s*cit|loc\.?\s*cit|supra)/i, // Latin references
    /^note\s+\d+/i, // "Note 12"
    /^fn\.\s*\d+/i, // "Fn. 5"
  ]

  // Check strong patterns first
  if (
    [...strongBibPatterns, ...strongFootnotePatterns].some((pattern) =>
      pattern.test(text),
    )
  ) {
    return true
  }

  // Citation-like patterns (may need context)
  const citationPatterns = [
    /^\d+\.\s*[a-z]+,?\s+[a-z]+/i, // "1. Author, Title"
    /^[a-z]+,?\s+[a-z]+\.?\s+\(\d{4}\)/i, // "Author, Title. (2023)"
    /^[a-z]+,?\s+[a-z]+\.?\s+\d{4}/i, // "Author, Title. 2023"
    /^[a-z]+\s+et\s+al\./i, // "Smith et al."
    /^see\s+(also\s+)?[a-z]+/i, // "See also Author"
    /\b(doi|isbn|issn):\s*[\w\-\.\/]+/i, // DOI/ISBN identifiers
    /\b(pp?\.|pages?)\s+\d+/i, // Page references
    /\b(vol\.|volume)\s+\d+/i, // Volume references
  ]

  // URL-heavy content
  const urlPattern = /(https?:\/\/[^\s]+)/gi
  const urlMatches = text.match(urlPattern)
  if (urlMatches && urlMatches.join('').length > text.length * 0.5) {
    return true // More than 50% URLs
  }

  // Context-aware detection (if surrounding chunks are provided)
  if (allSnippets && typeof currentIndex === 'number') {
    return isInBibliographySection(snippet, allSnippets, currentIndex)
  }

  // Fallback to citation patterns for individual chunks
  return citationPatterns.some((pattern) => pattern.test(text))
}
const norm = (s?: string) => (s || '').trim().toLowerCase()
const toRef = (id: string) =>
  norm(id)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || `ref_${Math.random().toString(36).slice(2, 10)}`
const toHost = (u?: string) => {
  try {
    return u ? new URL(u).host.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}
const toYear = (x: any): number | undefined => {
  if (typeof x === 'number') return x
  const s = String(x || '')
  const m = s.match(/\b(19|20)\d{2}\b/)
  return m ? Number(m[0]) : undefined
}
const parseAuthors = (raw: any): string[] | undefined => {
  if (!raw) return undefined
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return String(raw)
    .split(/[;|,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function ensureAtLeastOneKP(doc: DocMeta): void {
  if (!doc.kps || doc.kps.length === 0) {
    const base = doc.score ?? 0.7
    doc.kps = [
      {
        kp_relevance: base,
        snippet: doc.title || '',
        page: 1,
        passage_id: `${doc.doc_id}:t`,
        citation_targets: [
          { score: base, page: 1, passage_id: `${doc.doc_id}:t` },
        ],
      },
    ]
  }
}

function scoreOf(x: any): number | undefined {
  const c = x ?? {}
  for (const k of ['score', 'similarity', 'relevance', 'kp_relevance']) {
    if (typeof c[k] === 'number') return c[k] as number
  }
  return undefined
}

/* tolerant extraction for old responses */
function extractCandidates(x: any): any[] {
  if (!x || typeof x !== 'object') return []
  if (Array.isArray(x.docs) && x.docs.length) return x.docs
  if (Array.isArray(x.sources)) return x.sources
  if (x.citations?.sources && Array.isArray(x.citations.sources))
    return x.citations.sources
  for (const k of [
    'nodes',
    'results',
    'passages',
    'chunks',
    'items',
    'evidence',
    'bibliography',
    'references',
  ]) {
    const v = (x as any)[k]
    if (Array.isArray(v)) return v
  }
  return []
}

function normalizeOneUnfiltered(raw: any): DocMeta | null {
  if (!raw) return null
  const md = raw.metadata || raw.meta || {}
  const documentId = String(
    raw.document_id ??
      raw.doc_id ??
      md.document_id ??
      md.parent_document_id ??
      md.parent_id ??
      md.pipeline_file_id ??
      md.external_file_id ??
      raw.id ??
      '',
  )
  if (!documentId) return null

  const title = String(
    raw.title ??
      md.ArticleTitle ??
      md.title ??
      md.file_name ??
      md.file_path ??
      raw.section_title ??
      ((raw.text || '').slice(0, 80) || 'Untitled'),
  )
  const url = raw.url ?? md.SourceURL ?? md.url
  const authors = parseAuthors(
    md.Allauthors ?? md.authors ?? md.author ?? md.creator,
  )
  const year = toYear(
    md.YEARaccepted ?? md.year ?? md.pub_year ?? md.Dateaccepted ?? md.date,
  )
  const source = md.source ?? md.collection ?? md.domain ?? toHost(url)
  const summary = md.Summary ?? md.summary ?? null
  const baseScore = scoreOf(raw)
  const page = raw.page ?? md.page_label ?? md.page ?? md.start_page_label ?? 1
  const passageId = String(
    raw.passage_id ?? raw.node_id ?? raw.id ?? `${documentId}:${page}`,
  )

  let kps: KP[] = []
  if (Array.isArray(raw.kps) && raw.kps.length) {
    kps = raw.kps.map((k: any) => ({
      kp_relevance: Number(scoreOf(k) ?? baseScore ?? 0.7),
      snippet: String(k.snippet ?? k.text ?? ''),
      page: k.page ?? page,
      passage_id: String(k.passage_id ?? passageId),
      citation_targets:
        Array.isArray(k.citation_targets) && k.citation_targets.length
          ? k.citation_targets.map((t: any) => ({
              score: Number(scoreOf(t) ?? scoreOf(k) ?? baseScore ?? 0.7),
              page: t.page ?? page,
              passage_id: String(t.passage_id ?? passageId),
            }))
          : [
              {
                score: Number(scoreOf(k) ?? baseScore ?? 0.7),
                page,
                passage_id: passageId,
              },
            ],
    }))
  } else if (raw.text || raw.snippet || raw.excerpt) {
    const snippet = String(raw.text ?? raw.snippet ?? raw.excerpt)
    const s = Number(baseScore ?? 0.7)
    kps = [
      {
        kp_relevance: s,
        snippet,
        page,
        passage_id: passageId,
        citation_targets: [{ score: s, page, passage_id: passageId }],
      },
    ]
  }

  const doc: DocMeta = {
    doc_id: documentId,
    document_id: documentId,
    ref: toRef(documentId),
    title,
    url,
    _url: md.file_path || md.file_name || undefined,
    host: toHost(url),
    authors,
    year,
    source,
    summary,
    score: baseScore,
    kps,
    meta: { raw },
  }
  ensureAtLeastOneKP(doc)
  // NO FILTERING - keep all content including references/bibliography for alignment analysis
  doc.kps = doc.kps
    .sort((a, b) => b.kp_relevance - a.kp_relevance)
    .slice(0, 200) // Increased from 80 to 200
  return doc
}

function normalizeOne(raw: any): DocMeta | null {
  if (!raw) return null
  const md = raw.metadata || raw.meta || {}
  const document_id = String(
    raw.document_id ??
      raw.doc_id ??
      md.document_id ??
      md.parent_document_id ??
      md.parent_id ??
      md.pipeline_file_id ??
      md.external_file_id ??
      raw.id ??
      '',
  )
  if (!document_id) return null

  const title = String(
    raw.title ??
      md['Article Title'] ??
      md.title ??
      md.file_name ??
      md.file_path ??
      raw.section_title ??
      ((raw.text || '').slice(0, 80) || 'Untitled'),
  )
  const url = raw.url ?? md['Source URL'] ?? md.url
  const authors = parseAuthors(
    md['All authors'] ?? md.authors ?? md.author ?? md.creator,
  )
  const year = toYear(
    md['YEAR accepted'] ??
      md.year ??
      md.pub_year ??
      md['Date accepted'] ??
      md.date,
  )
  const source = md.source ?? md.collection ?? md.domain ?? toHost(url)
  const summary = md.Summary ?? md.summary ?? null // Get pre-generated summary from CSV
  const baseScore = scoreOf(raw)
  const page = raw.page ?? md.page_label ?? md.page ?? md.start_page_label ?? 1
  const passage_id = String(
    raw.passage_id ?? raw.node_id ?? raw.id ?? `${document_id}:${page}`,
  )

  let kps: KP[] = []
  if (Array.isArray(raw.kps) && raw.kps.length) {
    kps = raw.kps.map((k: any) => ({
      kp_relevance: Number(scoreOf(k) ?? baseScore ?? 0.7),
      snippet: String(k.snippet ?? k.text ?? ''),
      page: k.page ?? page,
      passage_id: String(k.passage_id ?? passage_id),
      citation_targets:
        Array.isArray(k.citation_targets) && k.citation_targets.length
          ? k.citation_targets.map((t: any) => ({
              score: Number(scoreOf(t) ?? scoreOf(k) ?? baseScore ?? 0.7),
              page: t.page ?? page,
              passage_id: String(t.passage_id ?? passage_id),
            }))
          : [
              {
                score: Number(scoreOf(k) ?? baseScore ?? 0.7),
                page,
                passage_id,
              },
            ],
    }))
  } else if (raw.text || raw.snippet || raw.excerpt) {
    const snippet = String(raw.text ?? raw.snippet ?? raw.excerpt)
    const s = Number(baseScore ?? 0.7)
    kps = [
      {
        kp_relevance: s,
        snippet,
        page,
        passage_id,
        citation_targets: [{ score: s, page, passage_id }],
      },
    ]
  }

  const doc: DocMeta = {
    doc_id: document_id,
    document_id,
    ref: toRef(document_id),
    title,
    url,
    _url: md.file_path || md.file_name || undefined,
    host: toHost(url),
    authors,
    year,
    source,
    summary,
    score: baseScore,
    kps,
    meta: { raw },
  }
  ensureAtLeastOneKP(doc)
  // Filter out footnotes and bibliography before sorting and capping (with context)
  const allSnippets = doc.kps.map((kp) => kp.snippet)
  const filteredKps = doc.kps.filter(
    (kp, index) => !isFootnoteOrBibliography(kp.snippet, allSnippets, index),
  )

  // Ensure we always keep at least 3-5 KPs per document for rich citations
  if (filteredKps.length < 3 && doc.kps.length > 0) {
    // If filtering removed too much, keep top KPs regardless of filtering
    const topKps = doc.kps
      .sort((a, b) => b.kp_relevance - a.kp_relevance)
      .slice(0, 5)
    doc.kps = topKps
  } else {
    doc.kps = filteredKps
      .sort((a, b) => b.kp_relevance - a.kp_relevance)
      .slice(0, 80)
  }
  return doc
}

function unfilteredDedupe(docs: DocMeta[]): DocMeta[] {
  const m = new Map<string, DocMeta>()
  for (const d of docs) {
    const ex = m.get(d.doc_id)
    if (!ex) {
      m.set(d.doc_id, { ...d, kps: [...d.kps] })
      continue
    }
    ex.title ||= d.title
    ex.url ||= d.url
    ex._url ||= d._url
    ex.host ||= d.host
    if (!ex.authors?.length && d.authors?.length) ex.authors = d.authors
    ex.year ||= d.year
    ex.source ||= d.source
    ex.score = Math.max(ex.score ?? 0, d.score ?? 0)
    ex.kps.push(...d.kps)
    // NO FILTERING - preserve all content including references for alignment analysis
    ex.kps = ex.kps
      .sort((a, b) => b.kp_relevance - a.kp_relevance)
      .slice(0, 300) // Increased from 200 to 300 for maximum recall
  }
  return Array.from(m.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

function dedupe(docs: DocMeta[]): DocMeta[] {
  const m = new Map<string, DocMeta>()
  for (const d of docs) {
    const ex = m.get(d.doc_id)
    if (!ex) {
      m.set(d.doc_id, { ...d, kps: [...d.kps] })
      continue
    }
    ex.title ||= d.title
    ex.url ||= d.url
    ex._url ||= d._url
    ex.host ||= d.host
    if (!ex.authors?.length && d.authors?.length) ex.authors = d.authors
    ex.year ||= d.year
    ex.source ||= d.source
    ex.score = Math.max(ex.score ?? 0, d.score ?? 0)
    ex.kps.push(...d.kps)
    // Apply context-aware filtering after merging all KPs
    const allSnippets = ex.kps.map((kp) => kp.snippet)
    const filteredKps = ex.kps.filter(
      (kp, index) => !isFootnoteOrBibliography(kp.snippet, allSnippets, index),
    )

    // Ensure we always keep at least one KP per document after deduplication
    if (filteredKps.length === 0 && ex.kps.length > 0) {
      const bestKp = ex.kps.sort((a, b) => b.kp_relevance - a.kp_relevance)[0]
      ex.kps = [bestKp]
    } else {
      ex.kps = filteredKps
        .sort((a, b) => b.kp_relevance - a.kp_relevance)
        .slice(0, 300) // Increased from 200 to 300
    }
  }
  return Array.from(m.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

async function call(routeBody: any) {
  const res = await fetch('/api/llama/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // NOTE: we intentionally do NOT send preview:true to avoid empty sources frames
    body: JSON.stringify(routeBody),
  })
  if (!res.ok) throw new Error(`/api/llama/chat ${res.status}`)
  return res.json()
}

export async function chatAnswer(
  query: string,
  overrides?: Record<string, any>,
): Promise<ChatResponse> {
  // Force broader retrieval by using more permissive defaults
  const defaultOverrides = {
    retrievalMode: 'hybrid', // Changed to hybrid for better recall
    denseTopK: 1500, // Increased from 1000
    sparseTopK: 1500, // Increased from 1000
    alpha: 0.3, // More balanced
    rerank: false,
    surface: 'union',
    citation: true,
    ...overrides,
  }
  const payload = { query, mode: 'answer', ...defaultOverrides }
  const data = await call(payload)
  const prelim =
    Array.isArray(data?.docs) && data.docs.length
      ? data.docs
      : extractCandidates(data)
  const docs = dedupe(prelim.map(normalizeOne).filter(Boolean) as DocMeta[])
  const debug = {
    ...(data.debug || {}),
    sourcesCount: Array.isArray(prelim) ? prelim.length : 0,
    upstreamUniqueDocsCount: docs.length,
  }
  return {
    message: String(data?.message || ''),
    docs,
    usage: data?.usage,
    debug,
  }
}

export async function chatAnswerUnfiltered(
  query: string,
  overrides?: Record<string, any>,
): Promise<ChatResponse> {
  const payload = {
    query,
    mode: 'answer',
    surface: 'union',
    citation: true,
    retrievalMode: 'chunks',
    ...(overrides || {}),
  }
  const data = await call(payload)
  const prelim =
    Array.isArray(data?.docs) && data.docs.length
      ? data.docs
      : extractCandidates(data)
  // Use unfilteredDedupe that preserves references/bibliography
  const docs = unfilteredDedupe(
    prelim.map(normalizeOneUnfiltered).filter(Boolean) as DocMeta[],
  )
  const debug = {
    ...(data.debug || {}),
    sourcesCount: Array.isArray(prelim) ? prelim.length : 0,
    upstreamUniqueDocsCount: docs.length,
  }
  return {
    message: String(data?.message || ''),
    docs,
    usage: data?.usage,
    debug,
  }
}

export async function chatCite(
  query: string,
  overrides?: Record<string, any>,
): Promise<ChatResponse> {
  // Check if multi-query mode is enabled (default: false for now to avoid recursion issues)
  const useMultiQuery = overrides?.multiQuery === true
  if (useMultiQuery) {
    // Pass this function recursively for the multi-query to use
    const { docs, queryCount, timing } = await smartMultiQuerySearch(
      query,
      'cite',
      10,
      (q: string, o?: any) => chatCite(q, { ...o, multiQuery: false }), // Prevent infinite recursion
    )
    return {
      message: '',
      docs,
      usage: { total_tokens: queryCount * 1000 }, // Rough estimate
      debug: {
        multiQuery: true,
        queryCount,
        timing,
        uniqueDocsCount: docs.length,
      },
    }
  }
  // Original single-query logic
  const defaultOverrides = {
    retrievalMode: 'hybrid', // Changed to hybrid for maximum recall
    denseTopK: 2000, // Doubled from 1000
    sparseTopK: 2000, // Doubled from 1000
    alpha: 0.2, // More balanced for better recall
    rerank: false,
    surface: 'union',
    citation: true,
    ...overrides,
  }
  const payload = { query, mode: 'cite', ...defaultOverrides }
  const data = await call(payload)
  const prelim =
    Array.isArray(data?.docs) && data.docs.length
      ? data.docs
      : extractCandidates(data)
  const docs = dedupe(prelim.map(normalizeOne).filter(Boolean) as DocMeta[])
  const debug = {
    ...(data.debug || {}),
    sourcesCount: Array.isArray(prelim) ? prelim.length : 0,
    upstreamUniqueDocsCount: docs.length,
  }
  return {
    message: String(data?.message || ''),
    docs,
    usage: data?.usage,
    debug,
  }
}
