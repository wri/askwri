/**
 * Shared service client for AskWRI evaluation scripts.
 *
 * Provides mode-parameterized access to the hybrid retrieval service
 * and the Next.js answer API. No mode-specific filtering is applied here;
 * callers handle their own filtering logic.
 */

import { Agent, setGlobalDispatcher } from 'undici';
import type { DocMeta } from '../../src/lib/llamacloud';

// Local cite-mode queries rerank 500+ candidates on CPU and can exceed undici's
// default 300s headersTimeout; an aborted fetch leaves the service reranking a
// zombie request and cascades into concurrent slowdowns. Allow 30 min.
setGlobalDispatcher(new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 }));

export const PYTHON_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8000';
export const NEXTJS_SERVER_URL = process.env.NEXTJS_SERVER_URL || 'http://localhost:3000';

// --- Raw response from Python hybrid service ---

export interface RawServiceDoc {
  doc_id: string;
  title: string;
  content: string;
  score: number;
  page?: number;
  chunk_id?: string;
  metadata: Record<string, any>;
}

// --- Health Check ---

/**
 * Check if the Python hybrid service is available.
 */
export async function checkPythonService(): Promise<boolean> {
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/health`, { method: 'GET' });
    const data = await response.json();
    return data.status === 'healthy' || data.ok;
  } catch {
    return false;
  }
}

/**
 * Check if the Next.js server is available.
 */
export async function checkNextJsService(): Promise<boolean> {
  try {
    const response = await fetch(`${NEXTJS_SERVER_URL}/api/llamaindex`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Service Calls ---

/**
 * Call the Python hybrid retrieval service.
 * Returns raw docs without DocMeta transformation or filtering.
 */
export async function callPythonService(
  query: string,
  mode: 'answer' | 'cite',
  params?: {
    vector_top_k?: number;
    bm25_top_k?: number;
    rerank_top_n?: number;
    max_results?: number;
    dense_weight?: number;
    sparse_weight?: number;
  }
): Promise<RawServiceDoc[]> {
  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode,
      max_results: params?.max_results ?? 100,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      vector_top_k: params?.vector_top_k,
      bm25_top_k: params?.bm25_top_k,
      rerank_top_n: params?.rerank_top_n,
      dense_weight: params?.dense_weight,
      sparse_weight: params?.sparse_weight,
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Python service error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return (data.docs || []) as RawServiceDoc[];
}

/**
 * Transform a raw service doc into the DocMeta format used by the frontend.
 */
export function transformToDocMeta(raw: RawServiceDoc): DocMeta {
  const effectiveScore = raw.score > 0 ? raw.score : (raw.metadata.raw_score || raw.score);
  return {
    doc_id: raw.doc_id,
    document_id: raw.doc_id,
    ref: (raw.metadata.chunk_id || raw.doc_id).replace(/[^a-z0-9]+/gi, '_').slice(0, 64),
    title: raw.title,
    url: raw.metadata.url,
    _url: raw.metadata.file_path,
    host: undefined,
    authors: raw.metadata.authors ? raw.metadata.authors.split(';') : undefined,
    year: raw.metadata.year,
    source: raw.metadata.source,
    summary: raw.metadata.summary,
    score: effectiveScore,
    kps: [{
      kp_relevance: effectiveScore,
      snippet: raw.content,
      page: raw.page || raw.metadata.page || 1,
      passage_id: raw.metadata.chunk_id || raw.doc_id,
      citation_targets: [{
        score: effectiveScore,
        page: raw.page || raw.metadata.page || 1,
        passage_id: raw.metadata.chunk_id || raw.doc_id
      }]
    }],
    meta: { raw: raw.metadata }
  };
}

/**
 * Call the Next.js /api/answer endpoint for synthesis.
 */
export async function callAnswerAPI(
  query: string,
  docs: DocMeta[]
): Promise<{ sentences: string[]; warning?: string }> {
  const response = await fetch(`${NEXTJS_SERVER_URL}/api/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, docs })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Answer API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const synthesis = data.synthesis || {};
  return {
    sentences: synthesis.sentences || [],
    warning: synthesis.warning
  };
}
