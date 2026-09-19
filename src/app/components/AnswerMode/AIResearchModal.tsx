'use client'

import { useState } from 'react'
import { Spinner, Box } from '@chakra-ui/react'
import { DocMeta } from '@/lib/llamacloud'
import {
  getThemedColor,
  AlertBanner,
  Modal,
} from '@worldresources/wri-design-systems'
import { AISearchForm } from './AISearchForm'
import { AnswerPanel } from './AnswerPanel'
import { SupportingCitations } from './SupportingCitations'
import {
  AIResearchModalProps,
  AnswerResult,
  Assessment,
  Ops,
  WhyMeta,
} from './types'
import {
  buildAlignmentSummary,
  calculateEmbeddingCost,
} from '../../utils/utils'
import { buildInline } from './citations'

export const AIResearchModal = ({
  consultedDocs,
  userSelectedDocs,
  open,
  onClose,
}: AIResearchModalProps) => {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [answer, setAnswer] = useState<AnswerResult | null>(null)
  const [firstDocHowRelevant, setFirstDocHowRelevant] = useState('')
  // State for SupportingCitations page
  const [supportingCitationsPage, setSupportingCitationsPage] = useState(1)
  const [scrollVersion, setScrollVersion] = useState(0)
  const handleCitationPageClick = (page: number) => {
    setSupportingCitationsPage(page)
    setScrollVersion((v) => v + 1)
  }
  const [passageWhy, setPassageWhy] = useState<Record<string, WhyMeta>>({})
  const [passageWhyLoading, setPassageWhyLoading] = useState<
    Record<string, boolean>
  >({})
  const [supportingDocs, setSupportingDocs] = useState<DocMeta[]>([])
  const [alignLoading, setAlignLoading] = useState(false)
  const [alignment, setAlignment] = useState<Assessment | null>(null)
  const [ops, setOps] = useState<Ops | null>(null)
  const [sourceRelevance, setSourceRelevance] = useState<
    Record<string, string>
  >({}) // doc_id → tier
  const [coverageRating, setCoverageRating] = useState<string>('')
  const [coverageExplanation, setCoverageExplanation] = useState<string>('')

  const onExampleClick = (example: string) => {
    setQuery(example)
  }

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
        const { insights, alignment: alignmentData } = j.assessment

        setAlignment({ insights, alignment: alignmentData })
      } else {
        setAlignment(null)
      }
    } catch (_e: any) {
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
          include_metadata: true,
          ...(consultedDocIds ? { cite_doc_ids: consultedDocIds } : {}),
        }),
      })
      const data = await response.json()
      const { docs, usage, debug } = data
      const likelyOffTopic = data.likely_off_topic === true

      const embeddingCost = calculateEmbeddingCost(
        query,
        docs,
        usage,
        debug,
        'ANSv1.3',
      )
      setOps(embeddingCost)

      // IMPORTANT: Save ALL docs immediately (like original implementation)
      setSupportingDocs(docs)

      const topTenResults = JSON.stringify(
        docs.slice(0, 10).map((d: DocMeta) => d.title),
      )

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
          ...(likelyOffTopic
            ? {
                warning: 'low_coverage',
                warningMessage:
                  'Limited relevant sources found for this query. The answer may not fully address your question.',
              }
            : {}),
        })
        return
      }

      // Send all valid docs to answer route — nano filter handles relevance
      const synthesisResponse = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          docs: validDocs,
          likely_off_topic: likelyOffTopic,
        }),
      })

      runAlignment(query.trim(), validDocs)

      if (!synthesisResponse.ok) {
        console.error('❌ Synthesis API error:', synthesisResponse.status)
        throw new Error(`Synthesis failed: ${synthesisResponse.status}`)
      }

      const synthesisResult = await synthesisResponse.json()

      if (synthesisResult?.synthesis) {
        const {
          sentences,
          paragraphs,
          warning,
          warningMessage,
          source_relevance,
        } = synthesisResult.synthesis

        // Validate sentences array
        if (!Array.isArray(sentences) || sentences.length === 0) {
          console.error('❌ Invalid synthesis result: no sentences')
          setAnswer({
            sentences: ['Synthesis failed: no answer generated.'],
            inline: [],
          })
          return
        }

        const cites: number[][] = Array.isArray(synthesisResult.synthesis.cites)
          ? synthesisResult.synthesis.cites
          : sentences.map(() => [])
        const passagesSent = Array.isArray(synthesisResult.passages_sent)
          ? synthesisResult.passages_sent
          : []
        const inline = buildInline(cites, passagesSent, validDocs)

        // Store source relevance tiers from synthesis LLM
        if (Array.isArray(source_relevance)) {
          const tierMap: Record<string, string> = {}
          for (const sr of source_relevance) {
            if (sr.doc_id && sr.tier) {
              tierMap[sr.doc_id] = sr.tier
            }
          }
          setSourceRelevance(tierMap)
        }

        // Save the answer with generated citations
        const answerWithCitations = {
          sentences,
          paragraphs,
          inline,
          cites,
          warning,
          warningMessage,
        }

        setAnswer(answerWithCitations)

        // Coverage comes from nano filter (returned in synthesis response)
        if (synthesisResult.synthesis?.coverage) {
          setCoverageRating(synthesisResult.synthesis.coverage)
          const explanations: Record<string, string> = {
            good: '',
            limited:
              'Some passages touch on the topic but lack specific answers.',
            poor: 'The corpus likely does not contain material to adequately answer this question.',
          }
          setCoverageExplanation(
            explanations[synthesisResult.synthesis.coverage] || '',
          )
        }

        fetch('/api/answer-mode-query-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: query.trim(),
            topTenResults,
            answer: sentences.join(' '),
          }),
        })

        // Log warning if present
        if (warning) {
          console.warn(`[Answer Warning] ${warning}: ${warningMessage}`)
        }
      } else {
        console.error('❌ Synthesis result missing synthesis object')
        setAnswer({
          sentences: ['Synthesis failed: invalid response from server.'],
          inline: [],
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
      })
    } finally {
      setLoading(false)
    }
  }

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
            ops={ops}
            setSupportingCitationsPage={handleCitationPageClick}
            supportingCitationsPage={supportingCitationsPage}
            coverageRating={coverageRating}
          />
          <Box
            style={{
              flex: 1,
              backgroundColor: 'white',
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
              scrollVersion={scrollVersion}
              sourceRelevance={sourceRelevance}
              coverageRating={coverageRating}
              coverageExplanation={coverageExplanation}
              inline={answer.inline}
              passageWhy={passageWhy}
              setPassageWhy={setPassageWhy}
              passageWhyLoading={passageWhyLoading}
              setPassageWhyLoading={setPassageWhyLoading}
            />
          </Box>
        </Box>
      )
    }

    return (
      <AISearchForm
        query={query}
        loading={loading}
        numberOfCiteDocs={consultedDocs?.length}
        userSelectedDocs={userSelectedDocs}
        onQueryChange={setQuery}
        onSubmit={handleSubmit}
        onExampleClick={onExampleClick}
      />
    )
  }

  return (
    <Modal
      header={
        <p
          style={{
            fontWeight: 'bold',
            color: getThemedColor('neutral', 800),
          }}
        >
          AI research assistant
        </p>
      }
      content={
        <div style={{ margin: '-10px' }}>
          <div>
            <AlertBanner
              title='This feature is an early release and under evaluation. Output quality may vary and should be treated as exploratory.'
              variant='warning'
            />
          </div>
          {renderContent()}
        </div>
      }
      size='xlarge'
      blocking={false}
      open={open}
      onClose={onClose}
    />
  )
}
