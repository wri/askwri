/**
 * Answer Mode Retrieval Evaluation Runner
 *
 * Evaluates hybrid retrieval quality for Answer mode at two granularities:
 * - Chunk-level: Did we retrieve the right passages? (with adjacent tolerance)
 * - Doc-level: Did we retrieve the right documents? (coarse grain)
 *
 * Usage: npx tsx evaluation/run-answer-retrieval-eval.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPythonService, callPythonService, PYTHON_SERVICE_URL } from './lib/service-client';
import { calculateChunkMetrics, calculateDocMetrics, aggregateMetrics } from './lib/metrics';
import type {
  AnswerGoldenDataset,
  AnswerTestCase,
  RetrievalTestResult,
  RetrievalEvalReport,
} from './lib/types';

// --- Config ---

// Match ANSWER_PRESET from src/config/retrieval.ts
const ANSWER_PARAMS = {
  vector_top_k: 150,
  bm25_top_k: 150,
  rerank_top_n: 20,
};

const ADJACENT_TOLERANCE = 1; // chunk N+/-1 counts as partial match

// --- Load golden dataset ---

const goldenDataPath = path.join(__dirname, 'answer-golden-dataset.json');
const goldenData: AnswerGoldenDataset = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));

// --- Test runner ---

async function runTestCase(tc: AnswerTestCase): Promise<RetrievalTestResult> {
  console.log(`\n  Testing: ${tc.id}`);
  console.log(`   Question: ${tc.question}`);
  console.log(`   Expected: ${tc.retrieval_ground_truth.expected_passages.length} passages, ${tc.retrieval_ground_truth.expected_doc_ids.length} docs`);

  const start = Date.now();

  try {
    const rawDocs = await callPythonService(tc.question, 'answer', ANSWER_PARAMS);

    // Extract chunk_ids and doc_ids from retrieved results
    const retrievedChunks = rawDocs.map(d => ({
      chunk_id: d.metadata?.chunk_id || d.chunk_id || 'unknown',
      doc_id: d.doc_id,
    }));
    const retrievedDocIds = [...new Set(rawDocs.map(d => d.doc_id))];

    // Expected from golden set
    const expectedChunks = tc.retrieval_ground_truth.expected_passages.map(p => ({
      chunk_id: p.chunk_id,
      doc_id: p.doc_id,
    }));
    const expectedDocIds = tc.retrieval_ground_truth.expected_doc_ids;

    // Calculate metrics
    const chunkMetrics = calculateChunkMetrics(expectedChunks, retrievedChunks, ADJACENT_TOLERANCE);
    const docMetrics = calculateDocMetrics(expectedDocIds, retrievedDocIds);

    const elapsed = Date.now() - start;

    console.log(`   Retrieved: ${rawDocs.length} passages, ${retrievedDocIds.length} unique docs`);
    console.log(`   Chunk P/R/F1: ${(chunkMetrics.precision * 100).toFixed(1)}% / ${(chunkMetrics.recall * 100).toFixed(1)}% / ${(chunkMetrics.f1 * 100).toFixed(1)}%`);
    console.log(`   Chunk (adj) P/R/F1: ${(chunkMetrics.precision_with_adjacent * 100).toFixed(1)}% / ${(chunkMetrics.recall_with_adjacent * 100).toFixed(1)}% / ${(chunkMetrics.f1_with_adjacent * 100).toFixed(1)}%`);
    console.log(`   Doc P/R/F1: ${(docMetrics.precision * 100).toFixed(1)}% / ${(docMetrics.recall * 100).toFixed(1)}% / ${(docMetrics.f1 * 100).toFixed(1)}%`);

    return {
      test_case_id: tc.id,
      question: tc.question,
      chunk_precision: chunkMetrics.precision,
      chunk_recall: chunkMetrics.recall,
      chunk_f1: chunkMetrics.f1,
      chunk_precision_adjacent: chunkMetrics.precision_with_adjacent,
      chunk_recall_adjacent: chunkMetrics.recall_with_adjacent,
      chunk_f1_adjacent: chunkMetrics.f1_with_adjacent,
      doc_precision: docMetrics.precision,
      doc_recall: docMetrics.recall,
      doc_f1: docMetrics.f1,
      expected_chunk_ids: expectedChunks.map(c => c.chunk_id),
      retrieved_chunk_ids: retrievedChunks.map(c => c.chunk_id),
      expected_doc_ids: expectedDocIds,
      retrieved_doc_ids: retrievedDocIds,
      exact_matches: chunkMetrics.exact_matches,
      adjacent_matches: chunkMetrics.adjacent_matches,
      execution_time_ms: elapsed,
    };
  } catch (error: any) {
    console.error(`   Error: ${error.message}`);
    return {
      test_case_id: tc.id,
      question: tc.question,
      chunk_precision: 0, chunk_recall: 0, chunk_f1: 0,
      chunk_precision_adjacent: 0, chunk_recall_adjacent: 0, chunk_f1_adjacent: 0,
      doc_precision: 0, doc_recall: 0, doc_f1: 0,
      expected_chunk_ids: tc.retrieval_ground_truth.expected_passages.map(p => p.chunk_id),
      retrieved_chunk_ids: [],
      expected_doc_ids: tc.retrieval_ground_truth.expected_doc_ids,
      retrieved_doc_ids: [],
      exact_matches: [],
      adjacent_matches: [],
      execution_time_ms: Date.now() - start,
      error: error.message,
    };
  }
}

// --- Summary by query type ---

function summarizeByQueryType(
  results: RetrievalTestResult[],
  testCases: AnswerTestCase[]
): Record<string, any> {
  const byType: Record<string, RetrievalTestResult[]> = {};

  for (const result of results) {
    const tc = testCases.find(t => t.id === result.test_case_id);
    if (!tc) continue;
    const type = tc.query_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(result);
  }

  const summary: Record<string, any> = {};
  for (const [type, typeResults] of Object.entries(byType)) {
    summary[type] = {
      count: typeResults.length,
      chunk: aggregateMetrics(typeResults.map(r => ({
        precision: r.chunk_precision, recall: r.chunk_recall, f1: r.chunk_f1,
      }))),
      chunk_adjacent: aggregateMetrics(typeResults.map(r => ({
        precision: r.chunk_precision_adjacent, recall: r.chunk_recall_adjacent, f1: r.chunk_f1_adjacent,
      }))),
      doc: aggregateMetrics(typeResults.map(r => ({
        precision: r.doc_precision, recall: r.doc_recall, f1: r.doc_f1,
      }))),
    };
  }
  return summary;
}

// --- Main ---

async function main() {
  console.log('Starting AskWRI Answer Mode Retrieval Evaluation');
  console.log(`Test cases: ${goldenData.test_cases.length}`);
  console.log(`Golden set status: ${goldenData.metadata.status || 'unknown'}\n`);

  // Pre-flight check
  console.log(`Checking Python service at ${PYTHON_SERVICE_URL}...`);
  const available = await checkPythonService();
  if (!available) {
    console.error(`Python service not available at ${PYTHON_SERVICE_URL}`);
    console.error('Start with: npm run start:all');
    process.exit(1);
  }
  console.log('Python service is running\n');

  const results: RetrievalTestResult[] = [];

  for (const tc of goldenData.test_cases) {
    const result = await runTestCase(tc);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Aggregate
  const chunkAgg = aggregateMetrics(results.map(r => ({
    precision: r.chunk_precision, recall: r.chunk_recall, f1: r.chunk_f1,
  })));
  const chunkAdjAgg = aggregateMetrics(results.map(r => ({
    precision: r.chunk_precision_adjacent, recall: r.chunk_recall_adjacent, f1: r.chunk_f1_adjacent,
  })));
  const docAgg = aggregateMetrics(results.map(r => ({
    precision: r.doc_precision, recall: r.doc_recall, f1: r.doc_f1,
  })));

  // Build report
  const report: RetrievalEvalReport = {
    timestamp: new Date().toISOString(),
    test_cases_total: results.length,
    results,
    aggregate: {
      chunk: chunkAgg,
      chunk_adjacent: chunkAdjAgg,
      doc: docAgg,
    },
    summary_by_query_type: summarizeByQueryType(results, goldenData.test_cases),
  };

  // Save
  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportPath = path.join(resultsDir, `answer-retrieval-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('ANSWER MODE RETRIEVAL EVALUATION SUMMARY');
  console.log('='.repeat(70));
  console.log(`Test cases: ${results.length}`);
  console.log(`\nChunk-level (strict):`);
  console.log(`  Precision: ${(chunkAgg.avg_precision * 100).toFixed(1)}%`);
  console.log(`  Recall:    ${(chunkAgg.avg_recall * 100).toFixed(1)}%`);
  console.log(`  F1:        ${(chunkAgg.avg_f1 * 100).toFixed(1)}%`);
  console.log(`\nChunk-level (adjacent tolerance=${ADJACENT_TOLERANCE}):`);
  console.log(`  Precision: ${(chunkAdjAgg.avg_precision * 100).toFixed(1)}%`);
  console.log(`  Recall:    ${(chunkAdjAgg.avg_recall * 100).toFixed(1)}%`);
  console.log(`  F1:        ${(chunkAdjAgg.avg_f1 * 100).toFixed(1)}%`);
  console.log(`\nDoc-level (coarse grain):`);
  console.log(`  Precision: ${(docAgg.avg_precision * 100).toFixed(1)}%`);
  console.log(`  Recall:    ${(docAgg.avg_recall * 100).toFixed(1)}%`);
  console.log(`  F1:        ${(docAgg.avg_f1 * 100).toFixed(1)}%`);
  console.log(`\nReport saved: ${reportPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { main as runAnswerRetrievalEval };
