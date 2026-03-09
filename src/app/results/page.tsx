/* eslint-disable */

'use client'

import React, { useMemo, useState, useEffect, Suspense } from 'react'
import { Spinner } from '@chakra-ui/react'
import { useSearchParams } from 'next/navigation'
import { DocMeta } from '@/lib/llamacloud'
import { chatCiteLlamaIndex } from '@/lib/llamaindex-client'
import { estimateCostUSD } from '@/config/costs'
import { estimateEnergyGCO2e } from '@/config/energy'
import CitePanel from './CitePanel'
import {
  buildCatalogIndex,
  matchCatalogRow,
  titleFrom,
  authorsFrom,
  yearFrom,
  firstSentence,
  normalizeCatalogRow,
  buildAlignmentSummary,
} from '../utils/utils'

/* ---------- component ---------- */
type WhyMeta = { why: string; relation: 'direct' | 'indirect' }

const AskWriAppContent = () => {
  const [query, setQuery] = useState('')
  const [retrievalLoading, setRetrievalLoading] = useState(false)
  const [alignLoading, setAlignLoading] = useState(false)
  const [transcript, setTranscript] = useState<string[]>([])

  const [ops, setOps] = useState<{
    index_version: string
    prompt_version: string
    cost_usd: number | null
    energy_gco2e: number | null
  } | null>(null)
  const [supporting, setSupporting] = useState<DocMeta[]>([])
  const [alignment, setAlignment] = useState<{
    insights?: string[]
    alignment?: 'High' | 'Moderate' | 'Low' | 'Very Low'
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

    setDocWhy({})
    setDocSummary({})
    setDocWhyLoading({})
    setDocSummaryLoading({})

    setSupporting([])

    doCite(q)
  }

  useEffect(() => {
    if (!searchQuery) return
    if (query.trim() === searchQuery) return
    setQuery(searchQuery)
    runQuery(searchQuery)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

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

  async function runAlignment(q: string, docs: DocMeta[]) {
    try {
      if (!docs?.length) {
        setAlignment(null)
        return
      }
      setAlignLoading(true)

      const resultsSummaryForAlignment = buildAlignmentSummary(q, docs)

      const r = await fetch('/api/alignment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: q,
          resultsSummary: resultsSummaryForAlignment,
        }),
      })
      const j = await r.json()

      if (j?.ok && j?.assessment) {
        const { insights, alignment } = j.assessment

        const finalAlignment = {
          insights,
          alignment,
          _debugKeys: j.debug?.keys || [],
        }

        setAlignment(finalAlignment)

        // Cache the alignment result
        const cacheKey = `cite:${q.trim()}`
        setQueryCache((prev) => ({
          ...prev,
          [cacheKey]: {
            ...prev[cacheKey],
            alignment: finalAlignment,
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
      }
    } catch (e: any) {
      setAlignment(null)
    } finally {
      setAlignLoading(false)
    }
  }

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
        }
        const best = [...(d.kps || [])].sort(
          (a, b) => b.kp_relevance - a.kp_relevance,
        )[0]
        const txt = firstSentence(best?.snippet ?? '').trim()
        return { ...prevSummary, [d.doc_id]: txt }
      })
    })
  }, [pageDocs, index, supporting.length])

  /* -------- render -------- */
  if (searchQuery) {
    if (pageDocs.length > 0) {
      return (
        <CitePanel
          query={query}
          docs={pageDocs}
          index={index}
          docSummary={docSummary}
          docWhy={docWhy}
          docWhyLoading={docWhyLoading}
          docSummaryLoading={docSummaryLoading}
          ops={ops}
          transcript={transcript}
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

    return loader
  }

  return null
}

const AskWriApp = () => (
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

export default AskWriApp
