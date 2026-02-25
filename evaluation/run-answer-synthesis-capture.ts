/**
 * Stage 1: Capture system outputs for synthesis evaluation.
 *
 * For each test case in the golden dataset:
 *   1. Call hybrid service (mode=answer) to retrieve passages
 *   2. Transform to DocMeta format
 *   3. Call /api/answer for synthesis
 *   4. Save question + passages + synthesis to JSON
 *
 * Prerequisites: hybrid service on :8002, Next.js on :3000
 *
 * Usage: npx tsx evaluation/run-answer-synthesis-capture.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  checkPythonService,
  checkNextJsService,
  callPythonService,
  transformToDocMeta,
  callAnswerAPI,
  PYTHON_SERVICE_URL,
  NEXTJS_SERVER_URL,
} from './lib/service-client';
import type { AnswerGoldenDataset, SynthesisCaptureFile, SynthesisCaptureEntry, CapturedPassage } from './lib/types';
import { ANSWER_PRESET } from '../src/config/retrieval';

const EVAL_DIR = __dirname;
const GOLDEN_PATH = path.join(EVAL_DIR, 'answer-golden-dataset.json');
const OUTPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-raw.json');

const ANSWER_PARAMS = {
  vector_top_k: ANSWER_PRESET.denseTopK,
  bm25_top_k: ANSWER_PRESET.sparseTopK,
  rerank_top_n: ANSWER_PRESET.rerankTopN,
  max_results: ANSWER_PRESET.maxResults,
};

async function main() {
  console.log('=== Stage 1: System Output Capture ===\n');

  console.log(`Checking hybrid service at ${PYTHON_SERVICE_URL}...`);
  if (!(await checkPythonService())) {
    console.error('Hybrid service not available. Start with: npm run hybrid');
    process.exit(1);
  }
  console.log('Hybrid service: OK');

  console.log(`Checking Next.js at ${NEXTJS_SERVER_URL}...`);
  if (!(await checkNextJsService())) {
    console.error('Next.js not available. Start with: npm run dev');
    process.exit(1);
  }
  console.log('Next.js: OK\n');

  const golden: AnswerGoldenDataset = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8'));
  console.log(`Loaded ${golden.test_cases.length} test cases\n`);

  const output: SynthesisCaptureFile = {
    captured_at: new Date().toISOString(),
    system_model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    test_cases: [],
  };

  for (const tc of golden.test_cases) {
    console.log(`Processing: ${tc.id}`);
    console.log(`  Question: ${tc.question.slice(0, 80)}...`);

    const rawDocs = await callPythonService(tc.question, 'answer', ANSWER_PARAMS);
    console.log(`  Retrieved ${rawDocs.length} chunks`);

    const docMetas = rawDocs.map(transformToDocMeta);

    const synthesis = await callAnswerAPI(tc.question, docMetas);
    const fullText = synthesis.sentences.join(' ');
    console.log(`  Synthesis: ${fullText.slice(0, 120)}...`);

    const passages: CapturedPassage[] = rawDocs.map(d => ({
      doc_id: d.doc_id,
      chunk_id: d.metadata?.chunk_id || d.chunk_id || 'unknown',
      title: d.title,
      snippet: d.content,
      score: d.score,
      page: d.page || d.metadata?.page || 1,
    }));

    const entry: SynthesisCaptureEntry = {
      test_case_id: tc.id,
      question: tc.question,
      retrieved_passages: passages,
      synthesis: {
        sentences: synthesis.sentences,
        full_text: fullText,
        warning: synthesis.warning,
      },
      docs_sent_to_api: docMetas.length,
      docs_after_filter: docMetas.length,
      timestamp: new Date().toISOString(),
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };

    output.test_cases.push(entry);

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.test_cases.length} test cases to ${OUTPUT_PATH}`);
  console.log('\nNext step: npx tsx evaluation/run-answer-synthesis-llm-eval.ts');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
