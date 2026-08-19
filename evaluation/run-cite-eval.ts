/**
 * Automated evaluation runner for AskWRI Cite mode
 *
 * Tests retrieval recall against golden dataset
 * Generates precision, recall, F1 metrics and detailed report
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { DocMeta } from '../src/lib/llamacloud'
import {
  callPythonService as callPythonServiceRaw,
  callPythonServiceFull,
  transformToDocMeta,
  PYTHON_SERVICE_URL,
} from './lib/service-client'
import { calculateUrlMetrics, extractUrlSlug } from './lib/metrics'
import { classifyDisplacement } from './lib/lane-attribution'

// Lane-attribution mode (P2 displacement instrument). OFF by default so the
// default runner stays byte-identical to the instrument that produced the
// P0/P1 baselines. Attribution runs are DIAGNOSTIC — never compare their
// P/R/F1 against a non-attribution baseline (measured-change discipline);
// use a distinct EVAL_LABEL so checkpoints don't mix.
const LANE_ATTRIBUTION = process.env.EVAL_LANE_ATTRIBUTION === '1'

// Load golden dataset
const goldenDataPath = path.join(__dirname, 'golden-dataset.json')
const goldenDataRaw = fs.readFileSync(goldenDataPath, 'utf-8')
const goldenData = JSON.parse(goldenDataRaw)
const goldenSetHash = crypto
  .createHash('sha256')
  .update(goldenDataRaw)
  .digest('hex')
const evalLabel = process.env.EVAL_LABEL ?? null

interface TestCase {
  id: string
  question: string
  task_description: string
  expected_urls: string[]
  expected_count: number
  difficulty: string
  query_type: string
  note?: string
}

interface TestResult {
  test_case_id: string
  question: string
  task_description: string
  expected_count: number
  retrieved_count: number
  expected_urls: string[]
  retrieved_urls: string[]
  matched_urls: string[]
  precision: number
  recall: number
  f1: number
  false_positives: string[]
  false_negatives: string[]
  execution_time_ms: number
  error?: string
  lane_attribution?: any[]
  alias_lane_size?: number | null
  lane_contribution?: Record<string, number>
}

interface ServiceHealth {
  keyword_backend: string | null
  retrieval_backend: string | null
}

interface CheckpointIdentity {
  goldenSetHash: string
  serviceIdentity: string | null
  label: string | null
}

interface CheckpointFile {
  identity?: CheckpointIdentity
  results?: Record<string, TestResult>
}

interface EvalReport {
  timestamp: string
  label: string | null
  keyword_backend: string | null
  retrieval_backend: string | null
  test_cases_total: number
  test_cases_passed: number
  test_cases_failed: number
  overall_precision: number
  overall_recall: number
  overall_f1: number
  results: TestResult[]
  summary_by_query_type: Record<
    string,
    {
      count: number
      avg_precision: number
      avg_recall: number
      avg_f1: number
    }
  >
}

/**
 * Extract URLs from retrieved documents
 */
function extractUrls(docs: DocMeta[]): string[] {
  return docs
    .map((doc) => doc.url || doc._url)
    .filter(Boolean)
    .map((url) => url as string)
}

/**
 * Fetch /health and extract the service's backend identity.
 * Fails fast if /health is unreachable or the service is not healthy:
 * checkpoint identity and report provenance depend on knowing the backend.
 */
async function fetchServiceHealth(): Promise<ServiceHealth> {
  let data: any
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/health`, {
      method: 'GET',
    })
    data = await response.json()
  } catch (error: any) {
    console.error(
      `FATAL: /health unreachable at ${PYTHON_SERVICE_URL} (${error.message})`,
    )
    console.error(
      'Cannot verify the service backend identity. Start the service first:',
    )
    console.error('  npm run search-service   (or set LLAMAINDEX_SERVICE_URL)')
    process.exit(1)
  }
  if (data.status !== 'healthy' && !data.ok) {
    console.error(
      `FATAL: service at ${PYTHON_SERVICE_URL} reports status "${data.status}" — not ready`,
    )
    process.exit(1)
  }
  return {
    keyword_backend: data.keyword_backend ?? null,
    retrieval_backend: data.retrieval_backend ?? null,
  }
}

/**
 * Call Python service with Cite mode parameters and filtering.
 * Wraps the shared service client with cite-specific config.
 */
async function callCiteService(
  query: string,
  params?: {
    vector_top_k?: number
    bm25_top_k?: number
    rerank_top_n?: number
  },
): Promise<DocMeta[]> {
  // Service now handles logit floor filtering and tier assignment
  const rawDocs = await callPythonServiceRaw(query, 'cite', {
    vector_top_k: params?.vector_top_k ?? 800,
    bm25_top_k: params?.bm25_top_k ?? 800,
    rerank_top_n: params?.rerank_top_n ?? 500,
    max_results: 100,
  })

  console.log(
    `[Cite Service] Retrieved: ${rawDocs.length} docs (logit floor applied by service)`,
  )

  return rawDocs.map(transformToDocMeta)
}

/**
 * Run a single test case
 */
async function runTestCase(testCase: TestCase): Promise<TestResult> {
  console.log(`\n  Testing: ${testCase.id}`)
  console.log(`   Question: ${testCase.question}`)
  console.log(`   Task: ${testCase.task_description}`)
  console.log(`   Expected: ${testCase.expected_count} documents`)

  const startTime = Date.now()

  try {
    // Combine question and task description for full context
    const fullQuery = `${testCase.question}\n\nTask: ${testCase.task_description}`

    let docs: DocMeta[]
    let fullResponse: any = null
    if (LANE_ATTRIBUTION) {
      fullResponse = await callPythonServiceFull(fullQuery, 'cite', {
        vector_top_k: 800,
        bm25_top_k: 800,
        rerank_top_n: 500,
        max_results: 100,
        return_intermediate_results: true,
      })
      docs = (fullResponse.docs || []).map(transformToDocMeta)
    } else {
      docs = await callCiteService(fullQuery)
    }

    console.log(`   Retrieved: ${docs.length} documents`)

    const executionTime = Date.now() - startTime

    // Extract URLs
    const retrievedUrls = extractUrls(docs)

    // Calculate metrics using shared URL metrics
    const expectedSlugs = testCase.expected_urls.map(extractUrlSlug)
    const retrievedSlugs = retrievedUrls.map(extractUrlSlug)
    console.log(
      `[Matching] Expected slugs: ${expectedSlugs.slice(0, 3).join(', ')}...`,
    )
    console.log(
      `[Matching] Retrieved slugs: ${retrievedSlugs.slice(0, 3).join(', ')}...`,
    )

    const metrics = calculateUrlMetrics(testCase.expected_urls, retrievedUrls)

    console.log(`   Retrieved: ${retrievedUrls.length} documents`)
    console.log(`   Precision: ${(metrics.precision * 100).toFixed(1)}%`)
    console.log(`   Recall: ${(metrics.recall * 100).toFixed(1)}%`)
    console.log(`   F1: ${(metrics.f1 * 100).toFixed(1)}%`)

    return {
      test_case_id: testCase.id,
      question: testCase.question,
      task_description: testCase.task_description,
      expected_count: testCase.expected_count,
      retrieved_count: retrievedUrls.length,
      expected_urls: testCase.expected_urls,
      retrieved_urls: retrievedUrls,
      matched_urls: metrics.matched,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
      false_positives: metrics.false_positives,
      false_negatives: metrics.false_negatives,
      execution_time_ms: executionTime,
      ...(LANE_ATTRIBUTION
        ? {
            lane_attribution: classifyDisplacement(
              metrics.false_negatives,
              fullResponse?.debug?.fused_nodes ?? [],
              fullResponse?.debug?.rerank_window_ids ?? [],
            ),
            alias_lane_size: fullResponse?.debug?.alias_lane_size ?? null,
            lane_contribution: (() => {
              const lanesFor = new Map<string, Record<string, number | null>>(
                (fullResponse?.debug?.fused_nodes ?? []).map(
                  (n: any) => [n.node_id, n.lanes ?? {}],
                ),
              )
              const contribution: Record<string, number> = {}
              for (const raw of fullResponse?.docs ?? []) {
                const lanes = lanesFor.get(raw.chunk_id) ?? {}
                for (const [name, rank] of Object.entries(lanes)) {
                  if (rank != null)
                    contribution[name] = (contribution[name] || 0) + 1
                }
              }
              return contribution
            })(),
          }
        : {}),
    }
  } catch (error: any) {
    console.error(`   Error: ${error.message}`)
    return {
      test_case_id: testCase.id,
      question: testCase.question,
      task_description: testCase.task_description,
      expected_count: testCase.expected_count,
      retrieved_count: 0,
      expected_urls: testCase.expected_urls,
      retrieved_urls: [],
      matched_urls: [],
      precision: 0,
      recall: 0,
      f1: 0,
      false_positives: [],
      false_negatives: testCase.expected_urls,
      execution_time_ms: Date.now() - startTime,
      error: error.message,
    }
  }
}

/**
 * Generate summary statistics by query type
 */
function summarizeByQueryType(
  results: TestResult[],
  testCases: TestCase[],
): Record<string, any> {
  const byType: Record<string, TestResult[]> = {}

  for (const result of results) {
    const testCase = testCases.find((tc) => tc.id === result.test_case_id)
    if (!testCase) continue

    const type = testCase.query_type
    if (!byType[type]) byType[type] = []
    byType[type].push(result)
  }

  const summary: Record<string, any> = {}
  for (const [type, typeResults] of Object.entries(byType)) {
    const avgPrecision =
      typeResults.reduce((sum, r) => sum + r.precision, 0) / typeResults.length
    const avgRecall =
      typeResults.reduce((sum, r) => sum + r.recall, 0) / typeResults.length
    const avgF1 =
      typeResults.reduce((sum, r) => sum + r.f1, 0) / typeResults.length

    summary[type] = {
      count: typeResults.length,
      avg_precision: avgPrecision,
      avg_recall: avgRecall,
      avg_f1: avgF1,
    }
  }

  return summary
}

/**
 * Main evaluation runner
 */
async function runEvaluation() {
  console.log('Starting AskWRI Cite Mode Evaluation')
  console.log(`Test cases: ${goldenData.test_cases.length}`)
  console.log(
    `Total expected documents: ${goldenData.metadata.total_expected_documents}\n`,
  )

  // Pre-flight check: verify the service is up AND capture its backend identity.
  console.log('Checking Python service availability...')
  const serviceHealth = await fetchServiceHealth()
  console.log(
    `Python service is running (keyword_backend=${serviceHealth.keyword_backend}, retrieval_backend=${serviceHealth.retrieval_backend})\n`,
  )

  const results: TestResult[] = []

  // Resume support: each completed query is checkpointed so an interrupted run
  // (session limit, crash) only re-pays the queries it hasn't finished.
  // The checkpoint is stamped with an identity (golden-set hash, service backend,
  // label): resuming under a different identity would silently mix runs, so a
  // mismatch discards the checkpoint and starts fresh.
  const checkpointPath = path.join(
    __dirname,
    'results',
    'cite-eval-checkpoint.json',
  )
  const checkpointIdentity: CheckpointIdentity = {
    goldenSetHash,
    serviceIdentity: serviceHealth.keyword_backend,
    label: evalLabel,
  }
  let checkpoint: Record<string, TestResult> = {}
  if (fs.existsSync(checkpointPath)) {
    const stored: CheckpointFile = JSON.parse(
      fs.readFileSync(checkpointPath, 'utf-8'),
    )
    if (
      JSON.stringify(stored.identity ?? null) ===
      JSON.stringify(checkpointIdentity)
    ) {
      checkpoint = stored.results ?? {}
    } else {
      console.log(
        'Checkpoint identity mismatch — golden set, service backend, or label changed.',
      )
      console.log(`  stored:  ${JSON.stringify(stored.identity ?? null)}`)
      console.log(`  current: ${JSON.stringify(checkpointIdentity)}`)
      console.log('Discarding the old checkpoint and starting fresh.\n')
    }
  }
  const saveCheckpoint = () => {
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true })
    const tmpPath = `${checkpointPath}.tmp`
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(
        { identity: checkpointIdentity, results: checkpoint },
        null,
        2,
      ),
    )
    fs.renameSync(tmpPath, checkpointPath)
  }
  const resumed = Object.values(checkpoint).filter((r) => !r.error).length
  if (resumed > 0) {
    console.log(
      `Resuming from checkpoint: ${resumed} completed queries will be skipped\n`,
    )
  }

  // Run each test case. Reuse is keyed by the CURRENT golden set's ids: only
  // checkpoint entries whose id exists in goldenData.test_cases are consulted.
  for (const testCase of goldenData.test_cases as TestCase[]) {
    const prior = checkpoint[testCase.id]
    if (prior && !prior.error) {
      console.log(`\n  Skipping (checkpointed): ${testCase.id}`)
      results.push(prior)
      continue
    }
    const result = await runTestCase(testCase)
    results.push(result)
    checkpoint[testCase.id] = result
    saveCheckpoint()

    // Add delay between requests to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  // Calculate overall metrics
  const overallPrecision =
    results.reduce((sum, r) => sum + r.precision, 0) / results.length
  const overallRecall =
    results.reduce((sum, r) => sum + r.recall, 0) / results.length
  const overallF1 = results.reduce((sum, r) => sum + r.f1, 0) / results.length

  const passed = results.filter(
    (r) => r.recall >= 0.75 && r.precision >= 0.15 && r.f1 >= 0.25,
  ).length
  const failed = results.length - passed

  // Generate report
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    label: evalLabel,
    keyword_backend: serviceHealth.keyword_backend,
    retrieval_backend: serviceHealth.retrieval_backend,
    test_cases_total: results.length,
    test_cases_passed: passed,
    test_cases_failed: failed,
    overall_precision: overallPrecision,
    overall_recall: overallRecall,
    overall_f1: overallF1,
    results,
    summary_by_query_type: summarizeByQueryType(results, goldenData.test_cases),
  }

  // Save report
  const reportPath = path.join(
    __dirname,
    'results',
    `eval-report-${evalLabel ? `${evalLabel}-` : ''}${Date.now()}.json`,
  )
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  // Completed run: clear the checkpoint only if every query succeeded, so a
  // rerun retries failures instead of starting over.
  if (results.every((r) => !r.error) && fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath)
  }

  // Print summary
  console.log('\n' + '='.repeat(80))
  console.log('EVALUATION SUMMARY')
  console.log('='.repeat(80))
  console.log(`Passed: ${passed}/${results.length}`)
  console.log(`Failed: ${failed}/${results.length}`)
  console.log(`\nOverall Metrics:`)
  console.log(`   Precision: ${(overallPrecision * 100).toFixed(1)}%`)
  console.log(`   Recall: ${(overallRecall * 100).toFixed(1)}%`)
  console.log(`   F1 Score: ${(overallF1 * 100).toFixed(1)}%`)

  console.log(`\nFull report saved to: ${reportPath}`)

  // Per-query errors must fail the run: exiting 0 on a partial result would
  // poison downstream comparisons. The checkpoint is preserved (it is only
  // cleared above when every query succeeded), so a re-run resumes and
  // retries exactly the errored queries.
  const errored = results.filter((r) => r.error)
  if (errored.length > 0) {
    console.error(
      `\n${errored.length} test case(s) errored: ${errored.map((r) => r.test_case_id).join(', ')}`,
    )
    console.error('Checkpoint preserved — re-run to retry the errored queries.')
    process.exit(1)
  }

  return report
}

// Run if called directly
if (require.main === module) {
  runEvaluation()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error)
      process.exit(1)
    })
}

export { runEvaluation, runTestCase }
