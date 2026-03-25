'use client'

/* eslint-disable no-restricted-syntax */

import { useState, useEffect, useMemo, useRef } from 'react'
import { Box, Heading, Text } from '@chakra-ui/react'
import {
  getThemedColor,
  InlineMessage,
} from '@worldresources/wri-design-systems'
import { DocMeta, KP } from '@/lib/llamacloud'
import { firstSentence } from '../../utils/utils'
import { WhyMeta, SupportingCitationsProps } from './types'
import { CitationCard } from './CitationCard'

export const SupportingCitations = ({
  supportingDocs,
  setFirstDocHowRelevant,
  page: controlledPage,
  setPage: setControlledPage,
  scrollVersion,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sourceRelevance,
  coverageRating,
  coverageExplanation,
  directlyCitedCount = 0,
  citationLabels,
  passageWhy: externalPassageWhy,
  setPassageWhy: setExternalPassageWhy,
  passageWhyLoading: externalPassageWhyLoading,
  setPassageWhyLoading: setExternalPassageWhyLoading,
}: SupportingCitationsProps) => {
  const [internalPassageWhy, setInternalPassageWhy] = useState<
    Record<string, WhyMeta>
  >({})
  const [internalPassageWhyLoading, setInternalPassageWhyLoading] = useState<
    Record<string, boolean>
  >({})
  const passageWhy = externalPassageWhy ?? internalPassageWhy
  const setPassageWhy = setExternalPassageWhy ?? setInternalPassageWhy
  const passageWhyLoading =
    externalPassageWhyLoading ?? internalPassageWhyLoading
  const setPassageWhyLoading =
    setExternalPassageWhyLoading ?? setInternalPassageWhyLoading
  const [docSummary, setDocSummary] = useState<Record<string, string>>({})
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [docSummaryLoading, setDocSummaryLoading] = useState<
    Record<string, boolean>
  >({})

  // Flatten all passages and sort by relevance
  const allItems = useMemo(() => {
    const arr: { doc: DocMeta; kp: KP }[] = []
    for (const d of supportingDocs) {
      if (d.kps) {
        for (const kp of d.kps) {
          arr.push({ doc: d, kp })
        }
      }
    }
    return arr.sort((a, b) => b.kp.kp_relevance - a.kp.kp_relevance)
  }, [supportingDocs])

  const paginatedItems = allItems
  const itemRefs = useRef<Record<number, HTMLElement | null>>({})
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  const isProgrammaticScroll = useRef(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!controlledPage) return undefined
    const el = itemRefs.current[controlledPage - 1]
    if (el) {
      isProgrammaticScroll.current = true
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      scrollTimeoutRef.current = setTimeout(() => {
        isProgrammaticScroll.current = false
        scrollTimeoutRef.current = null
      }, 800)
    }
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = null
      }
      isProgrammaticScroll.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollVersion])

  useEffect(() => {
    if (!setControlledPage) return undefined
    const container = scrollContainerRef.current
    if (!container) return undefined
    const handleScroll = () => {
      if (isProgrammaticScroll.current) return
      const containerTop = container.getBoundingClientRect().top
      let closestIdx = 0
      let closestDist = Infinity
      Object.entries(itemRefs.current).forEach(([idxStr, el]) => {
        if (!el) return
        const dist = Math.abs(el.getBoundingClientRect().top - containerTop)
        if (dist < closestDist) {
          closestDist = dist
          closestIdx = Number(idxStr)
        }
      })
      setControlledPage(closestIdx + 1)
    }
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [allItems, setControlledPage])

  // When passageWhy updates, call setFirstDocHowRelevant with first doc why
  useEffect(() => {
    // Only call if there is at least one item
    if (supportingDocs.length === 0 || Object.keys(passageWhy).length === 0)
      return
    // Find the first doc/passage id
    const firstDoc = supportingDocs[0]
    const firstKP = firstDoc.kps && firstDoc.kps[0]
    if (!firstDoc || !firstKP) return
    const passageId = `${firstDoc.doc_id}:${firstKP.passage_id}`
    const whyMeta = passageWhy[passageId]
    if (whyMeta && setFirstDocHowRelevant) {
      setFirstDocHowRelevant(whyMeta.why)
    }
  }, [passageWhy, supportingDocs, setFirstDocHowRelevant])

  // Fetch "Why it answers" explanations for visible passages
  useEffect(() => {
    if (paginatedItems.length === 0) return

    const passagesToFetch = paginatedItems.filter(({ doc, kp }) => {
      const passageId = `${doc.doc_id}:${kp.passage_id}`
      return (
        !passageWhy[passageId] && !passageWhyLoading[passageId] && kp.snippet
      )
    })

    if (passagesToFetch.length === 0) return

    // Set loading state
    passagesToFetch.forEach(({ doc, kp }) => {
      const passageId = `${doc.doc_id}:${kp.passage_id}`
      setPassageWhyLoading((prev) => ({ ...prev, [passageId]: true }))
    })

    setDocSummary((prev) => {
      const next = { ...prev }
      paginatedItems.forEach(({ doc, kp }) => {
        if (!next[doc.doc_id]) {
          next[doc.doc_id] = firstSentence(kp.snippet)
        }
      })
      return next
    })
    // Fetch batch explanations
    fetch('/api/batch-why', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'answer', // Generic query since we don't have access to actual query here
        mode: 'answer',
        passages: passagesToFetch.map(({ doc, kp }) => ({
          docTitle: doc.title || 'Document',
          snippet: kp.snippet,
        })),
      }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to fetch passage explanations: ${res.status}`)
        }
        return res.json()
      })
      .then((data) => {
        if (data.ok && data.explanations) {
          passagesToFetch.forEach(({ doc, kp }, index) => {
            const passageId = `${doc.doc_id}:${kp.passage_id}`
            const explanation = data.explanations[index]
            if (explanation) {
              setPassageWhy((prev) => ({
                ...prev,
                [passageId]: {
                  why: explanation.why || 'Relevant to the query.',
                  relation:
                    explanation.relation === 'direct' ? 'direct' : 'indirect',
                },
              }))
            }
          })
        }
      })
      .catch((error) => {
        console.error('Failed to fetch passage explanations:', error)
        // Set fallback explanations
        passagesToFetch.forEach(({ doc, kp }) => {
          const passageId = `${doc.doc_id}:${kp.passage_id}`
          setPassageWhy((prev) => ({
            ...prev,
            [passageId]: {
              why: 'This passage provides relevant context for the query.',
              relation: 'indirect',
            },
          }))
        })
      })
      .finally(() => {
        passagesToFetch.forEach(({ doc, kp }) => {
          const passageId = `${doc.doc_id}:${kp.passage_id}`
          setPassageWhyLoading((prev) => ({ ...prev, [passageId]: false }))
        })
      })
  }, [
    paginatedItems,
    passageWhy,
    passageWhyLoading,
    setPassageWhy,
    setPassageWhyLoading,
  ])

  if (allItems.length === 0) return null

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        maxHeight: 570,
        height: 570,
        backgroundColor: '#f2f6ff',
        padding: '20px',
        borderRadius: '16px',
      }}
    >
      {(coverageRating === 'poor' || coverageRating === 'limited') &&
        coverageExplanation && (
          <Box padding='2' marginBottom='2'>
            <InlineMessage
              variant='warning'
              label={
                coverageRating === 'poor'
                  ? 'Low corpus coverage'
                  : 'Limited corpus coverage'
              }
              caption={coverageExplanation}
            />
          </Box>
        )}

      <Heading size='2xl' paddingBottom='8px' color='#123369' flexShrink={0}>
        Sources
      </Heading>

      {/* Scrollable content area */}
      <Box
        ref={(el: HTMLElement | null) => {
          scrollContainerRef.current = el
        }}
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingRight: '8px',
          minHeight: 0,
        }}
      >
        <Heading size='md' flexShrink={0}>
          Directly cited{' '}
          {directlyCitedCount > 0 ? `(${directlyCitedCount})` : ''}
        </Heading>
        <Text paddingBottom='16px' color={getThemedColor('neutral', 700)}>
          Excerpts used directly to generate answer.
        </Text>
        {/* Directly cited cards */}
        <Box display='flex' flexDirection='column' gap='3'>
          {paginatedItems
            .slice(0, directlyCitedCount)
            .map(({ doc, kp }, idx) => (
              <CitationCard
                key={`${doc.doc_id}-${kp.passage_id}`}
                doc={doc}
                kp={kp}
                idx={idx}
                isActive={controlledPage === idx + 1}
                isDirectlyCited
                citationLabel={citationLabels?.[idx]}
                itemRef={(el) => {
                  itemRefs.current[idx] = el
                }}
                passageWhy={passageWhy}
                passageWhyLoading={passageWhyLoading}
                docSummary={docSummary}
                docSummaryLoading={docSummaryLoading}
              />
            ))}
        </Box>
        {paginatedItems.length > directlyCitedCount && (
          <>
            <Heading size='md' flexShrink={0} marginTop='4'>
              Additional reading{' '}
              {paginatedItems.length - directlyCitedCount > 0
                ? `(${paginatedItems.length - directlyCitedCount})`
                : ''}
            </Heading>
            <Text paddingBottom='8px' color={getThemedColor('neutral', 700)}>
              Other potentially relevant excerpts not used to generate answer.
            </Text>
            <Box display='flex' flexDirection='column' gap='3'>
              {paginatedItems
                .slice(directlyCitedCount)
                .map(({ doc, kp }, i) => {
                  const idx = directlyCitedCount + i
                  return (
                    <CitationCard
                      key={`${doc.doc_id}-${kp.passage_id}`}
                      doc={doc}
                      kp={kp}
                      idx={idx}
                      isActive={controlledPage === idx + 1}
                      isDirectlyCited={false}
                      itemRef={(el) => {
                        itemRefs.current[idx] = el
                      }}
                      passageWhy={passageWhy}
                      passageWhyLoading={passageWhyLoading}
                      docSummary={docSummary}
                      docSummaryLoading={docSummaryLoading}
                    />
                  )
                })}
            </Box>
          </>
        )}
      </Box>
    </Box>
  )
}
