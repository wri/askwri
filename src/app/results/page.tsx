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
  calculateEmbeddingCost,
} from '../utils/utils'
import { Assessment, Ops } from '../components/AnswerMode/types'

/* ---------- component ---------- */
type WhyMeta = { why: string; relation: 'direct' | 'indirect' }

const AskWriAppContent = () => {
  const [query, setQuery] = useState('')
  const [retrievalLoading, setRetrievalLoading] = useState(false)
  const [alignLoading, setAlignLoading] = useState(false)
  const [ops, setOps] = useState<Ops | null>(null)
  const [supporting, setSupporting] = useState<DocMeta[]>([])
  const [alignment, setAlignment] = useState<Assessment | null>(null)

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

  async function doCite(q: string) {
    try {
      setRetrievalLoading(true)
      const { docs, usage, debug } = await chatCiteLlamaIndex(q)

      setSupporting(docs)
      setRetrievalLoading(false)

      const embeddingCost = calculateEmbeddingCost(
        query,
        docs,
        usage,
        debug ?? {},
      )
      setOps(embeddingCost)
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

    setAlignment(null)

    setDocWhy({})
    setDocSummary({})
    setDocWhyLoading({})
    setDocSummaryLoading({})
    setBatchRelatesRequested(false)

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

  // Document-level WHY processing — batched into a single LLM call
  const [batchRelatesRequested, setBatchRelatesRequested] = useState(false)
  useEffect(() => {
    if (!index || supporting.length === 0 || batchRelatesRequested) return

    // Collect all docs that need relates explanations
    const docsToProcess = pageDocs.filter(
      (d) => !docWhy[d.doc_id] && !docWhyLoading[d.doc_id],
    )
    if (docsToProcess.length === 0) return

    setBatchRelatesRequested(true)

    // Mark all docs as loading
    const loadingUpdate: Record<string, boolean> = {}
    docsToProcess.forEach((d) => { loadingUpdate[d.doc_id] = true })
    setDocWhyLoading((prev) => ({ ...prev, ...loadingUpdate }))

    // Build batch request
    const batchDocs = docsToProcess.map((d) => {
      const row = matchCatalogRow(d, index)
      const best = [...(d.kps || [])].sort(
        (a, b) => b.kp_relevance - a.kp_relevance,
      )[0]
      return {
        title: titleFrom(d, row),
        authors: authorsFrom(d, row),
        year: yearFrom(d, row),
        snippet: best?.snippet ?? '',
      }
    })

    fetch('/api/batch-relates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, docs: batchDocs }),
    })
      .then((r) => r.json())
      .then((j) => {
        const results = j?.results || []
        const whyUpdate: Record<string, WhyMeta> = {}
        docsToProcess.forEach((d, i) => {
          const item = results[i]
          whyUpdate[d.doc_id] = {
            why: (
              item?.relates ||
              'Document provides relevant context for this query.'
            ).trim(),
            relation: item?.relation === 'direct' ? 'direct' : 'indirect',
          }
        })
        setDocWhy((prev) => ({ ...prev, ...whyUpdate }))
      })
      .catch(() => {
        const whyUpdate: Record<string, WhyMeta> = {}
        docsToProcess.forEach((d) => {
          whyUpdate[d.doc_id] = {
            why: 'Document provides relevant context for this query.',
            relation: 'indirect',
          }
        })
        setDocWhy((prev) => ({ ...prev, ...whyUpdate }))
      })
      .finally(() => {
        const doneUpdate: Record<string, boolean> = {}
        docsToProcess.forEach((d) => { doneUpdate[d.doc_id] = false })
        setDocWhyLoading((prev) => ({ ...prev, ...doneUpdate }))
      })
  }, [index, pageDocs, query, batchRelatesRequested, docWhy, docWhyLoading])

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

  useEffect(() => {
    if (pageDocs.length === 0) return
    const topTenResults = JSON.stringify(
      pageDocs
        .slice(0, 10)
        .map((doc) => titleFrom(doc, matchCatalogRow(doc, index))),
    )

    const sendFeedback = async () => {
      await fetch('/api/cite-mode-query-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          topTenResults,
        }),
      })
    }
    sendFeedback()
  }, [pageDocs, query])

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
