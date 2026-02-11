/* eslint-disable */

'use client'

import React, { useMemo, useState, useEffect, Suspense } from 'react'
import { Spinner } from '@chakra-ui/react'
import { useSearchParams } from 'next/navigation'
import { DocMeta as LiveDoc } from '@/lib/llamacloud'
import { chatCiteLlamaIndex } from '@/lib/llamaindex-client'
import { estimateCostUSD } from '@/config/costs'
import { estimateEnergyGCO2e } from '@/config/energy'
import ResultsPage from '@/app/components/results'
import { RowData } from '@/app/components/results/types'

/* ---------- types ---------- */
type DocMeta = LiveDoc

/* ---------- general helpers ---------- */
const norm = (s?: string) => (s || '').trim().toLowerCase()
const firstSentence = (t?: string) => {
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
    yearAccepted: toYear(meta['year accepted'] ?? meta['year']),
    dateAccepted: meta['date accepted'] || undefined,
    office: meta['wri office affiliation (primary)'] || undefined,
    summary: r.meta?.summary || undefined, // Preserve the CSV summary field
    raw: meta,
  }
}
function buildCatalogIndex(items: any[]) {
  const byBase = new Map<string, any>() // basename + noExt
  const bySlug = new Map<string, any>() // title slug
  for (const r of items) {
    if (r.baseName) byBase.set(r.baseName, r)
    if (r.noExt) byBase.set(r.noExt, r)
    if (r.titleSlug) bySlug.set(r.titleSlug, r)
  }
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

/* ---------- component ---------- */
type WhyMeta = { why: string; relation: 'direct' | 'indirect' }

function AskWriAppContent() {
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [retrievalLoading, setRetrievalLoading] = useState(false)
  const [alignLoading, setAlignLoading] = useState(false)
  const [alignNote, setAlignNote] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<string[]>([])

  const [ops, setOps] = useState<{
    index_version: string
    prompt_version: string
    cost_usd: number | null
    energy_gco2e: number | null
  } | null>(null)
  const [supporting, setSupporting] = useState<DocMeta[]>([])
  const [alignment, setAlignment] = useState<{
    coverage?: string[]
    caveats?: string[]
    risks?: string[]
    suggestions?: string[]
    confidence?: number
    _debugKeys?: string[]
  } | null>(null)

  const [queryCache, setQueryCache] = useState<
    Record<
      string,
      {
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
  const [docSummary, setDocSummary] = useState<Record<string, string>>({})
  const [docSummaryLoading, setDocSummaryLoading] = useState<
    Record<string, boolean>
  >({})
  const [citeSelected, setCiteSelected] = useState<Record<string, boolean>>({})

  // Catalog & index
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
    if (query.trim() === searchQuery) return
    setQuery(searchQuery)
    runQuery(searchQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  function pushHistory(q: string) {
    setHistory((h) => [q, ...h.filter((x) => x !== q)].slice(0, 20))
  }

  const pageDocs = useMemo(() => {
    if (!Array.isArray(supporting)) return []
    return supporting
  }, [supporting])

  // Document-level WHY processing
  useEffect(() => {
    if (!index || supporting.length === 0) return

    pageDocs.forEach((d) => {
      const row = matchCatalogRow(d, index)
      const docTitle = titleFrom(d, row)

      setDocWhy((prevWhy) => {
        setDocWhyLoading((prevLoading) => {
          // Document-level explanations via /api/relates
          if (!prevWhy[d.doc_id] && !prevLoading[d.doc_id]) {
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

            return { ...prevLoading, [d.doc_id]: true }
          }
          return prevLoading
        })
        return prevWhy
      })
    })
  }, [index, pageDocs, query])

  const runAlignmentAfterResults = React.useCallback(() => {
    if (
      supporting.length > 0 &&
      !alignLoading &&
      query.trim() &&
      !retrievalLoading
    ) {
      const cacheKey = `cite:${query.trim()}`
      const cached = queryCache[cacheKey]
      const isExpired = cached && Date.now() - cached.timestamp > 5 * 60 * 1000

      if (cached && !isExpired && cached.alignment) {
        setAlignment(cached.alignment)
        return
      }

      runAlignment(query, supporting)
    }
  }, [supporting, alignLoading, query, queryCache, retrievalLoading])

  // Auto-run alignment after all other LLM calls complete
  useEffect(() => {
    const hasSummaryLoading = Object.values(docSummaryLoading).some(Boolean)
    const hasWhyLoading = Object.values(docWhyLoading).some(Boolean)

    const allLoadingComplete =
      !retrievalLoading && !hasSummaryLoading && !hasWhyLoading

    if (
      allLoadingComplete &&
      supporting.length > 0 &&
      query.trim() &&
      !alignLoading
    ) {
      const timer = setTimeout(() => {
        runAlignmentAfterResults()
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [
    retrievalLoading,
    docSummaryLoading,
    docWhyLoading,
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

      setDocSummary((prevSummary) => {
        if (prevSummary[d.doc_id]) return prevSummary

        const catalogSummary =
          row?.summary || row?.meta?.summary || row?.raw?.summary

        if (catalogSummary) {
          return { ...prevSummary, [d.doc_id]: catalogSummary }
        } else {
          const best = [...(d.kps || [])].sort(
            (a, b) => b.kp_relevance - a.kp_relevance,
          )[0]
          const txt = firstSentence(best?.snippet ?? '').trim()
          return { ...prevSummary, [d.doc_id]: txt }
        }
      })

      setCiteSelected((prevSelected) => {
        if (prevSelected[d.doc_id] != null) return prevSelected
        return { ...prevSelected, [d.doc_id]: true }
      })
    })
  }, [pageDocs, index, supporting.length])

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
          answer: undefined,
        }),
      })
      const j = await r.json()
      if (j?.ok && j?.assessment) {
        setAlignment(j.assessment)
        setAlignNote(
          j?.debug?.fallback ? `(fallback: ${j.debug.reason})` : null,
        )

        // Cache the alignment result
        const cacheKey = `cite:${q.trim()}`
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

  async function doCite(q: string) {
    try {
      setRetrievalLoading(true)
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
    }
  }

  function runQuery(q = query) {
    if (!q.trim()) {
      return
    }

    const cacheKey = `cite:${q.trim()}`
    const cached = queryCache[cacheKey]
    const isExpired = cached && Date.now() - cached.timestamp > 5 * 60 * 1000

    if (cached && !isExpired) {
      setSupporting(Array.isArray(cached.supporting) ? cached.supporting : [])
      setAlignment(cached.alignment)
      return
    }

    setTranscript([
      `Interpret query: "${q.trim()}"`,
      'Plan: CITE → build annotated bibliography.',
    ])
    setAlignment(null)
    setAlignNote(null)
    setDocWhy({})
    setDocSummary({})
    setDocWhyLoading({})
    setDocSummaryLoading({})
    setCiteSelected({})
    setSupporting([])
    pushHistory(q.trim())
    doCite(q)
  }

  /* -------- render -------- */
  if (searchQuery) {
    if (pageDocs.length > 0) {
      return (
        <CitePanel
          query={query}
          docs={pageDocs}
          totalDocs={supporting.length}
          index={index}
          docSummary={docSummary}
          docWhy={docWhy}
          docWhyLoading={docWhyLoading}
          docSummaryLoading={docSummaryLoading}
          citeSelected={citeSelected}
          ops={ops}
          transcript={transcript}
          onToggleSelect={(id, v) =>
            setCiteSelected((prev) => ({ ...prev, [id]: v }))
          }
          alignment={alignment}
          alignLoading={alignLoading}
        />
      )
    }

    const loader = (
      <div
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

    if (retrievalLoading) {
      return loader
    }

    console.error('No results found for query:', searchQuery)
    return loader
  }

  return null
}

/* ---------- Cite mode panel (uses ResultsTable component) ---------- */
function CitePanel({
  query,
  docs,
  totalDocs,
  index,
  docSummary,
  docWhy,
  docWhyLoading,
  docSummaryLoading,
  citeSelected,
  ops,
  transcript,
  onToggleSelect,
  alignment,
  alignLoading,
}: {
  query: string
  docs: DocMeta[]
  totalDocs: number
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
  docWhy: Record<string, { why: string; relation: 'direct' | 'indirect' }>
  docWhyLoading: Record<string, boolean>
  docSummaryLoading: Record<string, boolean>
  citeSelected: Record<string, boolean>
  ops: {
    index_version: string
    prompt_version: string
    cost_usd: number | null
    energy_gco2e: number | null
  } | null
  alignment: {
    coverage?: string[]
    caveats?: string[]
    risks?: string[]
    suggestions?: string[]
    confidence?: number
    _debugKeys?: string[]
  } | null
  alignLoading: boolean
  onToggleSelect: (id: string, v: boolean) => void
  transcript: string[]
}) {
  async function exportBib(selectedIds: string[]) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } =
      await import('docx')

    const selectedDocs = docs.filter((doc) => selectedIds.includes(doc.doc_id))

    const children = [
      new Paragraph({
        text: `Annotated Bibliography for: ${query}`,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 400 },
      }),
      new Paragraph({ text: '' }),
    ]

    selectedDocs.forEach((doc, i) => {
      const row = index ? matchCatalogRow(doc, index) : undefined
      const summary =
        docSummary[doc.doc_id] || firstSentence(doc.kps?.[0]?.snippet ?? '')
      const url = urlFrom(doc, row)
      const typeLabel = typeFrom(doc, row)

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

      children.push(
        new Paragraph({
          text: summary,
          spacing: { after: 100 },
          indent: { left: 360 },
        }),
      )

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
        children.push(new Paragraph({ text: '', spacing: { after: 200 } }))
      }
    })

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: children,
        },
      ],
    })

    const blob = await Packer.toBlob(doc)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'askwri-bibliography.docx'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Transform DocMeta[] to RowData[] for ResultsTable
  const tableData: RowData[] = useMemo(() => {
    return docs.map((doc, idx) => {
      const row = index ? matchCatalogRow(doc, index) : undefined
      const best = [...(doc.kps || [])].sort(
        (a, b) => b.kp_relevance - a.kp_relevance,
      )[0]
      const summary =
        docSummary[doc.doc_id] || firstSentence(best?.snippet ?? '')
      const whyMeta = docWhy[doc.doc_id]
      const url = urlFrom(doc, row)
      const docRel =
        (doc.kps?.length ?? 0) > 0
          ? Math.max(...doc.kps.map((k) => k.kp_relevance || 0))
          : 0

      // Convert relevance score to High/Medium/Low
      const relevanceLabel =
        docRel >= 0.7 ? 'High' : docRel >= 0.4 ? 'Medium' : 'Low'

      return {
        id: doc.doc_id,
        publication_name: titleFrom(doc, row),
        author: chicagoFull(doc, row) + ` [${typeFrom(doc, row)}]`,
        summary: summary,
        relevance: relevanceLabel,
        how_relevant: whyMeta?.why || firstSentence(best?.snippet ?? ''),
        download_url: url,
        relevance_score: docRel,
      }
    })
  }, [docs, index, docSummary, docWhy])

  return (
    <ResultsPage
      data={tableData}
      query={query}
      ops={ops}
      transcript={transcript}
      docSummaryLoading={docSummaryLoading}
      docWhyLoading={docWhyLoading}
      alignment={alignment}
      alignLoading={alignLoading}
      onExportBib={exportBib}
    />
  )
}

export default function AskWriApp() {
  return (
    <Suspense
      fallback={
        <div
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
      }
    >
      <AskWriAppContent />
    </Suspense>
  )
}
