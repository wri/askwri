/**
 * Target transports for the answer-eval harness (§3.1). Two modes measure
 * the same system two ways:
 *
 * - `gateway` — the deployed Next app: `/api/llamaindex` for retrieval (its
 *   deployed presets apply — this measures the system as users experience
 *   it, run-evalset's stance) and `/api/answer` for synthesis.
 * - `direct` — the local search-service `/query` with the gateway's
 *   ANSWER_PRESET mirrored field-for-field (so both modes measure the same
 *   retrieval), plus the local app's `/api/answer`.
 *
 * Field names are read from the shipped routes, not invented: gateway docs
 * come from src/app/api/llamaindex/route.ts's response shape (kps[0].snippet,
 * meta.raw.chunk_id, debug.total_ms, usage.total_usd), direct docs from the
 * search-service QueryResponse DocumentResult (content, chunk_id).
 */
import * as path from 'path'
import { extractPassage } from '@/app/utils/passage'
import { fetchJson } from './http'
import { PassageSent, RetrievedChunk } from './types'

export interface RetrievalOutcome {
  chunks: RetrievedChunk[]
  likely_off_topic: boolean
  service_ms: number | null
  cost_usd: number | null
  /** The docs to pass VERBATIM to answer() — gateway mode: the gateway's
   * response docs unchanged; direct mode: DocumentResults mapped to the
   * same shape the gateway produces (what /api/answer consumes). */
  docs: unknown[]
}

export interface AnswerOutcome {
  ok: boolean
  status: number
  synthesis?: {
    sentences: string[]
    cites: number[][]
    source_relevance?: Array<{ doc_id: string; tier: string }>
    warning?: string
  }
  passages_sent: PassageSent[]
  debug?: any
  error?: string
}

export interface TargetClient {
  mode: 'gateway' | 'direct'
  retrieve(
    query: string,
    knobs: Record<string, unknown>,
  ): Promise<RetrievalOutcome>
  answer(
    query: string,
    docs: unknown[],
    knobs: Record<string, unknown>,
  ): Promise<AnswerOutcome>
  health(): Promise<Record<string, unknown> | null>
  catalogIds(): Promise<Set<string>>
}

// The gateway's answer-mode request to the search service, mirrored exactly:
// src/config/retrieval.ts ANSWER_PRESET (maxResults 15, dense/sparse 150,
// rerankTopN 20, fusionTopK 100, alpha 0.65 → dense_weight 0.65 / sparse
// 0.35) plus the route's fixed threshold/metadata/rerank. The route never
// sends retrieval_mode (ANSWER_PRESET.retrievalMode is UI-side only), so
// neither do we. Keep in sync with ANSWER_PRESET if it ever changes.
const ANSWER_MODE_QUERY_DEFAULTS = {
  similarity_threshold: 0.0,
  include_metadata: true,
  rerank: true,
  max_results: 15,
  vector_top_k: 150,
  bm25_top_k: 150,
  rerank_top_n: 20,
  fusion_top_k: 100,
  dense_weight: 0.65,
  sparse_weight: 0.35,
} as const

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '')

function errorText(json: any, text: string): string {
  return json?.error ?? text.slice(0, 200)
}

/** Shared /api/answer call (identical contract for both transports). */
async function answerAt(
  url: string,
  http: typeof fetchJson,
  query: string,
  docs: unknown[],
  knobs: Record<string, unknown>,
): Promise<AnswerOutcome> {
  const r = await http(url, {
    method: 'POST',
    body: { query, docs, ...knobs },
  })
  const j = r.json ?? {}
  if (!r.ok || j.ok === false) {
    return {
      ok: false,
      status: r.status,
      passages_sent: [],
      error: errorText(j, r.text),
    }
  }
  const sentences: string[] = j.synthesis?.sentences ?? []
  return {
    ok: true,
    status: r.status,
    synthesis: {
      sentences,
      // Fallback paths (no_api_key, api_error) omit cites — never assume it.
      cites: j.synthesis?.cites ?? sentences.map(() => []),
      source_relevance: j.synthesis?.source_relevance,
      warning: j.synthesis?.warning,
    },
    passages_sent: j.passages_sent ?? [],
    debug: j.debug,
  }
}

/** Catalog ids = items[].meta.file_path basenames minus .pdf (run-evalset's
 * exact parse — the evalsets' external_ids are these slugs). */
async function fetchCatalogIds(
  url: string,
  http: typeof fetchJson,
): Promise<Set<string>> {
  const r = await http(url)
  if (!r.ok) {
    throw new Error(`GET ${url} → ${r.status}: ${errorText(r.json, r.text)}`)
  }
  const ids = new Set<string>()
  for (const item of r.json?.items ?? []) {
    const filePath = item?.meta?.file_path
    if (filePath) ids.add(path.basename(filePath).replace(/\.pdf$/, ''))
  }
  return ids
}

export function gatewayTarget(
  baseUrl: string,
  http: typeof fetchJson,
): TargetClient {
  const base = trimTrailingSlash(baseUrl)
  return {
    mode: 'gateway',
    async retrieve(query, knobs) {
      const r = await http(`${base}/api/llamaindex`, {
        method: 'POST',
        body: { query, mode: 'answer', ...knobs },
      })
      if (!r.ok || r.json?.ok === false) {
        throw new Error(
          `POST ${base}/api/llamaindex → ${r.status}: ${errorText(r.json, r.text)}`,
        )
      }
      // run-evalset's field map: an absent meta.raw.chunk_id stays null
      // (kps[].passage_id falls back to the doc id — not a substitute).
      const docs: any[] = r.json.docs ?? []
      return {
        chunks: docs.map((d, i) => ({
          rank: i + 1,
          doc_id: d.doc_id,
          chunk_id: d.meta?.raw?.chunk_id ?? null,
          text: d.kps?.[0]?.snippet ?? '',
          score: d.score,
        })),
        // Verbatim — the capture stage hands these to /api/answer unchanged
        // (the AIResearchModal mirror).
        docs,
        likely_off_topic: r.json.likely_off_topic ?? false,
        service_ms: r.json.debug?.total_ms ?? null,
        cost_usd: r.json.usage?.total_usd ?? null,
      }
    },
    answer: (query, docs, knobs) =>
      answerAt(`${base}/api/answer`, http, query, docs, knobs),
    async health() {
      try {
        const r = await http(`${base}/api/llamaindex`)
        return r.ok ? (r.json?.hybrid_service ?? null) : null
      } catch {
        return null
      }
    },
    catalogIds: () => fetchCatalogIds(`${base}/api/catalog`, http),
  }
}

export function directTarget(
  searchUrl: string,
  answerUrl: string,
  http: typeof fetchJson,
): TargetClient {
  const search = trimTrailingSlash(searchUrl)
  const app = trimTrailingSlash(answerUrl)
  return {
    mode: 'direct',
    async retrieve(query, knobs) {
      const r = await http(`${search}/query`, {
        method: 'POST',
        body: {
          query,
          mode: 'answer',
          ...ANSWER_MODE_QUERY_DEFAULTS,
          ...knobs,
        },
      })
      if (!r.ok || r.json?.ok === false) {
        throw new Error(
          `POST ${search}/query → ${r.status}: ${errorText(r.json, r.text)}`,
        )
      }
      const docs: any[] = r.json.docs ?? []
      return {
        chunks: docs.map((d, i) => ({
          rank: i + 1,
          doc_id: d.doc_id,
          chunk_id: d.chunk_id ?? null,
          text: d.content ?? '',
          score: d.score,
        })),
        // /api/answer consumes the gateway's doc shape (doc_id, title,
        // kps[0].snippet/passage_id/page) — mirror the gateway's own mapping
        // so direct mode synthesizes over the same passages it would.
        docs: docs.map((d) => ({
          doc_id: d.doc_id,
          title: d.title,
          score: d.score,
          kps: [
            {
              snippet: extractPassage(d.content),
              passage_id: d.chunk_id || d.doc_id,
              page: d.page || 1,
            },
          ],
        })),
        likely_off_topic: r.json.likely_off_topic ?? false,
        service_ms: r.json.debug?.total_ms ?? null,
        cost_usd: r.json.usage?.total_usd ?? null,
      }
    },
    answer: (query, docs, knobs) =>
      answerAt(`${app}/api/answer`, http, query, docs, knobs),
    async health() {
      try {
        const r = await http(`${search}/health`)
        return r.ok ? (r.json ?? null) : null
      } catch {
        return null
      }
    },
    // The app route serves the catalog in both modes.
    catalogIds: () => fetchCatalogIds(`${app}/api/catalog`, http),
  }
}
