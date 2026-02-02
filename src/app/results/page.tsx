'use client'

/* eslint-disable */
// WIP it might not be worth linting this file while we are migrating it

import React, { useMemo, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { Spinner } from '@chakra-ui/react'
import { DocMeta as LiveDoc, KP as LiveKP } from '@/lib/llamacloud'
import {
  chatAnswerLlamaIndex,
  chatCiteLlamaIndex,
} from '@/lib/llamaindex-client'
import { ANSWER_PRESET, CITE_PRESET } from '@/config/retrieval'
import { estimateCostUSD } from '@/config/costs'
import { estimateEnergyGCO2e } from '@/config/energy'
import ResultsPage from '../components/results'
import { RowData } from '../components/results/types'

// import { FeedbackWidget } from "@/components/FeedbackWidget";

/* ---------- tiny UI helpers ---------- */
const SectionTitle = ({ children }: React.PropsWithChildren) => (
  <h3>{children}</h3>
)
const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <span>{label}</span>
    <span>{value}</span>
  </div>
)

/* ---------- types ---------- */
type DocMeta = LiveDoc
type KP = LiveKP
type Mode = 'answer' | 'cite' | 'lit' | 'explain'
type CitationTarget = { score: number; page: number; passage_id: string }

/* ---------- general helpers ---------- */
const norm = (s?: string) => (s || '').trim().toLowerCase()
const firstSentence = (t?: string) => {
  const m = (t || '').match(/[^.!?]*[.!?]/)
  return m ? m[0].trim() : t || ''
}
const twoDp = (n?: number) =>
  (Math.round((Number(n) || 0) * 100) / 100).toFixed(2)
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
const parseAuthors = (csv?: string) =>
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
const fallbackCity = () => 'Washington, DC'
const fallbackPublisher = () => 'WRI'

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
function normalizeCatalogRow(r: any): any {
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
function buildCatalogIndex(items: any[]) {
  const byBase = new Map<string, any>() // basename + noExt
  const bySlug = new Map<string, any>() // title slug
  items.forEach((r) => {
    if (!r) return
    if (r.baseName) byBase.set(r.baseName, r)
    if (r.noExt) byBase.set(r.noExt, r)
    if (r.titleSlug) bySlug.set(r.titleSlug, r)
  })
  return { byBase, bySlug }
}
function matchCatalogRow(
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
function titleFrom(doc: DocMeta, row?: any) {
  const t = row?.articleTitle || doc.title || ''
  if (t) return t
  const fromName =
    row?.baseName || stripExt(basename(doc._url || '')) || '(untitled)'
  return titleCase(fromName.replace(/[_\-]+/g, ' ').trim())
}
function authorsFrom(doc: DocMeta, row?: any) {
  if (row?.allAuthors && row.allAuthors !== '—' && row.allAuthors !== '-')
    return parseAuthors(row.allAuthors)
  const fn = row?.raw?.['wri lead author - first name']
  const ln = row?.raw?.['wri lead author - last name']
  if (fn || ln) return [`${fn || ''} ${ln || ''}`.trim()]
  return (doc.authors || []).filter(Boolean)
}
function yearFrom(doc: DocMeta, row?: any) {
  return (
    row?.yearAccepted ??
    toYear(row?.dateAccepted) ??
    (typeof doc.year === 'number' ? doc.year : undefined)
  )
}
function typeFrom(doc: DocMeta, row?: any) {
  return row?.articleType || 'Report'
}
function urlFrom(doc: DocMeta, row?: any) {
  if (row?.sourceUrl) return row.sourceUrl
  const fn =
    row?.fileName ||
    (doc.meta as any)?.raw?.chunk?.file_name ||
    (doc.meta as any)?.raw?.chunk?.external_file_id
  return fn ? `/api/pdf/${basename(fn)}` : doc._url || null
}
const chicagoFull = (doc: DocMeta, row?: any) => {
  const authors = authorsFrom(doc, row).join(', ') || '(author unknown)'
  const title = `"${titleFrom(doc, row)}"`
  const cityPub = `${fallbackCity()}: ${fallbackPublisher()}`
  const year = yearFrom(doc, row) ?? ''
  return `${authors}. ${title}. ${cityPub}, ${year}.`
}
const chicagoShort = (doc: DocMeta, row?: any) => {
  const a = authorsFrom(doc, row)
  const first = a[0] || ''
  const last = first.split(/,|\s+/).filter(Boolean).slice(-1)[0] || ''
  const year = yearFrom(doc, row)
  return `${last}${year ? ` (${year})` : ''}`
}

/* ---------- component ---------- */
type WhyMeta = { why: string; relation: 'direct' | 'indirect' }

export default function AskWriApp() {
  const [mode, setMode] = useState<Mode>('answer')
  const [query, setQuery] = useState('')

  // Filters (catalog-based)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [yearAny, setYearAny] = useState(true)
  const [yearMin, setYearMin] = useState<number | ''>('')
  const [yearMax, setYearMax] = useState<number | ''>('')
  const [selectedSubTags, setSelectedSubTags] = useState<string[]>([])
  const [subTagQuery, setSubTagQuery] = useState('')
  const [topCount, setTopCount] = useState<5 | 10 | 20 | 'all'>(20)
  const [page, setPage] = useState(1)

  // State
  const [history, setHistory] = useState<string[]>([])
  const [retrievalLoading, setRetrievalLoading] = useState(false)
  const [answerLoading, setAnswerLoading] = useState(false)
  const [alignLoading, setAlignLoading] = useState(false)
  const [alignNote, setAlignNote] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<string[]>([])

  const [ops, setOps] = useState<{
    index_version: string
    prompt_version: string
    cost_usd: number | null
    energy_gco2e: number | null
  } | null>(null)
  const [selectedCitation, setSelectedCitation] = useState<{
    ref: string
    page: number
    passage_id: string
    score: number
  } | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  const [answer, setAnswer] = useState<null | {
    sentences: string[]
    paragraphs?: string[][]
    inline: { ref: string; page: number }[][]
    confidence: number
    warning?: string
    warningMessage?: string
  }>(null)
  const [supporting, setSupporting] = useState<DocMeta[]>([])
  const [alignment, setAlignment] = useState<{
    coverage?: string[]
    caveats?: string[]
    risks?: string[]
    suggestions?: string[]
    confidence?: number
    _debugKeys?: string[]
  } | null>(null)

  // Query-level caching to avoid redundant API calls
  const [queryCache, setQueryCache] = useState<
    Record<
      string,
      {
        answer: {
          sentences: string[]
          paragraphs?: string[][]
          inline: { ref: string; page: number }[][]
          confidence: number
        } | null
        supporting: DocMeta[]
        alignment: any
        timestamp: number
      }
    >
  >({})

  const [docWhy, setDocWhy] = useState<Record<string, WhyMeta>>({})
  const [docWhyLoading, setDocWhyLoading] = useState<Record<string, boolean>>(
    {},
  )
  const [passageWhy, setPassageWhy] = useState<Record<string, WhyMeta>>({})
  const [passageWhyLoading, setPassageWhyLoading] = useState<
    Record<string, boolean>
  >({})
  const [docSummary, setDocSummary] = useState<Record<string, string>>({})
  const [docSummaryLoading, setDocSummaryLoading] = useState<
    Record<string, boolean>
  >({})
  const [citeSelected, setCiteSelected] = useState<Record<string, boolean>>({})

  const [catalog, setCatalog] = useState<any[]>([])
  const [index, setIndex] = useState<ReturnType<
    typeof buildCatalogIndex
  > | null>(null)
  useEffect(() => {
    ;(async () => {
      const res = await fetch('/api/catalog', { cache: 'no-store' })
      if (!res.ok) {
        return
      }
      const j = await res.json()
      const normed = (j.items as any[]).map(normalizeCatalogRow)
      setCatalog(normed)
      setIndex(buildCatalogIndex(normed))
    })()
  }, [])

  const searchParams = useSearchParams()
  const searchQuery = searchParams?.get('q')?.trim() ?? ''

  useEffect(() => {
    if (!searchQuery) return
    if (query) return
    setQuery(searchQuery)
    runQuery(mode, searchQuery)
  }, [searchQuery, mode, query])

  const resultRows = useMemo<RowData[]>(() => {
    return supporting.map((doc, idx) => {
      const row = index ? matchCatalogRow(doc, index) : undefined
      const downloadUrl = urlFrom(doc, row) || undefined
      const snippet = firstSentence(
        doc.kps?.[0]?.snippet || doc.summary || '',
      ).slice(0, 280)
      const summaryText = doc.doc_id ? docSummary[doc.doc_id] : undefined
      const authors = Array.isArray(doc.authors)
        ? doc.authors.filter(Boolean).join(', ')
        : ''
      const relevanceScore = doc.kps?.[0]?.kp_relevance ?? doc.score ?? 0

      const formattedWhy = (() => {
        const relationLabel = (relation?: 'direct' | 'indirect') =>
          relation === 'direct'
            ? '[Direct] '
            : relation === 'indirect'
              ? '[Indirect] '
              : ''

        if (mode === 'cite' && doc.doc_id) {
          const info = docWhy[doc.doc_id]
          if (info?.why) {
            return `${relationLabel(info.relation)}${info.why}`
          }
        }

        const best = doc.kps?.[0]
        if (doc.doc_id && best?.passage_id) {
          const passageInfo = passageWhy[`${doc.doc_id}:${best.passage_id}`]
          if (passageInfo?.why) {
            return `${relationLabel(passageInfo.relation)}${passageInfo.why}`
          }
        }

        return snippet || '—'
      })()

      return {
        id: doc.doc_id || idx,
        publication_name: doc.title || doc.ref || `Document ${idx + 1}`,
        author: authors || '—',
        summary: summaryText || snippet || 'Summary not available.',
        how_relevant: formattedWhy,
        download_url: downloadUrl,
        relevance:
          relevanceScore >= 0.75
            ? 'High'
            : relevanceScore >= 0.4
              ? 'Medium'
              : 'Low',
        relevance_score: relevanceScore,
      } satisfies RowData
    })
  }, [supporting, docWhy, passageWhy, docSummary, mode, index])

  function pushHistory(q: string) {
    setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 20))
  }

  // Prefilter basenames (Year accepted + Sub-tag)
  const prefilterBases = useMemo(() => {
    if (!catalog.length) return undefined
    const subTagsSet = new Set(selectedSubTags.map(norm))
    const minY = yearAny
      ? -Infinity
      : typeof yearMin === 'number'
        ? yearMin
        : -Infinity
    const maxY = yearAny
      ? Infinity
      : typeof yearMax === 'number'
        ? yearMax
        : Infinity

    const bases = catalog
      .filter((row) => {
        const ya = row.yearAccepted
        const st = norm(row.subTag)
        const okYear = yearAny || (ya != null && ya >= minY && ya <= maxY)
        const okSub = subTagsSet.size === 0 || subTagsSet.has(st)
        return okYear && okSub
      })
      .map((row) => row.noExt)

    return bases.length ? new Set(bases) : undefined
  }, [catalog, selectedSubTags, yearAny, yearMin, yearMax])

  // Guard visibility using catalog match (since server can't prefilter by file_id)
  const filteredDocs: DocMeta[] = useMemo(() => {
    // Defensive: ensure supporting is always an array
    if (!Array.isArray(supporting)) return []
    if (!prefilterBases || !index) return supporting
    const allowed = prefilterBases
    const out: DocMeta[] = []
    for (const d of supporting) {
      const row = matchCatalogRow(d, index)
      const base =
        row?.noExt ||
        stripExt(
          basename(
            d._url ||
              (d.meta as any)?.raw?.chunk?.file_name ||
              (d.meta as any)?.raw?.chunk?.file_path ||
              '',
          ),
        )
      if (!base) continue
      if (allowed.has(base.toLowerCase())) out.push(d)
    }
    return out
  }, [supporting, prefilterBases, index])

  // Determine how many results to show based on filters
  const size = topCount === 'all' ? filteredDocs.length || 1 : topCount

  // Answer mode: paginate by PASSAGES, Cite mode: paginate by DOCUMENTS
  const { pageDocs, totalPages } = useMemo(() => {
    if (mode === 'answer') {
      // Flatten all passages from all documents
      const allPassages: Array<{ doc: DocMeta; kp: KP }> = []
      filteredDocs.forEach((d) => {
        ;(d.kps || []).forEach((kp) => {
          allPassages.push({ doc: d, kp })
        })
      })

      // Sort by relevance
      const sorted = allPassages.sort(
        (a, b) => b.kp.kp_relevance - a.kp.kp_relevance,
      )

      // Calculate pagination based on passage count
      const totalPassages = sorted.length
      const actualSize = topCount === 'all' ? totalPassages : size
      const totalPgs = Math.max(1, Math.ceil(totalPassages / actualSize))

      // Slice to current page
      const start = (page - 1) * actualSize
      const pagePassages = sorted.slice(start, start + actualSize)

      // Convert to DocMeta[] format (each doc contains only 1 KP)
      const docsForPage: DocMeta[] = pagePassages.map(({ doc, kp }) => ({
        ...doc,
        kps: [kp], // Only this one passage
      }))

      return { pageDocs: docsForPage, totalPages: totalPgs }
    }
    // Cite mode: paginate by documents (existing behavior)
    const totalDocs = filteredDocs.length
    const actualSize = topCount === 'all' ? totalDocs : size
    const totalPgs = Math.max(1, Math.ceil(totalDocs / actualSize))
    const start = (page - 1) * actualSize
    const docs = filteredDocs.slice(start, start + actualSize)
    return { pageDocs: docs, totalPages: totalPgs }
  }, [filteredDocs, page, size, mode, topCount])

  // BATCH WHY processing - uses pageDocs (already paginated above)
  // Caching: passageWhy/docWhy state prevents re-fetching viewed pages
  useEffect(() => {
    if (!index || supporting.length === 0) return

    // Collect passages that need explanations (skip already cached)
    const passagesToProcess: Array<{
      passageId: string
      docId: string
      docTitle: string
      snippet: string
    }> = []

    // Process pageDocs (already paginated for current page)
    pageDocs.forEach((d) => {
      const row = matchCatalogRow(d, index)
      const docTitle = titleFrom(d, row)

      if (mode === 'answer') {
        // Answer mode: Process each passage (pageDocs has 1 KP per doc)
        ;(d.kps || []).forEach((kp) => {
          const passageId = `${d.doc_id}:${kp.passage_id}`
          const alreadyHas = passageWhy[passageId]
          const isLoading = passageWhyLoading[passageId]
          const hasSnippet = kp.snippet && kp.snippet.trim().length > 10

          if (!alreadyHas && !isLoading && hasSnippet) {
            passagesToProcess.push({
              passageId,
              docId: d.doc_id,
              docTitle,
              snippet: kp.snippet.trim(),
            })
          } else if (!alreadyHas && !isLoading) {
            // Fallback for passages without snippets
            const fallbackWhy = {
              why: 'This passage is relevant to the query based on its content and context.',
              relation: 'indirect' as const,
            }
            setPassageWhy((prev) => ({ ...prev, [passageId]: fallbackWhy }))
          }
        })
      } else {
        // Cite mode: document-level explanations via /api/relates
        if (!docWhy[d.doc_id] && !docWhyLoading[d.doc_id]) {
          setDocWhyLoading((prev) => ({ ...prev, [d.doc_id]: true }))
          const best = [...(d.kps || [])].sort(
            (a, b) => b.kp_relevance - a.kp_relevance,
          )[0]

          fetch('/api/relates', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query,
              doc: {
                title: docTitle,
                authors: authorsFrom(d, row),
                year: yearFrom(d, row),
                snippet: best?.snippet ?? '',
              },
            }),
          })
            .then((r) => r.json())
            .then((j) => {
              const txt = (
                j?.relates ||
                j?.why ||
                'Document provides relevant context for this query.'
              ).trim()
              const rel: 'direct' | 'indirect' =
                j?.relation === 'direct' ? 'direct' : 'indirect'
              setDocWhy((prev) => ({
                ...prev,
                [d.doc_id]: { why: txt, relation: rel },
              }))
            })
            .catch(() => {
              // Fallback explanation for Cite mode
              setDocWhy((prev) => ({
                ...prev,
                [d.doc_id]: {
                  why: 'Document provides relevant context for this query.',
                  relation: 'indirect' as const,
                },
              }))
            })
            .finally(() =>
              setDocWhyLoading((prev) => ({ ...prev, [d.doc_id]: false })),
            )
        }
      }
    })

    // Only batch process for Answer mode (Cite mode handles individual calls above)
    if (mode !== 'answer') return

    if (passagesToProcess.length === 0) {
      return
    }

    // Set loading state for passage-specific explanations
    passagesToProcess.forEach((p) => {
      setPassageWhyLoading((prev) => ({ ...prev, [p.passageId]: true }))
    })

    // Make single batch API call for Answer mode passage-specific explanations
    fetch('/api/batch-why', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        mode,
        passages: passagesToProcess.map((p) => ({
          docTitle: p.docTitle,
          snippet: p.snippet,
        })),
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && data.explanations) {
          passagesToProcess.forEach((passage, index) => {
            const explanation = data.explanations[index]
            if (explanation) {
              const whyMeta = {
                why: explanation.why || 'Relevant to the query.',
                relation:
                  explanation.relation === 'direct'
                    ? ('direct' as const)
                    : ('indirect' as const),
              }
              setPassageWhy((prev) => ({
                ...prev,
                [passage.passageId]: whyMeta,
              }))
            }
          })
        }
      })
      .catch(() => {
        // Set fallback explanations
        passagesToProcess.forEach((passage) => {
          const fallbackWhy = {
            why: 'This passage provides relevant context for the query.',
            relation: 'indirect' as const,
          }
          setPassageWhy((prev) => ({
            ...prev,
            [passage.passageId]: fallbackWhy,
          }))
        })
      })
      .finally(() => {
        // Clear loading states
        passagesToProcess.forEach((p) => {
          setPassageWhyLoading((prev) => ({ ...prev, [p.passageId]: false }))
        })
      })
  }, [index, pageDocs, query, mode]) // pageDocs changes when page changes

  /* Automatic alignment analysis - runs after all other LLM calls complete */
  const runAlignmentAfterResults = React.useCallback(() => {
    // More robust checks to ensure stable state
    if (
      supporting.length > 0 &&
      !alignLoading &&
      query.trim() &&
      !retrievalLoading &&
      !answerLoading
    ) {
      // Check cache first
      const cacheKey = `${mode}:${query.trim()}`
      const cached = queryCache[cacheKey]
      const isExpired = cached && Date.now() - cached.timestamp > 5 * 60 * 1000

      if (cached && !isExpired && cached.alignment) {
        setAlignment(cached.alignment)
        return
      }

      runAlignment(query, supporting)
    }
  }, [
    supporting,
    alignLoading,
    query,
    mode,
    queryCache,
    retrievalLoading,
    answerLoading,
  ])

  // Auto-run alignment after all other LLM calls complete
  useEffect(() => {
    // Check if any loading operations are still running
    const hasSummaryLoading = Object.values(docSummaryLoading).some(Boolean)
    const hasWhyLoading = Object.values(docWhyLoading).some(Boolean)
    const hasPassageWhyLoading = Object.values(passageWhyLoading).some(Boolean)

    // Wait for ALL operations to complete before running alignment
    const allLoadingComplete =
      !retrievalLoading &&
      !answerLoading &&
      !hasSummaryLoading &&
      !hasWhyLoading &&
      !hasPassageWhyLoading

    if (
      allLoadingComplete &&
      supporting.length > 0 &&
      query.trim() &&
      !alignLoading
    ) {
      // Longer delay to ensure all rendering and state updates are complete
      const timer = setTimeout(() => {
        runAlignmentAfterResults()
      }, 500) // Increased delay for stability
      return () => clearTimeout(timer)
    }
  }, [
    retrievalLoading,
    answerLoading,
    docSummaryLoading,
    docWhyLoading,
    passageWhyLoading,
    alignLoading,
    supporting.length,
    query,
    runAlignmentAfterResults,
  ])

  // SUMMARY processing - cached from CSV (separate effect to avoid conflicts)
  useEffect(() => {
    if (!index || supporting.length === 0) return

    pageDocs.forEach((d) => {
      const row = matchCatalogRow(d, index)
      // Summary - Use cached summary from CSV if available
      if (!docSummary[d.doc_id]) {
        const catalogSummary =
          row?.summary || row?.meta?.summary || row?.raw?.summary

        if (catalogSummary) {
          // Use pre-generated summary from CSV or user-provided summary
          setDocSummary((prev) => ({ ...prev, [d.doc_id]: catalogSummary }))
        } else {
          // No summary available - use first sentence from best snippet as fallback
          const best = [...(d.kps || [])].sort(
            (a, b) => b.kp_relevance - a.kp_relevance,
          )[0]
          const txt = firstSentence(best?.snippet ?? '').trim()
          setDocSummary((prev) => ({ ...prev, [d.doc_id]: txt }))
        }
      }
      if (mode === 'cite' && citeSelected[d.doc_id] == null) {
        setCiteSelected((prev) => ({ ...prev, [d.doc_id]: true }))
      }
    })
    // eslint-disable-next-line
  }, [pageDocs, query, mode, supporting, index])

  // Helper function to get top quality results (top 40% by score)
  function getTopQualityDocs(docs: DocMeta[], maxDocs: number = 8): DocMeta[] {
    if (!docs.length) return []

    // Sort by score descending
    const sortedDocs = [...docs].sort((a, b) => (b.score || 0) - (a.score || 0))

    // Take top 40% but cap at maxDocs
    const top40Percent = Math.max(1, Math.ceil(sortedDocs.length * 0.4))
    const finalCount = Math.min(top40Percent, maxDocs)

    const selected = sortedDocs.slice(0, finalCount)

    return selected
  }

  async function runAlignment(q: string, docs: DocMeta[]) {
    try {
      setAlignNote(null)
      if (!docs?.length) {
        setAlignment(null)
        return
      }
      setAlignLoading(true)

      // Use only top 40% quality docs for alignment to improve signal and reduce cost
      const topQualityDocs = getTopQualityDocs(docs, 8)

      // For alignment analysis, enhance existing docs with more context (avoid extra API call)
      const docsForAlignment = topQualityDocs.map((doc) => ({
        ...doc,
        // Add a flag to indicate this is for alignment analysis
        _alignmentContext: true,
        // COST OPTIMIZATION: Reduce KPs from 30 to 5 per doc - alignment still works with less context
        kps: (doc.kps || []).slice(0, 5), // Fewer passages saves tokens while maintaining quality
      }))

      const r = await fetch('/api/alignment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: q,
          docs: docsForAlignment,
          answer: mode === 'answer' ? answer?.sentences : undefined,
        }),
      })
      const j = await r.json()
      if (j?.ok && j?.assessment) {
        setAlignment(j.assessment)
        setAlignNote(
          j?.debug?.fallback ? `(fallback: ${j.debug.reason})` : null,
        )

        // Cache the alignment result
        const cacheKey = `${mode}:${q.trim()}`
        setQueryCache((prev) => ({
          ...prev,
          [cacheKey]: {
            ...prev[cacheKey],
            alignment: j.assessment,
            timestamp: Date.now(),
          },
        }))

        // Update energy estimator with alignment token usage
        if (j.debug?.tries) {
          const alignmentUsage = j.debug.tries.reduce(
            (total: any, tryInfo: any) => {
              if (tryInfo.usage) {
                return {
                  prompt_tokens:
                    (total.prompt_tokens || 0) +
                    (tryInfo.usage.prompt_tokens || 0),
                  completion_tokens:
                    (total.completion_tokens || 0) +
                    (tryInfo.usage.completion_tokens || 0),
                  total_tokens:
                    (total.total_tokens || 0) +
                    (tryInfo.usage.total_tokens || 0),
                }
              }
              return total
            },
            {},
          )

          if (
            alignmentUsage.total_tokens ||
            alignmentUsage.prompt_tokens ||
            alignmentUsage.completion_tokens
          ) {
            // Add alignment usage to existing ops
            setOps((prev) => {
              if (!prev) return prev
              const alignmentCost = estimateCostUSD(alignmentUsage)
              const alignmentEnergy = estimateEnergyGCO2e(alignmentUsage)
              return {
                ...prev,
                cost_usd: (prev.cost_usd || 0) + (alignmentCost || 0),
                energy_gco2e: (prev.energy_gco2e || 0) + (alignmentEnergy || 0),
              }
            })
          }
        }
      } else {
        setAlignment(null)
        setAlignNote(
          `(alignment error: ${j?.debug?.reason ?? j?.error ?? 'unknown'})`,
        )
      }
    } catch (e: any) {
      setAlignment(null)
      setAlignNote(`(alignment exception: ${String(e?.message || e)})`)
    } finally {
      setAlignLoading(false)
    }
  }

  function approxUsageAndOps(
    q: string,
    message: string,
    docs: DocMeta[],
    promptVersion: string,
  ) {
    const promptChars =
      q.length +
      docs
        .slice(0, 6)
        .reduce((a, d) => a + (d.kps?.[0]?.snippet?.length ?? 0), 0)
    const completionChars = message.length
    const usage = {
      model: process.env.OPENAI_MODEL || 'unknown',
      prompt_tokens: Math.max(1, Math.round(promptChars / 4)),
      completion_tokens: Math.max(1, Math.round(completionChars / 4)),
    }
    const total = usage.prompt_tokens + usage.completion_tokens
    const cost = estimateCostUSD({ ...usage, total_tokens: total })
    const energy = estimateEnergyGCO2e({ ...usage, total_tokens: total })
    setOps({
      index_version: 'v1.0',
      prompt_version: promptVersion,
      cost_usd: cost ?? 0,
      energy_gco2e: energy ?? 0,
    })
  }

  async function synthesizeAnswer(q: string, docs: DocMeta[]) {
    try {
      setAnswerLoading(true)

      // Use only top 40% quality docs for answer synthesis to improve quality and reduce cost
      const topQualityDocs = getTopQualityDocs(docs, 6) // COST OPTIMIZATION: Reduced from 10 to 6 docs max

      const r = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, docs: topQualityDocs }),
      })
      const j = await r.json()

      // Return full synthesis object including warnings
      return j?.synthesis || { sentences: [] }
    } finally {
      setAnswerLoading(false)
    }
  }

  async function doAnswer(q: string) {
    try {
      setRetrievalLoading(true)
      const { docs, usage, debug } = await chatAnswerLlamaIndex(q, {
        ...ANSWER_PRESET,
      })

      // Calculate embedding costs for transparent reporting
      const embeddingTokens = debug?.estimated_embedding_tokens ?? 50
      const embeddingCost =
        estimateCostUSD({
          model: 'openai/text-embedding-3-small',
          prompt_tokens: embeddingTokens,
          completion_tokens: 0,
        }) ?? 0.001
      const embeddingEnergy =
        estimateEnergyGCO2e({
          model: 'text-embedding-3-small',
          prompt_tokens: embeddingTokens,
          completion_tokens: 0,
        }) ?? 0.01

      setSupporting(docs)
      setRetrievalLoading(false)

      // Filter docs to only those with actual content before synthesis
      const validDocs = docs.filter(
        (d) =>
          d.kps &&
          d.kps.length > 0 &&
          d.kps.some((kp) => kp.snippet && kp.snippet.length > 10), // At least one valid KP
      )
      if (validDocs.length === 0) {
        setAnswer({
          sentences: [
            'Unable to synthesize answer: no documents with content found.',
          ],
          inline: [],
          confidence: 0.1,
        })
        return
      }

      const result = await synthesizeAnswer(q, validDocs)

      // Extract sentences and metadata from synthesis result
      let sentences: string[] = []
      let paragraphs: string[][] | undefined
      let warning: string | undefined
      let warningMessage: string | undefined

      if (typeof result === 'object' && result !== null) {
        // New format: synthesis object with metadata
        sentences = result.sentences || []
        paragraphs = result.paragraphs
        warning = result.warning
        warningMessage = result.warningMessage
      } else if (Array.isArray(result)) {
        // Legacy format: direct array
        const isParagraphs = Array.isArray(result[0])
        if (isParagraphs) {
          paragraphs = result as string[][]
          sentences = paragraphs.flat()
        } else {
          sentences = result as string[]
        }
      }

      const inline = sentences.map((sent, sentIdx) => {
        const refs: { ref: string; page: number }[] = []

        // Collect ALL available chunks/passages from ALL documents
        const allChunks: { doc: DocMeta; kp: KP }[] = []
        validDocs.forEach((doc) => {
          ;(doc.kps || []).forEach((kp) => {
            allChunks.push({ doc, kp })
          })
        })
        // Distribute chunks across sentences (2-3 citations per sentence)
        const chunksPerSentence = Math.max(
          1,
          Math.min(3, Math.ceil(allChunks.length / sentences.length)),
        )
        const startIdx = sentIdx * chunksPerSentence
        const endIdx = Math.min(startIdx + chunksPerSentence, allChunks.length)

        for (let i = startIdx; i < endIdx; i++) {
          const chunk = allChunks[i]
          if (chunk && chunk.kp) {
            refs.push({
              ref: chunk.doc.ref,
              page: chunk.kp.page ?? 1,
            })
          }
        }

        // Fallback: ensure every sentence has at least one citation
        if (refs.length === 0 && allChunks.length > 0) {
          const fallbackChunk = allChunks[sentIdx % allChunks.length]
          refs.push({
            ref: fallbackChunk.doc.ref,
            page: fallbackChunk.kp.page ?? 1,
          })
        }
        return refs
      })

      setAnswer({
        sentences,
        paragraphs,
        inline,
        confidence: Math.min(0.9, 0.5 + docs.length * 0.06),
        warning,
        warningMessage,
      })

      if (usage) {
        const total =
          (usage.total_tokens ?? 0) ||
          (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
        const cost = estimateCostUSD({ ...usage, total_tokens: total })
        const energy = estimateEnergyGCO2e({ ...usage, total_tokens: total })

        // Add embedding costs from retrieval
        const totalCost = (cost ?? 0) + (embeddingCost ?? 0)
        const totalEnergy = (energy ?? 0) + (embeddingEnergy ?? 0)

        setOps({
          index_version: 'v1.0',
          prompt_version: 'ANSv1.3',
          cost_usd: totalCost,
          energy_gco2e: totalEnergy,
        })
      } else {
        approxUsageAndOps(q, sentences.join(' '), docs, 'ANSv1.3')
      }
    } catch (e: any) {
      setRetrievalLoading(false)
      setTranscript((prev) => [
        ...prev,
        `Vector search error → ${String(e?.message || e)}`,
      ])
    }
  }

  async function doCite(q: string) {
    try {
      setRetrievalLoading(true)
      // Use hybrid retrieval for maximum recall in Cite mode
      const { docs, usage, debug } = await chatCiteLlamaIndex(q)

      // Calculate embedding costs for cite mode
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

      setAnswer(null)
      setSupporting(docs)
      setRetrievalLoading(false)

      if (usage) {
        const total =
          (usage.total_tokens ?? 0) ||
          (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
        const cost = estimateCostUSD({ ...usage, total_tokens: total })
        const energy = estimateEnergyGCO2e({ ...usage, total_tokens: total })

        // Add embedding costs from retrieval
        const totalCost = (cost ?? 0) + (citeEmbeddingCost ?? 0)
        const totalEnergy = (energy ?? 0) + (citeEmbeddingEnergy ?? 0)

        setOps({
          index_version: 'v1.0',
          prompt_version: 'CITEv1.3',
          cost_usd: totalCost,
          energy_gco2e: totalEnergy,
        })
      } else {
        approxUsageAndOps(q, '', docs, 'CITEv1.3')
      }
    } catch (e: any) {
      setRetrievalLoading(false)
      setTranscript((prev) => [
        ...prev,
        `Vector search error → ${String(e?.message || e)}`,
      ])
    }
  }

  function runQuery(runMode = mode, q = query) {
    if (!q.trim()) {
      setTranscript(['No query text. Enter a query and press Submit.'])
      return
    }

    // Check cache first (5 minute expiry)
    const cacheKey = `${runMode}:${q.trim()}`
    const cached = queryCache[cacheKey]
    const isExpired = cached && Date.now() - cached.timestamp > 5 * 60 * 1000

    if (cached && !isExpired) {
      setAnswer(cached.answer)
      // Defensive: ensure supporting is always an array
      setSupporting(Array.isArray(cached.supporting) ? cached.supporting : [])
      setAlignment(cached.alignment)
      setPage(1)
      return
    }

    setTranscript([
      `Interpret query: "${q.trim()}"`,
      runMode === 'answer'
        ? 'Plan: ANSWER → synthesize with inline citations.'
        : 'Plan: CITE → build annotated bibliography.',
    ])
    setSelectedCitation(null)
    setAlignment(null)
    setAlignNote(null)
    if (runMode === 'cite') {
      setDocWhy({})
      setDocSummary({})
      setDocWhyLoading({})
      setDocSummaryLoading({})
      setCiteSelected({})
    }
    if (runMode === 'answer') {
      setDocWhy({})
      setDocSummary({})
      setDocWhyLoading({})
      setDocSummaryLoading({})
    }
    setAnswer(null)
    setSupporting([])
    setPage(1)
    pushHistory(q.trim())
    if (runMode === 'answer') doAnswer(q)
    else if (runMode === 'cite') doCite(q)
  }

  // Clear all results when switching modes
  function clearResults() {
    setAnswer(null)
    setSupporting([])
    setAlignment(null)
    setDocWhy({})
    setDocWhyLoading({})
    setPassageWhy({})
    setPassageWhyLoading({})
    setDocSummary({})
    setDocSummaryLoading({})
    setCiteSelected({})
    setSelectedCitation(null)
    setPdfUrl(null)
    setOps(null)
  }

  if (searchQuery) {
    if (resultRows.length > 0) {
      return (
        <ResultsPage
          data={resultRows}
          query={searchQuery}
          confidence={(answer?.confidence ?? 0) * 100}
        />
      )
    }

    const loader = (
      <div
        className='gradient-background'
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
        }}
      >
        <Spinner />
      </div>
    )

    if (retrievalLoading || answerLoading) {
      return loader
    }
    console.error('No results found for query:', searchQuery)
    return loader
  }

  /* -------- render -------- */
  return (
    <div>
      <header>
        <div>
          <textarea
            rows={2}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Ask a research question'
          />
        </div>
        <div>
          <button
            type='button'
            onClick={() => setFiltersOpen((value) => !value)}
          >
            {filtersOpen ? 'Hide filters' : 'Show filters'}
          </button>
          <button type='button' onClick={() => runQuery(mode, query)}>
            {retrievalLoading || answerLoading ? 'Running...' : 'Submit'}
          </button>
        </div>
        <div>
          <button
            type='button'
            onClick={() => {
              clearResults()
              setMode('answer')
            }}
          >
            {mode === 'answer' ? 'Answer (selected)' : 'Answer'}
          </button>
          <button
            type='button'
            onClick={() => {
              clearResults()
              setMode('cite')
            }}
          >
            {mode === 'cite' ? 'Cite (selected)' : 'Cite'}
          </button>
          <button type='button' disabled>
            Lit review
          </button>
          <button type='button' disabled>
            Explain
          </button>
        </div>
      </header>

      <main>
        <section>
          <SectionTitle>History</SectionTitle>
          {history.length === 0 ? (
            <p>No recent queries.</p>
          ) : (
            <ul>
              {history.map((q, idx) => (
                <li key={idx}>
                  <button
                    type='button'
                    onClick={() => {
                      setQuery(q)
                      setPage(1)
                      runQuery(mode, q)
                    }}
                  >
                    {q}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle>About</SectionTitle>
          <div>
            <Metric label='Index version' value={ops?.index_version ?? '—'} />
            <Metric
              label='Prompt version'
              value={
                ops?.prompt_version ??
                (mode === 'answer' ? 'ANSv1.2' : 'CITEv1.2')
              }
            />
            <Metric
              label='Query cost (USD)'
              value={
                ops?.cost_usd != null ? `$${ops.cost_usd.toFixed(4)}` : '—'
              }
            />
            <Metric
              label='Energy (gCO₂e)'
              value={
                ops?.energy_gco2e != null
                  ? `${ops.energy_gco2e.toFixed(2)}`
                  : '—'
              }
            />
          </div>
        </section>

        <section>
          <details
            open={filtersOpen}
            onToggle={(event) =>
              setFiltersOpen((event.target as HTMLDetailsElement).open)
            }
          >
            <summary>Filters</summary>
            <div>
              <div>
                <label>
                  <input
                    type='checkbox'
                    checked={yearAny}
                    onChange={(event) => setYearAny(event.target.checked)}
                  />
                  Any year
                </label>
                <div>
                  <input
                    type='number'
                    min={1900}
                    max={2100}
                    placeholder='Min'
                    value={yearAny ? '' : yearMin === '' ? '' : yearMin}
                    onChange={(event) => {
                      const { value } = event.target
                      setYearMin(value === '' ? '' : Number(value))
                    }}
                    disabled={yearAny}
                  />
                  <input
                    type='number'
                    min={1900}
                    max={2100}
                    placeholder='Max'
                    value={yearAny ? '' : yearMax === '' ? '' : yearMax}
                    onChange={(event) => {
                      const { value } = event.target
                      setYearMax(value === '' ? '' : Number(value))
                    }}
                    disabled={yearAny}
                  />
                </div>
              </div>
              <div>
                <div>
                  {selectedSubTags.map((tag) => (
                    <span key={tag}>
                      {tag}
                      <button
                        type='button'
                        onClick={() =>
                          setSelectedSubTags((current) =>
                            current.filter((t) => t !== tag),
                          )
                        }
                      >
                        Remove
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  value={subTagQuery}
                  onChange={(event) => setSubTagQuery(event.target.value)}
                  placeholder='Type to add'
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && subTagQuery.trim()) {
                      setSelectedSubTags((current) =>
                        Array.from(new Set([...current, subTagQuery.trim()])),
                      )
                      setSubTagQuery('')
                    }
                  }}
                />
              </div>
              <div>
                <span>Show:</span>
                {[5, 10, 20].map((n) => (
                  <button
                    type='button'
                    key={n}
                    onClick={() => {
                      setTopCount(n as any)
                      setPage(1)
                    }}
                  >
                    {topCount === n ? `${n} (selected)` : n}
                  </button>
                ))}
                <button
                  type='button'
                  onClick={() => {
                    setTopCount('all')
                    setPage(1)
                  }}
                >
                  {topCount === 'all' ? 'All (selected)' : 'All'}
                </button>
              </div>
            </div>
          </details>
        </section>

        <section>
          <SectionTitle>Thinking</SectionTitle>
          {transcript.length === 0 ? (
            <p>No system messages yet.</p>
          ) : (
            <ul>
              {transcript.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle>Alignment</SectionTitle>
          {alignLoading && <p>Evaluating results...</p>}
          {!alignLoading && !alignment && (
            <p>
              Alignment analysis will run automatically after results are
              retrieved.
            </p>
          )}
          {!alignLoading && alignment && (
            <div>
              <div>
                <strong>Coverage & correspondence</strong>
                <ul>
                  {(alignment.coverage || []).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Caveats & reservations</strong>
                <ul>
                  {(alignment.caveats || []).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Risks & failure modes</strong>
                <ul>
                  {(alignment.risks || []).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>Suggestions for query improvement</strong>
                <ul>
                  {(alignment.suggestions || []).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
              <p>
                Confidence: {(alignment.confidence ?? 0).toFixed(2)}
                {alignNote ? ` ${alignNote}` : ''}
              </p>
            </div>
          )}
        </section>

        <section>
          {mode === 'answer' ? (
            <div>
              <SectionTitle>Answer</SectionTitle>
              {(retrievalLoading || answerLoading) && (
                <p>Generating answer...</p>
              )}
              {answer ? (
                answer.paragraphs ? (
                  answer.paragraphs.map((paragraph, paragraphIndex) => {
                    let sentenceOffset = 0
                    for (let index = 0; index < paragraphIndex; index++) {
                      sentenceOffset += answer.paragraphs![index].length
                    }
                    return (
                      <p key={paragraphIndex}>
                        {paragraph.map((sentence, sentenceIndex) => {
                          const globalIndex = sentenceOffset + sentenceIndex
                          return (
                            <span key={sentenceIndex}>
                              {sentence}{' '}
                              {answer.inline[globalIndex]?.map(
                                (citation, citationIndex) => {
                                  const doc = filteredDocs.find(
                                    (item) => item.ref === citation.ref,
                                  )
                                  if (!doc) {
                                    return null
                                  }
                                  const topKp = doc.kps[0]
                                  const topTarget = topKp?.citation_targets?.[0]
                                  const target: CitationTarget = topTarget
                                    ? {
                                        score: topTarget.score,
                                        page: topTarget.page ?? citation.page,
                                        passage_id: topTarget.passage_id,
                                      }
                                    : {
                                        score: topKp?.kp_relevance ?? 0.7,
                                        page: topKp?.page ?? citation.page,
                                        passage_id:
                                          topKp?.passage_id ??
                                          `p${citation.page}:?`,
                                      }
                                  return (
                                    <button
                                      type='button'
                                      key={citationIndex}
                                      onClick={() =>
                                        setSelectedCitation({
                                          ref: doc.ref,
                                          page: target.page,
                                          passage_id: target.passage_id,
                                          score: target.score,
                                        })
                                      }
                                    >
                                      [{globalIndex + 1}.{citationIndex + 1}]
                                    </button>
                                  )
                                },
                              )}
                            </span>
                          )
                        })}
                      </p>
                    )
                  })
                ) : (
                  answer.sentences.map((sentence, sentenceIndex) => (
                    <p key={sentenceIndex}>
                      {sentence}{' '}
                      {answer.inline[sentenceIndex]?.map(
                        (citation, citationIndex) => {
                          const doc = filteredDocs.find(
                            (item) => item.ref === citation.ref,
                          )
                          if (!doc) {
                            return null
                          }
                          const topKp = doc.kps[0]
                          const topTarget = topKp?.citation_targets?.[0]
                          const target: CitationTarget = topTarget
                            ? {
                                score: topTarget.score,
                                page: topTarget.page ?? citation.page,
                                passage_id: topTarget.passage_id,
                              }
                            : {
                                score: topKp?.kp_relevance ?? 0.7,
                                page: topKp?.page ?? citation.page,
                                passage_id:
                                  topKp?.passage_id ?? `p${citation.page}:?`,
                              }
                          return (
                            <button
                              type='button'
                              key={citationIndex}
                              onClick={() =>
                                setSelectedCitation({
                                  ref: doc.ref,
                                  page: target.page,
                                  passage_id: target.passage_id,
                                  score: target.score,
                                })
                              }
                            >
                              [{sentenceIndex + 1}.{citationIndex + 1}]
                            </button>
                          )
                        },
                      )}
                    </p>
                  ))
                )
              ) : (
                <p>Enter a query and click Submit.</p>
              )}
              {answer && answer.warning && (
                <p>
                  {answer.warningMessage || 'Answer may have quality issues.'}
                </p>
              )}

              <SectionTitle>Supporting Citations</SectionTitle>
              {totalPages > 1 && (
                <div>
                  <button
                    type='button'
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </button>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type='button'
                    onClick={() =>
                      setPage((value) => Math.min(totalPages, value + 1))
                    }
                    disabled={page === totalPages}
                  >
                    Next
                  </button>
                </div>
              )}

              <AllKPsList
                docs={pageDocs}
                index={index}
                mode={mode}
                docWhy={docWhy}
                docWhyLoading={docWhyLoading}
                passageWhy={passageWhy}
                passageWhyLoading={passageWhyLoading}
                docSummary={docSummary}
                docSummaryLoading={docSummaryLoading}
                onOpenPassage={(doc, target) =>
                  setSelectedCitation({
                    ref: doc.ref,
                    page: target.page,
                    passage_id: target.passage_id,
                    score: target.score,
                  })
                }
              />

              {totalPages > 1 && (
                <div>
                  <button
                    type='button'
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </button>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type='button'
                    onClick={() =>
                      setPage((value) => Math.min(totalPages, value + 1))
                    }
                    disabled={page === totalPages}
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          ) : mode === 'cite' ? (
            <CitePanel
              query={query}
              docs={pageDocs}
              index={index}
              docSummary={docSummary}
              docWhy={docWhy}
              docWhyLoading={docWhyLoading}
              docSummaryLoading={docSummaryLoading}
              citeSelected={citeSelected}
              onToggleSelect={(id, value) =>
                setCiteSelected((current) => ({ ...current, [id]: value }))
              }
              onOpenPdf={(url) => setPdfUrl(url)}
            />
          ) : (
            <p>Lit review and Explain are disabled in this build.</p>
          )}
        </section>

        {/* <section>
          <FeedbackWidget
            query={query}
            mode={mode}
            resultCount={filteredDocs.length}
            hasResults={supporting.length > 0 && !retrievalLoading && !answerLoading}
          />
        </section> */}

        <section>
          {mode === 'cite' ? (
            <div>
              <SectionTitle>PDF Preview</SectionTitle>
              {pdfUrl ? (
                <iframe title='PDF preview' src={pdfUrl} />
              ) : (
                <p>Open a PDF from the results to preview it here.</p>
              )}
            </div>
          ) : (
            <div>
              <SectionTitle>Passage preview</SectionTitle>
              {selectedCitation ? (
                <div>
                  <p>
                    {(() => {
                      const doc = filteredDocs.find(
                        (item) => item.ref === selectedCitation.ref,
                      )
                      const row =
                        doc && index ? matchCatalogRow(doc, index) : undefined
                      return doc
                        ? `${chicagoShort(doc, row)}, p.${selectedCitation.page}`
                        : `p.${selectedCitation.page}`
                    })()}
                  </p>
                  {(() => {
                    const doc = filteredDocs.find(
                      (item) => item.ref === selectedCitation.ref,
                    )
                    const row =
                      doc && index ? matchCatalogRow(doc, index) : undefined
                    const url = doc ? urlFrom(doc, row) : null
                    if (!doc || !url) {
                      return null
                    }
                    const href = `${url}#page=${selectedCitation.page}`
                    return (
                      <a href={href} target='_blank' rel='noreferrer'>
                        Open PDF
                      </a>
                    )
                  })()}
                  <PassageParagraph
                    selected={selectedCitation}
                    docs={filteredDocs}
                  />
                </div>
              ) : (
                <p>Select a passage to preview it here.</p>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

/* ---------- Supporting Citations (Answer mode) ---------- */
const AllKPsList = ({
  docs,
  index,
  mode,
  docWhy,
  docWhyLoading,
  passageWhy,
  passageWhyLoading,
  docSummary,
  docSummaryLoading,
  onOpenPassage,
}: {
  docs: DocMeta[]
  index: ReturnType<typeof buildCatalogIndex> | null
  mode: Mode
  docWhy: Record<string, { why: string; relation: 'direct' | 'indirect' }>
  docWhyLoading: Record<string, boolean>
  passageWhy: Record<string, { why: string; relation: 'direct' | 'indirect' }>
  passageWhyLoading: Record<string, boolean>
  docSummary: Record<string, string>
  docSummaryLoading: Record<string, boolean>
  onOpenPassage: (doc: DocMeta, ct: CitationTarget) => void
}) => {
  const items = useMemo(() => {
    const arr: { doc: DocMeta; kp: KP }[] = []
    for (const d of docs) for (const kp of d.kps) arr.push({ doc: d, kp })
    return arr.sort((a, b) => b.kp.kp_relevance - a.kp.kp_relevance)
  }, [docs])

  return (
    <div>
      {items.map(({ doc, kp }, idx) => {
        const row = index ? matchCatalogRow(doc, index) : undefined
        // Use passage-specific explanations in Answer mode, document-level in Cite mode
        const passageId = `${doc.doc_id}:${kp.passage_id}`
        const whyData =
          mode === 'answer' ? passageWhy[passageId] : docWhy[doc.doc_id]
        const why = whyData?.why
        const rel = whyData?.relation === 'direct' ? 'Direct' : 'Indirect'

        const sum = docSummary[doc.doc_id]

        return (
          <article key={`${doc.doc_id}-${kp.passage_id}-${idx}`}>
            <h4>{titleFrom(doc, row)}</h4>
            <p>
              {chicagoFull(doc, row)} • p.{kp.page}
            </p>
            <div>
              <strong>Why it answers:</strong>{' '}
              {(
                mode === 'answer'
                  ? passageWhyLoading[passageId]
                  : docWhyLoading[doc.doc_id]
              )
                ? 'Loading...'
                : mode === 'answer' && why
                  ? `[${rel}] ${why}`
                  : `[${rel}] ${why || '—'}`}
            </div>
            <details>
              <summary>Doc summary</summary>
              <div>
                {docSummaryLoading[doc.doc_id] ? 'Loading...' : sum || '—'}
              </div>
            </details>
            <div>
              {kp.citation_targets.slice(0, 1).map((ct, j) => (
                <button
                  type='button'
                  key={j}
                  onClick={() =>
                    onOpenPassage(doc, { ...ct, page: ct.page ?? kp.page ?? 1 })
                  }
                >
                  Open passage (p.{ct.page ?? kp.page ?? 1}, Score:{' '}
                  {twoDp(ct.score)})
                </button>
              ))}
            </div>
          </article>
        )
      })}
    </div>
  )
}

/* ---------- Cite mode panel (adds Doc Relevance next to [Direct]) ---------- */
const CitePanel = ({
  query,
  docs,
  index,
  docSummary,
  docWhy,
  docWhyLoading,
  docSummaryLoading,
  citeSelected,
  onToggleSelect,
  onOpenPdf,
}: {
  query: string
  docs: DocMeta[]
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
  docWhy: Record<string, { why: string; relation: 'direct' | 'indirect' }>
  docWhyLoading: Record<string, boolean>
  docSummaryLoading: Record<string, boolean>
  citeSelected: Record<string, boolean>
  onToggleSelect: (id: string, v: boolean) => void
  onOpenPdf: (url: string) => void
}) => {
  async function exportBib() {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } =
      await import('docx')

    const selectedDocs = docs.filter((doc) => citeSelected[doc.doc_id])

    // Create document sections
    const children = [
      // Title
      new Paragraph({
        text: `Annotated Bibliography for: ${query}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 400 },
      }),
      // Empty paragraph for spacing
      new Paragraph({ text: '' }),
    ]

    // Add each selected document
    selectedDocs.forEach((doc, i) => {
      const row = index ? matchCatalogRow(doc, index) : undefined
      const summary =
        docSummary[doc.doc_id] || firstSentence(doc.kps?.[0]?.snippet ?? '')
      const url = urlFrom(doc, row)
      const typeLabel = typeFrom(doc, row)

      // Citation entry (numbered)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${i + 1}. `,
              bold: true,
            }),
            new TextRun({
              text: chicagoFull(doc, row),
            }),
            new TextRun({
              text: ` [${typeLabel}]`,
              italics: true,
              color: '666666',
            }),
          ],
          spacing: { before: 200, after: 100 },
        }),
      )

      // Summary paragraph
      children.push(
        new Paragraph({
          text: summary,
          spacing: { after: 100 },
          indent: { left: 360 }, // Indent summary slightly
        }),
      )

      // URL if available
      if (url) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: 'Available at: ',
                italics: true,
                color: '666666',
              }),
              new TextRun({
                text: url,
                color: '0066CC',
                underline: {},
              }),
            ],
            spacing: { after: 200 },
            indent: { left: 360 },
          }),
        )
      } else {
        // Add spacing if no URL
        children.push(new Paragraph({ text: '', spacing: { after: 200 } }))
      }
    })

    // Create the document
    const doc = new Document({
      sections: [
        {
          properties: {},
          children,
        },
      ],
    })

    // Generate and download the file
    const blob = await Packer.toBlob(doc)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'askwri-bibliography.docx'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div>
        <p>Annotated Bibliography for</p>
        <h2>"{query}"</h2>
        <button type='button' onClick={exportBib}>
          Export
        </button>
      </div>

      <div>
        {docs.map((doc, idx) => {
          const row = index ? matchCatalogRow(doc, index) : undefined
          const best = [...(doc.kps || [])].sort(
            (a, b) => b.kp_relevance - a.kp_relevance,
          )[0]
          const summary =
            docSummary[doc.doc_id] || firstSentence(best?.snippet ?? '')
          const whyMeta = docWhy[doc.doc_id]
          const selected = Boolean(citeSelected[doc.doc_id])
          const url = urlFrom(doc, row)
          const docRel =
            (doc.kps?.length ?? 0) > 0
              ? Math.max(...doc.kps.map((k) => k.kp_relevance || 0))
              : 0

          return (
            <article key={doc.doc_id}>
              <h3>
                {idx + 1}. {titleFrom(doc, row)}
              </h3>
              <label>
                <input
                  type='checkbox'
                  checked={selected}
                  onChange={(event) =>
                    onToggleSelect(doc.doc_id, event.target.checked)
                  }
                />
                Include in export
              </label>
              <p>
                {chicagoFull(doc, row)} [{typeFrom(doc, row)}]
              </p>
              <p>{docSummaryLoading[doc.doc_id] ? 'Loading...' : summary}</p>
              {url && (
                <button type='button' onClick={() => onOpenPdf(url)}>
                  Open PDF
                </button>
              )}
              <div>
                <strong>How it relates</strong>
                <span>
                  {' '}
                  [{whyMeta?.relation === 'direct' ? 'Direct' : 'Indirect'} •
                  Relevance {twoDp(docRel)}]
                </span>
                <p>
                  {docWhyLoading[doc.doc_id]
                    ? 'Loading...'
                    : whyMeta?.why || firstSentence(best?.snippet ?? '')}
                </p>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- Passage preview (exact chunk highlight + 2 prior + 2 after) ---------- */
const PassageParagraph = ({
  selected,
  docs,
}: {
  selected: { ref: string; passage_id: string; page: number }
  docs: DocMeta[]
}) => {
  const doc = docs.find((d) => d.ref === selected.ref)
  if (!doc) return <p>Document not found.</p>

  // Sort KPs by page first, then by relevance within each page
  const kps = [...(doc.kps || [])].sort(
    (a, b) => (a.page ?? 0) - (b.page ?? 0) || b.kp_relevance - a.kp_relevance,
  )

  // Find target passage with multiple fallback strategies
  let idx = -1

  // Strategy 1: Exact passage_id match
  idx = kps.findIndex((k) => k.passage_id === selected.passage_id)

  // Strategy 2: Best match on same page (highest relevance)
  if (idx < 0) {
    const samePage = kps.filter((k) => k.page === selected.page)
    if (samePage.length > 0) {
      const bestOnPage = samePage[0] // Already sorted by relevance
      idx = kps.findIndex((k) => k.passage_id === bestOnPage.passage_id)
    }
  }

  // Strategy 3: Find by partial passage_id match (sometimes IDs have prefixes/suffixes)
  if (idx < 0) {
    const targetId = selected.passage_id
    idx = kps.findIndex(
      (k) => k.passage_id.includes(targetId) || targetId.includes(k.passage_id),
    )
  }

  // Strategy 4: Fallback to first passage (should rarely happen now)
  if (idx < 0 && kps.length > 0) {
    idx = 0
  }

  // If still no passages, show error
  if (idx < 0 || kps.length === 0) {
    return <p>No passages found for this document.</p>
  }

  // Always ensure we have at least 2 before and 2 after when possible
  const beforeArr = [kps[idx - 2]?.snippet, kps[idx - 1]?.snippet]
  const afterArr = [kps[idx + 1]?.snippet, kps[idx + 2]?.snippet]
  const before = beforeArr.filter(Boolean).join(' … ')
  const center = kps[idx]?.snippet ?? ''
  const after = afterArr.filter(Boolean).join(' … ')

  return (
    <p>
      {before ? `${before} … ` : '… '}
      <mark>{center}</mark>
      {after ? ` … ${after}` : ' …'}
    </p>
  )
}
