import { NextRequest, NextResponse } from 'next/server'
import { ANSWER_PRESET, CITE_PRESET } from '@/config/retrieval'
import { extractPassage } from '@/app/utils/passage'

const SEARCH_SERVICE_URL =
  process.env.SEARCH_SERVICE_URL || 'http://localhost:8000'

interface LlamaIndexRequest {
  query: string
  mode: 'answer' | 'cite'
  max_results?: number
  similarity_threshold?: number
  include_metadata?: boolean
  rerank?: boolean
  cite_doc_ids?: string[]
  alpha?: number
  denseTopK?: number
  sparseTopK?: number
  rerankTopK?: number
  retrievalMode?: 'chunks' | 'docs' | 'hybrid'
}

interface LlamaIndexResponse {
  docs: Array<{
    doc_id: string
    title: string
    content: string
    score: number
    metadata: Record<string, any> & {
      raw_score?: number
      relevance_tier?: 'strong' | 'partial' | 'weak'
    }
    page?: number
  }>
  total_results: number
  query: string
  mode: string
  debug: Record<string, any>
  /** Dollar cost of the request's paid API calls: {calls, total_usd}. */
  usage?: Record<string, any> | null
  query_understanding?: Record<string, unknown> | null
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const {
      query: rawQuery,
      mode = 'cite',
      alpha,
      denseTopK,
      sparseTopK,
      rerankTopK,
      retrievalMode,
      ...options
    } = body
    const query = rawQuery?.trim()

    if (!query) {
      return NextResponse.json(
        { ok: false, error: 'Query parameter is required' },
        { status: 400 },
      )
    }

    console.log(`[LlamaIndex API] Processing query: "${query}" (mode: ${mode})`)

    // Prepare request for embedded service
    const defaults =
      mode === 'cite'
        ? {
            max_results: CITE_PRESET.maxResults,
            vector_top_k: CITE_PRESET.denseTopK,
            bm25_top_k: CITE_PRESET.sparseTopK,
            rerank_top_n: CITE_PRESET.rerankTopN,
            fusion_top_k: CITE_PRESET.fusionTopK,
          }
        : {
            max_results: ANSWER_PRESET.maxResults,
            vector_top_k: ANSWER_PRESET.denseTopK,
            bm25_top_k: ANSWER_PRESET.sparseTopK,
            rerank_top_n: ANSWER_PRESET.rerankTopN,
            fusion_top_k: ANSWER_PRESET.fusionTopK,
            dense_weight: ANSWER_PRESET.alpha,
            sparse_weight: 1 - (ANSWER_PRESET.alpha ?? 0.5),
          }

    const llamaIndexRequest: LlamaIndexRequest & {
      vector_top_k?: number
      bm25_top_k?: number
      rerank_top_n?: number
      fusion_top_k?: number
    } = {
      query,
      mode,
      similarity_threshold: 0.0, // Use 0.0 threshold - let hybrid fusion handle ranking
      include_metadata: true,
      rerank: true, // Enable reranking for quality results
      ...defaults,
      // Override with client-supplied retrieval params if provided
      ...(alpha !== undefined && {
        dense_weight: alpha,
        sparse_weight: 1 - alpha,
      }),
      ...(denseTopK !== undefined && { vector_top_k: denseTopK }),
      ...(sparseTopK !== undefined && { bm25_top_k: sparseTopK }),
      ...(rerankTopK !== undefined && { rerank_top_n: rerankTopK }),
      ...(retrievalMode !== undefined && { retrieval_mode: retrievalMode }),
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

    // Cite mode filtering is now handled by the search service via logit floor threshold.
    // The service drops docs below the calibrated logit floor and assigns relevance tiers.
    const filteredDocs = llamaIndexResponse.docs

    console.log(
      `[LlamaIndex API] After service-side filtering: ${filteredDocs.length} docs`,
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

      // `doc.content` is a passage window, not the chunk: strip the context and
      // the `**[...]**` markers once, here, so every downstream consumer (the
      // excerpt UI, the synthesis key_finding, why/relates prompts, translation,
      // CSV export) gets the cited passage rather than the window.
      const snippet = extractPassage(doc.content)

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
        raw_score: doc.metadata.raw_score,
        relevance_tier: doc.metadata.relevance_tier,
        kps: [
          {
            kp_relevance: effectiveScore,
            snippet,
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
      usage: llamaIndexResponse.usage ?? null,
      query_understanding: llamaIndexResponse.query_understanding ?? null,
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
