/**
 * Score Distribution Analysis for Answer Mode — Passage Threshold Calibration
 *
 * For each query in the Answer mode golden set, hits the search service with a
 * wide retrieval ceiling and no floor filtering, then labels each returned
 * passage as relevant or not-relevant based on chunk_id matching against the
 * golden set ground truth (exact match or adjacent ±1 tolerance).
 *
 * Captures both the current normalized score and the raw cross-encoder logit
 * (stored in metadata.raw_score by the service) for every result.
 *
 * Output: evaluation/results/answer-score-distribution-<timestamp>.json
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env evaluation/score_distribution_analysis_answer.ts
 *
 * Prerequisites:
 *   Search service must be running on LLAMAINDEX_SERVICE_URL (default: http://127.0.0.1:8000)
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  checkPythonService,
  callPythonService,
  PYTHON_SERVICE_URL,
} from './lib/service-client'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GOLDEN_DATASET_PATH = path.join(__dirname, 'answer-golden-dataset.json')

// Wide-net params to expose the full score distribution.
// Answer mode production preset is rerank_top_n=20, max_results=20.
// We cast a much wider net here so the full relevant/non-relevant score
// distributions are visible for threshold calibration.
const MAX_RESULTS = 100
const VECTOR_TOP_K = 500
const BM25_TOP_K = 500
const RERANK_TOP_N = 100

// Adjacent chunk tolerance: chunk N±ADJACENT_TOLERANCE counts as relevant.
// Consistent with run-answer-retrieval-eval.ts.
const ADJACENT_TOLERANCE = 1

const OUTPUT_DIR = path.join(__dirname, 'results')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExpectedPassage {
  doc_id: string
  chunk_id: string
  page: number
  text_snippet: string
}

interface AnswerTestCase {
  id: string
  question: string
  query_type: string
  difficulty: string
  retrieval_ground_truth: {
    expected_passages: ExpectedPassage[]
    expected_doc_ids: string[]
  }
}

interface AnswerGoldenDataset {
  version: string
  description: string
  test_cases: AnswerTestCase[]
  metadata?: Record<string, unknown>
}

interface PassageScoreRecord {
  rank: number // 1-based position in service response (sorted by score desc)
  chunk_id: string // from metadata.chunk_id
  doc_id: string
  title: string
  page: number
  normalized_score: number // min-max normalized score returned by service as doc.score
  raw_logit: number | null // raw cross-encoder logit from metadata.raw_score (null if absent)
  is_relevant: boolean // true if chunk_id is an exact match in expected_passages
  is_adjacent_relevant: boolean // true if chunk_id is within ±ADJACENT_TOLERANCE of an expected chunk
}

interface FalseNegativeRecord {
  chunk_id: string
  doc_id: string
  page: number
}

interface QueryResult {
  query_id: string
  question: string
  query_type: string
  difficulty: string
  expected_passage_count: number
  expected_doc_count: number
  retrieved_count: number
  recall_exact_at_max: number // fraction of expected passages retrieved (exact)
  recall_adjacent_at_max: number // fraction of expected passages retrieved (exact + adjacent)
  passages: PassageScoreRecord[]
  false_negatives: FalseNegativeRecord[] // expected passages absent from results
  execution_time_ms: number
  error?: string
}

interface AnalysisOutput {
  generated_at: string
  service_url: string
  golden_dataset: string
  params: {
    max_results: number
    vector_top_k: number
    bm25_top_k: number
    rerank_top_n: number
    adjacent_tolerance: number
  }
  queries: QueryResult[]
  summary: {
    total_queries: number
    total_passages_retrieved: number
    total_relevant_retrieved_exact: number
    total_relevant_retrieved_adjacent: number
    total_expected_passages: number
    overall_recall_exact_at_max: number
    overall_recall_adjacent_at_max: number
    queries_with_errors: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse the numeric chunk index from a chunk_id string.
 * Expected format: "<doc_id>_chunk_<N>"
 * Returns null if the format doesn't match.
 */
function parseChunkIndex(chunkId: string): number | null {
  const match = chunkId.match(/_chunk_(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Build a set of chunk_ids that are considered "adjacent relevant":
 * for each expected chunk_id, add chunk indices within ±tolerance.
 */
function buildAdjacentSet(
  expectedPassages: ExpectedPassage[],
  tolerance: number,
): Set<string> {
  const adjacentSet = new Set<string>()
  for (const ep of expectedPassages) {
    const idx = parseChunkIndex(ep.chunk_id)
    if (idx === null) {
      adjacentSet.add(ep.chunk_id)
      continue
    }
    // Extract the doc prefix (everything before "_chunk_N")
    const prefix = ep.chunk_id.replace(/_chunk_\d+$/, '')
    for (let delta = -tolerance; delta <= tolerance; delta++) {
      adjacentSet.add(`${prefix}_chunk_${idx + delta}`)
    }
  }
  return adjacentSet
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Answer Mode Score Distribution Analysis ===')
  console.log(`Service:            ${PYTHON_SERVICE_URL}`)
  console.log(`Golden dataset:     ${path.basename(GOLDEN_DATASET_PATH)}`)
  console.log(
    `Max results:        ${MAX_RESULTS}  (rerank_top_n=${RERANK_TOP_N})`,
  )
  console.log(`Adjacent tolerance: ±${ADJACENT_TOLERANCE}`)
  console.log()

  // Health check
  console.log('Checking service health...')
  const healthy = await checkPythonService()
  if (!healthy) {
    console.error('ERROR: Search service is not available.')
    console.error(`Expected at ${PYTHON_SERVICE_URL}`)
    console.error(
      'Start it with: cd search-service && uv run python -m app.main',
    )
    process.exit(1)
  }
  console.log('Service is healthy.\n')

  // Load golden dataset
  const goldenData: AnswerGoldenDataset = JSON.parse(
    fs.readFileSync(GOLDEN_DATASET_PATH, 'utf-8'),
  )
  const testCases = goldenData.test_cases
  console.log(
    `Loaded ${testCases.length} test cases from ${path.basename(GOLDEN_DATASET_PATH)}\n`,
  )

  const queryResults: QueryResult[] = []

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i]
    console.log(`[${i + 1}/${testCases.length}] ${tc.id}: "${tc.question}"`)

    const start = Date.now()

    try {
      const rawDocs = await callPythonService(tc.question, 'answer', {
        vector_top_k: VECTOR_TOP_K,
        bm25_top_k: BM25_TOP_K,
        rerank_top_n: RERANK_TOP_N,
        max_results: MAX_RESULTS,
      })

      const elapsed = Date.now() - start
      console.log(`  Retrieved ${rawDocs.length} passages in ${elapsed}ms`)

      const expectedPassages = tc.retrieval_ground_truth.expected_passages
      const expectedChunkIds = new Set(expectedPassages.map((p) => p.chunk_id))
      const adjacentChunkIds = buildAdjacentSet(
        expectedPassages,
        ADJACENT_TOLERANCE,
      )

      // Track which expected chunks were retrieved
      const retrievedChunkIds = new Set<string>()

      const passages: PassageScoreRecord[] = rawDocs.map((doc, idx) => {
        const chunkId: string =
          doc.metadata?.chunk_id || doc.chunk_id || doc.doc_id
        const page: number = doc.page ?? doc.metadata?.page ?? 0
        const rawLogit: number | null =
          typeof doc.metadata?.raw_score === 'number'
            ? doc.metadata.raw_score
            : null
        const isRelevant = expectedChunkIds.has(chunkId)
        const isAdjacentRelevant = adjacentChunkIds.has(chunkId)

        retrievedChunkIds.add(chunkId)

        return {
          rank: idx + 1,
          chunk_id: chunkId,
          doc_id: doc.doc_id,
          title: doc.title,
          page,
          normalized_score: doc.score,
          raw_logit: rawLogit,
          is_relevant: isRelevant,
          is_adjacent_relevant: isAdjacentRelevant,
        }
      })

      // False negatives: expected passages not retrieved at this depth
      const falseNegatives: FalseNegativeRecord[] = expectedPassages
        .filter((ep) => !retrievedChunkIds.has(ep.chunk_id))
        .map((ep) => ({
          chunk_id: ep.chunk_id,
          doc_id: ep.doc_id,
          page: ep.page,
        }))

      const relevantExact = passages.filter((p) => p.is_relevant).length
      const relevantAdjacent = passages.filter(
        (p) => p.is_adjacent_relevant,
      ).length
      const recallExact =
        expectedPassages.length > 0
          ? relevantExact / expectedPassages.length
          : 0
      const recallAdjacent =
        expectedPassages.length > 0
          ? Math.min(relevantAdjacent / expectedPassages.length, 1)
          : 0

      console.log(
        `  Expected passages: ${expectedPassages.length}  Exact recall@${MAX_RESULTS}: ${recallExact.toFixed(2)}  Adjacent recall@${MAX_RESULTS}: ${recallAdjacent.toFixed(2)}`,
      )
      if (falseNegatives.length > 0) {
        console.log(
          `  False negatives (not in top ${MAX_RESULTS}): ${falseNegatives.map((fn) => fn.chunk_id).join(', ')}`,
        )
      }

      queryResults.push({
        query_id: tc.id,
        question: tc.question,
        query_type: tc.query_type,
        difficulty: tc.difficulty,
        expected_passage_count: expectedPassages.length,
        expected_doc_count: tc.retrieval_ground_truth.expected_doc_ids.length,
        retrieved_count: rawDocs.length,
        recall_exact_at_max: recallExact,
        recall_adjacent_at_max: recallAdjacent,
        passages,
        false_negatives: falseNegatives,
        execution_time_ms: elapsed,
      })
    } catch (err) {
      const elapsed = Date.now() - start
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`  ERROR: ${errorMsg}`)
      queryResults.push({
        query_id: tc.id,
        question: tc.question,
        query_type: tc.query_type,
        difficulty: tc.difficulty,
        expected_passage_count:
          tc.retrieval_ground_truth.expected_passages.length,
        expected_doc_count: tc.retrieval_ground_truth.expected_doc_ids.length,
        retrieved_count: 0,
        recall_exact_at_max: 0,
        recall_adjacent_at_max: 0,
        passages: [],
        false_negatives: [],
        execution_time_ms: elapsed,
        error: errorMsg,
      })
    }

    // Brief pause between queries to avoid hammering the service
    if (i < testCases.length - 1) await sleep(500)
  }

  // Compute summary stats
  const totalExpected = queryResults.reduce(
    (s, q) => s + q.expected_passage_count,
    0,
  )
  const totalRelevantExact = queryResults.reduce(
    (s, q) => s + q.passages.filter((p) => p.is_relevant).length,
    0,
  )
  const totalRelevantAdjacent = queryResults.reduce(
    (s, q) => s + q.passages.filter((p) => p.is_adjacent_relevant).length,
    0,
  )
  const totalPassagesRetrieved = queryResults.reduce(
    (s, q) => s + q.retrieved_count,
    0,
  )
  const queriesWithErrors = queryResults.filter((q) => q.error).length

  const output: AnalysisOutput = {
    generated_at: new Date().toISOString(),
    service_url: PYTHON_SERVICE_URL,
    golden_dataset: path.basename(GOLDEN_DATASET_PATH),
    params: {
      max_results: MAX_RESULTS,
      vector_top_k: VECTOR_TOP_K,
      bm25_top_k: BM25_TOP_K,
      rerank_top_n: RERANK_TOP_N,
      adjacent_tolerance: ADJACENT_TOLERANCE,
    },
    queries: queryResults,
    summary: {
      total_queries: testCases.length,
      total_passages_retrieved: totalPassagesRetrieved,
      total_relevant_retrieved_exact: totalRelevantExact,
      total_relevant_retrieved_adjacent: totalRelevantAdjacent,
      total_expected_passages: totalExpected,
      overall_recall_exact_at_max:
        totalExpected > 0 ? totalRelevantExact / totalExpected : 0,
      overall_recall_adjacent_at_max:
        totalExpected > 0
          ? Math.min(totalRelevantAdjacent / totalExpected, 1)
          : 0,
      queries_with_errors: queriesWithErrors,
    },
  }

  // Write output
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const outPath = path.join(
    OUTPUT_DIR,
    `answer-score-distribution-${Date.now()}.json`,
  )
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))

  console.log()
  console.log('=== Summary ===')
  console.log(`Total queries:             ${output.summary.total_queries}`)
  console.log(
    `Total passages retrieved:  ${output.summary.total_passages_retrieved}`,
  )
  console.log(
    `Exact recall@${MAX_RESULTS}:        ${(output.summary.overall_recall_exact_at_max * 100).toFixed(1)}%  (${output.summary.total_relevant_retrieved_exact} / ${output.summary.total_expected_passages})`,
  )
  console.log(
    `Adjacent recall@${MAX_RESULTS}:     ${(output.summary.overall_recall_adjacent_at_max * 100).toFixed(1)}%  (${output.summary.total_relevant_retrieved_adjacent} / ${output.summary.total_expected_passages})`,
  )
  if (queriesWithErrors > 0) {
    console.log(`Queries with errors:       ${queriesWithErrors}`)
  }
  console.log()
  console.log(`Output written to: ${outPath}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
