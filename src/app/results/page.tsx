/* eslint-disable */

'use client'

import React, { useMemo, useState, useEffect, Suspense } from 'react'
import { Spinner } from '@chakra-ui/react'
import { useSearchParams, useRouter } from 'next/navigation'
import { DocMeta } from '@/lib/llamacloud'
import { chatCiteLlamaIndex } from '@/lib/llamaindex-client'
import { estimateCostUSD } from '@/config/costs'
import { estimateEnergyGCO2e } from '@/config/energy'
import CitePanel from './CitePanel'
import { EmptyStateTopics } from '@/app/components/results/EmptyStateTopics'
import {
  InterpretationLine,
  facetChipLabel,
} from '@/app/components/results/InterpretationLine'
import {
  buildCatalogIndex,
  matchCatalogRow,
  titleFrom,
  authorsFrom,
  yearFrom,
  firstSentence,
  buildAlignmentSummary,
  calculateEmbeddingCost,
} from '../utils/utils'
import { getCatalog } from '@/lib/catalog-cache'
import { Assessment, Ops } from '../components/AnswerMode/types'

/* ---------- component ---------- */
type WhyMeta = { why: string; relation: 'direct' | 'indirect' }
type UserFacet = { facet: string; value: string }

// One key scheme for every cache read AND write: the facet mode is part of
// the key, so a chip removal or an as-typed re-run can never serve the
// auto-mode entry.
const cacheKeyFor = (q: string, facets: UserFacet[] | null, asTyped = false) =>
  `cite:${q.trim()}:${asTyped ? 'as-typed' : facets ? JSON.stringify(facets) : 'auto'}`

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
        supporting?: DocMeta[]
        alignment?: any
        understanding?: any
        timestamp: number
      }
    >
  >({})
  // False until a search has actually completed (success only): gates the
  // empty state so it never claims "no matches" before the first response
  // or after a failed request.
  const [searchCompleted, setSearchCompleted] = useState(false)
  // The cache key of the in-flight/most-recent search — alignment results
  // merge into the same entry the docs were written under.
  const [activeCacheKey, setActiveCacheKey] = useState<string | null>(null)

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
  // Distinct from `index !== null`: getCatalog resolves to a null index when
  // the fetch fails, and the metadata-dependent effects below must still run
  // (degraded) rather than hang forever waiting for a catalog.
  const [catalogSettled, setCatalogSettled] = useState(false)
  // Query understanding (design 2026-08-19 §3): userFacets=null ⇒ auto mode;
  // once the user removes a chip, switch to explicit-facets mode and re-query.
  const [userFacets, setUserFacets] = useState<
    { facet: string; value: string }[] | null
  >(null)
  const [understanding, setUnderstanding] = useState<any>(null)
  const [autoSwitchedFrom, setAutoSwitchedFrom] = useState<string | null>(null)
  const router = useRouter()
  useEffect(() => {
    getCatalog().then(({ catalog: c, index: i }) => {
      setCatalog(c)
      setIndex(i)
      setCatalogSettled(true)
    })
  }, [])

  const searchParams = useSearchParams()
  const searchQuery = searchParams?.get('q')?.trim() ?? ''

  async function doCite(
    q: string,
    opts: {
      facets: UserFacet[] | null
      cacheKey: string
      autoSwitched?: boolean
      expansion?: false
    },
  ) {
    try {
      setRetrievalLoading(true)
      const res = await chatCiteLlamaIndex(q, {
        ...(opts.facets ? { facets: opts.facets } : {}),
        ...(opts.expansion === false ? { expansion: false } : {}),
      })
      const { docs, usage, debug } = res
      setUnderstanding(res.queryUnderstanding ?? null)

      // Auto-switch (design §3, decidable rule): only when the original query
      // returned <3 docs, a spelling suggestion exists, and this request is
      // not itself the auto-switch hop (loop-proof: the flag is threaded
      // through the chained call, not read from state, so at most one switch
      // happens per user-initiated search).
      const spelling = res.queryUnderstanding?.suggestions?.find(
        (s: any) => s.type === 'spelling',
      )?.text
      if (
        docs.length < 3 &&
        spelling &&
        !opts.autoSwitched &&
        opts.expansion !== false &&
        spelling !== q
      ) {
        setAutoSwitchedFrom(q)
        // The corrected text becomes THE query: the banner, alignment,
        // batch-relates and caching all key off it.
        setQuery(spelling)
        setRetrievalLoading(false)
        runQuery(spelling, { facets: opts.facets, autoSwitched: true })
        return
      }

      setSupporting(docs)
      setSearchCompleted(true)
      setRetrievalLoading(false)
      setQueryCache((prev) => ({
        ...prev,
        [opts.cacheKey]: {
          ...prev[opts.cacheKey],
          supporting: docs,
          understanding: res.queryUnderstanding ?? null,
          timestamp: Date.now(),
        },
      }))

      const embeddingCost = calculateEmbeddingCost(q, docs, usage, debug ?? {})
      setOps(embeddingCost)
    } catch (e: any) {
      setRetrievalLoading(false)
    }
  }

  function runQuery(
    q = query,
    opts?: {
      facets?: UserFacet[] | null
      autoSwitched?: boolean
      asTyped?: boolean
    },
  ) {
    if (!q.trim()) {
      return
    }

    // Facets are threaded explicitly: a caller that just called
    // setUserFacets passes the new value, so we never read a stale closure.
    const facets = opts?.facets !== undefined ? opts.facets : userFacets
    const cacheKey = cacheKeyFor(q, facets, opts?.asTyped)
    setActiveCacheKey(cacheKey)
    const cached = queryCache[cacheKey]
    const isExpired = cached && Date.now() - cached.timestamp > 5 * 60 * 1000

    if (cached && !isExpired && Array.isArray(cached.supporting)) {
      setSupporting(cached.supporting)
      setAlignment(cached.alignment ?? null)
      setUnderstanding(cached.understanding ?? null)
      setSearchCompleted(true)
      return
    }

    setAlignment(null)

    setDocWhy({})
    setDocSummary({})
    setDocWhyLoading({})
    setDocSummaryLoading({})
    setBatchRelatesRequested(false)

    setSupporting([])
    setSearchCompleted(false)

    doCite(q, {
      facets,
      cacheKey,
      autoSwitched: opts?.autoSwitched,
      ...(opts?.asTyped ? { expansion: false as const } : {}),
    })
  }

  // Re-query the original-as-typed with expansion suppressed so the server
  // does not re-suggest and the client does not re-switch (one auto-switch per
  // user-initiated search, loop-proof — design §3).
  function runAsTyped(q: string) {
    setQuery(q)
    setUserFacets(null)
    setAutoSwitchedFrom(null)
    runQuery(q, { facets: null, asTyped: true })
  }

  useEffect(() => {
    if (!searchQuery) return
    if (query.trim() === searchQuery) return
    setQuery(searchQuery)
    setUserFacets(null) // new search = auto mode again (design §3)
    setAutoSwitchedFrom(null) // new search = no auto-switch carried over
    runQuery(searchQuery, { facets: null })
  }, [searchQuery])

  const pageDocs = useMemo(() => {
    if (!Array.isArray(supporting)) return []
    return supporting
  }, [supporting])

  // Chip removal (design §3): drop the facet, switch to explicit-facets mode,
  // and re-query. The remaining facets are passed to runQuery directly (state
  // updates are async) and become part of the cache key, so this never sends
  // the pre-removal facets and never serves the auto-mode cached result.
  const onRemoveFacet = (chip: { facet: string; value: string }) => {
    const currentHard = (understanding?.facets ?? []).filter(
      (f: any) => f.action === 'hard',
    )
    const remaining = currentHard
      .filter((f: any) => !(f.facet === chip.facet && f.value === chip.value))
      .map((f: any) => ({ facet: f.facet, value: f.value }))
    setUserFacets(remaining)
    runQuery(query, { facets: remaining })
  }

  // Did-you-mean accept: re-search with the corrected text (new q = auto mode).
  const onApplySuggestion = (text: string) => {
    router.push('/results?q=' + encodeURIComponent(text))
  }

  // Document-level WHY processing — batched into a single LLM call
  const [batchRelatesRequested, setBatchRelatesRequested] = useState(false)
  useEffect(() => {
    // Wait for the catalog: the prompt is built from titles/authors/years that
    // only the catalog carries, and this effect fires exactly once.
    if (supporting.length === 0 || batchRelatesRequested || !catalogSettled)
      return

    // Collect all docs that need relates explanations
    const docsToProcess = pageDocs.filter(
      (d) => !docWhy[d.doc_id] && !docWhyLoading[d.doc_id],
    )
    if (docsToProcess.length === 0) return

    setBatchRelatesRequested(true)

    // Mark all docs as loading
    const loadingUpdate: Record<string, boolean> = {}
    docsToProcess.forEach((d) => {
      loadingUpdate[d.doc_id] = true
    })
    setDocWhyLoading((prev) => ({ ...prev, ...loadingUpdate }))

    // Build batch request — catalog index is optional (enriches metadata when available)
    const batchDocs = docsToProcess.map((d) => {
      const row = index ? matchCatalogRow(d, index) : undefined
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
        docsToProcess.forEach((d) => {
          doneUpdate[d.doc_id] = false
        })
        setDocWhyLoading((prev) => ({ ...prev, ...doneUpdate }))
      })
  }, [index, catalogSettled, pageDocs, query, batchRelatesRequested])

  async function runAlignment(
    q: string,
    docs: DocMeta[],
    cacheKey: string | null,
  ) {
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

        // Merge the alignment into the same cache entry the docs were
        // written under (facet-aware key — see cacheKeyFor).
        if (cacheKey) {
          setQueryCache((prev) => ({
            ...prev,
            [cacheKey]: {
              ...prev[cacheKey],
              alignment: finalAlignment,
              timestamp: Date.now(),
            },
          }))
        }

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
      const cached = activeCacheKey ? queryCache[activeCacheKey] : undefined
      const isExpired = cached && Date.now() - cached.timestamp > 5 * 60 * 1000

      if (cached && !isExpired && cached.alignment) {
        setAlignment(cached.alignment)
        return
      }

      runAlignment(query, supporting, activeCacheKey)
    }
  }, [
    supporting,
    alignLoading,
    query,
    queryCache,
    retrievalLoading,
    activeCacheKey,
  ])

  // Auto-run alignment after retrieval completes
  useEffect(() => {
    if (
      !retrievalLoading &&
      supporting.length > 0 &&
      query.trim() &&
      !alignLoading
    ) {
      const timer = setTimeout(() => {
        runAlignmentAfterResults()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [
    retrievalLoading,
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
        <>
          {autoSwitchedFrom && (
            <p
              style={{
                fontSize: '14px',
                marginTop: '4px',
                padding: '0 2rem',
                maxWidth: '800px',
              }}
            >
              Searched for “{query}” instead ·{' '}
              <button
                onClick={() => runAsTyped(autoSwitchedFrom)}
                style={{
                  color: '#0A6CFF',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  fontSize: '14px',
                }}
              >
                search for “{autoSwitchedFrom}” as typed
              </button>
            </p>
          )}
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
            queryUnderstanding={understanding}
            onRemoveFacet={onRemoveFacet}
            onApplySuggestion={onApplySuggestion}
          />
        </>
      )
    }

    // Empty state (design §3): a search actually COMPLETED with no docs
    // surviving the floor (searchCompleted gates out the pre-search render
    // and failed requests — those fall through to the spinner, as before
    // this feature). A dead end becomes a door — show nearby topics, and
    // keep any hard-facet chips removable: a facet that filtered everything
    // out is exactly the one the user needs to be able to remove
    // (facet_filter.py Invariant 1).
    if (!retrievalLoading && searchCompleted && pageDocs.length === 0) {
      return (
        <>
          <div style={{ padding: '0 2rem' }}>
            <InterpretationLine
              chips={(understanding?.facets ?? [])
                .filter((f: any) => f.action === 'hard')
                .map((f: any) => ({
                  facet: f.facet,
                  value: f.value,
                  label: facetChipLabel(f.facet, f.value),
                }))}
              suggestion={
                (understanding?.suggestions ?? []).find(
                  (s: any) => s.type === 'spelling',
                )?.text ?? null
              }
              onRemoveChip={onRemoveFacet}
              onApplySuggestion={onApplySuggestion}
            />
          </div>
          <EmptyStateTopics
            query={query}
            topics={(understanding?.suggestions ?? [])
              .filter((s: any) => s.type === 'nearby_topic')
              .map((s: any) => s.text)}
            onPickTopic={(t) =>
              router.push('/results?q=' + encodeURIComponent(t))
            }
          />
        </>
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
