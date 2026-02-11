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
  SUGGESTION_POOL,
  getRandomSuggestions,
} from '../../utils/exampleQuestions'
import { AISearchForm } from './AISearchForm'
import { AnswerPanel } from './AnswerPanel'
import { SupportingCitations } from './SupportingCitations'
import { AnswerResult } from './types'


export const AIResearchModalContent = () => {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [answer, setAnswer] = useState<AnswerResult | null>(null)
  const [supportingDocs, setSupportingDocs] = useState<DocMeta[]>([])
  const [suggestions, setSuggestions] = useState<string[]>(() =>
    SUGGESTION_POOL.slice(0, 3),
  )

  const handleShuffleSuggestions = () => {
    setSuggestions(getRandomSuggestions())
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

  const handleSubmit = async () => {
    if (!query.trim()) return

    try {
      setLoading(true)
      console.log('🔍 Starting answer mode query:', query)
      console.log(
        '⚙️ Answer: Using hybrid retrieval (dense + sparse) with reranking',
      )

      // Step 1: Call the answer mode API for retrieval
      const response = await fetch('/api/llamaindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          mode: 'answer',
          max_results: 100,
          similarity_threshold: 0.05,
          include_metadata: true,
          rerank: true,
        }),
      })
      const data = await response.json()
      const { message, docs, usage, debug } = {
        message: data.message,
        docs: data.docs,
        usage: data.usage,
        debug: { llamaindex: true, ...data.debug },
      }

      console.log('📊 Retrieved documents:', {
        message,
        docsCount: docs.length,
        usage,
        debug,
        retrievalMethod: debug?.retrieval_method || 'hybrid_fusion_rrf',
      })

      // Enhanced logging for debugging
      console.log('📚 Document retrieval summary:', {
        totalDocs: docs.length,
        stage1Results: debug?.stage1_results,
        stage2Results: debug?.stage2_results,
        finalResults: docs.length,
      })

      // Log sample of documents
      docs.slice(0, 3).forEach((doc: any, idx: number) => {
        console.log(`Document ${idx + 1}:`, {
          doc_id: doc.doc_id,
          title: doc.title?.slice(0, 50),
          score: doc.score,
          kps_count: doc.kps?.length || 0,
          has_snippets: doc.kps?.some((kp: any) => kp.snippet?.length > 10),
        })
      })

      // IMPORTANT: Save ALL docs immediately (like original implementation)
      setSupportingDocs(docs)

      // Filter docs to only those with actual content for synthesis
      const validDocs = docs.filter(
        (d: any) =>
          d.kps &&
          d.kps.length > 0 &&
          d.kps.some((kp: any) => kp.snippet && kp.snippet.length > 10),
      )

      console.log('📚 Document validation for synthesis:', {
        totalRetrieved: docs.length,
        validDocs: validDocs.length,
        docsWithKps: docs.filter((d: any) => d.kps && d.kps.length > 0).length,
        docsWithSnippets: docs.filter((d: any) =>
          d.kps?.some((kp: any) => kp.snippet && kp.snippet.length > 10),
        ).length,
      })

      // Log validation details for first few docs
      docs.slice(0, 3).forEach((d: any, idx: number) => {
        console.log(`Doc ${idx + 1} validation:`, {
          doc_id: d.doc_id,
          title: d.title?.slice(0, 30),
          kpsCount: d.kps?.length,
          hasValidKPs: d.kps?.some(
            (kp: any) => kp.snippet && kp.snippet.length > 10,
          ),
          firstSnippet: d.kps?.[0]?.snippet?.slice(0, 50),
        })
      })

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
          confidence: 0.1,
        })
        return
      }

      // Step 2: Get top quality docs for synthesis (top 40%, max 6)
      const topQualityDocs = getTopQualityDocs(validDocs, 6)

      console.log('🎯 Top quality docs for synthesis:', {
        count: topQualityDocs.length,
        qualityFilter: 'top 40%',
        maxDocs: 6,
        titles: topQualityDocs.map((d: any) => d.title?.slice(0, 50)),
        scores: topQualityDocs.map((d: any) => d.score?.toFixed(3)),
      })

      // Step 3: Call synthesis API to generate answer
      console.log('🔄 Calling synthesis API with:', {
        query: query.trim().slice(0, 50),
        docsCount: topQualityDocs.length,
        docsHaveKps: topQualityDocs.every(
          (d: any) => d.kps && d.kps.length > 0,
        ),
      })

      const synthesisResponse = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), docs: topQualityDocs }),
      })

      if (!synthesisResponse.ok) {
        console.error('❌ Synthesis API error:', synthesisResponse.status)
        throw new Error(`Synthesis failed: ${synthesisResponse.status}`)
      }

      const synthesisResult = await synthesisResponse.json()

      console.log('💡 Answer synthesis result:', {
        ok: synthesisResult?.ok,
        hasSynthesis: !!synthesisResult?.synthesis,
        sentenceCount: synthesisResult?.synthesis?.sentences?.length,
        paragraphCount: synthesisResult?.synthesis?.paragraphs?.length,
        warning: synthesisResult?.synthesis?.warning,
        warningMessage: synthesisResult?.synthesis?.warningMessage,
        debug: synthesisResult?.debug,
      })

      if (synthesisResult?.synthesis) {
        console.log('✅ Synthesis completed successfully')
        console.log('📝 Answer structure:', {
          hasSentences: !!synthesisResult.synthesis.sentences,
          sentenceCount: synthesisResult.synthesis.sentences?.length,
          hasParagraphs: !!synthesisResult.synthesis.paragraphs,
          paragraphCount: synthesisResult.synthesis.paragraphs?.length,
        })

        const { sentences, paragraphs, warning, warningMessage } =
          synthesisResult.synthesis

        // Validate sentences array
        if (!Array.isArray(sentences) || sentences.length === 0) {
          console.error('❌ Invalid synthesis result: no sentences')
          setAnswer({
            sentences: ['Synthesis failed: no answer generated.'],
            inline: [],
            confidence: 0.1,
          })
          return
        }

        // Generate citations for each sentence manually (like the original implementation)
        console.log('[Citation generation] Starting citation mapping:', {
          sentenceCount: sentences.length,
          docsForCitations: validDocs.length,
          docTitles: validDocs.map((d: any) => d.title?.slice(0, 30)),
        })

        // Collect ALL available chunks/passages from ALL documents
        const allChunks: { doc: any; kp: any }[] = []
        validDocs.forEach((doc: any) => {
          ;(doc.kps || []).forEach((kp: any) => {
            if (kp.snippet && kp.snippet.length > 10) {
              allChunks.push({ doc, kp })
            }
          })
        })

        console.log(
          `[Citations] Available chunks: ${allChunks.length} from ${validDocs.length} docs`,
        )

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

          console.log(
            `[Citations] Sentence ${sentIdx}: distributing chunks ${startIdx}-${endIdx}`,
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
            console.log(
              `[Citations] Using fallback chunk for sentence ${sentIdx}`,
            )
            refs.push({
              ref: fallbackChunk.doc.ref,
              page: fallbackChunk.kp.page ?? 1,
            })
          }

          console.log(
            `[Citations] Sentence ${sentIdx}: ${refs.length} citations assigned`,
          )
          return refs
        })

        console.log('🔗 Citation generation complete:', {
          totalCitations: inline.reduce((sum, refs) => sum + refs.length, 0),
          citationsPerSentence: inline.map((refs) => refs.length),
          uniqueDocs: new Set(inline.flat().map((ref) => ref.ref)).size,
        })

        // Calculate confidence based on document coverage
        const confidence = Math.min(0.9, 0.5 + validDocs.length * 0.06)

        // Save the answer with generated citations
        const answerWithCitations = {
          sentences,
          paragraphs,
          inline,
          confidence,
          warning,
          warningMessage,
        }

        setAnswer(answerWithCitations)
        // Note: supportingDocs already set earlier with ALL docs

        console.log('💾 Answer saved successfully:', {
          sentenceCount: answerWithCitations.sentences.length,
          paragraphCount: answerWithCitations.paragraphs?.length || 0,
          inlineCount: answerWithCitations.inline.length,
          confidence: answerWithCitations.confidence.toFixed(3),
          hasWarning: !!warning,
          totalDocs: docs.length,
          validDocs: validDocs.length,
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
          confidence: 0.1,
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
        confidence: 0,
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
        <Box
          style={{
            display: 'flex',
          }}
        >
          <AnswerPanel query={query} answer={answer} />
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
            <SupportingCitations docs={supportingDocs} />
          </Box>
        </Box>
      )
    }

    return (
      <AISearchForm
        query={query}
        loading={loading}
        suggestions={suggestions}
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
          size='large'
          variant='warning'
          label=''
          caption='This feature is an early release and under evaluation. Output quality may vary and should be treated as exploratory.'
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
