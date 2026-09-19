/**
 * Shared evaluation metrics for AskWRI.
 *
 * Provides P/R/F1 calculation at multiple granularities:
 * - Set-based (generic string matching)
 * - URL-based (slug matching, used by Cite eval)
 * - Chunk-based (with adjacent tolerance, used by Answer retrieval eval)
 * - Doc-based (coarse grain, used by Answer retrieval eval)
 */

import type { MetricsResult, ChunkMetricsResult } from './types'

// --- URL Slug Helpers (extracted from run-cite-eval.ts) ---

/**
 * Extract a slug identifier from a URL for matching.
 * Handles wri.org research URLs, file URLs, and bare filenames.
 */
export function extractUrlSlug(url: string): string {
  if (!url) return ''

  const slug = url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')

  const pathParts = slug.split('/').filter(Boolean)
  const lastPart = pathParts[pathParts.length - 1] || ''

  const cleanSlug = lastPart
    .split('?')[0]
    .replace(/\.(pdf|docx?|html?)$/i, '')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^_+|_+$/g, '')

  return cleanSlug
}

/**
 * Normalize a URL for comparison (protocol, trailing slash, www).
 */
export function normalizeUrl(url: string): string {
  if (!url) return ''
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/^www\./, '')
}

// --- Ranking Metrics ---

/**
 * Average precision of a ranked retrieval list against a set of expected ids
 * (exact match): the mean, over the expected docs, of precision at each rank
 * where one is found. Docs never retrieved contribute 0. Returns a value in
 * [0, 1]; 1 means every expected doc sits at the top of the list.
 *
 * Callers scoring against a corpus with known gaps should pass only the
 * attainable expected ids, so corpus gaps cap recall reporting, not this.
 */
export function averagePrecision(
  expected: string[],
  retrieved: string[],
): number {
  if (expected.length === 0) return 0
  const expectedSet = new Set(expected)
  const found = new Set<string>()
  let sum = 0
  for (let i = 0; i < retrieved.length; i++) {
    const id = retrieved[i]
    if (!expectedSet.has(id) || found.has(id)) continue
    found.add(id)
    sum += found.size / (i + 1)
  }
  return sum / expected.length
}

/**
 * Doc-level corpus coverage across a set of positive eval cases: how many
 * expected documents there are in total, how many of those the target's corpus
 * actually holds, and how many of the held ones were retrieved. Reported
 * alongside attainable recall so a document dropped from the corpus (which
 * raises attainable recall by shrinking its denominator) shows up as a fall in
 * in_corpus rather than passing as a retrieval improvement.
 */
export function docCoverage(
  cases: {
    expected_ids: string[]
    missing_from_corpus: string[]
    attainable_retrieved?: number | null
  }[],
): { expected: number; in_corpus: number; retrieved: number } {
  let expected = 0
  let in_corpus = 0
  let retrieved = 0
  for (const c of cases) {
    expected += c.expected_ids.length
    in_corpus += c.expected_ids.length - c.missing_from_corpus.length
    retrieved += c.attainable_retrieved ?? 0
  }
  return { expected, in_corpus, retrieved }
}

/**
 * Chunk-level coverage across eval cases, the passage-grain twin of
 * docCoverage: how many chunks are expected in total, how many sit in
 * documents the target's corpus holds, and how many of those were retrieved.
 * A case with no passage ground truth (the answer sets are being migrated to
 * it cluster by cluster) contributes nothing rather than a zero, so
 * cases_scored says how much of the set these numbers actually cover.
 */
export function chunkCoverage(
  cases: {
    expected_chunk_ids: string[]
    chunks_missing_from_corpus: string[]
    chunk_attainable_retrieved?: number | null
  }[],
): {
  cases_scored: number
  expected: number
  in_corpus: number
  retrieved: number
} {
  let cases_scored = 0
  let expected = 0
  let in_corpus = 0
  let retrieved = 0
  for (const c of cases) {
    if (c.expected_chunk_ids.length === 0) continue
    cases_scored += 1
    expected += c.expected_chunk_ids.length
    in_corpus +=
      c.expected_chunk_ids.length - c.chunks_missing_from_corpus.length
    retrieved += c.chunk_attainable_retrieved ?? 0
  }
  return { cases_scored, expected, in_corpus, retrieved }
}

// --- Generic Set Metrics ---

/**
 * Calculate P/R/F1 from two sets of string identifiers (exact match).
 */
export function calculateSetMetrics(
  expected: string[],
  retrieved: string[],
): MetricsResult {
  if (expected.length === 0 && retrieved.length === 0) {
    return {
      matched: [],
      precision: 1,
      recall: 1,
      f1: 1,
      false_positives: [],
      false_negatives: [],
    }
  }
  if (expected.length === 0) {
    return {
      matched: [],
      precision: 0,
      recall: 1,
      f1: 0,
      false_positives: [...retrieved],
      false_negatives: [],
    }
  }

  const expectedSet = new Set(expected)
  const retrievedSet = new Set(retrieved)

  const matched = retrieved.filter((r) => expectedSet.has(r))
  const tp = matched.length
  const precision = retrieved.length > 0 ? tp / retrieved.length : 0
  const recall = expected.length > 0 ? tp / expected.length : 0
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  const false_positives = retrieved.filter((r) => !expectedSet.has(r))
  const false_negatives = expected.filter((e) => !retrievedSet.has(e))

  return { matched, precision, recall, f1, false_positives, false_negatives }
}

// --- URL Metrics (for Cite eval) ---

/**
 * Calculate P/R/F1 using slug-based URL matching.
 * Replaces the inline calculateMetrics in run-cite-eval.ts.
 */
export function calculateUrlMetrics(
  expected: string[],
  retrieved: string[],
): MetricsResult {
  const expectedSlugs = expected.map(extractUrlSlug)
  const retrievedSlugs = retrieved.map(extractUrlSlug)

  const matched: string[] = []
  const matchedSlugs = new Set<string>()

  for (let i = 0; i < retrieved.length; i++) {
    const retrievedSlug = retrievedSlugs[i]
    const expectedIndex = expectedSlugs.indexOf(retrievedSlug)
    if (expectedIndex !== -1) {
      matched.push(retrieved[i])
      matchedSlugs.add(retrievedSlug)
    }
  }

  const tp = matched.length
  const precision = retrieved.length > 0 ? tp / retrieved.length : 0
  const recall = expected.length > 0 ? tp / expected.length : 0
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  const fps = retrieved.filter(
    (_, i) => !expectedSlugs.includes(retrievedSlugs[i]),
  )
  const fns = expected.filter((_, i) => !matchedSlugs.has(expectedSlugs[i]))

  return {
    matched,
    precision,
    recall,
    f1,
    false_positives: fps,
    false_negatives: fns,
  }
}

// --- Chunk Metrics (for Answer retrieval eval) ---

/**
 * Parse a chunk_id into doc_id and chunk index.
 * Format: "{doc_id}_chunk_{index}" (e.g., "doc_000042_chunk_7")
 */
function parseChunkId(
  chunkId: string,
): { docId: string; chunkIdx: number } | null {
  const match = chunkId.match(/^(.+)_chunk_(\d+)$/)
  if (!match) return null
  return { docId: match[1], chunkIdx: parseInt(match[2], 10) }
}

/**
 * Calculate chunk-level P/R/F1 with adjacent tolerance.
 *
 * Adjacent tolerance means chunk N+/-tolerance counts as a partial match (0.5 weight).
 * This handles cases where chunking boundaries split a relevant passage.
 */
export function calculateChunkMetrics(
  expected: { chunk_id: string; doc_id: string }[],
  retrieved: { chunk_id: string; doc_id: string }[],
  adjacentTolerance: number = 1,
): ChunkMetricsResult {
  if (expected.length === 0 && retrieved.length === 0) {
    return {
      exact_matches: [],
      adjacent_matches: [],
      precision: 1,
      recall: 1,
      f1: 1,
      precision_with_adjacent: 1,
      recall_with_adjacent: 1,
      f1_with_adjacent: 1,
    }
  }
  if (expected.length === 0) {
    return {
      exact_matches: [],
      adjacent_matches: [],
      precision: 0,
      recall: 1,
      f1: 0,
      precision_with_adjacent: 0,
      recall_with_adjacent: 1,
      f1_with_adjacent: 0,
    }
  }

  const retrievedSet = new Set(retrieved.map((r) => r.chunk_id))
  const exact_matches: string[] = []
  const adjacent_matches: string[] = []
  // Each retrieved chunk may be credited at most once. Seed with exact matches
  // first, then let adjacent credit claim only chunks not already spent — so a
  // single retrieved chunk can't count as both an exact match and an adjacent
  // source, nor as the adjacent source for two expected chunks (the bug that
  // let precision_with_adjacent exceed 1.0).
  const consumedRetrieved = new Set<string>()

  for (const exp of expected) {
    if (retrievedSet.has(exp.chunk_id)) {
      exact_matches.push(exp.chunk_id)
      consumedRetrieved.add(exp.chunk_id)
    }
  }

  for (const exp of expected) {
    if (retrievedSet.has(exp.chunk_id)) continue // already an exact match
    const parsed = parseChunkId(exp.chunk_id)
    if (!parsed) continue
    for (let delta = -adjacentTolerance; delta <= adjacentTolerance; delta++) {
      if (delta === 0) continue
      const adjId = `${parsed.docId}_chunk_${parsed.chunkIdx + delta}`
      if (retrievedSet.has(adjId) && !consumedRetrieved.has(adjId)) {
        adjacent_matches.push(exp.chunk_id)
        consumedRetrieved.add(adjId)
        break
      }
    }
  }

  // Strict metrics (exact only)
  const tp = exact_matches.length
  const precision = retrieved.length > 0 ? tp / retrieved.length : 0
  const recall = expected.length > 0 ? tp / expected.length : 0
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  // Lenient metrics (exact + adjacent at 0.5 weight). Each match consumes a
  // distinct retrieved chunk (see consumedRetrieved above), so
  // tpAdj <= retrieved.length and precision_with_adjacent stays in [0, 1];
  // recall_with_adjacent gives partial credit for near-misses.
  const tpAdj = exact_matches.length + adjacent_matches.length * 0.5
  const precisionAdj = retrieved.length > 0 ? tpAdj / retrieved.length : 0
  const recallAdj = expected.length > 0 ? tpAdj / expected.length : 0
  const f1Adj =
    precisionAdj + recallAdj > 0
      ? (2 * precisionAdj * recallAdj) / (precisionAdj + recallAdj)
      : 0

  return {
    exact_matches,
    adjacent_matches,
    precision,
    recall,
    f1,
    precision_with_adjacent: precisionAdj,
    recall_with_adjacent: recallAdj,
    f1_with_adjacent: f1Adj,
  }
}

/**
 * Regression tripwire: chunk P/R/F1 must stay within [0, 1]. A value above 1
 * means adjacency credit double-counted a retrieved chunk (the ans_008/ans_009
 * bug). Call at each eval site so a future reintroduction fails loudly instead
 * of silently reporting >100% precision.
 */
export function assertChunkMetricsValid(
  m: ChunkMetricsResult,
  label: string,
): void {
  const EPS = 1e-9
  const keys = [
    'precision',
    'recall',
    'f1',
    'precision_with_adjacent',
    'recall_with_adjacent',
    'f1_with_adjacent',
  ] as const
  for (const key of keys) {
    const v = m[key]
    if (v > 1 + EPS || v < -EPS) {
      throw new Error(
        `chunk metric ${key}=${v} out of [0,1] for ${label} — adjacency double-count regression?`,
      )
    }
  }
}

// --- Doc Metrics (coarse grain) ---

/**
 * Calculate doc-level P/R/F1 from doc_id arrays.
 */
export function calculateDocMetrics(
  expected: string[],
  retrieved: string[],
): MetricsResult {
  return calculateSetMetrics(expected, retrieved)
}

// --- Latency ---

/**
 * Mean and nearest-rank p50/p95 of a set of latency samples, in ms. Callers
 * pass successful cases only — a timed-out case measures the timeout setting,
 * not the system. Returns null when there is nothing to summarize.
 */
export function latencySummary(
  values: number[],
): { mean_ms: number; p50_ms: number; p95_ms: number } | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const nearestRank = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]
  return {
    mean_ms: values.reduce((s, v) => s + v, 0) / values.length,
    p50_ms: nearestRank(0.5),
    p95_ms: nearestRank(0.95),
  }
}

// --- Aggregation ---

/**
 * Average metrics across multiple test results.
 */
export function aggregateMetrics(
  results: { precision: number; recall: number; f1: number }[],
): {
  avg_precision: number
  avg_recall: number
  avg_f1: number
} {
  if (results.length === 0)
    return { avg_precision: 0, avg_recall: 0, avg_f1: 0 }
  return {
    avg_precision:
      results.reduce((s, r) => s + r.precision, 0) / results.length,
    avg_recall: results.reduce((s, r) => s + r.recall, 0) / results.length,
    avg_f1: results.reduce((s, r) => s + r.f1, 0) / results.length,
  }
}
