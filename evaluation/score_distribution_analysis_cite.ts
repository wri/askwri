/**
 * Score Distribution Analysis for Relevance Threshold Calibration
 *
 * For each query in the golden set, hits the search service with a high
 * max_results ceiling and no floor filtering, then labels each returned
 * document as relevant (in expected_urls) or not-relevant.
 *
 * Captures both the current normalized score and the raw cross-encoder
 * logit (stored in metadata.raw_score by the service) for every result.
 *
 * Output: evaluation/results/score-distribution-<timestamp>.json
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env evaluation/score-distribution-analysis.ts
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
import { extractUrlSlug } from './lib/metrics'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Golden dataset — use either 'golden-dataset-updated.json' or 'golden-dataset.json', etc. 
const GOLDEN_DATASET_PATH = path.join(__dirname, 'golden-dataset.json')

// Request params: cast a very wide net, no artificial floor
const MAX_RESULTS = 200 // max docs returned (deduplicated per doc_id by service)
const VECTOR_TOP_K = 800 // mirrors run-cite-eval.ts
const BM25_TOP_K = 800 // mirrors run-cite-eval.ts
const RERANK_TOP_N = 200 // rerank all 800 candidates, return top 200

const OUTPUT_DIR = path.join(__dirname, 'results')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoldenTestCase {
  id: string
  question: string
  task_description: string
  expected_urls: string[]
  expected_count: number
  difficulty: string
  query_type: string
  note?: string
}

interface GoldenDataset {
  version: string
  description: string
  test_cases: GoldenTestCase[]
}

interface DocScoreRecord {
  rank: number // 1-based position in service response (sorted by score desc)
  doc_id: string
  title: string
  url: string // from metadata.url
  normalized_score: number // min-max normalized score returned by service as doc.score
  raw_logit: number | null // raw cross-encoder logit from metadata.raw_score (null if absent)
  is_relevant: boolean // true if URL slug matches an expected_url for this query
}

interface FalseNegativeRecord {
  url: string // expected URL not returned in the top MAX_RESULTS results
  url_slug: string
}

interface QueryResult {
  query_id: string
  question: string
  query_type: string
  difficulty: string
  expected_count: number
  retrieved_count: number // how many docs the service returned
  recall_at_max: number // fraction of expected docs present in retrieved set
  docs: DocScoreRecord[]
  false_negatives: FalseNegativeRecord[] // expected docs absent from results
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
  }
  queries: QueryResult[]
  summary: {
    total_queries: number
    total_docs_retrieved: number
    total_relevant_retrieved: number
    total_expected: number
    overall_recall_at_max: number
    queries_with_errors: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Score Distribution Analysis ===')
  console.log(`Service:        ${PYTHON_SERVICE_URL}`)
  console.log(`Golden dataset: ${path.basename(GOLDEN_DATASET_PATH)}`)
  console.log(`Max results:    ${MAX_RESULTS}  (rerank_top_n=${RERANK_TOP_N})`)
  console.log()

  // Health check
  console.log('Checking service health...')
  const healthy = await checkPythonService()
  if (!healthy) {
    console.error('ERROR: Search service is not available.')
    console.error(`Expected at ${PYTHON_SERVICE_URL}`)
    console.error(
      'Start it with: cd search-service && source venv/bin/activate && uvicorn app.main:app --port 8000',
    )
    process.exit(1)
  }
  console.log('Service is healthy.\n')

  // Load golden dataset
  const goldenData: GoldenDataset = JSON.parse(
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
      // Hit service with wide params, no filtering applied here
      const rawDocs = await callPythonService(tc.question, 'cite', {
        vector_top_k: VECTOR_TOP_K,
        bm25_top_k: BM25_TOP_K,
        rerank_top_n: RERANK_TOP_N,
        max_results: MAX_RESULTS,
      })

      const elapsed = Date.now() - start
      console.log(`  Retrieved ${rawDocs.length} docs in ${elapsed}ms`)

      // Build set of expected slugs for relevance labelling
      const expectedSlugs = new Set(tc.expected_urls.map(extractUrlSlug))

      // Map returned docs to score records
      const retrievedSlugs = new Set<string>()
      const docs: DocScoreRecord[] = rawDocs.map((doc, idx) => {
        const url = doc.metadata?.url || doc.metadata?.file_path || ''
        const slug = extractUrlSlug(url)
        if (slug) retrievedSlugs.add(slug)

        const rawLogit =
          typeof doc.metadata?.raw_score === 'number'
            ? doc.metadata.raw_score
            : null

        const isRelevant = slug !== '' && expectedSlugs.has(slug)

        return {
          rank: idx + 1,
          doc_id: doc.doc_id,
          title: doc.title,
          url,
          normalized_score: doc.score,
          raw_logit: rawLogit,
          is_relevant: isRelevant,
        }
      })

      // Identify expected docs not returned at this retrieval depth
      const falseNegatives: FalseNegativeRecord[] = tc.expected_urls
        .filter((url) => !retrievedSlugs.has(extractUrlSlug(url)))
        .map((url) => ({ url, url_slug: extractUrlSlug(url) }))

      const relevantRetrieved = docs.filter((d) => d.is_relevant).length
      const recall =
        tc.expected_urls.length > 0
          ? relevantRetrieved / tc.expected_urls.length
          : 0

      console.log(
        `  Relevant retrieved: ${relevantRetrieved}/${tc.expected_urls.length}  recall@${MAX_RESULTS}=${recall.toFixed(2)}`,
      )
      if (falseNegatives.length > 0) {
        console.log(
          `  False negatives (not in top ${MAX_RESULTS}): ${falseNegatives.map((fn) => fn.url_slug).join(', ')}`,
        )
      }

      queryResults.push({
        query_id: tc.id,
        question: tc.question,
        query_type: tc.query_type,
        difficulty: tc.difficulty,
        expected_count: tc.expected_count,
        retrieved_count: rawDocs.length,
        recall_at_max: recall,
        docs,
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
        expected_count: tc.expected_count,
        retrieved_count: 0,
        recall_at_max: 0,
        docs: [],
        false_negatives: [],
        execution_time_ms: elapsed,
        error: errorMsg,
      })
    }

    // Brief pause between queries to avoid hammering the service
    if (i < testCases.length - 1) await sleep(500)
  }

  // Compute summary stats
  const totalExpected = queryResults.reduce((s, q) => s + q.expected_count, 0)
  const totalRelevantRetrieved = queryResults.reduce(
    (s, q) => s + q.docs.filter((d) => d.is_relevant).length,
    0,
  )
  const totalDocsRetrieved = queryResults.reduce(
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
    },
    queries: queryResults,
    summary: {
      total_queries: testCases.length,
      total_docs_retrieved: totalDocsRetrieved,
      total_relevant_retrieved: totalRelevantRetrieved,
      total_expected: totalExpected,
      overall_recall_at_max:
        totalExpected > 0 ? totalRelevantRetrieved / totalExpected : 0,
      queries_with_errors: queriesWithErrors,
    },
  }

  // Write output
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  const outPath = path.join(OUTPUT_DIR, `score-distribution-${Date.now()}.json`)
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))

  console.log()
  console.log('=== Summary ===')
  console.log(`Total queries:         ${output.summary.total_queries}`)
  console.log(`Total docs retrieved:  ${output.summary.total_docs_retrieved}`)
  console.log(
    `Relevant retrieved:    ${output.summary.total_relevant_retrieved} / ${output.summary.total_expected}`,
  )
  console.log(
    `Overall recall@${MAX_RESULTS}:  ${(output.summary.overall_recall_at_max * 100).toFixed(1)}%`,
  )
  if (queriesWithErrors > 0) {
    console.log(`Queries with errors:   ${queriesWithErrors}`)
  }
  console.log()
  console.log(`Output written to: ${outPath}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
