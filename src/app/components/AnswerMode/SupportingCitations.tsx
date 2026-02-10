/* eslint-disable no-restricted-syntax */

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Box, Text, Heading, Spinner } from '@chakra-ui/react'
import { getThemedColor, Button } from '@worldresources/wri-design-systems'
import { FaChevronRight, FaChevronLeft } from 'react-icons/fa6'
import { IoIosCopy, IoMdOpen } from 'react-icons/io'
import { AiIcon } from '../icons/AiIcon'
import { DocMeta, KP, WhyMeta, SupportingCitationsProps } from './types'

// Helper to get first sentence from text
const firstSentence = (text?: string) => {
  if (!text) return ''
  const match = text.match(/[^.!?]*[.!?]/)
  return match ? match[0].trim() : text
}

// Helper to get relevance color (green, yellow, red) using theme colors
const getRelevanceColor = (relevance: number) => {
  const percent = relevance * 100
  if (percent >= 70) return getThemedColor('success', 500) // green
  if (percent >= 40) return getThemedColor('warning', 500) // yellow
  return getThemedColor('error', 500) // red
}

export const SupportingCitations = ({ docs }: SupportingCitationsProps) => {
  const [page, setPage] = useState(1)
  const [pageSize] = useState(1)
  const [passageWhy, setPassageWhy] = useState<Record<string, WhyMeta>>({})
  const [passageWhyLoading, setPassageWhyLoading] = useState<
    Record<string, boolean>
  >({})
  const [docSummary, setDocSummary] = useState<Record<string, string>>({})
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [docSummaryLoading, setDocSummaryLoading] = useState<
    Record<string, boolean>
  >({})

  // Flatten all passages and sort by relevance
  const allItems = useMemo(() => {
    const arr: { doc: DocMeta; kp: KP }[] = []
    for (const d of docs) {
      if (d.kps) {
        for (const kp of d.kps) {
          arr.push({ doc: d, kp })
        }
      }
    }
    return arr.sort((a, b) => b.kp.kp_relevance - a.kp.kp_relevance)
  }, [docs])

  // Paginate items
  const totalPages = Math.max(1, Math.ceil(allItems.length / pageSize))
  const paginatedItems = allItems.slice((page - 1) * pageSize, page * pageSize)

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
  }, [paginatedItems])

  // Set doc summaries from first snippet
  useEffect(() => {
    setDocSummary((prev) => {
      const next = { ...prev }
      paginatedItems.forEach(({ doc, kp }) => {
        if (!next[doc.doc_id]) {
          next[doc.doc_id] = firstSentence(kp.snippet)
        }
      })
      return next
    })
  }, [paginatedItems])

  if (allItems.length === 0) return null

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <Heading
            size='md'
            color={getThemedColor('neutral', 900)}
            flexShrink={0}
          >
            Citation {page} of {allItems.length}
          </Heading>

          {/* Relevance score */}
          {paginatedItems[0] && (
            <Box display='flex' alignItems='center' gap='2' marginBottom='4'>
              <Text
                fontSize='xs'
                color={getRelevanceColor(paginatedItems[0].kp.kp_relevance)}
                fontWeight='medium'
              >
                Relevance:{' '}
                {(paginatedItems[0].kp.kp_relevance * 100).toFixed(0)}%
              </Text>
            </Box>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            variant='secondary'
            size='small'
            leftIcon={<IoMdOpen />}
            onClick={
              () =>
                console.log('Open document') /* TODO: implement functionality */
            }
          >
            Open document
          </Button>
          <Button
            variant='secondary'
            size='small'
            leftIcon={<IoIosCopy />}
            onClick={
              () =>
                console.log('Copy citation') /* TODO: implement functionality */
            }
          >
            Copy citation
          </Button>
        </div>
      </div>
      {/* Scrollable content area */}
      <Box
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingRight: '8px',
          minHeight: 0,
        }}
      >
        {/* Document cards */}
        <Box display='flex' flexDirection='column' gap='3'>
          {paginatedItems.map(({ doc, kp }, idx) => {
            const docTitle =
              doc.title || `Document ${doc.doc_id?.slice(0, 8) || idx + 1}`
            const authors = doc.authors?.join(', ') || 'Unknown author'
            const year = doc.year || ''
            const passageId = `${doc.doc_id}:${kp.passage_id}`
            const whyData = passageWhy[passageId]
            const summary = docSummary[doc.doc_id]

            return (
              <Box
                key={`${doc.doc_id}-${kp.passage_id}`}
                borderWidth='1px'
                borderColor={getThemedColor('neutral', 200)}
                backgroundColor='white'
              >
                {/* Why it answers */}
                <Box
                  backgroundColor={getThemedColor('neutral', 200)}
                  padding='3'
                >
                  <Text fontSize='md' as='div' marginBottom={3}>
                    <AiIcon /> How is this relevant?{' '}
                  </Text>
                  {passageWhyLoading[passageId] ? (
                    <Spinner size='xs' marginLeft='2' />
                  ) : (
                    <Text
                      as='span'
                      fontSize='sm'
                      color={getThemedColor('neutral', 700)}
                    >
                      {whyData?.why || '—'}
                    </Text>
                  )}
                </Box>

                {/* Doc summary (collapsible) */}
                <details>
                  <summary
                    style={{
                      fontSize: '14px',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      color: getThemedColor('neutral', 700),
                    }}
                  >
                    Doc summary
                  </summary>
                  <Box marginTop='1'>
                    <Text fontSize='sm' color={getThemedColor('neutral', 700)}>
                      {docSummaryLoading[doc.doc_id] ? (
                        <Spinner size='xs' />
                      ) : (
                        summary || '—'
                      )}
                    </Text>
                  </Box>
                </details>

                {/* Snippet preview */}
                <Box
                  marginTop='3'
                  paddingTop='3'
                  borderTopWidth='1px'
                  borderColor={getThemedColor('neutral', 200)}
                >
                  <Text
                    fontSize='sm'
                    color={getThemedColor('neutral', 600)}
                    fontStyle='italic'
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    &rdquo;{kp.snippet}&rdquo;
                  </Text>
                </Box>

                {/* Title */}
                <Heading
                  padding='3'
                  size='sm'
                  color={getThemedColor('neutral', 900)}
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {docTitle}
                </Heading>

                {/* Citation info */}
                <Text
                  padding='3'
                  fontSize='xs'
                  color={getThemedColor('neutral', 600)}
                  marginBottom='3'
                >
                  {authors}
                  {year && ` (${year})`} • p.{kp.page || '?'}
                </Text>
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* Fixed pagination at bottom */}
      {totalPages > 1 && (
        <Box
          display='flex'
          justifyContent='space-between'
          alignItems='center'
          paddingTop='4'
          marginTop='4'
          borderTopWidth='1px'
          borderColor={getThemedColor('neutral', 200)}
          flexShrink={0}
        >
          <Button
            size='small'
            variant='secondary'
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            colorScheme='gray'
            leftIcon={<FaChevronLeft size={20} />}
          >
            Previous
          </Button>
          <Text fontSize='sm' color={getThemedColor('neutral', 600)}>
            {page} of {totalPages}
          </Text>
          <Button
            size='small'
            variant='secondary'
            rightIcon={<FaChevronRight size={20} />}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            colorScheme='gray'
          >
            Next
          </Button>
        </Box>
      )}
    </Box>
  )
}
