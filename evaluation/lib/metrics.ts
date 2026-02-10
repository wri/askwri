/**
 * Shared evaluation metrics for AskWRI.
 *
 * Provides P/R/F1 calculation at multiple granularities:
 * - Set-based (generic string matching)
 * - URL-based (slug matching, used by Cite eval)
 * - Chunk-based (with adjacent tolerance, used by Answer retrieval eval)
 * - Doc-based (coarse grain, used by Answer retrieval eval)
 */

import type { MetricsResult, ChunkMetricsResult } from './types';

// --- URL Slug Helpers (extracted from run-cite-eval.ts) ---

/**
 * Extract a slug identifier from a URL for matching.
 * Handles wri.org research URLs, file URLs, and bare filenames.
 */
export function extractUrlSlug(url: string): string {
  if (!url) return '';

  let slug = url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');

  const pathParts = slug.split('/').filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1] || '';

  const cleanSlug = lastPart
    .split('?')[0]
    .replace(/\.(pdf|docx?|html?)$/i, '')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^_+|_+$/g, '');

  return cleanSlug;
}

/**
 * Normalize a URL for comparison (protocol, trailing slash, www).
 */
export function normalizeUrl(url: string): string {
  if (!url) return '';
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/^www\./, '');
}

// --- Generic Set Metrics ---

/**
 * Calculate P/R/F1 from two sets of string identifiers (exact match).
 */
export function calculateSetMetrics(expected: string[], retrieved: string[]): MetricsResult {
  if (expected.length === 0 && retrieved.length === 0) {
    return { matched: [], precision: 1, recall: 1, f1: 1, false_positives: [], false_negatives: [] };
  }
  if (expected.length === 0) {
    return { matched: [], precision: 0, recall: 1, f1: 0, false_positives: [...retrieved], false_negatives: [] };
  }

  const expectedSet = new Set(expected);
  const retrievedSet = new Set(retrieved);

  const matched = retrieved.filter(r => expectedSet.has(r));
  const tp = matched.length;
  const precision = retrieved.length > 0 ? tp / retrieved.length : 0;
  const recall = expected.length > 0 ? tp / expected.length : 0;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const false_positives = retrieved.filter(r => !expectedSet.has(r));
  const false_negatives = expected.filter(e => !retrievedSet.has(e));

  return { matched, precision, recall, f1, false_positives, false_negatives };
}

// --- URL Metrics (for Cite eval) ---

/**
 * Calculate P/R/F1 using slug-based URL matching.
 * Replaces the inline calculateMetrics in run-cite-eval.ts.
 */
export function calculateUrlMetrics(expected: string[], retrieved: string[]): MetricsResult {
  const expectedSlugs = expected.map(extractUrlSlug);
  const retrievedSlugs = retrieved.map(extractUrlSlug);

  const matched: string[] = [];
  const matchedSlugs = new Set<string>();

  for (let i = 0; i < retrieved.length; i++) {
    const retrievedSlug = retrievedSlugs[i];
    const expectedIndex = expectedSlugs.indexOf(retrievedSlug);
    if (expectedIndex !== -1) {
      matched.push(retrieved[i]);
      matchedSlugs.add(retrievedSlug);
    }
  }

  const tp = matched.length;
  const precision = retrieved.length > 0 ? tp / retrieved.length : 0;
  const recall = expected.length > 0 ? tp / expected.length : 0;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const fps = retrieved.filter((_, i) => !expectedSlugs.includes(retrievedSlugs[i]));
  const fns = expected.filter((_, i) => !matchedSlugs.has(expectedSlugs[i]));

  return { matched, precision, recall, f1, false_positives: fps, false_negatives: fns };
}

// --- Chunk Metrics (for Answer retrieval eval) ---

/**
 * Parse a chunk_id into doc_id and chunk index.
 * Format: "{doc_id}_chunk_{index}" (e.g., "doc_000042_chunk_7")
 */
function parseChunkId(chunkId: string): { docId: string; chunkIdx: number } | null {
  const match = chunkId.match(/^(.+)_chunk_(\d+)$/);
  if (!match) return null;
  return { docId: match[1], chunkIdx: parseInt(match[2], 10) };
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
  adjacentTolerance: number = 1
): ChunkMetricsResult {
  if (expected.length === 0 && retrieved.length === 0) {
    return {
      exact_matches: [], adjacent_matches: [],
      precision: 1, recall: 1, f1: 1,
      precision_with_adjacent: 1, recall_with_adjacent: 1, f1_with_adjacent: 1
    };
  }
  if (expected.length === 0) {
    return {
      exact_matches: [], adjacent_matches: [],
      precision: 0, recall: 1, f1: 0,
      precision_with_adjacent: 0, recall_with_adjacent: 1, f1_with_adjacent: 0
    };
  }

  const retrievedSet = new Set(retrieved.map(r => r.chunk_id));
  const exact_matches: string[] = [];
  const adjacent_matches: string[] = [];

  for (const exp of expected) {
    if (retrievedSet.has(exp.chunk_id)) {
      exact_matches.push(exp.chunk_id);
    } else {
      const parsed = parseChunkId(exp.chunk_id);
      if (parsed) {
        for (let delta = -adjacentTolerance; delta <= adjacentTolerance; delta++) {
          if (delta === 0) continue;
          const adjId = `${parsed.docId}_chunk_${parsed.chunkIdx + delta}`;
          if (retrievedSet.has(adjId)) {
            adjacent_matches.push(exp.chunk_id);
            break;
          }
        }
      }
    }
  }

  // Strict metrics (exact only)
  const tp = exact_matches.length;
  const precision = retrieved.length > 0 ? tp / retrieved.length : 0;
  const recall = expected.length > 0 ? tp / expected.length : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  // Lenient metrics (exact + adjacent at 0.5 weight).
  // Adjacent matches add 0.5 to TP but don't reduce FP count,
  // so precision_with_adjacent can slightly exceed strict precision
  // while recall_with_adjacent gives partial credit for near-misses.
  const tpAdj = exact_matches.length + adjacent_matches.length * 0.5;
  const precisionAdj = retrieved.length > 0 ? tpAdj / retrieved.length : 0;
  const recallAdj = expected.length > 0 ? tpAdj / expected.length : 0;
  const f1Adj = (precisionAdj + recallAdj) > 0 ? 2 * precisionAdj * recallAdj / (precisionAdj + recallAdj) : 0;

  return {
    exact_matches,
    adjacent_matches,
    precision, recall, f1,
    precision_with_adjacent: precisionAdj,
    recall_with_adjacent: recallAdj,
    f1_with_adjacent: f1Adj,
  };
}

// --- Doc Metrics (coarse grain) ---

/**
 * Calculate doc-level P/R/F1 from doc_id arrays.
 */
export function calculateDocMetrics(expected: string[], retrieved: string[]): MetricsResult {
  return calculateSetMetrics(expected, retrieved);
}

// --- Aggregation ---

/**
 * Average metrics across multiple test results.
 */
export function aggregateMetrics(results: { precision: number; recall: number; f1: number }[]): {
  avg_precision: number;
  avg_recall: number;
  avg_f1: number;
} {
  if (results.length === 0) return { avg_precision: 0, avg_recall: 0, avg_f1: 0 };
  return {
    avg_precision: results.reduce((s, r) => s + r.precision, 0) / results.length,
    avg_recall: results.reduce((s, r) => s + r.recall, 0) / results.length,
    avg_f1: results.reduce((s, r) => s + r.f1, 0) / results.length,
  };
}
