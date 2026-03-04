/* eslint-disable no-restricted-syntax */

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Box, Text, Heading, Spinner } from '@chakra-ui/react'
import { getThemedColor, Button, Tag } from '@worldresources/wri-design-systems'
import { DocMeta, KP } from '@/lib/llamacloud'
import { FaChevronRight, FaChevronLeft, FaQuoteRight } from 'react-icons/fa6'
import { IoIosCopy, IoMdOpen } from 'react-icons/io'
import { getRelevanceLevel, getRelevanceColor } from '@/app/utils/relevance'
import { AiIcon } from '../icons/AiIcon'
import { WhyMeta, SupportingCitationsProps } from './types'

// Helper to get first sentence from text
const firstSentence = (text?: string) => {
  if (!text) return ''
  const match = text.match(/[^.!?]*[.!?]/)
  return match ? match[0].trim() : text
}

export const SupportingCitations = ({
  supportingDocs,
  setFirstDocHowRelevant,
  page: controlledPage,
  setPage: setControlledPage,
}: SupportingCitationsProps) => {
  const [internalPage, setInternalPage] = useState(1)
  const page = controlledPage ?? internalPage
  const setPage = setControlledPage ?? setInternalPage
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

  const [expandedSnippets, setExpandedSnippets] = useState<
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

  // Paginate items
  const totalPages = Math.max(1, Math.ceil(allItems.length / pageSize))
  const paginatedItems = allItems.slice((page - 1) * pageSize, page * pageSize)

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
  }, [paginatedItems])

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
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
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
                {`${getRelevanceLevel(paginatedItems[0].kp.kp_relevance)} relevance`}
              </Text>
            </Box>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant='secondary' size='small' leftIcon={<IoMdOpen />}>
            <a
              href={`api/pdf/${paginatedItems[0].doc.doc_id}.pdf#page=${paginatedItems[0].kp.page || 1}`}
              target='_blank'
              rel='noopener noreferrer'
            >
              Open document
            </a>
          </Button>
          <Button
            variant='secondary'
            size='small'
            leftIcon={<IoIosCopy />}
            onClick={() => {
              if (paginatedItems[0]?.kp?.snippet) {
                navigator.clipboard.writeText(paginatedItems[0].kp.snippet)
              }
            }}
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

                {/* Snippet preview */}
                <Box
                  margin='3'
                  paddingX='3'
                  borderLeftWidth='5px'
                  borderColor={getThemedColor('neutral', 200)}
                  position='relative'
                  minHeight={150}
                >
                  <Text
                    fontSize='sm'
                    style={
                      expandedSnippets[passageId]
                        ? {}
                        : {
                            display: '-webkit-box',
                            WebkitLineClamp: 6,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            position: 'relative',
                          }
                    }
                  >
                    &rdquo;{kp.snippet}&rdquo;
                  </Text>
                  {!expandedSnippets[passageId] && kp.snippet.length > 120 && (
                    <Box
                      position='absolute'
                      left={0}
                      right={0}
                      bottom={0}
                      height={100}
                      background='linear-gradient(to bottom, rgba(255,255,255,0) 0%, white 90%)'
                      display='flex'
                      alignItems='flex-end'
                      justifyContent='center'
                      pointerEvents='none'
                      zIndex={1}
                    >
                      {/* Fade overlay */}
                    </Box>
                  )}
                  {!expandedSnippets[passageId] && kp.snippet.length > 120 && (
                    <Box
                      position='absolute'
                      left={0}
                      right={0}
                      bottom={0}
                      display='flex'
                      alignItems='flex-end'
                      justifyContent='center'
                      zIndex={2}
                      pointerEvents='auto'
                      minHeight={200}
                      height={200}
                    >
                      <Button
                        size='small'
                        variant='borderless'
                        style={{ margin: '8px 0' }}
                        onClick={() =>
                          setExpandedSnippets((prev) => ({
                            ...prev,
                            [passageId]: true,
                          }))
                        }
                      >
                        Show more
                      </Button>
                    </Box>
                  )}
                  {expandedSnippets[passageId] && kp.snippet.length > 120 && (
                    <Box
                      position='relative'
                      left={0}
                      right={0}
                      bottom={0}
                      display='flex'
                      alignItems='flex-end'
                      justifyContent='center'
                      zIndex={2}
                      pointerEvents='auto'
                    >
                      <Button
                        size='small'
                        variant='borderless'
                        style={{ margin: '8px 0' }}
                        onClick={() =>
                          setExpandedSnippets((prev) => ({
                            ...prev,
                            [passageId]: false,
                          }))
                        }
                      >
                        Show less
                      </Button>
                    </Box>
                  )}
                </Box>

                <div style={{ width: '100px', margin: '0 12px' }}>
                  <Tag
                    icon={<FaQuoteRight />}
                    label={`Page ${kp.page}`}
                    variant='info-white'
                  />
                </div>
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
                {/* Doc summary */}
                <Box marginTop='1' paddingX='3' paddingBottom='2'>
                  <Text
                    fontSize='xs'
                    color={getThemedColor('neutral', 700)}
                    fontWeight='medium'
                    marginBottom='1'
                  >
                    Doc summary
                  </Text>
                  <Text fontSize='sm' color={getThemedColor('neutral', 700)}>
                    {docSummaryLoading[doc.doc_id] ? (
                      <Spinner size='xs' />
                    ) : (
                      summary || '—'
                    )}
                  </Text>
                </Box>
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
          width='55%'
          padding='0 8px'
          marginTop='4'
          borderColor={getThemedColor('neutral', 200)}
          flexShrink={0}
        >
          <Button
            size='small'
            variant='secondary'
            onClick={() => setPage(Math.max(1, page - 1))}
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
            onClick={() => setPage(Math.min(totalPages, page + 1))}
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
