/* eslint-disable no-plusplus */

'use client'

import { useState } from 'react'
import { Spinner, Box } from '@chakra-ui/react'
import { DocMeta } from '@/lib/llamacloud'
import {
  getThemedColor,
  InlineMessage,
} from '@worldresources/wri-design-systems'
import {
  ANSWER_MODE_SUGGESTION_POOL,
  getRandomSuggestions,
} from '../../utils/exampleQuestions'
import { AISearchForm } from './AISearchForm'
import { AnswerPanel } from './AnswerPanel'
import { SupportingCitations } from './SupportingCitations'
import { AnswerResult, Assessment } from './types'
import { RowData } from '../results/types'
import { buildAlignmentSummary } from '@/app/utils/utils'

const MAX_ANSWER_MODE_RESULTS = 20

export const AIResearchModalContent = ({
  consultedDocs,
}: {
  consultedDocs?: RowData[]
}) => {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [answer, setAnswer] = useState<AnswerResult | null>(null)
  const [firstDocHowRelevant, setFirstDocHowRelevant] = useState('')
  // State for SupportingCitations page
  const [supportingCitationsPage, setSupportingCitationsPage] = useState(1)
  const [supportingDocs, setSupportingDocs] = useState<DocMeta[]>([])
  const [suggestions, setSuggestions] = useState<string[]>(() =>
    ANSWER_MODE_SUGGESTION_POOL.slice(0, 3),
  )
  const [alignLoading, setAlignLoading] = useState(false)

  const [alignment, setAlignment] = useState<Assessment | null>(null)

  const handleShuffleSuggestions = () => {
    setSuggestions(getRandomSuggestions(3, 'answer'))
  }

  const handleExampleClick = (example: string) => {
    setQuery(example)
  }

  // Helper function to get top quality results (top 40% by score)
  const getTopQualityDocs = (docs: any[], maxDocs: number = 8): any[] => {
    if (!docs.length) return []
    const sortedDocs = [...docs].sort((a, b) => (b.score || 0) - (a.score || 0))
    const top40Percent = Math.max(1, Math.ceil(sortedDocs.length * 0.4))
    const finalCount = Math.min(top40Percent, maxDocs)
    return sortedDocs.slice(0, finalCount)
  }

  async function runAlignment(q: string, docs: DocMeta[]) {
    try {
      if (!docs?.length) {
        setAlignment(null)
        return
      }
      setAlignLoading(true)

      const resultsSummaryForAlignment = buildAlignmentSummary(q, docs)
      console.log({ resultsSummaryForAlignment, q, docs })
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

        setAlignment({ insights, alignment })
      } else {
        setAlignment(null)
      }
    } catch (e: any) {
      setAlignment(null)
    } finally {
      setAlignLoading(false)
    }
  }

  const handleSubmit = async () => {
    if (!query.trim()) return

    try {
      setLoading(true)

      // Step 1: Call the answer mode API for retrieval
      // If citeDocs has docs, send cite_doc_ids (top 20)
      let consultedDocIds
      if (consultedDocs && consultedDocs.length > 0) {
        consultedDocIds = consultedDocs.map((d) => d.id)
      }

      const response = await fetch('/api/llamaindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          mode: 'answer',
          max_results: MAX_ANSWER_MODE_RESULTS,
          similarity_threshold: 0.05,
          include_metadata: true,
          rerank: true,
          alpha: 0.5,
          denseTopK: 150,
          rerankTopK: 20,
          retrievalMode: 'hybrid',
          sparseTopK: 150,
          ...(consultedDocIds ? { cite_doc_ids: consultedDocIds } : {}),
        }),
      })
      const data = await response.json()
      const { docs } = data

      // IMPORTANT: Save ALL docs immediately (like original implementation)
      setSupportingDocs(docs)

      // Filter docs to only those with actual content for synthesis
      const validDocs = docs.filter(
        (d: any) =>
          d.kps &&
          d.kps.length > 0 &&
          d.kps.some((kp: any) => kp.snippet && kp.snippet.length > 10),
      )

      if (validDocs.length === 0) {
        console.warn('⚠️ No valid docs with snippets for synthesis!')
        console.warn(
          'All docs:',
          docs.map((d: any) => ({
            doc_id: d.doc_id,
            hasKps: !!d.kps,
            kpsCount: d.kps?.length,
          })),
        )
        setAnswer({
          sentences: [
            'Unable to synthesize answer: no documents with content found.',
          ],
          inline: [],
          alignment: {
            insights: [],
            alignment: 'Very Low',
          },
        })
        return
      }

      // Step 2: Get top quality docs for synthesis (top 40%, max 6)
      const topQualityDocs = getTopQualityDocs(validDocs, 6)

      const synthesisResponse = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), docs: topQualityDocs }),
      })

      runAlignment(query.trim(), validDocs)

      if (!synthesisResponse.ok) {
        console.error('❌ Synthesis API error:', synthesisResponse.status)
        throw new Error(`Synthesis failed: ${synthesisResponse.status}`)
      }

      const synthesisResult = await synthesisResponse.json()

      if (synthesisResult?.synthesis) {
        const { sentences, paragraphs, warning, warningMessage } =
          synthesisResult.synthesis

        // Validate sentences array
        if (!Array.isArray(sentences) || sentences.length === 0) {
          console.error('❌ Invalid synthesis result: no sentences')
          setAnswer({
            sentences: ['Synthesis failed: no answer generated.'],
            inline: [],
            alignment: {
              insights: [],
              alignment: 'Very Low',
            },
          })
          return
        }

        // Collect ALL available chunks/passages from ALL documents
        const allChunks: { doc: any; kp: any }[] = []
        validDocs.forEach((doc: any) => {
          ;(doc.kps || []).forEach((kp: any) => {
            if (kp.snippet && kp.snippet.length > 10) {
              allChunks.push({ doc, kp })
            }
          })
        })

        if (allChunks.length === 0) {
          console.warn('[Citations] No valid chunks available for citations!')
        }

        // Generate inline citations by distributing chunks across sentences
        const inline = sentences.map((sent: string, sentIdx: number) => {
          const refs: { ref: string; page: number }[] = []

          // Distribute chunks across sentences (2-3 citations per sentence)
          const chunksPerSentence = Math.max(
            1,
            Math.min(3, Math.ceil(allChunks.length / sentences.length)),
          )
          const startIdx = sentIdx * chunksPerSentence
          const endIdx = Math.min(
            startIdx + chunksPerSentence,
            allChunks.length,
          )

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

        // Calculate confidence based on document coverage
        const confidence = Math.min(0.9, 0.5 + validDocs.length * 0.06)

        // Save the answer with generated citations
        const answerWithCitations = {
          sentences,
          paragraphs,
          inline,
          warning,
          warningMessage,
        }

        setAnswer(answerWithCitations)

        // Log warning if present
        if (warning) {
          console.warn(`[Answer Warning] ${warning}: ${warningMessage}`)
        }
      } else {
        console.error('❌ Synthesis result missing synthesis object')
        setAnswer({
          sentences: ['Synthesis failed: invalid response from server.'],
          inline: [],
          alignment: {
            insights: [],
            alignment: 'Very Low',
          },
        })
      }
    } catch (error) {
      console.error('❌ Error in answer mode:', error)
      console.error('Error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })

      // Set error state for user
      setAnswer({
        sentences: [
          'An error occurred while processing your request. Please try again.',
        ],
        inline: [],
        alignment: {
          insights: [],
          alignment: 'Very Low',
        },
      })
    } finally {
      setLoading(false)
    }
  }

  console.log({ alignLoading, alignment })
  const renderContent = () => {
    if (loading) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '60px 20px',
            gap: '20px',
          }}
        >
          <Spinner size='xl' color={getThemedColor('primary', 500)} />
        </div>
      )
    }

    if (answer) {
      return (
        <Box style={{ display: 'flex' }}>
          <AnswerPanel
            query={query}
            answer={answer}
            firstDocHowRelevant={firstDocHowRelevant}
            supportingDocs={supportingDocs}
            consultedDocs={consultedDocs}
            setAnswer={setAnswer}
            setQuery={setQuery}
            alignLoading={alignLoading}
            alignment={alignment}
            setSupportingCitationsPage={setSupportingCitationsPage}
          />
          <Box
            style={{
              flex: 1,
              backgroundColor: 'white',
              borderRadius: '8px',
              border: '1px solid',
              borderColor: getThemedColor('neutral', 200),
              minWidth: 0,
              maxHeight: '600px',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <SupportingCitations
              setFirstDocHowRelevant={setFirstDocHowRelevant}
              supportingDocs={supportingDocs}
              page={supportingCitationsPage}
              setPage={setSupportingCitationsPage}
            />
          </Box>
        </Box>
      )
    }

    return (
      <AISearchForm
        query={query}
        loading={loading}
        suggestions={suggestions}
        numberOfCiteDocs={consultedDocs?.length}
        onQueryChange={setQuery}
        onSubmit={handleSubmit}
        onShuffleSuggestions={handleShuffleSuggestions}
        onExampleClick={handleExampleClick}
      />
    )
  }

  return (
    <div style={{ margin: '-10px' }}>
      <div>
        <InlineMessage
          size='full-width'
          variant='warning'
          label='This feature is an early release and under evaluation. Output quality may vary and should be treated as exploratory.'
        />
      </div>
      {renderContent()}
    </div>
  )
}

export const aiResearchModalHeader = (
  <p
    style={{
      fontWeight: 'bold',
      color: getThemedColor('neutral', 800),
    }}
  >
    AI research assistant
  </p>
)
