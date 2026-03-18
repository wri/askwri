/**
 * Quick eval WITHOUT LLM filter to test hypothesis
 *
 * Hypothesis: LLM filter is removing good docs, hurting recall more than helping precision
 * Expected: Recall improves from 52.5% to ~82%, precision may stay similar or improve
 */
import * as fs from 'fs';
import * as path from 'path';

const PYTHON_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8000';

const goldenDataPath = path.join(__dirname, '../golden-dataset.json');
const goldenData = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));

interface TestCase {
  id: string;
  question: string;
  task_description: string;
  expected_urls: string[];
  expected_count: number;
}

function extractUrlSlug(url: string): string {
  if (!url) return '';
  let slug = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const pathParts = slug.split('/').filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1] || '';
  return lastPart.split('?')[0].replace(/\.(pdf|docx?|html?)$/i, '').replace(/[^a-z0-9\-]/g, '').replace(/^_+|_+$/g, '');
}

function calculateMetrics(expected: string[], retrieved: string[]) {
  const expectedSlugs = expected.map(extractUrlSlug);
  const retrievedSlugs = retrieved.map(extractUrlSlug);

  const matched: string[] = [];
  for (let i = 0; i < retrieved.length; i++) {
    if (expectedSlugs.includes(retrievedSlugs[i])) {
      matched.push(retrieved[i]);
    }
  }

  const precision = retrieved.length > 0 ? matched.length / retrieved.length : 0;
  const recall = expected.length > 0 ? matched.length / expected.length : 0;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1, matched: matched.length };
}

async function callPythonService(query: string) {
  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'cite',
      max_results: 80,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      vector_top_k: 500,
      bm25_top_k: 500,
      rerank_top_n: 120
    })
  });

  if (!response.ok) throw new Error(`Service error: ${response.status}`);
  const data = await response.json();
  return data.docs || [];
}

async function runTestCase(testCase: TestCase) {
  const fullQuery = `${testCase.question}\n\nTask: ${testCase.task_description}`;
  const docs = await callPythonService(fullQuery);

  const retrievedUrls = docs.map((d: any) => d.metadata?.url || d.metadata?.file_path).filter(Boolean);
  const metrics = calculateMetrics(testCase.expected_urls, retrievedUrls);

  console.log(`${testCase.id}: P=${(metrics.precision*100).toFixed(0)}% R=${(metrics.recall*100).toFixed(0)}% (${retrievedUrls.length} docs)`);

  return { ...metrics, retrieved_count: retrievedUrls.length };
}

async function main() {
  console.log('🚀 EVAL WITHOUT LLM FILTER\n');

  const results = [];
  for (const tc of goldenData.test_cases as TestCase[]) {
    const result = await runTestCase(tc);
    results.push(result);
    await new Promise(r => setTimeout(r, 1000));
  }

  const avgPrecision = results.reduce((s, r) => s + r.precision, 0) / results.length;
  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const avgF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;

  console.log('\n📊 RESULTS (NO FILTER):');
  console.log(`Precision: ${(avgPrecision*100).toFixed(1)}%`);
  console.log(`Recall: ${(avgRecall*100).toFixed(1)}%`);
  console.log(`F1: ${(avgF1*100).toFixed(1)}%`);

  console.log('\n📊 COMPARISON TO WITH-FILTER:');
  console.log(`Recall: 52.5% → ${(avgRecall*100).toFixed(1)}% (${avgRecall > 0.525 ? '✅ BETTER' : '❌ WORSE'})`);
  console.log(`Precision: 30.1% → ${(avgPrecision*100).toFixed(1)}% (${avgPrecision > 0.301 ? '✅ BETTER' : '⚠️  worse but expected'})`);
}

main().catch(console.error);
