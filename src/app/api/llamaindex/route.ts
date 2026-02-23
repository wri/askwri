/* eslint-disable no-console, no-plusplus */
import { NextRequest, NextResponse } from 'next/server'
import { ANSWER_PRESET } from '@/config/retrieval'

const SEARCH_SERVICE_URL =
  process.env.SEARCH_SERVICE_URL || 'http://localhost:8000'

interface LlamaIndexRequest {
  query: string
  mode: 'answer' | 'cite'
  max_results?: number
  similarity_threshold?: number
  include_metadata?: boolean
  rerank?: boolean
}

interface LlamaIndexResponse {
  docs: Array<{
    doc_id: string
    title: string
    content: string
    score: number
    metadata: Record<string, any>
    page?: number
  }>
  total_results: number
  query: string
  mode: string
  debug: Record<string, any>
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const { query: rawQuery, mode = 'cite', ...options } = body
    const query = rawQuery?.trim()

    if (!query) {
      return NextResponse.json(
        { ok: false, error: 'Query parameter is required' },
        { status: 400 },
      )
    }

    console.log(`[LlamaIndex API] Processing query: "${query}" (mode: ${mode})`)

    // Prepare request for embedded service
    // Cite mode: larger retrieval pool (800) for better recall on semantic matches
    const llamaIndexRequest: LlamaIndexRequest & {
      vector_top_k?: number
      bm25_top_k?: number
      rerank_top_n?: number
    } = {
      query,
      mode,
      similarity_threshold: 0.0, // Use 0.0 threshold - let hybrid fusion handle ranking
      include_metadata: true,
      rerank: true, // Enable reranking for quality results
      ...(mode === 'cite'
        ? {
            max_results: 100,
            vector_top_k: 800,
            bm25_top_k: 800,
            rerank_top_n: 120,
          }
        : {
            max_results: ANSWER_PRESET.maxResults,
            vector_top_k: ANSWER_PRESET.denseTopK,
            bm25_top_k: ANSWER_PRESET.sparseTopK,
            rerank_top_n: ANSWER_PRESET.rerankTopN,
          }),
      ...options,
    }

    // Call hybrid retrieval service
    const response = await fetch(`${SEARCH_SERVICE_URL}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(llamaIndexRequest),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(
        `[LlamaIndex API] Embeddings service error: ${response.status} - ${errorText}`,
      )

      return NextResponse.json(
        {
          ok: false,
          error: `Embeddings service error: ${response.status}`,
          details: errorText,
        },
        { status: response.status },
      )
    }

    const llamaIndexResponse: LlamaIndexResponse = await response.json()

    console.log(
      `[LlamaIndex API] Hybrid service returned ${llamaIndexResponse.docs?.length || 0} docs`,
    )

    // Cite mode: Apply "top-N with floor" filtering for precision/recall balance
    // - Keep at least MIN_DOCS (even if scores are low) to preserve recall on hard queries
    // - Keep up to MAX_DOCS if they meet the SCORE_FLOOR quality threshold
    // Analysis: This achieves 75% recall, 18.6% precision, F1=29.8% (vs baseline 73.7%/13.3%/21.4%)
    const CITE_MIN_DOCS = 12
    const CITE_MAX_DOCS = 32
    const CITE_SCORE_FLOOR = 0.15

    let filteredDocs: typeof llamaIndexResponse.docs
    if (mode === 'cite') {
      filteredDocs = []
      for (let i = 0; i < llamaIndexResponse.docs.length; i++) {
        const doc = llamaIndexResponse.docs[i]
        if (doc.score >= CITE_SCORE_FLOOR) {
          filteredDocs.push(doc)
          if (filteredDocs.length >= CITE_MAX_DOCS) break
        } else if (i < CITE_MIN_DOCS) {
          // Below floor but within min docs - still include for recall
          filteredDocs.push(doc)
        }
      }
    } else {
      filteredDocs = llamaIndexResponse.docs
    }

    console.log(
      `[LlamaIndex API] After filtering (${mode === 'cite' ? `min=${CITE_MIN_DOCS}, max=${CITE_MAX_DOCS}, floor=${CITE_SCORE_FLOOR}` : 'none'}): ${filteredDocs.length}/${llamaIndexResponse.docs.length} docs`,
    )

    // Transform response to match existing API format
    const docs = filteredDocs.map((doc) => {
      // Ensure score is always in valid [0, 1] range
      let effectiveScore = doc.score

      // Handle invalid scores from upstream
      if (
        typeof effectiveScore !== 'number' ||
        !Number.isFinite(effectiveScore)
      ) {
        console.warn(
          `[LlamaIndex API] Invalid score for doc ${doc.doc_id}: ${effectiveScore}, using 0`,
        )
        effectiveScore = 0
      }

      // Clamp to [0, 1] range
      effectiveScore = Math.max(0, Math.min(1, effectiveScore))

      return {
        doc_id: doc.doc_id,
        document_id: doc.doc_id,
        ref: (doc.metadata.chunk_id || doc.doc_id)
          .replace(/[^a-z0-9]+/gi, '_')
          .slice(0, 64),
        title: doc.title,
        url: doc.metadata.url,
        _url: doc.metadata.file_path,
        host: undefined,
        authors: doc.metadata.authors
          ? doc.metadata.authors.split(';')
          : undefined,
        year: doc.metadata.year,
        source: doc.metadata.source,
        summary: doc.metadata.summary,
        score: effectiveScore,
        kps: [
          {
            kp_relevance: effectiveScore,
            snippet: doc.content,
            page: doc.page || doc.metadata.page || 1,
            passage_id: doc.metadata.chunk_id || doc.doc_id,
            citation_targets: [
              {
                score: effectiveScore,
                page: doc.page || doc.metadata.page || 1,
                passage_id: doc.metadata.chunk_id || doc.doc_id,
              },
            ],
          },
        ],
        meta: { raw: doc.metadata, llamaindex: true },
      }
    })

    console.log(`[LlamaIndex API] Returning ${docs.length} documents`)

    // Return in existing API format
    return NextResponse.json({
      ok: true,
      message: '',
      docs,
      sources: docs, // For compatibility
      usage: {
        total_tokens: llamaIndexResponse.total_results * 100, // Rough estimate
      },
      debug: {
        llamaindex: true,
        service_url: SEARCH_SERVICE_URL,
        ...llamaIndexResponse.debug,
        sourcesCount: llamaIndexResponse.total_results,
        upstreamUniqueDocsCount: docs.length,
      },
    })
  } catch (error: any) {
    console.error('[LlamaIndex API] Error:', error)
    return NextResponse.json(
      {
        ok: false,
        error: 'Internal server error',
        details: error.message,
      },
      { status: 500 },
    )
  }
}

export async function GET() {
  try {
    // Health check for hybrid service
    const response = await fetch(`${SEARCH_SERVICE_URL}/health`, {
      method: 'GET',
    })
    const healthData = await response.json()

    return NextResponse.json({
      ok: true,
      service: 'LlamaIndex API Gateway (Hybrid)',
      hybrid_service: healthData,
      endpoints: {
        query: 'POST /api/llamaindex',
        health: 'GET /api/llamaindex',
      },
    })
  } catch (error: any) {
    return NextResponse.json({
      ok: false,
      service: 'LlamaIndex API Gateway (Hybrid)',
      error: 'Hybrid service unavailable',
      details: error.message,
      hybrid_service_url: SEARCH_SERVICE_URL,
    })
  }
}
