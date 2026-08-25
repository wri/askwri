# Answer Synthesis Evaluation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a 4-stage synthesis evaluation pipeline: capture system outputs, score with GPT-5.2 thinking, human review via extended label review server, and assemble ground truth back into the golden dataset.

**Architecture:** Three new TypeScript scripts (capture, llm-eval, assemble) plus a new route/HTML page on the existing review server. All stages communicate through JSON intermediates. The review UI follows the same autosave pattern as the existing label review page.

**Tech Stack:** TypeScript (tsx), existing `callPythonService()` and `callAnswerAPI()` from `evaluation/lib/service-client.ts`, OpenAI API via fetch (GPT-5.2 thinking), Node built-in `http` (extending existing review server).

---

### Task 1: Add Synthesis Eval Types

**Files:**
- Modify: `evaluation/lib/types.ts`

**Step 1: Write the types**

Append to the end of `evaluation/lib/types.ts`:

```typescript
// --- Synthesis Eval Types ---

export interface SynthesisScores {
  faithfulness: number;
  completeness: number;
  conciseness: number;
  coherence: number;
  citation_accuracy: number;
}

export interface FlaggedIssue {
  type: 'unsupported_claim' | 'missing_info' | 'verbatim_copy' | 'other';
  text: string;
  detail: string;
}

export interface CapturedPassage {
  doc_id: string;
  chunk_id: string;
  title: string;
  snippet: string;
  score: number;
  page: number;
}

export interface SynthesisCaptureEntry {
  test_case_id: string;
  question: string;
  retrieved_passages: CapturedPassage[];
  synthesis: {
    sentences: string[];
    full_text: string;
    warning?: string;
  };
  docs_sent_to_api: number;
  docs_after_filter: number;
  timestamp: string;
  model: string;
}

export interface SynthesisCaptureFile {
  captured_at: string;
  system_model: string;
  test_cases: SynthesisCaptureEntry[];
}

export interface LLMEvalEntry {
  test_case_id: string;
  scores: SynthesisScores;
  qualitative_feedback: string;
  flagged_issues: FlaggedIssue[];
  key_facts_extracted: string[];
  model: string;
  reasoning_tokens?: number;
}

export interface LLMEvalFile {
  evaluated_at: string;
  evaluator_model: string;
  test_cases: LLMEvalEntry[];
}

export interface HumanEval {
  scores: SynthesisScores;
  qualitative_feedback: string;
  key_facts_confirmed: string[];
  key_facts_added: string[];
  reviewed: boolean;
}

export interface SynthesisEvalFinalEntry {
  test_case_id: string;
  question: string;
  synthesis_text: string;
  passage_count: number;
  llm_eval: LLMEvalEntry;
  human_eval: HumanEval;
}

export interface SynthesisEvalFinalFile {
  evaluated_at: string;
  system_model: string;
  evaluator_model: string;
  test_cases: SynthesisEvalFinalEntry[];
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit evaluation/lib/types.ts`
Expected: No errors (or use `npx tsx --eval "import './evaluation/lib/types'"`)

**Step 3: Commit**

```bash
git add evaluation/lib/types.ts
git commit -m "feat(eval): add synthesis evaluation type definitions"
```

---

### Task 2: Stage 1 — System Output Capture Script

**Files:**
- Create: `evaluation/run-answer-synthesis-capture.ts`

**Step 1: Write the capture script**

This script runs the full end-to-end pipeline for each test case: retrieval → transform to DocMeta → call `/api/answer` → save everything.

```typescript
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

const EVAL_DIR = path.dirname(__filename);
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

  // Check services
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

  // Load golden dataset
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

    // Step 1: Retrieve passages
    const rawDocs = await callPythonService(tc.question, 'answer', ANSWER_PARAMS);
    console.log(`  Retrieved ${rawDocs.length} chunks`);

    // Step 2: Transform to DocMeta for answer API
    const docMetas = rawDocs.map(transformToDocMeta);

    // Step 3: Call answer API
    const synthesis = await callAnswerAPI(tc.question, docMetas);
    const fullText = synthesis.sentences.join(' ');
    console.log(`  Synthesis: ${fullText.slice(0, 120)}...`);

    // Step 4: Capture passages with citation data
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
      docs_after_filter: docMetas.length, // actual filtered count is inside route
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
```

**Step 2: Test manually**

```bash
# Requires: hybrid service running, Next.js running
npx tsx evaluation/run-answer-synthesis-capture.ts
# Expected: Creates evaluation/answer-synthesis-raw.json
# Verify:
python3 -c "
import json
d = json.load(open('evaluation/answer-synthesis-raw.json'))
for tc in d['test_cases']:
    print(f\"{tc['test_case_id']}: {len(tc['retrieved_passages'])} passages, {len(tc['synthesis']['sentences'])} sentences\")
"
```

**Step 3: Commit**

```bash
git add evaluation/run-answer-synthesis-capture.ts
git commit -m "feat(eval): add synthesis capture script (stage 1)"
```

---

### Task 3: Stage 2 — LLM Evaluation Script

**Files:**
- Create: `evaluation/run-answer-synthesis-llm-eval.ts`

**Step 1: Write the LLM evaluation script**

Reads `answer-synthesis-raw.json`, sends each test case to GPT-5.2 thinking mode for evaluation, saves scores + feedback.

```typescript
/**
 * Stage 2: LLM evaluation of synthesis quality.
 *
 * For each captured test case, sends the question + passages + synthesis
 * to GPT-5.2 (thinking mode) for multi-dimensional scoring.
 *
 * Prerequisites: OPENAI_API_KEY set, answer-synthesis-raw.json present
 *
 * Usage: npx tsx evaluation/run-answer-synthesis-llm-eval.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  SynthesisCaptureFile,
  LLMEvalFile,
  LLMEvalEntry,
  SynthesisScores,
  FlaggedIssue,
} from './lib/types';

const EVAL_DIR = path.dirname(__filename);
const INPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-raw.json');
const OUTPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-llm-eval.json');

const EVALUATOR_MODEL = 'gpt-5.2';

const SYSTEM_PROMPT = `You are an expert evaluator assessing the quality of AI-generated research synthesis. You will be given:
1. A research question
2. The source passages the AI had access to
3. The synthesis the AI produced

Score each dimension from 0.0 to 1.0 (one decimal place):

- **faithfulness**: Is every claim in the synthesis grounded in the provided passages? 0 = hallucinated claims, 1 = all claims traceable to specific passages.
- **completeness**: Does the synthesis cover the key information from the passages? 0 = misses major findings, 1 = covers the most important information across passages.
- **conciseness**: Is the synthesis appropriately brief without filler? 0 = verbose/repetitive, 1 = every word earns its place (2-3 sentences expected).
- **coherence**: Does it read as a unified, well-structured answer? 0 = disjointed facts, 1 = smooth narrative that synthesizes rather than concatenates.
- **citation_accuracy**: Could each claim in the synthesis be attributed to specific source passages? 0 = claims can't be traced to sources, 1 = each claim clearly maps to passage(s).

Also:
- Provide qualitative feedback: what's good, what's missing, what's wrong.
- Flag specific issues (unsupported claims, missing key info, verbatim copying).
- Extract the key factual claims present in the synthesis as a list.

Respond with JSON only (no markdown fencing):
{
  "scores": {
    "faithfulness": 0.0,
    "completeness": 0.0,
    "conciseness": 0.0,
    "coherence": 0.0,
    "citation_accuracy": 0.0
  },
  "qualitative_feedback": "...",
  "flagged_issues": [
    {"type": "unsupported_claim|missing_info|verbatim_copy|other", "text": "the problematic text", "detail": "explanation"}
  ],
  "key_facts_extracted": ["fact 1", "fact 2"]
}`;

function buildUserPrompt(question: string, passages: string, synthesis: string): string {
  return `RESEARCH QUESTION: ${question}

SOURCE PASSAGES:
${passages}

AI-GENERATED SYNTHESIS:
${synthesis}

Evaluate the synthesis against the source passages. Respond with JSON only.`;
}

function formatPassages(entry: SynthesisCaptureFile['test_cases'][0]): string {
  return entry.retrieved_passages
    .map((p, i) =>
      `[${i + 1}] "${p.title}" (doc: ${p.doc_id}, score: ${p.score.toFixed(3)})\n${p.snippet}`
    )
    .join('\n\n---\n\n');
}

async function evaluateWithLLM(
  question: string,
  passagesText: string,
  synthesisText: string,
  apiKey: string,
): Promise<LLMEvalEntry & { test_case_id: string }> {
  const userPrompt = buildUserPrompt(question, passagesText, synthesisText);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EVALUATOR_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      // GPT-5.2 thinking mode parameters — adjust based on API docs when available
      max_completion_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;

  // Parse JSON response
  let parsed: {
    scores: SynthesisScores;
    qualitative_feedback: string;
    flagged_issues: FlaggedIssue[];
    key_facts_extracted: string[];
  };

  try {
    const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('  Failed to parse LLM response, using defaults');
    parsed = {
      scores: { faithfulness: 0, completeness: 0, conciseness: 0, coherence: 0, citation_accuracy: 0 },
      qualitative_feedback: `Parse error. Raw content: ${content.slice(0, 500)}`,
      flagged_issues: [],
      key_facts_extracted: [],
    };
  }

  return {
    test_case_id: '', // filled by caller
    scores: parsed.scores,
    qualitative_feedback: parsed.qualitative_feedback,
    flagged_issues: parsed.flagged_issues || [],
    key_facts_extracted: parsed.key_facts_extracted || [],
    model: EVALUATOR_MODEL,
    reasoning_tokens: reasoningTokens,
  };
}

async function main() {
  console.log('=== Stage 2: LLM Evaluation ===\n');

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input file not found: ${INPUT_PATH}`);
    console.error('Run stage 1 first: npx tsx evaluation/run-answer-synthesis-capture.ts');
    process.exit(1);
  }

  const captured: SynthesisCaptureFile = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  console.log(`Loaded ${captured.test_cases.length} captured test cases\n`);

  const output: LLMEvalFile = {
    evaluated_at: new Date().toISOString(),
    evaluator_model: EVALUATOR_MODEL,
    test_cases: [],
  };

  for (const tc of captured.test_cases) {
    console.log(`Evaluating: ${tc.test_case_id}`);
    console.log(`  Synthesis: ${tc.synthesis.full_text.slice(0, 100)}...`);

    const passagesText = formatPassages(tc);
    const result = await evaluateWithLLM(
      tc.question,
      passagesText,
      tc.synthesis.full_text,
      apiKey,
    );
    result.test_case_id = tc.test_case_id;

    const s = result.scores;
    const avg = (s.faithfulness + s.completeness + s.conciseness + s.coherence + s.citation_accuracy) / 5;
    console.log(`  Scores: F=${s.faithfulness} Co=${s.completeness} Cn=${s.conciseness} Ch=${s.coherence} Ci=${s.citation_accuracy} (avg=${avg.toFixed(2)})`);
    console.log(`  Key facts: ${result.key_facts_extracted.length}, Issues: ${result.flagged_issues.length}`);

    output.test_cases.push(result);

    // Rate limit — GPT-5.2 thinking uses significant tokens
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.test_cases.length} evaluations to ${OUTPUT_PATH}`);

  // Print summary
  const dims: (keyof SynthesisScores)[] = ['faithfulness', 'completeness', 'conciseness', 'coherence', 'citation_accuracy'];
  console.log('\n=== AGGREGATE SCORES ===');
  for (const dim of dims) {
    const avg = output.test_cases.reduce((sum, tc) => sum + tc.scores[dim], 0) / output.test_cases.length;
    console.log(`  ${dim}: ${avg.toFixed(2)}`);
  }

  console.log('\nNext step: npx tsx evaluation/serve-label-review.ts');
  console.log('Then open: http://localhost:3001/eval/review-synthesis');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
```

**Step 2: Test manually**

```bash
# Requires: OPENAI_API_KEY set, answer-synthesis-raw.json present
npx tsx evaluation/run-answer-synthesis-llm-eval.ts
# Expected: Creates evaluation/answer-synthesis-llm-eval.json with scores per test case
python3 -c "
import json
d = json.load(open('evaluation/answer-synthesis-llm-eval.json'))
for tc in d['test_cases']:
    s = tc['scores']
    avg = sum(s.values()) / len(s)
    print(f\"{tc['test_case_id']}: avg={avg:.2f} facts={len(tc['key_facts_extracted'])} issues={len(tc['flagged_issues'])}\")
"
```

**Step 3: Commit**

```bash
git add evaluation/run-answer-synthesis-llm-eval.ts
git commit -m "feat(eval): add LLM evaluation script with GPT-5.2 thinking (stage 2)"
```

---

### Task 4: Merge Stage 1 + 2 Outputs into Review-Ready File

Before building the review UI, we need a script that merges the capture data and LLM eval into the `answer-synthesis-eval-final.json` file that the review UI will read/write.

**Files:**
- Create: `evaluation/prepare-synthesis-review.ts`

**Step 1: Write the merge script**

```typescript
/**
 * Merge capture + LLM eval data into the review-ready format.
 *
 * Reads answer-synthesis-raw.json and answer-synthesis-llm-eval.json,
 * produces answer-synthesis-eval-final.json with empty human_eval fields
 * ready for the review UI.
 *
 * Usage: npx tsx evaluation/prepare-synthesis-review.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  SynthesisCaptureFile,
  LLMEvalFile,
  SynthesisEvalFinalFile,
  SynthesisEvalFinalEntry,
  HumanEval,
} from './lib/types';

const EVAL_DIR = path.dirname(__filename);
const CAPTURE_PATH = path.join(EVAL_DIR, 'answer-synthesis-raw.json');
const LLM_EVAL_PATH = path.join(EVAL_DIR, 'answer-synthesis-llm-eval.json');
const OUTPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-eval-final.json');

function emptyHumanEval(): HumanEval {
  return {
    scores: { faithfulness: 0, completeness: 0, conciseness: 0, coherence: 0, citation_accuracy: 0 },
    qualitative_feedback: '',
    key_facts_confirmed: [],
    key_facts_added: [],
    reviewed: false,
  };
}

function main() {
  console.log('=== Preparing Synthesis Review Data ===\n');

  const captured: SynthesisCaptureFile = JSON.parse(fs.readFileSync(CAPTURE_PATH, 'utf-8'));
  const llmEval: LLMEvalFile = JSON.parse(fs.readFileSync(LLM_EVAL_PATH, 'utf-8'));

  // Index LLM evals by test_case_id
  const evalMap = new Map(llmEval.test_cases.map(tc => [tc.test_case_id, tc]));

  // If output already exists, preserve existing human reviews
  let existingHumanEvals = new Map<string, HumanEval>();
  if (fs.existsSync(OUTPUT_PATH)) {
    const existing: SynthesisEvalFinalFile = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    existingHumanEvals = new Map(
      existing.test_cases
        .filter(tc => tc.human_eval.reviewed)
        .map(tc => [tc.test_case_id, tc.human_eval])
    );
    console.log(`Preserving ${existingHumanEvals.size} existing human reviews\n`);
  }

  const entries: SynthesisEvalFinalEntry[] = [];

  for (const tc of captured.test_cases) {
    const llm = evalMap.get(tc.test_case_id);
    if (!llm) {
      console.warn(`  WARNING: No LLM eval for ${tc.test_case_id}, skipping`);
      continue;
    }

    const existingHuman = existingHumanEvals.get(tc.test_case_id);

    entries.push({
      test_case_id: tc.test_case_id,
      question: tc.question,
      synthesis_text: tc.synthesis.full_text,
      passage_count: tc.retrieved_passages.length,
      llm_eval: llm,
      human_eval: existingHuman || emptyHumanEval(),
    });

    console.log(`  ${tc.test_case_id}: ${existingHuman ? 'preserved human review' : 'awaiting review'}`);
  }

  const output: SynthesisEvalFinalFile = {
    evaluated_at: new Date().toISOString(),
    system_model: captured.system_model,
    evaluator_model: llmEval.evaluator_model,
    test_cases: entries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${entries.length} entries to ${OUTPUT_PATH}`);
}

main();
```

**Step 2: Test manually**

```bash
npx tsx evaluation/prepare-synthesis-review.ts
# Expected: Creates evaluation/answer-synthesis-eval-final.json
python3 -c "
import json
d = json.load(open('evaluation/answer-synthesis-eval-final.json'))
for tc in d['test_cases']:
    print(f\"{tc['test_case_id']}: reviewed={tc['human_eval']['reviewed']}\")
"
```

**Step 3: Commit**

```bash
git add evaluation/prepare-synthesis-review.ts
git commit -m "feat(eval): add script to merge capture + LLM eval into review format"
```

---

### Task 5: Stage 3 — Synthesis Review UI (Server Routes)

**Files:**
- Modify: `evaluation/serve-label-review.ts`

Add new API routes and HTML page for synthesis review. The server already handles label review at `/eval/review-labels`; we add parallel routes for synthesis review.

**Step 1: Add new constants and file paths**

At the top of `serve-label-review.ts`, after the existing `LABELS_PATH` constant, add:

```typescript
const SYNTHESIS_EVAL_PATH = path.join(__dirname, 'answer-synthesis-eval-final.json');
const SYNTHESIS_RAW_PATH = path.join(__dirname, 'answer-synthesis-raw.json');
```

**Step 2: Add API routes to the server**

Inside the `http.createServer` callback, before the 404 handler, add three new routes:

```typescript
    // GET /eval/review-synthesis → serve synthesis review HTML page
    if (req.method === 'GET' && pathname === '/eval/review-synthesis') {
      html(res, SYNTHESIS_REVIEW_HTML);
      return;
    }

    // GET /api/synthesis-eval → return synthesis eval JSON
    if (req.method === 'GET' && pathname === '/api/synthesis-eval') {
      if (!fs.existsSync(SYNTHESIS_EVAL_PATH)) {
        json(res, 404, { error: 'answer-synthesis-eval-final.json not found. Run stages 1-2 first.' });
        return;
      }
      const data = JSON.parse(fs.readFileSync(SYNTHESIS_EVAL_PATH, 'utf-8'));
      json(res, 200, data);
      return;
    }

    // GET /api/synthesis-raw → return captured passages for a test case
    if (req.method === 'GET' && pathname === '/api/synthesis-raw') {
      if (!fs.existsSync(SYNTHESIS_RAW_PATH)) {
        json(res, 404, { error: 'answer-synthesis-raw.json not found. Run stage 1 first.' });
        return;
      }
      const data = JSON.parse(fs.readFileSync(SYNTHESIS_RAW_PATH, 'utf-8'));
      const testCaseId = url.searchParams.get('id');
      if (testCaseId) {
        const tc = data.test_cases.find((t: any) => t.test_case_id === testCaseId);
        json(res, tc ? 200 : 404, tc || { error: 'Test case not found' });
      } else {
        json(res, 200, data);
      }
      return;
    }

    // POST /api/synthesis-eval/review → update human eval for a test case
    if (req.method === 'POST' && pathname === '/api/synthesis-eval/review') {
      const body = await collectBody(req);
      let parsed: {
        test_case_id: string;
        human_eval: {
          scores: Record<string, number>;
          qualitative_feedback: string;
          key_facts_confirmed: string[];
          key_facts_added: string[];
          reviewed: boolean;
        };
      };
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (!parsed.test_case_id || !parsed.human_eval) {
        json(res, 400, { error: 'Missing test_case_id or human_eval' });
        return;
      }

      const data = JSON.parse(fs.readFileSync(SYNTHESIS_EVAL_PATH, 'utf-8'));
      const tc = data.test_cases.find((t: any) => t.test_case_id === parsed.test_case_id);
      if (!tc) {
        json(res, 404, { error: 'Test case not found' });
        return;
      }

      tc.human_eval = parsed.human_eval;
      fs.writeFileSync(SYNTHESIS_EVAL_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      json(res, 200, { ok: true });
      return;
    }
```

**Step 3: Verify the server starts and routes respond**

```bash
npx tsx evaluation/serve-label-review.ts &
# Test routes:
curl -s http://localhost:3001/api/synthesis-eval | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"test_cases\",[]))} test cases')"
curl -s http://localhost:3001/eval/review-synthesis | head -5
kill %1
```

**Step 4: Commit**

```bash
git add evaluation/serve-label-review.ts
git commit -m "feat(eval): add synthesis review API routes to label review server"
```

---

### Task 6: Stage 3 — Synthesis Review UI (HTML Page)

**Files:**
- Modify: `evaluation/serve-label-review.ts`

Add the `SYNTHESIS_REVIEW_HTML` constant. This is the self-contained HTML page for human review of synthesis quality.

**Step 1: Write the HTML template**

Add a new constant `SYNTHESIS_REVIEW_HTML` after the existing `REVIEW_HTML` constant. The page should:

- **Summary bar** (sticky top): "X/9 reviewed" plus average scores across all 5 dimensions
- **Test case sections** (collapsible, one per question):
  - Question text as header
  - Review status badge (green "Reviewed" / orange "Pending")
  - **Passages panel** (collapsible): shows the passages used, each with title, doc_id, score badge, truncated snippet with expand toggle
  - **Synthesis display**: the 2-3 sentence answer in a highlighted box
  - **LLM Evaluation panel**:
    - 5 score bars (colored: green >0.7, yellow >0.4, red otherwise) showing dimension name + score
    - Qualitative feedback in a blockquote
    - Flagged issues as warning cards (if any)
    - Key facts as a bulleted list
  - **Human Evaluation panel**:
    - 5 range sliders (0.0–1.0, step 0.1) pre-filled with LLM scores, labeled with dimension names
    - Textarea for qualitative feedback
    - Checkboxes next to each LLM-extracted key fact (pre-checked = confirmed)
    - Text input + "Add fact" button for additional key facts
    - "Mark as Reviewed" button that sets `reviewed: true`
  - Every slider change, checkbox toggle, and text blur triggers autosave via `POST /api/synthesis-eval/review`

**Key UI patterns** (match existing label review):
- Same CSS variable scheme, font stack, layout patterns
- Lazy rendering: chunk/passage cards rendered on first section expand
- Autosave with "Saved" flash indicator
- Error banner for save failures

**JavaScript behavior:**
- On load: `fetch('/api/synthesis-eval')` + `fetch('/api/synthesis-raw')` to get both files
- Render all sections collapsed
- On expand: lazy-render the full content
- Autosave debounced (300ms) on slider/input changes, immediate on checkbox/button clicks
- Summary bar updates after each save

The HTML should be written as a template literal string assigned to `const SYNTHESIS_REVIEW_HTML`. It will be approximately 400-600 lines of HTML/CSS/JS (matching the scale of the existing `REVIEW_HTML` which is ~630 lines).

**Implementation note:** The full HTML is too long to include inline in this plan. The implementer should follow the patterns in the existing `REVIEW_HTML` constant (lines 27-632 of `serve-label-review.ts`) and adapt them for the synthesis review layout described above. Key differences from the label review page:
- Sliders instead of 3-button label selectors
- Textarea for qualitative feedback
- Checkbox list for key facts
- Two data sources (eval final + raw captures for passages)

**Step 2: Test in browser**

```bash
npx tsx evaluation/serve-label-review.ts
# Open http://localhost:3001/eval/review-synthesis
# Verify:
# 1. Summary bar shows correct counts
# 2. Expanding a test case shows passages, synthesis, LLM scores
# 3. Moving a slider and clicking away triggers autosave (flash "Saved")
# 4. Checking/unchecking a key fact autosaves
# 5. Clicking "Mark as Reviewed" updates the badge
# 6. Verify persistence: close browser, reopen, confirm scores persisted
```

**Step 3: Commit**

```bash
git add evaluation/serve-label-review.ts
git commit -m "feat(eval): add synthesis review HTML page with autosave UI"
```

---

### Task 7: Stage 4 — Assemble Ground Truth

**Files:**
- Create: `evaluation/assemble-synthesis-ground-truth.ts`

**Step 1: Write the assembly script**

Reads the reviewed eval file and writes qualifying answers back to the golden dataset.

```typescript
/**
 * Stage 4: Assemble synthesis ground truth.
 *
 * Reads answer-synthesis-eval-final.json (with human reviews),
 * writes canonical_answer and key_facts back into answer-golden-dataset.json
 * for test cases meeting the quality threshold.
 *
 * Usage: npx tsx evaluation/assemble-synthesis-ground-truth.ts [--threshold 0.7]
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  AnswerGoldenDataset,
  SynthesisEvalFinalFile,
  SynthesisScores,
} from './lib/types';

const EVAL_DIR = path.dirname(__filename);
const EVAL_FINAL_PATH = path.join(EVAL_DIR, 'answer-synthesis-eval-final.json');
const GOLDEN_PATH = path.join(EVAL_DIR, 'answer-golden-dataset.json');

function avgScore(scores: SynthesisScores): number {
  const vals = Object.values(scores);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function main() {
  // Parse threshold from CLI args
  const args = process.argv.slice(2);
  const threshIdx = args.indexOf('--threshold');
  const threshold = threshIdx >= 0 ? parseFloat(args[threshIdx + 1]) : 0.7;

  console.log(`=== Stage 4: Assemble Synthesis Ground Truth ===`);
  console.log(`Quality threshold: ${threshold}\n`);

  const evalData: SynthesisEvalFinalFile = JSON.parse(fs.readFileSync(EVAL_FINAL_PATH, 'utf-8'));
  const golden: AnswerGoldenDataset = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8'));

  // Index golden test cases
  const goldenMap = new Map(golden.test_cases.map(tc => [tc.id, tc]));

  let updated = 0;
  let skippedNotReviewed = 0;
  let skippedBelowThreshold = 0;

  for (const tc of evalData.test_cases) {
    const goldenTc = goldenMap.get(tc.test_case_id);
    if (!goldenTc) {
      console.warn(`  ${tc.test_case_id}: not in golden dataset, skipping`);
      continue;
    }

    if (!tc.human_eval.reviewed) {
      console.log(`  ${tc.test_case_id}: not yet reviewed, skipping`);
      skippedNotReviewed++;
      continue;
    }

    const humanAvg = avgScore(tc.human_eval.scores);
    if (humanAvg < threshold) {
      console.log(`  ${tc.test_case_id}: human avg ${humanAvg.toFixed(2)} < ${threshold}, skipping (feedback preserved in eval file)`);
      skippedBelowThreshold++;
      continue;
    }

    // Combine confirmed + added key facts
    const keyFacts = [
      ...tc.human_eval.key_facts_confirmed,
      ...tc.human_eval.key_facts_added,
    ];

    goldenTc.synthesis_ground_truth = {
      canonical_answer: tc.synthesis_text,
      key_facts: keyFacts,
    };

    console.log(`  ${tc.test_case_id}: updated (avg=${humanAvg.toFixed(2)}, ${keyFacts.length} key facts)`);
    updated++;
  }

  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (not reviewed): ${skippedNotReviewed}`);
  console.log(`  Skipped (below threshold): ${skippedBelowThreshold}`);
  console.log(`  Golden dataset saved: ${GOLDEN_PATH}`);
}

main();
```

**Step 2: Test manually**

```bash
npx tsx evaluation/assemble-synthesis-ground-truth.ts
# Expected: Updates answer-golden-dataset.json for qualifying test cases
python3 -c "
import json
d = json.load(open('evaluation/answer-golden-dataset.json'))
for tc in d['test_cases']:
    gt = tc['synthesis_ground_truth']
    has = bool(gt['canonical_answer'])
    print(f\"{tc['id']}: {'populated' if has else 'empty'} ({len(gt['key_facts'])} facts)\")
"
```

**Step 3: Commit**

```bash
git add evaluation/assemble-synthesis-ground-truth.ts
git commit -m "feat(eval): add synthesis ground truth assembly script (stage 4)"
```

---

### Task 8: Add npm Scripts

**Files:**
- Modify: `package.json`

**Step 1: Add scripts**

Add to the `"scripts"` section in `package.json`:

```json
"eval:synthesis-capture": "npx tsx evaluation/run-answer-synthesis-capture.ts",
"eval:synthesis-llm-eval": "npx tsx evaluation/run-answer-synthesis-llm-eval.ts",
"eval:synthesis-prepare-review": "npx tsx evaluation/prepare-synthesis-review.ts",
"eval:synthesis-assemble": "npx tsx evaluation/assemble-synthesis-ground-truth.ts"
```

**Step 2: Verify scripts work**

```bash
npm run eval:synthesis-capture -- --help 2>&1 | head -3
# Should not error on script resolution
```

**Step 3: Commit**

```bash
git add package.json
git commit -m "feat(eval): add npm scripts for synthesis evaluation pipeline"
```

---

### Task 9: Add Generated Files to .gitignore

**Files:**
- Modify: `.gitignore`

**Step 1: Add synthesis eval intermediates**

Append to `.gitignore` (in the evaluation section if one exists):

```
# Synthesis eval intermediates (regenerated by pipeline)
evaluation/answer-synthesis-raw.json
evaluation/answer-synthesis-llm-eval.json
```

Note: `answer-synthesis-eval-final.json` should be tracked in git (like `answer-labels-review.json`) since it contains human review data that must persist.

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore synthesis eval intermediates"
```

---

### Task 10: Update Evaluation README

**Files:**
- Modify: `evaluation/README.md`

**Step 1: Add synthesis eval documentation**

In the **Quick Reference** section, after the existing Answer Mode block, add:

```markdown
**Synthesis Evaluation (Track 2 — Human-in-the-loop):**
```bash
# Stage 1: Capture system outputs (needs hybrid + Next.js)
npm run eval:synthesis-capture

# Stage 2: LLM scoring (needs OPENAI_API_KEY)
npm run eval:synthesis-llm-eval

# Merge into review format
npm run eval:synthesis-prepare-review

# Stage 3: Human review
npm run eval:golden-review
# → http://localhost:3001/eval/review-synthesis

# Stage 4: Write ground truth to golden dataset
npm run eval:synthesis-assemble
```

In the **Answer Mode Evaluation** section, update the Track 2 description to reference the new pipeline and its relationship to the older RAGAS-based approach.

In the **File Structure** section, add the new files:

```
├── # Answer Mode — Synthesis Evaluation
├── run-answer-synthesis-capture.ts       # Stage 1: capture system outputs
├── run-answer-synthesis-llm-eval.ts      # Stage 2: GPT-5.2 scoring
├── prepare-synthesis-review.ts           # Merge into review-ready format
├── assemble-synthesis-ground-truth.ts    # Stage 4: write back to golden dataset
├── answer-synthesis-eval-final.json      # Human-reviewed synthesis scores (tracked)
```

**Step 2: Commit**

```bash
git add evaluation/README.md
git commit -m "docs(eval): add synthesis evaluation pipeline to README"
```

---

### Task 11: End-to-End Smoke Test

This is a manual verification task to run after all code is written.

**Step 1: Run the full pipeline**

```bash
# Prerequisites
npm run hybrid &    # :8002
npm run dev &       # :3000

# Stage 1
npm run eval:synthesis-capture
# Verify: evaluation/answer-synthesis-raw.json exists with 9 test cases

# Stage 2
npm run eval:synthesis-llm-eval
# Verify: evaluation/answer-synthesis-llm-eval.json exists with scores

# Merge
npm run eval:synthesis-prepare-review
# Verify: evaluation/answer-synthesis-eval-final.json exists

# Stage 3
npm run eval:golden-review
# Open http://localhost:3001/eval/review-synthesis
# Review 1-2 test cases:
#   - Adjust slider scores
#   - Add qualitative feedback
#   - Confirm/reject key facts
#   - Click "Mark as Reviewed"
# Verify autosave works (check JSON file)

# Stage 4
npm run eval:synthesis-assemble
# Verify: answer-golden-dataset.json has synthesis_ground_truth populated
# for reviewed test cases above threshold
```

**Step 2: Verify backward compatibility**

```bash
# Existing retrieval eval still works
npm run eval:answer-retrieval

# Existing RAGAS synthesis eval still works (if deps installed)
npm run eval:answer-synthesis
```

**Step 3: Final commit**

```bash
git add evaluation/answer-synthesis-eval-final.json
git commit -m "chore(eval): track synthesis eval review data"
```
