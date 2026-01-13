/* eslint-disable @typescript-eslint/no-explicit-any */
import { DocMeta, ChatResponse } from './llamacloud';

/**
 * LlamaIndex client - direct replacement for LlamaCloud with full control
 */

const LLAMAINDEX_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || "http://127.0.0.1:8002";

interface LlamaIndexQueryOptions {
  max_results?: number;
  similarity_threshold?: number;
  include_metadata?: boolean;
  rerank?: boolean;
}

async function callLlamaIndexService(query: string, mode: "answer" | "cite", options: LlamaIndexQueryOptions = {}): Promise<any> {
  const response = await fetch("/api/llamaindex", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      mode,
      ...options
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`LlamaIndex service error: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  return response.json();
}

export async function chatAnswerLlamaIndex(query: string, overrides?: Record<string, any>): Promise<ChatResponse> {
  console.log('[llamaindex-client.chatAnswer] Using direct LlamaIndex for answer mode');

  try {
    const options: LlamaIndexQueryOptions = {
      max_results: 100, // Increased for 203-doc corpus (answer mode: precision)
      similarity_threshold: 0.05, // Slightly more selective for answers
      include_metadata: true,
      rerank: true,
      ...overrides
    };

    const data = await callLlamaIndexService(query, "answer", options);

    console.log(`[llamaindex-client.chatAnswer] Retrieved ${data.docs.length} documents`);

    return {
      message: "",
      docs: data.docs,
      usage: data.usage,
      debug: {
        llamaindex: true,
        ...data.debug
      }
    };

  } catch (error: any) {
    console.error('[llamaindex-client.chatAnswer] Error:', error.message);
    throw error;
  }
}

export async function chatCiteLlamaIndex(query: string, overrides?: Record<string, any>): Promise<ChatResponse> {
  console.log('[llamaindex-client.chatCite] Using direct LlamaIndex for cite mode');

  try {
    const options: LlamaIndexQueryOptions = {
      max_results: 150, // Increased for 203-doc corpus (cite mode: recall)
      similarity_threshold: 0.0, // Include all potentially relevant documents
      include_metadata: true,
      rerank: true,
      ...overrides
    };

    const data = await callLlamaIndexService(query, "cite", options);

    console.log(`[llamaindex-client.chatCite] Retrieved ${data.docs.length} documents`);

    // For cite mode, we want maximum recall, so let's also try some variations
    if (data.docs.length < 10) {
      console.log('[llamaindex-client.chatCite] Low result count, trying broader search');

      // Try with even lower threshold
      const broaderOptions = {
        ...options,
        similarity_threshold: -0.1, // Very permissive
        max_results: 100
      };

      try {
        const broaderData = await callLlamaIndexService(query, "cite", broaderOptions);
        console.log(`[llamaindex-client.chatCite] Broader search found ${broaderData.docs.length} documents`);

        if (broaderData.docs.length > data.docs.length) {
          // Use broader results if we got more documents
          return {
            message: "",
            docs: broaderData.docs,
            usage: broaderData.usage,
            debug: {
              llamaindex: true,
              broaderSearch: true,
              ...broaderData.debug
            }
          };
        }
      } catch (error: any) {
        console.warn('[llamaindex-client.chatCite] Broader search failed:', error.message);
      }
    }

    return {
      message: "",
      docs: data.docs,
      usage: data.usage,
      debug: {
        llamaindex: true,
        ...data.debug
      }
    };

  } catch (error: any) {
    console.error('[llamaindex-client.chatCite] Error:', error.message);
    throw error;
  }
}

export async function checkLlamaIndexHealth(): Promise<boolean> {
  try {
    const response = await fetch("/api/llamaindex");
    const data = await response.json();
    return data.ok && data.python_service?.index_loaded;
  } catch (error: any) {
    console.error('[llamaindex-client.checkHealth] Health check failed:', error.message);
    return false;
  }
}