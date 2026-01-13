/**
 * Diagnostic: Check if expected documents are retrieved BEFORE LLM filter
 *
 * This tells us if the problem is:
 * A) Upstream (retrieval/reranking not finding the docs) - filter makes it worse
 * B) Filter itself (retrieval finds docs but filter removes them) - filter is broken
 */
import * as fs from 'fs';
import * as path from 'path';

// Configuration
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
}

/**
 * Extract slug from URL for matching
 */
function extractUrlSlug(url: string): string {
  if (!url) return '';
  let slug = url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
  const pathParts = slug.split('/').filter(Boolean);
  const lastPart = pathParts[pathParts.length - 1] || '';
  const cleanSlug = lastPart
    .split('?')[0]
    .replace(/\.(pdf|docx?|html?)$/i, '')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^_+|_+$/g, '');
  return cleanSlug;
}

/**
 * Call Python service WITHOUT any filtering
 */
async function callPythonService(query: string): Promise<any[]> {
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
      rerank_top_n: 120  // Use PRODUCTION setting (eval uses 60)
    })
  });

  if (!response.ok) {
    throw new Error(`Python service error: ${response.status}`);
  }

  const data = await response.json();
  return data.docs || [];
}

/**
 * Check if expected docs are in retrieved results
 */
function checkRecall(expectedUrls: string[], retrievedDocs: any[]): {
  found: number;
  missing: number;
  recall: number;
  foundUrls: string[];
  missingUrls: string[];
} {
  const expectedSlugs = expectedUrls.map(extractUrlSlug);
  const retrievedSlugs = retrievedDocs.map(doc =>
    extractUrlSlug(doc.metadata?.url || doc.metadata?.file_path || '')
  );

  const foundUrls: string[] = [];
  const missingUrls: string[] = [];

  for (let i = 0; i < expectedUrls.length; i++) {
    const expectedSlug = expectedSlugs[i];
    if (retrievedSlugs.includes(expectedSlug)) {
      foundUrls.push(expectedUrls[i]);
    } else {
      missingUrls.push(expectedUrls[i]);
    }
  }

  return {
    found: foundUrls.length,
    missing: missingUrls.length,
    recall: expectedUrls.length > 0 ? foundUrls.length / expectedUrls.length : 0,
    foundUrls,
    missingUrls
  };
}

/**
 * Run diagnostic on one test case
 */
async function diagnoseTestCase(testCase: TestCase) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 ${testCase.id}`);
  console.log(`Question: ${testCase.question}`);
  console.log(`Expected: ${testCase.expected_count} documents`);

  const fullQuery = `${testCase.question}\n\nTask: ${testCase.task_description}`;

  // Call retrieval WITHOUT filter
  const docs = await callPythonService(fullQuery);
  console.log(`\n📊 Retrieved (pre-filter): ${docs.length} documents`);

  // Check recall
  const recall = checkRecall(testCase.expected_urls, docs);
  console.log(`✅ Found: ${recall.found}/${testCase.expected_count} (${(recall.recall * 100).toFixed(1)}% recall)`);
  console.log(`❌ Missing: ${recall.missing}/${testCase.expected_count}`);

  if (recall.missingUrls.length > 0) {
    console.log(`\n❌ Missing documents (UPSTREAM PROBLEM):`);
    recall.missingUrls.forEach(url => console.log(`   - ${url}`));
  }

  return {
    test_case_id: testCase.id,
    expected_count: testCase.expected_count,
    retrieved_count: docs.length,
    found_count: recall.found,
    missing_count: recall.missing,
    pre_filter_recall: recall.recall,
    missing_urls: recall.missingUrls
  };
}

/**
 * Main diagnostic
 */
async function main() {
  console.log('🚀 PRE-FILTER RECALL DIAGNOSTIC');
  console.log('Goal: Check if expected documents are retrieved BEFORE LLM filter');
  console.log(`Using rerankTopN: 120 (production setting)\n`);

  const results = [];

  for (const testCase of goldenData.test_cases as TestCase[]) {
    const result = await diagnoseTestCase(testCase);
    results.push(result);

    // Delay between queries
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log('📊 SUMMARY');
  console.log('='.repeat(80));

  const totalExpected = results.reduce((sum, r) => sum + r.expected_count, 0);
  const totalFound = results.reduce((sum, r) => sum + r.found_count, 0);
  const totalMissing = results.reduce((sum, r) => sum + r.missing_count, 0);
  const avgRecall = results.reduce((sum, r) => sum + r.pre_filter_recall, 0) / results.length;

  console.log(`Total expected documents: ${totalExpected}`);
  console.log(`Found pre-filter: ${totalFound} (${((totalFound/totalExpected)*100).toFixed(1)}%)`);
  console.log(`Missing pre-filter: ${totalMissing} (${((totalMissing/totalExpected)*100).toFixed(1)}%)`);
  console.log(`Average recall: ${(avgRecall * 100).toFixed(1)}%`);

  console.log(`\n💡 DIAGNOSIS:`);
  if (totalMissing > totalExpected * 0.2) {
    console.log(`⚠️  UPSTREAM PROBLEM: ${((totalMissing/totalExpected)*100).toFixed(0)}% of expected docs not retrieved`);
    console.log(`   → Problem is in vector search, BM25, or reranking`);
    console.log(`   → LLM filter is making things WORSE by filtering what little we retrieve`);
    console.log(`   → RECOMMENDATION: Disable LLM filter, fix retrieval first`);
  } else {
    console.log(`✅ Retrieval is working: ${((totalFound/totalExpected)*100).toFixed(0)}% recall pre-filter`);
    console.log(`   → Problem is likely the LLM filter removing good documents`);
    console.log(`   → RECOMMENDATION: Fix or remove LLM filter`);
  }

  // Save results
  const reportPath = path.join(__dirname, 'results', `pre-filter-diagnostic-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ results, summary: {
    totalExpected,
    totalFound,
    totalMissing,
    avgRecall
  }}, null, 2));
  console.log(`\n📁 Report saved: ${reportPath}`);
}

main().catch(console.error);
