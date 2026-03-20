/**
 * Diagnostic tool to analyze retrieval gaps
 *
 * For each test query, identifies which expected documents are:
 * 1. Retrieved by Python service (before LLM filter)
 * 2. Missing entirely from retrieval
 *
 * This helps us understand WHY recall is capped at ~52%
 */

import * as fs from 'fs';
import * as path from 'path';

const PYTHON_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8000';

// Load golden dataset
const goldenDataPath = path.join(__dirname, '../golden-dataset.json');
const goldenData = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));

interface TestCase {
  id: string;
  question: string;
  expected_urls: string[];
  expected_count: number;
}

function extractUrlSlug(url: string): string {
  if (!url) return '';

  const pathParts = url.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/').filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1] || '';

  return lastPart
    .split('?')[0]
    .replace(/\.(pdf|docx?|html?)$/i, '')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^_+|_+$/g, '');
}

async function checkRetrievalForQuery(testCase: TestCase): Promise<void> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Query: ${testCase.id}`);
  console.log(`Question: ${testCase.question}`);
  console.log(`Expected: ${testCase.expected_count} documents`);

  // Call Python service with baseline params
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
      vector_top_k: 500,
      bm25_top_k: 500,
      rerank_top_n: 60
    })
  });

  const data = await response.json();
  const retrievedUrls = data.docs.map((doc: any) => doc.metadata.url || doc.metadata.file_path);
  const retrievedSlugs = retrievedUrls.map(extractUrlSlug);

  const expectedSlugs = testCase.expected_urls.map(extractUrlSlug);

  // Find matches
  const found: string[] = [];
  const missing: string[] = [];

  for (let i = 0; i < testCase.expected_urls.length; i++) {
    const expectedSlug = expectedSlugs[i];
    if (retrievedSlugs.includes(expectedSlug)) {
      found.push(testCase.expected_urls[i]);
    } else {
      missing.push(testCase.expected_urls[i]);
    }
  }

  const retrievalRecall = found.length / testCase.expected_count;

  console.log(`\nRetrieval Stats (BEFORE LLM filter):`);
  console.log(`  Retrieved: ${retrievedUrls.length} documents`);
  console.log(`  Found: ${found.length}/${testCase.expected_count} expected docs`);
  console.log(`  Retrieval Recall: ${(retrievalRecall * 100).toFixed(1)}%`);

  if (missing.length > 0) {
    console.log(`\n⚠️  MISSING from retrieval (${missing.length}):`);
    missing.forEach((url, i) => {
      const slug = extractUrlSlug(url);
      console.log(`  ${i + 1}. ${slug}`);
    });
  }

  if (found.length > 0) {
    console.log(`\n✅ Found in retrieval (${found.length}):`);
    found.slice(0, 3).forEach((url, i) => {
      const slug = extractUrlSlug(url);
      console.log(`  ${i + 1}. ${slug}`);
    });
    if (found.length > 3) {
      console.log(`  ... and ${found.length - 3} more`);
    }
  }
}

async function main() {
  console.log('🔍 Diagnosing Retrieval Gaps');
  console.log(`📊 Analyzing ${goldenData.test_cases.length} test queries\n`);

  const testCases: TestCase[] = goldenData.test_cases;

  for (const testCase of testCases) {
    try {
      await checkRetrievalForQuery(testCase);
      await new Promise(resolve => setTimeout(resolve, 500)); // Brief delay between queries
    } catch (error) {
      console.error(`❌ Error analyzing ${testCase.id}:`, error);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('✅ Diagnosis complete');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
