/**
 * Automated evaluation runner for AskWRI Cite mode
 *
 * Tests retrieval recall against golden dataset
 * Generates precision, recall, F1 metrics and detailed report
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocMeta } from '../src/lib/llamacloud';

// Configuration
const NEXTJS_SERVER_URL = process.env.NEXTJS_SERVER_URL || 'http://localhost:3000';
const PYTHON_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8002';

// Load golden dataset
const goldenDataPath = path.join(__dirname, 'golden-dataset.json');
const goldenData = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));

interface TestCase {
  id: string;
  question: string;
  task_description: string;
  expected_urls: string[];
  expected_count: number;
  difficulty: string;
  query_type: string;
  note?: string;
}

interface TestResult {
  test_case_id: string;
  question: string;
  task_description: string;
  expected_count: number;
  retrieved_count: number;
  expected_urls: string[];
  retrieved_urls: string[];
  matched_urls: string[];
  precision: number;
  recall: number;
  f1: number;
  false_positives: string[];
  false_negatives: string[];
  execution_time_ms: number;
  error?: string;
}

interface EvalReport {
  timestamp: string;
  test_cases_total: number;
  test_cases_passed: number;
  test_cases_failed: number;
  overall_precision: number;
  overall_recall: number;
  overall_f1: number;
  results: TestResult[];
  summary_by_query_type: Record<string, {
    count: number;
    avg_precision: number;
    avg_recall: number;
    avg_f1: number;
  }>;
}

/**
 * Extract the slug/identifier from a URL for matching
 * Examples:
 * - https://www.wri.org/research/synergizing-land-value-capture-tod -> synergizing-land-value-capture-tod
 * - https://files.wri.org/d8/s3fs-public/synergizing-land-value-capture-tod.pdf -> synergizing-land-value-capture-tod
 * - synergizing-land-value-capture-tod.pdf -> synergizing-land-value-capture-tod
 */
function extractUrlSlug(url: string): string {
  if (!url) return '';

  // Remove protocol and domain
  let slug = url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');

  // Extract the last meaningful part of the path
  const pathParts = slug.split('/').filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1] || '';

  // Remove file extension and query parameters
  const cleanSlug = lastPart
    .split('?')[0]  // Remove query params
    .replace(/\.(pdf|docx?|html?)$/i, '')  // Remove common extensions
    .replace(/[^a-z0-9\-]/g, '')  // Remove special chars except hyphens
    .replace(/^_+|_+$/g, '');  // Trim underscores

  return cleanSlug;
}

/**
 * Normalize URLs for comparison (handles trailing slashes, http/https, etc.)
 */
function normalizeUrl(url: string): string {
  if (!url) return '';
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .replace(/^www\./, '');
}

/**
 * Extract URLs from retrieved documents
 */
function extractUrls(docs: DocMeta[]): string[] {
  return docs
    .map(doc => doc.url || doc._url)
    .filter(Boolean)
    .map(url => url as string);
}

/**
 * Calculate precision, recall, F1 using slug-based matching
 */
function calculateMetrics(expected: string[], retrieved: string[]): {
  matched: string[];
  precision: number;
  recall: number;
  f1: number;
  false_positives: string[];
  false_negatives: string[];
} {
  // Extract slugs for comparison
  const expectedSlugs = expected.map(extractUrlSlug);
  const retrievedSlugs = retrieved.map(extractUrlSlug);

  console.log(`[Matching] Expected slugs: ${expectedSlugs.slice(0, 3).join(', ')}...`);
  console.log(`[Matching] Retrieved slugs: ${retrievedSlugs.slice(0, 3).join(', ')}...`);

  // Find matches based on slug
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

  // Calculate metrics
  const truePositives = matched.length;
  const falsePositives = retrieved.length - truePositives;
  const falseNegatives = expected.length - truePositives;

  const precision = retrieved.length > 0 ? truePositives / retrieved.length : 0;
  const recall = expected.length > 0 ? truePositives / expected.length : 0;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // Find false positives and false negatives using slug matching
  const fps = retrieved.filter((url, i) => !expectedSlugs.includes(retrievedSlugs[i]));
  const fns = expected.filter((url, i) => !matchedSlugs.has(expectedSlugs[i]));

  return {
    matched,
    precision,
    recall,
    f1,
    false_positives: fps,
    false_negatives: fns
  };
}

/**
 * Call Python service directly for evaluation
 */
async function callPythonService(query: string, params?: {
  vector_top_k?: number,
  bm25_top_k?: number,
  rerank_top_n?: number
}): Promise<DocMeta[]> {
  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      mode: 'cite',
      max_results: 100,  // Request more, filter in post-processing
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      vector_top_k: params?.vector_top_k ?? 800,   // Increased from 500 for better semantic recall
      bm25_top_k: params?.bm25_top_k ?? 800,       // Increased from 500 for better keyword recall
      rerank_top_n: params?.rerank_top_n ?? 120    // Rerank top 120 candidates
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Python service error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  // Apply "top-N with floor" filtering for precision/recall balance
  // - Keep at least MIN_DOCS (even if scores are low) to preserve recall on hard queries
  // - Keep up to MAX_DOCS if they meet the SCORE_FLOOR quality threshold
  // Analysis: This achieves 75% recall, 18.6% precision, F1=29.8% (vs baseline 73.7%/13.3%/21.4%)
  const CITE_MIN_DOCS = 12;
  const CITE_MAX_DOCS = 32;
  const CITE_SCORE_FLOOR = 0.15;

  const filteredDocs: any[] = [];
  for (let i = 0; i < data.docs.length; i++) {
    const doc = data.docs[i];
    const score = doc.score > 0 ? doc.score : (doc.metadata.raw_score || doc.score);
    if (score >= CITE_SCORE_FLOOR) {
      filteredDocs.push(doc);
      if (filteredDocs.length >= CITE_MAX_DOCS) break;
    } else if (i < CITE_MIN_DOCS) {
      // Below floor but within min docs - still include for recall
      filteredDocs.push(doc);
    }
  }

  console.log(`[Score Filter] Retrieved: ${data.docs.length}, After filtering (min=${CITE_MIN_DOCS}, max=${CITE_MAX_DOCS}, floor=${CITE_SCORE_FLOOR}): ${filteredDocs.length}`);

  // Transform to DocMeta format
  const docs = filteredDocs.map((doc: any) => {
    const effectiveScore = doc.score > 0 ? doc.score : (doc.metadata.raw_score || doc.score);
    return {
      doc_id: doc.doc_id,
      document_id: doc.doc_id,
      ref: (doc.metadata.chunk_id || doc.doc_id).replace(/[^a-z0-9]+/gi, "_").slice(0, 64),
      title: doc.title,
      url: doc.metadata.url,
      _url: doc.metadata.file_path,
      host: undefined,
      authors: doc.metadata.authors ? doc.metadata.authors.split(";") : undefined,
      year: doc.metadata.year,
      source: doc.metadata.source,
      summary: doc.metadata.summary,
      score: effectiveScore,
      kps: [{
        kp_relevance: effectiveScore,
        snippet: doc.content,
        page: doc.page || doc.metadata.page || 1,
        passage_id: doc.metadata.chunk_id || doc.doc_id,
        citation_targets: [{
          score: effectiveScore,
          page: doc.page || doc.metadata.page || 1,
          passage_id: doc.metadata.chunk_id || doc.doc_id
        }]
      }],
      meta: { raw: doc.metadata }
    };
  });

  return docs;
}

/**
 * Run a single test case
 */
async function runTestCase(testCase: TestCase): Promise<TestResult> {
  console.log(`\n🔍 Testing: ${testCase.id}`);
  console.log(`   Question: ${testCase.question}`);
  console.log(`   Task: ${testCase.task_description}`);
  console.log(`   Expected: ${testCase.expected_count} documents`);

  const startTime = Date.now();

  try {
    // Combine question and task description for full context
    const fullQuery = `${testCase.question}\n\nTask: ${testCase.task_description}`;

    // Call the Python service directly with configurable params
    const docs = await callPythonService(fullQuery); // Use default params from callPythonService (500, 500, 60)

    console.log(`   Retrieved: ${docs.length} documents`);

    const executionTime = Date.now() - startTime;

    // Extract URLs
    const retrievedUrls = extractUrls(docs);

    // Calculate metrics
    const metrics = calculateMetrics(testCase.expected_urls, retrievedUrls);

    console.log(`   Retrieved: ${retrievedUrls.length} documents`);
    console.log(`   Precision: ${(metrics.precision * 100).toFixed(1)}%`);
    console.log(`   Recall: ${(metrics.recall * 100).toFixed(1)}%`);
    console.log(`   F1: ${(metrics.f1 * 100).toFixed(1)}%`);

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
      execution_time_ms: executionTime
    };
  } catch (error: any) {
    console.error(`   ❌ Error: ${error.message}`);
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
      error: error.message
    };
  }
}

/**
 * Generate summary statistics by query type
 */
function summarizeByQueryType(results: TestResult[], testCases: TestCase[]): Record<string, any> {
  const byType: Record<string, TestResult[]> = {};

  for (const result of results) {
    const testCase = testCases.find(tc => tc.id === result.test_case_id);
    if (!testCase) continue;

    const type = testCase.query_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(result);
  }

  const summary: Record<string, any> = {};
  for (const [type, typeResults] of Object.entries(byType)) {
    const avgPrecision = typeResults.reduce((sum, r) => sum + r.precision, 0) / typeResults.length;
    const avgRecall = typeResults.reduce((sum, r) => sum + r.recall, 0) / typeResults.length;
    const avgF1 = typeResults.reduce((sum, r) => sum + r.f1, 0) / typeResults.length;

    summary[type] = {
      count: typeResults.length,
      avg_precision: avgPrecision,
      avg_recall: avgRecall,
      avg_f1: avgF1
    };
  }

  return summary;
}

/**
 * Check if Python service is available
 */
async function checkPythonService(): Promise<boolean> {
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/health`, {
      method: 'GET'
    });
    const data = await response.json();
    return data.status === 'healthy' || data.ok;
  } catch (error: any) {
    return false;
  }
}

/**
 * Main evaluation runner
 */
async function runEvaluation() {
  console.log('🚀 Starting AskWRI Cite Mode Evaluation');
  console.log(`📊 Test cases: ${goldenData.test_cases.length}`);
  console.log(`📄 Total expected documents: ${goldenData.metadata.total_expected_documents}\n`);

  // Pre-flight check
  console.log('🔍 Checking Python service availability...');
  const serviceAvailable = await checkPythonService();
  if (!serviceAvailable) {
    console.error(`❌ Python service not available at ${PYTHON_SERVICE_URL}`);
    console.error('   Please start the service with: npm run start:all');
    console.error('   Or set LLAMAINDEX_SERVICE_URL environment variable');
    process.exit(1);
  }
  console.log('✅ Python service is running\n');

  const results: TestResult[] = [];

  // Run each test case
  for (const testCase of goldenData.test_cases as TestCase[]) {
    const result = await runTestCase(testCase);
    results.push(result);

    // Add delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Calculate overall metrics
  const overallPrecision = results.reduce((sum, r) => sum + r.precision, 0) / results.length;
  const overallRecall = results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const overallF1 = results.reduce((sum, r) => sum + r.f1, 0) / results.length;

  const passed = results.filter(r => r.recall >= 0.75 && r.precision >= 0.15 && r.f1 >= 0.25).length;
  const failed = results.length - passed;

  // Generate report
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    test_cases_total: results.length,
    test_cases_passed: passed,
    test_cases_failed: failed,
    overall_precision: overallPrecision,
    overall_recall: overallRecall,
    overall_f1: overallF1,
    results,
    summary_by_query_type: summarizeByQueryType(results, goldenData.test_cases)
  };

  // Save report
  const reportPath = path.join(__dirname, 'results', `eval-report-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('📊 EVALUATION SUMMARY');
  console.log('='.repeat(80));
  console.log(`✅ Passed: ${passed}/${results.length}`);
  console.log(`❌ Failed: ${failed}/${results.length}`);
  console.log(`\n📈 Overall Metrics:`);
  console.log(`   Precision: ${(overallPrecision * 100).toFixed(1)}%`);
  console.log(`   Recall: ${(overallRecall * 100).toFixed(1)}%`);
  console.log(`   F1 Score: ${(overallF1 * 100).toFixed(1)}%`);

  console.log(`\n📁 Full report saved to: ${reportPath}`);

  return report;
}

// Run if called directly
if (require.main === module) {
  runEvaluation()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { runEvaluation, runTestCase };
