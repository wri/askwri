import { ChatResponse } from './llamacloud'

/**
 * LlamaIndex client - direct replacement for LlamaCloud with full control
 */

interface LlamaIndexQueryOptions {
  max_results?: number
  similarity_threshold?: number
  include_metadata?: boolean
  rerank?: boolean
  // Query understanding (design 2026-08-19 §4.6) — forwarded verbatim via
  // the ...options spread in route.ts. facets presence disables auto-detect.
  facets?: { facet: string; value: string }[]
  expansion?: boolean
}

async function callLlamaIndexService(
  query: string,
  mode: 'answer' | 'cite',
  options: LlamaIndexQueryOptions = {},
): Promise<any> {
  const response = await fetch('/api/llamaindex', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      mode,
      ...options,
    }),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(
      `LlamaIndex service error: ${response.status} - ${errorData.error || 'Unknown error'}`,
    )
  }

  return response.json()
}

export async function chatCiteLlamaIndex(
  query: string,
  overrides?: Record<string, any>,
): Promise<ChatResponse> {
  const options: LlamaIndexQueryOptions = {
    max_results: 40, // Increased for 203-doc corpus (cite mode: recall)
    similarity_threshold: 0.0, // Include all potentially relevant documents
    include_metadata: true,
    rerank: true,
    ...overrides,
  }

  const data = await callLlamaIndexService(query, 'cite', options)

  return {
    message: '',
    docs: data.docs,
    usage: data.usage,
    debug: {
      llamaindex: true,
      ...data.debug,
    },
    queryUnderstanding: data.query_understanding ?? null,
    likely_off_topic: data.likely_off_topic ?? false,
  }
}

export async function checkLlamaIndexHealth(): Promise<boolean> {
  try {
    const response = await fetch('/api/llamaindex')
    const data = await response.json()
    return data.ok && data.python_service?.index_loaded
  } catch (_error: any) {
    return false
  }
}
