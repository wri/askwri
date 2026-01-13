/**
 * Quick evaluation runner - tests 3 representative queries
 *
 * Use this for fast iteration during development
 * Run full eval (run-cite-eval.ts) before committing changes
 *
 * Usage: npx tsx evaluation/run-cite-eval-quick.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocMeta } from '../src/lib/llamacloud';
import { filterByLLMRelevance, type RelevanceMode } from '../src/lib/llm-relevance-filter';

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
  test_id: string;
  query: string;
  expected_count: number;
  retrieved_count: number;
  precision: number;
  recall: number;
  f1: number;
  expected_urls: string[];
  retrieved_urls: string[];
  missing_urls: string[];
  extra_urls: string[];
  execution_time_ms: number;
}

// Quick test set: 3 representative queries
// Q1: Simple topic (should pass)
// Q5: Fuzzy topic (medium difficulty)
// Q9: Critical failure case (program metadata)
const QUICK_TEST_IDS = ['q1_land_value_capture', 'q5_micromobility', 'q9_world_resources_report'];

const testCases: TestCase[] = goldenData.test_cases.filter((tc: TestCase) =>
  QUICK_TEST_IDS.includes(tc.id)
);

console.log('🚀 Starting AskWRI Quick Eval (3 queries)');
console.log(`📊 Test cases: ${testCases.length}`);
console.log(`📄 Total expected documents: ${testCases.reduce((sum: number, tc: TestCase) => sum + tc.expected_count, 0)}`);
console.log('');

// Check Python service availability
async function checkPythonService(): Promise<boolean> {
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/health`);
    return response.ok;
  } catch (error) {
    return false;
  }
}

function extractUrls(docs: DocMeta[]): string[] {
  return docs.map(doc => {
    const url = doc.meta?.raw?.['Source URL'] || doc.url || '';
    return url.trim();
  }).filter(url => url.length > 0);
}

function calculateMetrics(expectedUrls: string[], retrievedUrls: string[]): {
  precision: number;
  recall: number;
  f1: number;
  missing: string[];
  extra: string[];
} {
  const expectedSet = new Set(expectedUrls);
  const retrievedSet = new Set(retrievedUrls);

  const truePositives = retrievedUrls.filter(url => expectedSet.has(url)).length;
  const falsePositives = retrievedUrls.filter(url => !expectedSet.has(url)).length;
  const falseNegatives = expectedUrls.filter(url => !retrievedSet.has(url)).length;

  const precision = retrievedUrls.length > 0 ? truePositives / retrievedUrls.length : 0;
  const recall = expectedUrls.length > 0 ? truePositives / expectedUrls.length : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  const missing = expectedUrls.filter(url => !retrievedSet.has(url));
  const extra = retrievedUrls.filter(url => !expectedSet.has(url));

  return { precision, recall, f1, missing, extra };
}

async function runTestCase(testCase: TestCase): Promise<TestResult> {
  console.log(`🔍 Testing: ${testCase.id}`);
  console.log(`   Question: ${testCase.question}`);
  console.log(`   Expected: ${testCase.expected_count} documents`);

  const startTime = Date.now();

  // Call Python service
  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: testCase.question,
      mode: 'cite',
      max_results: 80,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      vector_top_k: 500,    // Baseline
      bm25_top_k: 500,
      rerank_top_n: 60      // Baseline - with query expansion active in hybrid service
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Python service error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  // Filter by reranker score threshold
  const RERANKER_SCORE_THRESHOLD = 0.0;
  const filteredDocs = data.docs.filter((doc: any) => {
    const score = doc.score > 0 ? doc.score : (doc.metadata.raw_score || doc.score);
    return score >= RERANKER_SCORE_THRESHOLD;
  });

  // Transform to DocMeta format
  let docs: DocMeta[] = filteredDocs.map((doc: any) => {
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

  console.log(`   [Before LLM Filter] Retrieved: ${docs.length} documents`);

  // Apply LLM-based relevance filtering
  const queryForLLM = testCase.question;
  docs = await filterByLLMRelevance(queryForLLM, docs, 'moderate', 0.3); // Final test: very low threshold with gpt-4o-mini

  console.log(`   [After LLM Filter] Kept: ${docs.length} documents`);

  const executionTime = Date.now() - startTime;

  // Extract URLs
  const retrievedUrls = extractUrls(docs);

  // Calculate metrics
  const metrics = calculateMetrics(testCase.expected_urls, retrievedUrls);

  console.log(`   Retrieved: ${docs.length} documents`);
  console.log(`   Precision: ${(metrics.precision * 100).toFixed(1)}%`);
  console.log(`   Recall: ${(metrics.recall * 100).toFixed(1)}%`);
  console.log(`   F1: ${(metrics.f1 * 100).toFixed(1)}%`);
  console.log('');

  return {
    test_id: testCase.id,
    query: testCase.question,
    expected_count: testCase.expected_count,
    retrieved_count: docs.length,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    expected_urls: testCase.expected_urls,
    retrieved_urls: retrievedUrls,
    missing_urls: metrics.missing,
    extra_urls: metrics.extra,
    execution_time_ms: executionTime
  };
}

async function main() {
  // Check Python service
  console.log('🔍 Checking Python service availability...');
  const serviceAvailable = await checkPythonService();

  if (!serviceAvailable) {
    console.error('❌ Python service not available at ' + PYTHON_SERVICE_URL);
    console.error('   Please start the service with: npm run start:all');
    console.error('   Or set LLAMAINDEX_SERVICE_URL environment variable');
    process.exit(1);
  }

  console.log('✅ Python service is running');
  console.log('');

  // Run test cases
  const results: TestResult[] = [];

  for (const testCase of testCases) {
    try {
      const result = await runTestCase(testCase);
      results.push(result);
    } catch (error) {
      console.error(`❌ Error running test ${testCase.id}:`, error);
      process.exit(1);
    }
  }

  // Calculate overall metrics
  const overallPrecision = results.reduce((sum, r) => sum + r.precision, 0) / results.length;
  const overallRecall = results.reduce((sum, r) => sum + r.recall, 0) / results.length;
  const overallF1 = results.reduce((sum, r) => sum + r.f1, 0) / results.length;

  const passed = results.filter(r => r.recall >= 0.75 && r.precision >= 0.15 && r.f1 >= 0.25).length;
  const failed = results.length - passed;

  console.log('='.repeat(80));
  console.log('📊 QUICK EVAL SUMMARY');
  console.log('='.repeat(80));
  console.log(`✅ Passed: ${passed}/${results.length}`);
  console.log(`❌ Failed: ${failed}/${results.length}`);
  console.log('');
  console.log('📈 Overall Metrics:');
  console.log(`   Precision: ${(overallPrecision * 100).toFixed(1)}%`);
  console.log(`   Recall: ${(overallRecall * 100).toFixed(1)}%`);
  console.log(`   F1 Score: ${(overallF1 * 100).toFixed(1)}%`);
  console.log('');
  console.log('💡 Run full eval before committing: npx tsx evaluation/run-cite-eval.ts');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
