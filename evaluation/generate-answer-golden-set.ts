/**
 * Answer Golden Set Generation Pipeline
 *
 * Three-phase pipeline for building the answer-mode golden evaluation dataset:
 *   1. retrieve — Calls hybrid retrieval service for each question
 *   2. label   — Uses LLM to label each chunk as relevant/partial/not_relevant
 *   3. assemble — Builds the final golden dataset from labeled chunks
 *
 * Usage:
 *   npx tsx evaluation/generate-answer-golden-set.ts --phase retrieve
 *   npx tsx evaluation/generate-answer-golden-set.ts --phase label
 *   npx tsx evaluation/generate-answer-golden-set.ts --phase assemble
 *   npx tsx evaluation/generate-answer-golden-set.ts --phase all
 *   npx tsx evaluation/generate-answer-golden-set.ts          # runs retrieve+label
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPythonService, callPythonService } from './lib/service-client';
import type { AnswerGoldenDataset, AnswerTestCase, ExpectedPassage } from './lib/types';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface QuestionBank {
  version: string;
  description: string;
  questions: QuestionEntry[];
}

interface QuestionEntry {
  id: string;
  question: string;
  query_type: string;
  difficulty: string;
  source: string;
}

interface RetrievedChunk {
  chunk_id: string;
  doc_id: string;
  title: string;
  content: string;
  score: number;
  page: number;
}

interface RetrievalRaw {
  retrieved_at: string;
  questions: Array<{
    id: string;
    question: string;
    query_type: string;
    difficulty: string;
    retrieved_chunks: RetrievedChunk[];
  }>;
}

interface LabeledChunk extends RetrievedChunk {
  label: 'relevant' | 'partially_relevant' | 'not_relevant';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  human_override: 'relevant' | 'partially_relevant' | 'not_relevant' | null;
}

interface LabelsReview {
  labeled_at: string;
  questions: Array<{
    id: string;
    question: string;
    query_type: string;
    difficulty: string;
    chunks: LabeledChunk[];
  }>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ANSWER_PARAMS = { vector_top_k: 150, bm25_top_k: 150, rerank_top_n: 10, max_results: 10 };

const EVAL_DIR = __dirname;
const QUESTION_BANK_PATH = path.join(EVAL_DIR, 'answer-question-bank.json');
const RETRIEVAL_RAW_PATH = path.join(EVAL_DIR, 'answer-retrieval-raw.json');
const LABELS_REVIEW_PATH = path.join(EVAL_DIR, 'answer-labels-review.json');
const GOLDEN_DATASET_PATH = path.join(EVAL_DIR, 'answer-golden-dataset.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJSON(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`  ✓ Wrote ${filePath}`);
}

// ---------------------------------------------------------------------------
// Phase 1: Retrieve
// ---------------------------------------------------------------------------

async function phaseRetrieve(): Promise<void> {
  console.log('\n=== Phase: RETRIEVE ===\n');

  // Health check
  const healthy = await checkPythonService();
  if (!healthy) {
    console.error('ERROR: Hybrid retrieval service is not available.');
    console.error('Start it first, then re-run with --phase retrieve');
    process.exit(1);
  }
  console.log('Hybrid service is healthy.\n');

  // Load question bank
  if (!fs.existsSync(QUESTION_BANK_PATH)) {
    console.error(`ERROR: Question bank not found at ${QUESTION_BANK_PATH}`);
    process.exit(1);
  }
  const bank: QuestionBank = JSON.parse(fs.readFileSync(QUESTION_BANK_PATH, 'utf-8'));
  console.log(`Loaded ${bank.questions.length} questions from question bank.\n`);

  const results: RetrievalRaw = {
    retrieved_at: new Date().toISOString(),
    questions: [],
  };

  for (let i = 0; i < bank.questions.length; i++) {
    const q = bank.questions[i];
    console.log(`[${i + 1}/${bank.questions.length}] "${q.question}"`);

    try {
      const docs = await callPythonService(q.question, 'answer', ANSWER_PARAMS);

      const chunks: RetrievedChunk[] = docs.map((d) => ({
        chunk_id: d.metadata?.chunk_id || d.chunk_id || 'unknown',
        doc_id: d.doc_id,
        title: d.title,
        content: d.content,
        score: d.score,
        page: d.page || d.metadata?.page || 1,
      }));

      const uniqueDocs = new Set(chunks.map((c) => c.doc_id));
      console.log(`  → ${chunks.length} chunks from ${uniqueDocs.size} unique docs`);

      results.questions.push({
        id: q.id,
        question: q.question,
        query_type: q.query_type,
        difficulty: q.difficulty,
        retrieved_chunks: chunks,
      });
    } catch (err) {
      console.error(`  ✗ Error retrieving: ${err}`);
      results.questions.push({
        id: q.id,
        question: q.question,
        query_type: q.query_type,
        difficulty: q.difficulty,
        retrieved_chunks: [],
      });
    }

    if (i < bank.questions.length - 1) {
      await sleep(1000);
    }
  }

  writeJSON(RETRIEVAL_RAW_PATH, results);
  console.log(`\nRetrieve phase complete. ${results.questions.length} questions processed.`);
}

// ---------------------------------------------------------------------------
// Phase 2: Label
// ---------------------------------------------------------------------------

async function phaseLabel(): Promise<void> {
  console.log('\n=== Phase: LABEL ===\n');

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY environment variable is required for labeling.');
    process.exit(1);
  }

  if (!fs.existsSync(RETRIEVAL_RAW_PATH)) {
    console.error(`ERROR: Retrieval raw file not found at ${RETRIEVAL_RAW_PATH}`);
    console.error('Run --phase retrieve first.');
    process.exit(1);
  }
  const raw: RetrievalRaw = JSON.parse(fs.readFileSync(RETRIEVAL_RAW_PATH, 'utf-8'));
  console.log(`Loaded retrieval data for ${raw.questions.length} questions.\n`);

  const review: LabelsReview = {
    labeled_at: new Date().toISOString(),
    questions: [],
  };

  for (let i = 0; i < raw.questions.length; i++) {
    const q = raw.questions[i];
    console.log(`[${i + 1}/${raw.questions.length}] "${q.question}" (${q.retrieved_chunks.length} chunks)`);

    if (q.retrieved_chunks.length === 0) {
      console.log('  → No chunks to label, skipping.');
      review.questions.push({
        id: q.id,
        question: q.question,
        query_type: q.query_type,
        difficulty: q.difficulty,
        chunks: [],
      });
      continue;
    }

    const chunkDescriptions = q.retrieved_chunks.map((c, idx) => {
      return `Chunk ${idx + 1} (doc_id: ${c.doc_id}, chunk_id: ${c.chunk_id}, score: ${c.score.toFixed(4)}):\n${c.content}`;
    });

    const systemPrompt = `You are an expert research librarian specializing in the WRI (World Resources Institute) urban sustainability corpus. Your task is to evaluate whether retrieved text chunks are relevant to a given research question.

For each chunk, provide:
- label: "relevant" (directly answers or provides key evidence), "partially_relevant" (tangentially related or provides background context), or "not_relevant" (unrelated to the question)
- confidence: "high", "medium", or "low"
- rationale: Brief explanation of your labeling decision (1-2 sentences)

Respond with a JSON array of objects, one per chunk, in order:
[
  { "chunk_index": 1, "label": "relevant", "confidence": "high", "rationale": "..." },
  ...
]

Return ONLY the JSON array, no other text.`;

    const userPrompt = `Question: "${q.question}"

${chunkDescriptions.join('\n\n---\n\n')}

Label each of the ${q.retrieved_chunks.length} chunks above.`;

    let labeledChunks: LabeledChunk[];

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty response from OpenAI');

      // Parse JSON — strip markdown fences if present
      const jsonStr = content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const labels: Array<{
        chunk_index: number;
        label: string;
        confidence: string;
        rationale: string;
      }> = JSON.parse(jsonStr);

      // Build a map from 1-based chunk_index to label data
      const labelMap = new Map<number, (typeof labels)[0]>();
      for (const l of labels) {
        labelMap.set(l.chunk_index, l);
      }

      labeledChunks = q.retrieved_chunks.map((chunk, idx) => {
        const lbl = labelMap.get(idx + 1);
        return {
          ...chunk,
          label: (lbl?.label as LabeledChunk['label']) || 'not_relevant',
          confidence: (lbl?.confidence as LabeledChunk['confidence']) || 'low',
          rationale: lbl?.rationale || 'No label returned by LLM',
          human_override: null,
        };
      });
    } catch (err) {
      console.error(`  ✗ Labeling error: ${err}`);
      console.log('  → Falling back: all chunks marked not_relevant/low');
      labeledChunks = q.retrieved_chunks.map((chunk) => ({
        ...chunk,
        label: 'not_relevant' as const,
        confidence: 'low' as const,
        rationale: `Labeling failed: ${err}`,
        human_override: null,
      }));
    }

    const relevant = labeledChunks.filter((c) => c.label === 'relevant').length;
    const partial = labeledChunks.filter((c) => c.label === 'partially_relevant').length;
    const needsReview = labeledChunks.filter((c) => c.confidence === 'low').length;
    console.log(`  → ${relevant} relevant, ${partial} partial, ${needsReview} needs review`);

    review.questions.push({
      id: q.id,
      question: q.question,
      query_type: q.query_type,
      difficulty: q.difficulty,
      chunks: labeledChunks,
    });

    if (i < raw.questions.length - 1) {
      await sleep(1500);
    }
  }

  writeJSON(LABELS_REVIEW_PATH, review);
  console.log(`\nLabel phase complete. ${review.questions.length} questions labeled.`);
}

// ---------------------------------------------------------------------------
// Phase 3: Assemble
// ---------------------------------------------------------------------------

async function phaseAssemble(): Promise<void> {
  console.log('\n=== Phase: ASSEMBLE ===\n');

  if (!fs.existsSync(LABELS_REVIEW_PATH)) {
    console.error(`ERROR: Labels review file not found at ${LABELS_REVIEW_PATH}`);
    console.error('Run --phase label first (and optionally review with the review server).');
    process.exit(1);
  }
  const review: LabelsReview = JSON.parse(fs.readFileSync(LABELS_REVIEW_PATH, 'utf-8'));
  console.log(`Loaded labels for ${review.questions.length} questions.\n`);

  const testCases: AnswerTestCase[] = [];

  for (const q of review.questions) {
    const expectedPassages: ExpectedPassage[] = [];
    const expectedDocIds = new Set<string>();

    for (const chunk of q.chunks) {
      const finalLabel = chunk.human_override || chunk.label;

      if (finalLabel === 'relevant') {
        expectedPassages.push({
          doc_id: chunk.doc_id,
          chunk_id: chunk.chunk_id,
          page: chunk.page,
          text_snippet: chunk.content,
        });
        expectedDocIds.add(chunk.doc_id);
      } else if (finalLabel === 'partially_relevant') {
        expectedDocIds.add(chunk.doc_id);
      }
      // not_relevant → excluded
    }

    // Warnings
    if (expectedPassages.length === 0) {
      console.warn(`  ⚠ "${q.question}" — 0 relevant passages`);
    }
    if (expectedPassages.length === q.chunks.length && q.chunks.length > 0) {
      console.warn(`  ⚠ "${q.question}" — ALL chunks marked relevant (${q.chunks.length})`);
    }

    testCases.push({
      id: q.id,
      question: q.question,
      query_type: q.query_type,
      difficulty: q.difficulty,
      retrieval_ground_truth: {
        expected_passages: expectedPassages,
        expected_doc_ids: [...expectedDocIds],
      },
      synthesis_ground_truth: {
        canonical_answer: '',
        key_facts: [],
      },
    });
  }

  const dataset: AnswerGoldenDataset = {
    version: '2.0',
    description: 'Answer mode golden evaluation dataset — retrieval ground truth with LLM-assisted labeling',
    test_cases: testCases,
    metadata: {
      generated_at: new Date().toISOString(),
      status: 'production',
      labeling_method: 'llm_assisted_human_override',
      retrieval_params: ANSWER_PARAMS,
      source_labels_file: 'answer-labels-review.json',
    },
  };

  writeJSON(GOLDEN_DATASET_PATH, dataset);

  const totalPassages = testCases.reduce((s, tc) => s + tc.retrieval_ground_truth.expected_passages.length, 0);
  const totalDocs = testCases.reduce((s, tc) => s + tc.retrieval_ground_truth.expected_doc_ids.length, 0);
  console.log(`\nAssemble phase complete.`);
  console.log(`  ${testCases.length} test cases`);
  console.log(`  ${totalPassages} expected passages total`);
  console.log(`  ${totalDocs} expected doc IDs total`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const phaseIdx = args.indexOf('--phase');
  const phase = phaseIdx !== -1 ? args[phaseIdx + 1] : undefined;

  switch (phase) {
    case 'retrieve':
      await phaseRetrieve();
      break;

    case 'label':
      await phaseLabel();
      break;

    case 'assemble':
      await phaseAssemble();
      break;

    case 'all':
      await phaseRetrieve();
      await phaseLabel();
      console.log('\n─────────────────────────────────────────────');
      console.log('Retrieve + Label complete.');
      console.log('Next steps:');
      console.log('  1. (Optional) Review labels with the review server');
      console.log('  2. Run: npx tsx evaluation/generate-answer-golden-set.ts --phase assemble');
      console.log('─────────────────────────────────────────────\n');
      break;

    case undefined:
      // Default: retrieve + label, then print instructions
      await phaseRetrieve();
      await phaseLabel();
      console.log('\n─────────────────────────────────────────────');
      console.log('Retrieve + Label complete.');
      console.log('Next steps:');
      console.log('  1. (Optional) Review labels with the review server');
      console.log('  2. Run: npx tsx evaluation/generate-answer-golden-set.ts --phase assemble');
      console.log('─────────────────────────────────────────────\n');
      break;

    default:
      console.error(`Unknown phase: "${phase}"`);
      console.error('Valid phases: retrieve, label, assemble, all');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
