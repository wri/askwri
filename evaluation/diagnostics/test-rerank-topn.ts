/**
 * Test different rerankTopN values to find optimal precision/recall balance
 * Goal: Find the sweet spot where we maintain high recall but reduce noise
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
  const slug = url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
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

async function callPythonService(query: string, maxResults: number) {
  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'cite',
      max_results: maxResults,  // This is what actually limits results
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true,
      vector_top_k: 500,
      bm25_top_k: 500,
      rerank_top_n: 120  // Rerank top 120, then cut to max_results
    })
  });

  if (!response.ok) throw new Error(`Service error: ${response.status}`);
  const data = await response.json();
  return data.docs || [];
}

async function testMaxResults(maxResults: number) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing max_results = ${maxResults}`);
  console.log('='.repeat(60));

  const results = [];

  for (const tc of goldenData.test_cases as TestCase[]) {
    const fullQuery = `${tc.question}\n\nTask: ${tc.task_description}`;
    const docs = await callPythonService(fullQuery, maxResults);

    const retrievedUrls = docs.map((d: any) => d.metadata?.url || d.metadata?.file_path).filter(Boolean);
    const metrics = calculateMetrics(tc.expected_urls, retrievedUrls);

    results.push({ ...metrics, retrieved_count: retrievedUrls.length });

    // Brief delay
    await new Promise(r => setTimeout(r, 500));
  }

  const avgPrecision = results.reduce((s, r) => s + r.precision, 0) / results.length;
  const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
  const avgF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;
  const avgRetrieved = results.reduce((s, r) => s + r.retrieved_count, 0) / results.length;

  console.log(`Precision: ${(avgPrecision*100).toFixed(1)}%`);
  console.log(`Recall: ${(avgRecall*100).toFixed(1)}%`);
  console.log(`F1: ${(avgF1*100).toFixed(1)}%`);
  console.log(`Avg docs: ${avgRetrieved.toFixed(0)}`);

  return { maxResults, precision: avgPrecision, recall: avgRecall, f1: avgF1, avgDocs: avgRetrieved };
}

async function main() {
  console.log('🚀 TESTING DIFFERENT max_results VALUES\n');
  console.log('Goal: Find best precision/recall trade-off without LLM filter');

  // Test different values
  const maxResultsValues = [20, 30, 40, 50, 60, 80];
  const allResults = [];

  for (const maxRes of maxResultsValues) {
    const result = await testMaxResults(maxRes);
    allResults.push(result);
  }

  // Summary comparison
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 SUMMARY COMPARISON');
  console.log('='.repeat(60));
  console.log('max  | Precision | Recall | F1    | Avg Docs');
  console.log('-'.repeat(60));

  for (const r of allResults) {
    console.log(
      `${r.maxResults.toString().padEnd(4)} | ` +
      `${(r.precision*100).toFixed(1).padStart(8)}% | ` +
      `${(r.recall*100).toFixed(1).padStart(5)}% | ` +
      `${(r.f1*100).toFixed(1).padStart(5)}% | ` +
      `${r.avgDocs.toFixed(0).padStart(8)}`
    );
  }

  // Find best F1
  const bestF1 = allResults.reduce((best, curr) => curr.f1 > best.f1 ? curr : best);
  console.log(`\n✅ Best F1: max_results=${bestF1.maxResults} (F1=${(bestF1.f1*100).toFixed(1)}%)`);

  // Find best recall above 80%
  const highRecall = allResults.filter(r => r.recall >= 0.80);
  if (highRecall.length > 0) {
    const bestHighRecall = highRecall.reduce((best, curr) => curr.precision > best.precision ? curr : best);
    console.log(`✅ Best high-recall (≥80%): max_results=${bestHighRecall.maxResults} (P=${(bestHighRecall.precision*100).toFixed(1)}%, R=${(bestHighRecall.recall*100).toFixed(1)}%)`);
  }

  console.log(`\n💡 Current production: max_results=80 with LLM filter`);
  console.log(`💡 Recommendation: Use max_results=${bestF1.maxResults} without LLM filter`);
}

main().catch(console.error);
