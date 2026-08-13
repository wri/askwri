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
 * Positive cases score ranking quality (average precision over the returned
 * list) and coverage (recall over the expected docs present in the target's
 * corpus). Cases expecting no documents ("Has WRI written about X?" where it
 * hasn't) are scored as abstentions and reported separately.
 *
 * Usage:
 *   npm run eval:qa                                   every set in EVALSET_DIR
 *   npx tsx evaluation/run-evalset.ts <evalset.json>   one set
 *   EVAL_TARGET=https://... npm run eval:qa            a different instance
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  averagePrecision,
  calculateSetMetrics,
  calculateUrlMetrics,
  docCoverage,
  extractUrlSlug,
} from './lib/metrics'

const TARGET = process.env.EVAL_TARGET || 'https://qa.askwri-app.org'
const QUERY_TIMEOUT_MS = 120_000

// Fixtures live in the eval-review submodule, pinned by commit so a report can
// always be traced back to the exact ground truth that produced it.
const EVALSET_DIR = path.join(__dirname, 'eval-review', 'evalsets')

interface EvalCase {
  id: string
  question: string
  query_type?: string
  source_language?: string
  expected_external_ids?: string[]
  retrieval_ground_truth?: { expected_external_ids?: string[] }
  /** Gen-1 golden set only — see the URL branch in runCase. */
  expected_urls?: string[]
}

/**
 * A case expecting no documents at all ("Has WRI written about X?" where the
 * answer is no) asks a different question of the system than a case expecting
 * a document set, and is scored differently — see CaseResult.
 */
type Polarity = 'positive' | 'negative'

interface CaseResult {
  test_case_id: string
  question: string
  query_type?: string
  source_language?: string
  polarity: Polarity
  expected_ids: string[]
  /** Expected docs absent from the target's corpus — these cap recall. */
  missing_from_corpus: string[]
  recall_ceiling: number
  retrieved_ids: string[]
  /**
   * Positive cases only. Both metrics score against the attainable expected
   * docs (those present in the target's corpus), so corpus gaps show up in
   * missing_from_corpus, not as retrieval misses. null when no expected doc
   * is attainable — nothing was measurable, and the case is excluded from
   * set-level means.
   */
  matched?: string[]
  average_precision?: number | null
  attainable_recall?: number | null
  /** How many attainable expected docs were retrieved — attainable_recall's numerator. */
  attainable_retrieved?: number | null
  /** Negative cases only: did the target correctly return nothing? */
  abstained?: boolean
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

interface RetrievedDoc {
  doc_id: string
  url: string
}

async function queryTarget(
  question: string,
  mode: 'cite' | 'answer',
): Promise<RetrievedDoc[]> {
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
  const docs: RetrievedDoc[] = []
  const seen = new Set<string>()
  for (const d of data.docs ?? []) {
    if (seen.has(d.doc_id)) continue
    seen.add(d.doc_id)
    docs.push({ doc_id: d.doc_id, url: d.url ?? '' })
  }
  return docs
}

async function runCase(
  tc: EvalCase,
  mode: 'cite' | 'answer',
  corpusIds: Set<string>,
): Promise<CaseResult> {
  // TEMPORARY: the URL branch exists only so the gen-1 English golden set
  // (evaluation/golden-dataset.json, keyed on expected_urls) can serve as the
  // regression baseline for corpus changes. Once the gen-2 evalsets have
  // expanded expected-document coverage and a committed before/after baseline
  // of their own, golden-dataset.json retires and this branch goes with it.
  // URL↔filename matching is fuzzy, so URL sets skip the corpus-gap check and
  // report raw recall (ceiling 1).
  const byUrl = (tc.expected_urls ?? []).length > 0
  const expected = byUrl ? tc.expected_urls! : expectedIdsOf(tc)
  const polarity: Polarity = expected.length === 0 ? 'negative' : 'positive'
  const missing = byUrl ? [] : expected.filter((id) => !corpusIds.has(id))
  // A negative case has no expected documents to be missing, so nothing caps
  // it — a ceiling of 0 here would read as a corpus gap that doesn't exist.
  const ceiling =
    byUrl || polarity === 'negative'
      ? 1
      : (expected.length - missing.length) / expected.length
  const start = Date.now()

  const base = {
    test_case_id: tc.id,
    question: tc.question,
    query_type: tc.query_type,
    source_language: tc.source_language,
    polarity,
    expected_ids: expected,
    missing_from_corpus: missing,
    recall_ceiling: ceiling,
  }

  try {
    const docs = await queryTarget(tc.question, mode)
    // URL sets score gateway urls with slug matching; id sets score doc_ids
    // exactly. expected_ids/retrieved_ids hold urls for URL sets.
    const retrieved = byUrl ? docs.map((d) => d.url) : docs.map((d) => d.doc_id)

    // Cite mode drops results below a calibrated score floor, so returning
    // nothing is a reachable outcome — that, not ranking quality, is what a
    // negative case measures.
    if (polarity === 'negative') {
      const abstained = retrieved.length === 0
      console.log(
        `  ${tc.id.padEnd(40)} ${
          abstained ? 'abstained' : `returned ${retrieved.length} docs`
        }`,
      )
      return {
        ...base,
        retrieved_ids: retrieved,
        abstained,
        execution_time_ms: Date.now() - start,
      }
    }

    const m = byUrl
      ? calculateUrlMetrics(expected, retrieved)
      : calculateSetMetrics(expected, retrieved)

    // Ranking metrics compare like against like: URL sets match on slugs,
    // id sets on doc_ids. Only attainable expected docs enter the
    // denominators — a corpus gap is a data request, not a retrieval miss.
    const attainable = expected.filter((e) => !missing.includes(e))
    const expectedKeys = byUrl ? attainable.map(extractUrlSlug) : attainable
    const retrievedKeys = byUrl ? retrieved.map(extractUrlSlug) : retrieved
    const retrievedKeySet = new Set(retrievedKeys)
    const hits = expectedKeys.filter((k) => retrievedKeySet.has(k)).length
    const ap =
      attainable.length > 0
        ? averagePrecision(expectedKeys, retrievedKeys)
        : null
    const aRecall = attainable.length > 0 ? hits / expectedKeys.length : null

    const capped =
      attainable.length === 0
        ? ' (all expected docs absent from corpus)'
        : missing.length > 0
          ? ` (ceiling ${(ceiling * 100).toFixed(0)}%)`
          : ''
    const pct = (v: number | null) =>
      v === null ? '  —' : `${(v * 100).toFixed(0).padStart(3)}%`
    console.log(
      `  ${tc.id.padEnd(40)} AP ${pct(ap)}  aR ${pct(aRecall)}${capped}`,
    )
    return {
      ...base,
      retrieved_ids: retrieved,
      matched: m.matched,
      average_precision: ap,
      attainable_recall: aRecall,
      attainable_retrieved: attainable.length > 0 ? hits : null,
      execution_time_ms: Date.now() - start,
    }
  } catch (error: any) {
    console.log(`  ${tc.id.padEnd(40)} ERROR: ${error.message}`)
    // A failed query proves nothing either way; count it against the target so
    // errors can't quietly improve a score. A case with nothing attainable
    // stays null — there was nothing to score even before the error.
    const scorable = expected.length - missing.length > 0
    const failure =
      polarity === 'negative'
        ? { abstained: false }
        : {
            matched: [],
            average_precision: scorable ? 0 : null,
            attainable_recall: scorable ? 0 : null,
            attainable_retrieved: scorable ? 0 : null,
          }
    return {
      ...base,
      retrieved_ids: [],
      ...failure,
      execution_time_ms: Date.now() - start,
      error: error.message,
    }
  }
}

/**
 * Mean of a per-case metric over the cases where it was measurable. null
 * values (nothing attainable) are excluded rather than counted as zero, so a
 * corpus gap can't drag a score down.
 */
function meanMeasurable(
  cases: CaseResult[],
  pick: (r: CaseResult) => number | null | undefined,
): number {
  const values = cases.map(pick).filter((v): v is number => v != null)
  return values.reduce((sum, v) => sum + v, 0) / (values.length || 1)
}

/**
 * The gen-2 sets tag every case with one of eight query types (topic_discovery,
 * geography_constrained, binary_presence, …). A run-wide mean hides which of
 * them the target is bad at; this is the breakdown that shows it.
 */
function byQueryType(results: CaseResult[]) {
  const types = [
    ...new Set(results.map((r) => r.query_type ?? 'untyped')),
  ].sort()
  return types.map((query_type) => {
    const group = results.filter(
      (r) => (r.query_type ?? 'untyped') === query_type,
    )
    const positives = group.filter((r) => r.polarity === 'positive')
    const negatives = group.filter((r) => r.polarity === 'negative')
    return {
      query_type,
      cases_positive: positives.length,
      cases_negative: negatives.length,
      map: meanMeasurable(positives, (r) => r.average_precision),
      attainable_recall: meanMeasurable(positives, (r) => r.attainable_recall),
      negatives_abstained: negatives.filter((r) => r.abstained).length,
    }
  })
}

async function runEvalset(
  evalsetPath: string,
  modeFlag: string | undefined,
  service: Record<string, any>,
  corpusIds: Set<string>,
) {
  const evalset = JSON.parse(fs.readFileSync(evalsetPath, 'utf-8'))
  const cases: EvalCase[] = evalset.test_cases ?? []

  // Cite sets hold expected ids at the top level; answer sets nest them under
  // retrieval_ground_truth. Explicit --mode wins.
  const mode: 'cite' | 'answer' =
    modeFlag === 'cite' || modeFlag === 'answer'
      ? modeFlag
      : cases[0]?.retrieval_ground_truth
        ? 'answer'
        : 'cite'

  console.log(
    `\n${path.basename(evalsetPath)} — ${cases.length} cases [mode: ${mode}]\n`,
  )

  const results: CaseResult[] = []
  for (const tc of cases) {
    results.push(await runCase(tc, mode, corpusIds))
  }

  // Positive and negative cases answer different questions, so they are
  // averaged apart: mixing them would let a growing negative batch move
  // overall_map and overall_attainable_recall on its own.
  const positives = results.filter((r) => r.polarity === 'positive')
  const negatives = results.filter((r) => r.polarity === 'negative')
  const ceilinged = results.filter((r) => r.missing_from_corpus.length > 0)
  const abstained = negatives.filter((r) => r.abstained)
  const coverage = docCoverage(positives)

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
    cases_positive: positives.length,
    cases_negative: negatives.length,
    cases_ceilinged: ceilinged.length,
    // overall_* and mean_recall_ceiling cover the positive cases only.
    overall_map: meanMeasurable(positives, (r) => r.average_precision),
    overall_attainable_recall: meanMeasurable(
      positives,
      (r) => r.attainable_recall,
    ),
    mean_recall_ceiling: meanMeasurable(positives, (r) => r.recall_ceiling),
    // Doc-level coverage, always read alongside attainable recall: a document
    // dropped from the corpus raises the recall (smaller denominator) but
    // lowers expected_docs_in_corpus, so the trade stays visible.
    expected_docs: coverage.expected,
    expected_docs_in_corpus: coverage.in_corpus,
    expected_docs_retrieved: coverage.retrieved,
    negatives_abstained: abstained.length,
    by_query_type: byQueryType(results),
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
    `${positives.length} positive   ` +
      `MAP ${(report.overall_map * 100).toFixed(1)}%   ` +
      `Attainable recall ${(report.overall_attainable_recall * 100).toFixed(1)}% ` +
      `(${coverage.in_corpus}/${coverage.expected} expected docs in corpus, ` +
      `${coverage.retrieved}/${coverage.in_corpus} retrieved)`,
  )
  if (negatives.length) {
    console.log(
      `${negatives.length} negative   ` +
        `${abstained.length}/${negatives.length} correctly returned nothing`,
    )
    for (const r of negatives.filter((n) => !n.abstained)) {
      console.log(
        `  - ${r.test_case_id}: ${r.error ?? `${r.retrieved_ids.length} docs`}`,
      )
    }
  }
  if (report.by_query_type.length > 1) {
    console.log('\nBy query type')
    for (const t of report.by_query_type) {
      const parts: string[] = []
      if (t.cases_positive) {
        parts.push(
          `${String(t.cases_positive).padStart(2)} pos  ` +
            `MAP ${(t.map * 100).toFixed(0).padStart(3)}%  ` +
            `aR ${(t.attainable_recall * 100).toFixed(0).padStart(3)}%`,
        )
      }
      if (t.cases_negative) {
        parts.push(
          `${String(t.cases_negative).padStart(2)} neg  ` +
            `abstained ${t.negatives_abstained}/${t.cases_negative}`,
        )
      }
      console.log(`  ${t.query_type.padEnd(24)} ${parts.join('   ')}`)
    }
  }
  if (ceilinged.length) {
    const missing = new Set(ceilinged.flatMap((r) => r.missing_from_corpus))
    console.log(
      `\n${ceilinged.length}/${results.length} cases capped by corpus gaps ` +
        `(mean ceiling ${(report.mean_recall_ceiling * 100).toFixed(0)}%). ` +
        `${missing.size} expected documents absent from the target:`,
    )
    for (const id of [...missing].sort()) console.log(`  - ${id}`)
  }
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`)
}

async function main() {
  const args = process.argv.slice(2)
  const explicit = args.find((a) => !a.startsWith('--'))
  const modeFlag = args[args.indexOf('--mode') + 1]

  const evalsetPaths = explicit
    ? [explicit]
    : fs
        .readdirSync(EVALSET_DIR)
        // Superseded sets stay in the submodule for provenance, named
        // `*_bkupNN.json`. They are still runnable by path, just not by default.
        .filter((f) => f.endsWith('.json') && !f.includes('_bkup'))
        .sort()
        .map((f) => path.join(EVALSET_DIR, f))

  if (evalsetPaths.length === 0) {
    console.error(
      `No evalsets in ${EVALSET_DIR} — run: git submodule update --init`,
    )
    process.exit(1)
  }

  // The target's backend and corpus are the same for every set in a run, so
  // fetch them once and report them once.
  const health = await getJson(`${TARGET}/api/llamaindex`)
  const service = health.hybrid_service ?? {}
  const corpusIds = await fetchCorpusIds()

  console.log(`\nTarget:   ${TARGET}`)
  console.log(
    `Backend:  keyword=${service.keyword_backend} retrieval=${service.retrieval_backend} env=${service.environment}`,
  )
  console.log(`Corpus:   ${corpusIds.size} documents`)

  for (const evalsetPath of evalsetPaths) {
    await runEvalset(evalsetPath, modeFlag, service, corpusIds)
  }
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
})
