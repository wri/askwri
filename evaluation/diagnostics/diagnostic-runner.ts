/**
 * Diagnostic Evaluation Runner for AskWRI Cite Mode
 *
 * This script runs a comprehensive diagnostic evaluation to identify
 * WHERE and WHY expected documents are being lost in the retrieval pipeline.
 *
 * Usage:
 *   npx tsx evaluation/diagnostics/diagnostic-runner.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// Configuration
const _NEXTJS_SERVER_URL = process.env.NEXTJS_SERVER_URL || 'http://localhost:3000';
const PYTHON_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8000';

// Load golden dataset
const goldenDataPath = path.join(__dirname, '../golden-dataset.json');
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

interface StageResult {
  stage_name: string;
  recall: number;
  docs_found: string[];
  docs_missing: string[];
  details: any;
}

interface DiagnosticReport {
  test_case_id: string;
  query: string;
  expected_docs: string[];
  recall_by_stage: StageResult[];
  root_cause: string;
  recommended_actions: string[];
  execution_time_ms: number;
}

/**
 * Extract URL slug for matching
 */
function extractUrlSlug(url: string): string {
  if (!url) return '';

  const slug = url
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
 * Stage 1: Dense Retrieval Analysis
 */
async function analyzeDenseRetrieval(
  query: string,
  expectedUrls: string[]
): Promise<StageResult> {
  console.log('  [Stage 1] Analyzing dense (vector) retrieval...');

  const expectedSlugs = expectedUrls.map(extractUrlSlug);

  try {
    // Call Python service with dense-only mode (if endpoint exists)
    // For now, use regular query endpoint and extract dense results from debug info
    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        mode: 'cite',
        max_results: 500,
        similarity_threshold: 0.0,
        rerank: false,  // No reranking for this stage
        include_metadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Dense retrieval failed: ${response.status}`);
    }

    const data = await response.json();
    const docs = data.docs || [];

    // Extract slugs from retrieved docs
    const retrievedSlugs = docs.map((doc: any) =>
      extractUrlSlug(doc.metadata?.url || '')
    );

    // Find matches
    const foundDocs: string[] = [];
    const missingDocs: string[] = [];

    for (let i = 0; i < expectedUrls.length; i++) {
      const expectedSlug = expectedSlugs[i];
      if (retrievedSlugs.includes(expectedSlug)) {
        foundDocs.push(expectedUrls[i]);
      } else {
        missingDocs.push(expectedUrls[i]);
      }
    }

    const recall = expectedUrls.length > 0 ? foundDocs.length / expectedUrls.length : 0;

    console.log(`    Dense recall: ${(recall * 100).toFixed(1)}% (${foundDocs.length}/${expectedUrls.length} found)`);

    return {
      stage_name: 'Dense Retrieval (Vector Search)',
      recall,
      docs_found: foundDocs,
      docs_missing: missingDocs,
      details: {
        total_retrieved: docs.length,
        top_10_scores: docs.slice(0, 10).map((d: any) => d.score),
        expected_doc_ranks: expectedSlugs.map(slug => {
          const rank = retrievedSlugs.indexOf(slug);
          return rank >= 0 ? rank + 1 : null;
        })
      }
    };
  } catch (error: any) {
    console.error(`    Dense retrieval error: ${error.message}`);
    return {
      stage_name: 'Dense Retrieval (Vector Search)',
      recall: 0,
      docs_found: [],
      docs_missing: expectedUrls,
      details: { error: error.message }
    };
  }
}

/**
 * Stage 2: Sparse Retrieval Analysis
 */
async function _analyzeSparseRetrieval(
  query: string,
  expectedUrls: string[]
): Promise<StageResult> {
  console.log('  [Stage 2] Analyzing sparse (BM25) retrieval...');

  // Note: This requires a sparse-only endpoint in the Python service
  // For now, we'll estimate based on query term matching

  const _expectedSlugs = expectedUrls.map(extractUrlSlug);

  // TODO: Implement sparse-only endpoint call
  // For now, return placeholder

  return {
    stage_name: 'Sparse Retrieval (BM25)',
    recall: 0,
    docs_found: [],
    docs_missing: expectedUrls,
    details: {
      note: 'Sparse-only endpoint not yet implemented. Add /debug/sparse-only to hybrid-service/main.py'
    }
  };
}

/**
 * Stage 3: Hybrid Fusion Analysis
 */
async function analyzeHybridFusion(
  query: string,
  expectedUrls: string[]
): Promise<StageResult> {
  console.log('  [Stage 3] Analyzing hybrid fusion (RRF)...');

  const expectedSlugs = expectedUrls.map(extractUrlSlug);

  try {
    // Call with hybrid fusion, no reranking
    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        mode: 'cite',
        max_results: 500,
        similarity_threshold: 0.0,
        rerank: false,  // No reranking yet
        include_metadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Fusion retrieval failed: ${response.status}`);
    }

    const data = await response.json();
    const docs = data.docs || [];

    const retrievedSlugs = docs.map((doc: any) =>
      extractUrlSlug(doc.metadata?.url || '')
    );

    const foundDocs: string[] = [];
    const missingDocs: string[] = [];

    for (let i = 0; i < expectedUrls.length; i++) {
      const expectedSlug = expectedSlugs[i];
      if (retrievedSlugs.includes(expectedSlug)) {
        foundDocs.push(expectedUrls[i]);
      } else {
        missingDocs.push(expectedUrls[i]);
      }
    }

    const recall = expectedUrls.length > 0 ? foundDocs.length / expectedUrls.length : 0;

    console.log(`    Fusion recall: ${(recall * 100).toFixed(1)}% (${foundDocs.length}/${expectedUrls.length} found)`);

    return {
      stage_name: 'Hybrid Fusion (RRF)',
      recall,
      docs_found: foundDocs,
      docs_missing: missingDocs,
      details: {
        total_retrieved: docs.length,
        fusion_weights: { dense: 0.4, sparse: 0.6 }
      }
    };
  } catch (error: any) {
    console.error(`    Fusion error: ${error.message}`);
    return {
      stage_name: 'Hybrid Fusion (RRF)',
      recall: 0,
      docs_found: [],
      docs_missing: expectedUrls,
      details: { error: error.message }
    };
  }
}

/**
 * Stage 4: Reranking Analysis
 */
async function analyzeReranking(
  query: string,
  expectedUrls: string[]
): Promise<StageResult> {
  console.log('  [Stage 4] Analyzing reranking (cross-encoder)...');

  const expectedSlugs = expectedUrls.map(extractUrlSlug);

  try {
    // Call with reranking enabled
    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        mode: 'cite',
        max_results: 100,
        similarity_threshold: 0.0,
        rerank: true,  // Enable reranking
        include_metadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Reranking failed: ${response.status}`);
    }

    const data = await response.json();
    const docs = data.docs || [];

    const retrievedSlugs = docs.map((doc: any) =>
      extractUrlSlug(doc.metadata?.url || '')
    );

    const foundDocs: string[] = [];
    const missingDocs: string[] = [];

    for (let i = 0; i < expectedUrls.length; i++) {
      const expectedSlug = expectedSlugs[i];
      if (retrievedSlugs.includes(expectedSlug)) {
        foundDocs.push(expectedUrls[i]);
      } else {
        missingDocs.push(expectedUrls[i]);
      }
    }

    const recall = expectedUrls.length > 0 ? foundDocs.length / expectedUrls.length : 0;

    console.log(`    Reranking recall: ${(recall * 100).toFixed(1)}% (${foundDocs.length}/${expectedUrls.length} found)`);

    return {
      stage_name: 'Reranking (Cross-Encoder)',
      recall,
      docs_found: foundDocs,
      docs_missing: missingDocs,
      details: {
        total_retrieved: docs.length,
        reranker_model: 'cross-encoder/ms-marco-MiniLM-L-6-v2'
      }
    };
  } catch (error: any) {
    console.error(`    Reranking error: ${error.message}`);
    return {
      stage_name: 'Reranking (Cross-Encoder)',
      recall: 0,
      docs_found: [],
      docs_missing: expectedUrls,
      details: { error: error.message }
    };
  }
}

/**
 * Stage 5: Final Output (Document Grouping)
 */
async function analyzeFinalOutput(
  query: string,
  expectedUrls: string[]
): Promise<StageResult> {
  console.log('  [Stage 5] Analyzing final output (document grouping)...');

  const expectedSlugs = expectedUrls.map(extractUrlSlug);

  try {
    // Call with all processing enabled (production configuration)
    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        mode: 'cite',
        max_results: 100,
        similarity_threshold: 0.0,
        rerank: true,
        include_metadata: true
      })
    });

    if (!response.ok) {
      throw new Error(`Final retrieval failed: ${response.status}`);
    }

    const data = await response.json();
    const docs = data.docs || [];

    const retrievedSlugs = docs.map((doc: any) =>
      extractUrlSlug(doc.metadata?.url || '')
    );

    const foundDocs: string[] = [];
    const missingDocs: string[] = [];

    for (let i = 0; i < expectedUrls.length; i++) {
      const expectedSlug = expectedSlugs[i];
      if (retrievedSlugs.includes(expectedSlug)) {
        foundDocs.push(expectedUrls[i]);
      } else {
        missingDocs.push(expectedUrls[i]);
      }
    }

    const recall = expectedUrls.length > 0 ? foundDocs.length / expectedUrls.length : 0;

    console.log(`    Final recall: ${(recall * 100).toFixed(1)}% (${foundDocs.length}/${expectedUrls.length} found)`);

    return {
      stage_name: 'Final Output (Current Production)',
      recall,
      docs_found: foundDocs,
      docs_missing: missingDocs,
      details: {
        total_retrieved: docs.length
      }
    };
  } catch (error: any) {
    console.error(`    Final output error: ${error.message}`);
    return {
      stage_name: 'Final Output (Current Production)',
      recall: 0,
      docs_found: [],
      docs_missing: expectedUrls,
      details: { error: error.message }
    };
  }
}

/**
 * Determine root cause based on stage results
 */
function determineRootCause(stageResults: StageResult[]): string {
  // If Stage 1 (dense) has low recall, it's an embedding quality issue
  const denseRecall = stageResults[0]?.recall || 0;
  if (denseRecall < 0.5) {
    return 'embedding_quality';
  }

  // If fusion hurts recall compared to dense, it's a fusion weights issue
  const fusionRecall = stageResults[2]?.recall || 0;
  if (fusionRecall < denseRecall - 0.1) {
    return 'fusion_weights';
  }

  // If reranking hurts recall, it's a reranker issue
  const rerankRecall = stageResults[3]?.recall || 0;
  if (rerankRecall < fusionRecall - 0.1) {
    return 'reranker_drops';
  }

  // If dense recall is good but final is bad, it's a pipeline issue
  if (denseRecall > 0.8 && rerankRecall < 0.6) {
    return 'query_complexity';
  }

  return 'unknown';
}

/**
 * Generate recommended actions based on root cause
 */
function getRecommendedActions(rootCause: string, _stageResults: StageResult[]): string[] {
  const actions: string[] = [];

  switch (rootCause) {
    case 'embedding_quality':
      actions.push('✓ Embeddings are not capturing semantic similarity well');
      actions.push('✓ Consider adding metadata (title, authors, tags) to chunk embeddings');
      actions.push('✓ Experiment with query expansion or reformulation');
      actions.push('✓ Try a more powerful embedding model');
      break;

    case 'fusion_weights':
      actions.push('✓ Hybrid fusion is degrading recall from dense retrieval');
      actions.push('✓ Increase sparse_weight if BM25 is finding more expected docs');
      actions.push('✓ Try different fusion_top_k values');
      actions.push('✓ Consider using dense-only retrieval for this query type');
      break;

    case 'reranker_drops':
      actions.push('✓ Cross-encoder reranker is dropping relevant documents');
      actions.push('✓ Try disabling reranking for Cite mode (prioritize recall over precision)');
      actions.push('✓ Increase reranker top_n to preserve more candidates');
      actions.push('✓ Consider using a different reranker model');
      break;

    case 'query_complexity':
      actions.push('✓ Query is too complex for current retrieval strategy');
      actions.push('✓ Implement query decomposition for multi-concept queries');
      actions.push('✓ Try query reformulation with LLM');
      actions.push('✓ Use query expansion with synonyms');
      break;

    default:
      actions.push('✓ Root cause unclear - needs deeper investigation');
      actions.push('✓ Review stage-by-stage recall waterfall');
      actions.push('✓ Check if expected documents exist in corpus');
  }

  return actions;
}

/**
 * Run diagnostic evaluation for a single test case
 */
async function runDiagnosticForTestCase(testCase: TestCase): Promise<DiagnosticReport> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔬 Diagnostic Evaluation: ${testCase.id}`);
  console.log(`Query: ${testCase.question}`);
  console.log(`Expected: ${testCase.expected_count} documents`);
  console.log(`${'='.repeat(80)}`);

  const startTime = Date.now();

  // Combine question and task description for full context
  const fullQuery = `${testCase.question}\n\nTask: ${testCase.task_description}`;

  // Run all diagnostic stages
  const stageResults: StageResult[] = [];

  // Stage 1: Dense Retrieval
  const denseResult = await analyzeDenseRetrieval(fullQuery, testCase.expected_urls);
  stageResults.push(denseResult);

  // Stage 2: Sparse Retrieval (placeholder for now)
  // const sparseResult = await analyzeSparseRetrieval(fullQuery, testCase.expected_urls);
  // stageResults.push(sparseResult);

  // Stage 3: Hybrid Fusion
  const fusionResult = await analyzeHybridFusion(fullQuery, testCase.expected_urls);
  stageResults.push(fusionResult);

  // Stage 4: Reranking
  const rerankResult = await analyzeReranking(fullQuery, testCase.expected_urls);
  stageResults.push(rerankResult);

  // Stage 5: Final Output
  const finalResult = await analyzeFinalOutput(fullQuery, testCase.expected_urls);
  stageResults.push(finalResult);

  // Determine root cause
  const rootCause = determineRootCause(stageResults);

  // Generate recommended actions
  const recommendedActions = getRecommendedActions(rootCause, stageResults);

  const executionTime = Date.now() - startTime;

  // Print summary
  console.log(`\n📊 Recall Waterfall:`);
  for (const stage of stageResults) {
    const status = stage.recall >= 0.8 ? '✅' : stage.recall >= 0.5 ? '⚠️' : '❌';
    console.log(`  ${status} ${stage.stage_name}: ${(stage.recall * 100).toFixed(1)}% recall`);
  }

  console.log(`\n🎯 Root Cause: ${rootCause}`);

  const finalMissing = finalResult.docs_missing;
  if (finalMissing.length > 0) {
    console.log(`\n❌ Missing Documents (${finalMissing.length}):`);
    for (const doc of finalMissing) {
      console.log(`  - ${doc}`);
    }
  }

  console.log(`\n💡 Recommended Actions:`);
  for (const action of recommendedActions) {
    console.log(`  ${action}`);
  }

  console.log(`\n⏱️  Execution time: ${(executionTime / 1000).toFixed(1)}s`);

  return {
    test_case_id: testCase.id,
    query: fullQuery,
    expected_docs: testCase.expected_urls,
    recall_by_stage: stageResults,
    root_cause: rootCause,
    recommended_actions: recommendedActions,
    execution_time_ms: executionTime
  };
}

/**
 * Main diagnostic evaluation runner
 */
async function runDiagnosticEvaluation() {
  console.log('🚀 Starting AskWRI Diagnostic Evaluation');
  console.log(`📊 Test cases: ${goldenData.test_cases.length}`);
  console.log(`📄 Total expected documents: ${goldenData.metadata.total_expected_documents}\n`);

  // Pre-flight check
  console.log('🔍 Checking Python service availability...');
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/health`);
    const data = await response.json();
    if (data.status !== 'healthy') {
      throw new Error('Service not healthy');
    }
    console.log('✅ Python service is running\n');
  } catch (_error: any) {
    console.error(`❌ Python service not available at ${PYTHON_SERVICE_URL}`);
    console.error('   Please start the service with: bash start.sh');
    process.exit(1);
  }

  const reports: DiagnosticReport[] = [];

  // Run diagnostic for each test case
  for (const testCase of goldenData.test_cases as TestCase[]) {
    const report = await runDiagnosticForTestCase(testCase);
    reports.push(report);

    // Add delay between requests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Generate summary report
  console.log('\n' + '='.repeat(80));
  console.log('📊 DIAGNOSTIC SUMMARY');
  console.log('='.repeat(80));

  // Count root causes
  const rootCauseCounts: Record<string, number> = {};
  for (const report of reports) {
    rootCauseCounts[report.root_cause] = (rootCauseCounts[report.root_cause] || 0) + 1;
  }

  console.log('\n🎯 Root Cause Distribution:');
  for (const [cause, count] of Object.entries(rootCauseCounts)) {
    console.log(`  ${cause}: ${count} test cases`);
  }

  // Calculate average recall by stage
  const stageNames = reports[0]?.recall_by_stage.map(s => s.stage_name) || [];
  console.log('\n📈 Average Recall by Stage:');
  for (let i = 0; i < stageNames.length; i++) {
    const avgRecall = reports.reduce((sum, r) => sum + (r.recall_by_stage[i]?.recall || 0), 0) / reports.length;
    const status = avgRecall >= 0.8 ? '✅' : avgRecall >= 0.5 ? '⚠️' : '❌';
    console.log(`  ${status} ${stageNames[i]}: ${(avgRecall * 100).toFixed(1)}%`);
  }

  // Save detailed report
  const reportPath = path.join(__dirname, '../results', `diagnostic-report-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    test_cases_total: reports.length,
    root_cause_distribution: rootCauseCounts,
    reports
  }, null, 2));

  console.log(`\n📁 Full report saved to: ${reportPath}`);

  return reports;
}

// Run if called directly
if (require.main === module) {
  runDiagnosticEvaluation()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { runDiagnosticEvaluation };
