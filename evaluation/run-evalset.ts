/**
 * Runs a generation-2 evalset (askwri-eval-review/evalsets/*.json) against a
 * deployed AskWRI instance via its public retrieval gateway.
 *
 * Scores document-level retrieval only: the gen-2 sets key on `external_id`,
 * which is exactly the `doc_id` the gateway returns. No local search service,
 * no corpus, no AWS credentials.
 *
 * Retrieval params are deliberately NOT sent — the gateway applies its own
 * deployed presets, so this measures the system as users experience it.
 *
 * Usage:
 *   npx tsx evaluation/run-evalset.ts <evalset.json> [--mode cite|answer]
 *   EVAL_TARGET=https://qa.askwri-app.org npx tsx evaluation/run-evalset.ts ...
 */

import * as fs from 'fs'
import * as path from 'path'
import { calculateSetMetrics } from './lib/metrics'

const TARGET = process.env.EVAL_TARGET || 'https://qa.askwri-app.org'
const QUERY_TIMEOUT_MS = 120_000

interface EvalCase {
  id: string
  question: string
  query_type?: string
  source_language?: string
  expected_external_ids?: string[]
  retrieval_ground_truth?: { expected_external_ids?: string[] }
}

interface CaseResult {
  test_case_id: string
  question: string
  query_type?: string
  source_language?: string
  expected_ids: string[]
  /** Expected docs absent from the target's corpus — these cap recall. */
  missing_from_corpus: string[]
  recall_ceiling: number
  retrieved_ids: string[]
  matched: string[]
  precision: number
  recall: number
  f1: number
  execution_time_ms: number
  error?: string
}

/** Gen-2 sets carry expected ids at the top level (cite) or nested (answer). */
function expectedIdsOf(tc: EvalCase): string[] {
  return (
    tc.expected_external_ids ??
    tc.retrieval_ground_truth?.expected_external_ids ??
    []
  )
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`)
  return response.json()
}

/**
 * Every external_id the target can currently return. An expected doc absent
 * here is a corpus gap, not a retrieval miss — the distinction is the
 * difference between a bug report and a data request.
 */
async function fetchCorpusIds(): Promise<Set<string>> {
  const data = await getJson(`${TARGET}/api/catalog`)
  const ids = new Set<string>()
  for (const item of data.items ?? []) {
    const filePath = item.meta?.file_path
    if (filePath) ids.add(path.basename(filePath).replace(/\.pdf$/, ''))
  }
  return ids
}

async function queryTarget(
  question: string,
  mode: 'cite' | 'answer',
): Promise<string[]> {
  const response = await fetch(`${TARGET}/api/llamaindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: question, mode }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`POST /api/llamaindex → ${response.status}`)
  }
  const data = await response.json()
  if (!data.ok) throw new Error(data.error ?? 'gateway returned ok:false')
  // Rank order is preserved; dedupe keeps the best-ranked hit per document.
  return [...new Set<string>((data.docs ?? []).map((d: any) => d.doc_id))]
}

async function runCase(
  tc: EvalCase,
  mode: 'cite' | 'answer',
  corpusIds: Set<string>,
): Promise<CaseResult> {
  const expected = expectedIdsOf(tc)
  const missing = expected.filter((id) => !corpusIds.has(id))
  const ceiling = expected.length
    ? (expected.length - missing.length) / expected.length
    : 0
  const start = Date.now()

  const base = {
    test_case_id: tc.id,
    question: tc.question,
    query_type: tc.query_type,
    source_language: tc.source_language,
    expected_ids: expected,
    missing_from_corpus: missing,
    recall_ceiling: ceiling,
  }

  try {
    const retrieved = await queryTarget(tc.question, mode)
    const m = calculateSetMetrics(expected, retrieved)
    const capped = missing.length > 0 ? ` (ceiling ${(ceiling * 100).toFixed(0)}%)` : ''
    console.log(
      `  ${tc.id.padEnd(40)} P ${(m.precision * 100).toFixed(0).padStart(3)}%  ` +
        `R ${(m.recall * 100).toFixed(0).padStart(3)}%  ` +
        `F1 ${(m.f1 * 100).toFixed(0).padStart(3)}%${capped}`,
    )
    return {
      ...base,
      retrieved_ids: retrieved,
      matched: m.matched,
      precision: m.precision,
      recall: m.recall,
      f1: m.f1,
      execution_time_ms: Date.now() - start,
    }
  } catch (error: any) {
    console.log(`  ${tc.id.padEnd(40)} ERROR: ${error.message}`)
    return {
      ...base,
      retrieved_ids: [],
      matched: [],
      precision: 0,
      recall: 0,
      f1: 0,
      execution_time_ms: Date.now() - start,
      error: error.message,
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const evalsetPath = args.find((a) => !a.startsWith('--'))
  if (!evalsetPath) {
    console.error(
      'Usage: npx tsx evaluation/run-evalset.ts <evalset.json> [--mode cite|answer]',
    )
    process.exit(1)
  }

  const evalset = JSON.parse(fs.readFileSync(evalsetPath, 'utf-8'))
  const cases: EvalCase[] = evalset.test_cases ?? []

  // Cite sets hold expected ids at the top level; answer sets nest them under
  // retrieval_ground_truth. Explicit --mode wins.
  const modeFlag = args[args.indexOf('--mode') + 1]
  const mode: 'cite' | 'answer' =
    modeFlag === 'cite' || modeFlag === 'answer'
      ? modeFlag
      : cases[0]?.retrieval_ground_truth
        ? 'answer'
        : 'cite'

  const health = await getJson(`${TARGET}/api/llamaindex`)
  const service = health.hybrid_service ?? {}
  const corpusIds = await fetchCorpusIds()

  console.log(`\nEvalset:  ${path.basename(evalsetPath)} (${cases.length} cases)`)
  console.log(`Target:   ${TARGET}  [mode: ${mode}]`)
  console.log(
    `Backend:  keyword=${service.keyword_backend} retrieval=${service.retrieval_backend} env=${service.environment}`,
  )
  console.log(`Corpus:   ${corpusIds.size} documents\n`)

  const results: CaseResult[] = []
  for (const tc of cases) {
    results.push(await runCase(tc, mode, corpusIds))
  }

  const mean = (pick: (r: CaseResult) => number) =>
    results.reduce((sum, r) => sum + pick(r), 0) / (results.length || 1)
  const ceilinged = results.filter((r) => r.missing_from_corpus.length > 0)

  const report = {
    timestamp: new Date().toISOString(),
    evalset: path.basename(evalsetPath),
    evalset_version: evalset.version,
    target: TARGET,
    mode,
    environment: service.environment ?? null,
    keyword_backend: service.keyword_backend ?? null,
    retrieval_backend: service.retrieval_backend ?? null,
    corpus_size: corpusIds.size,
    cases_total: results.length,
    cases_ceilinged: ceilinged.length,
    overall_precision: mean((r) => r.precision),
    overall_recall: mean((r) => r.recall),
    overall_f1: mean((r) => r.f1),
    mean_recall_ceiling: mean((r) => r.recall_ceiling),
    results,
  }

  const reportPath = path.join(
    __dirname,
    'results',
    `evalset-${path.basename(evalsetPath, '.json')}-${Date.now()}.json`,
  )
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(`\n${'='.repeat(72)}`)
  console.log(
    `Precision ${(report.overall_precision * 100).toFixed(1)}%   ` +
      `Recall ${(report.overall_recall * 100).toFixed(1)}%   ` +
      `F1 ${(report.overall_f1 * 100).toFixed(1)}%`,
  )
  if (ceilinged.length) {
    const missing = new Set(ceilinged.flatMap((r) => r.missing_from_corpus))
    console.log(
      `\n${ceilinged.length}/${results.length} cases capped by corpus gaps ` +
        `(mean ceiling ${(report.mean_recall_ceiling * 100).toFixed(0)}%). ` +
        `${missing.size} expected documents absent from the target:`,
    )
    for (const id of [...missing].sort()) console.log(`  - ${id}`)
  }
  console.log(`\nReport: ${path.relative(process.cwd(), reportPath)}`)
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
})
