# Answer Golden Set Generation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a chunk-first pipeline that generates a production answer-mode golden dataset from live index retrieval, LLM-assisted labeling, and human review.

**Architecture:** A single TypeScript pipeline script with phase flags (`--phase retrieve|label|assemble`) plus a standalone review server. All phases read/write JSON intermediates. The review UI is a self-contained HTML page served by Node's built-in `http` module — no new dependencies.

**Tech Stack:** TypeScript (tsx), Node built-in `http`/`fs`, OpenAI API (via fetch, matching existing patterns in `src/app/api/answer/route.ts`), existing `callPythonService()` from `evaluation/lib/service-client.ts`.

---

### Task 1: Create the Question Bank JSON

**Files:**
- Create: `evaluation/answer-question-bank.json`

**Step 1: Write the question bank file**

```json
{
  "version": "1.0",
  "description": "Answer mode evaluation questions - human-written anchor set",
  "questions": [
    {
      "id": "ans_001",
      "question": "What role do land value capture mechanisms play in more equitable urban development?",
      "query_type": "mechanism_role",
      "difficulty": "medium",
      "source": "human"
    },
    {
      "id": "ans_002",
      "question": "Are denser cities more sustainable? Why?",
      "query_type": "causal",
      "difficulty": "hard",
      "source": "human"
    },
    {
      "id": "ans_003",
      "question": "How can national governments better integrate subnational leadership into their NDCs?",
      "query_type": "policy_integration",
      "difficulty": "medium",
      "source": "human"
    },
    {
      "id": "ans_004",
      "question": "How do we improve motorcycle safety in cities?",
      "query_type": "intervention_design",
      "difficulty": "medium",
      "source": "human"
    },
    {
      "id": "ans_005",
      "question": "How can cities pay for electric buses?",
      "query_type": "financing",
      "difficulty": "medium",
      "source": "human"
    },
    {
      "id": "ans_006",
      "question": "What are nature-based solutions and how can they improve cities?",
      "query_type": "conceptual",
      "difficulty": "medium",
      "source": "human"
    },
    {
      "id": "ans_007",
      "question": "How do slums and informality affect climate resilience in cities?",
      "query_type": "impact_assessment",
      "difficulty": "hard",
      "source": "human"
    },
    {
      "id": "ans_008",
      "question": "What are the key opportunities for enhancing public transport in NDCs?",
      "query_type": "opportunity_identification",
      "difficulty": "medium",
      "source": "human"
    },
    {
      "id": "ans_009",
      "question": "How do we make housing more affordable in cities?",
      "query_type": "intervention_design",
      "difficulty": "hard",
      "source": "human"
    }
  ]
}
```

**Step 2: Commit**

```bash
git add evaluation/answer-question-bank.json
git commit -m "feat(eval): add answer mode question bank with 9 human-written queries"
```

---

### Task 2: Pipeline Script — Phase: Retrieve

**Files:**
- Create: `evaluation/generate-answer-golden-set.ts`

**Step 1: Write the retrieval phase**

The script parses CLI args for `--phase`, loads the question bank, and runs each question against the hybrid service. Uses the existing `callPythonService()` and `checkPythonService()` from `evaluation/lib/service-client.ts`.

```typescript
/**
 * Answer Golden Set Generation Pipeline
 *
 * Phases:
 *   --phase retrieve  Query hybrid service, save raw chunks
 *   --phase label     LLM-label each chunk for relevance
 *   --phase assemble  Build final golden dataset from reviewed labels
 *   (no flag)         Run all phases sequentially
 *
 * Usage: npx tsx evaluation/generate-answer-golden-set.ts [--phase retrieve|label|assemble]
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPythonService, callPythonService, PYTHON_SERVICE_URL } from './lib/service-client';

// --- Types ---

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

interface LabeledChunk {
  chunk_id: string;
  doc_id: string;
  title: string;
  content: string;
  score: number;
  page: number;
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

// --- Config ---

const ANSWER_PARAMS = {
  vector_top_k: 150,
  bm25_top_k: 150,
  rerank_top_n: 10,
};

const EVAL_DIR = path.dirname(__filename);
const QUESTION_BANK_PATH = path.join(EVAL_DIR, 'answer-question-bank.json');
const RETRIEVAL_RAW_PATH = path.join(EVAL_DIR, 'answer-retrieval-raw.json');
const LABELS_REVIEW_PATH = path.join(EVAL_DIR, 'answer-labels-review.json');
const GOLDEN_DATASET_PATH = path.join(EVAL_DIR, 'answer-golden-dataset.json');

// --- Phase: Retrieve ---

async function phaseRetrieve(): Promise<void> {
  console.log('Phase: RETRIEVE');
  console.log(`Checking Python service at ${PYTHON_SERVICE_URL}...`);

  const available = await checkPythonService();
  if (!available) {
    console.error(`Python service not available at ${PYTHON_SERVICE_URL}`);
    console.error('Start with: npm run hybrid');
    process.exit(1);
  }
  console.log('Python service is running\n');

  const bank: QuestionBank = JSON.parse(fs.readFileSync(QUESTION_BANK_PATH, 'utf-8'));
  console.log(`Loaded ${bank.questions.length} questions\n`);

  const raw: RetrievalRaw = {
    retrieved_at: new Date().toISOString(),
    questions: [],
  };

  for (const q of bank.questions) {
    console.log(`  ${q.id}: ${q.question}`);
    const docs = await callPythonService(q.question, 'answer', ANSWER_PARAMS);

    const chunks: RetrievedChunk[] = docs.map(d => ({
      chunk_id: d.metadata?.chunk_id || d.chunk_id || 'unknown',
      doc_id: d.doc_id,
      title: d.title,
      content: d.content,
      score: d.score,
      page: d.page || d.metadata?.page || 1,
    }));

    console.log(`    Retrieved ${chunks.length} chunks from ${new Set(chunks.map(c => c.doc_id)).size} docs`);

    raw.questions.push({
      id: q.id,
      question: q.question,
      query_type: q.query_type,
      difficulty: q.difficulty,
      retrieved_chunks: chunks,
    });

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  fs.writeFileSync(RETRIEVAL_RAW_PATH, JSON.stringify(raw, null, 2));
  console.log(`\nSaved: ${RETRIEVAL_RAW_PATH}`);
}
```

Note: `__filename` works with tsx. The script uses `callPythonService` which returns `RawServiceDoc[]` — we extract chunk metadata from the raw response.

**Step 2: Test manually**

```bash
# Requires hybrid service running
npx tsx evaluation/generate-answer-golden-set.ts --phase retrieve
# Expected: Creates evaluation/answer-retrieval-raw.json with 9 questions × 10 chunks each
cat evaluation/answer-retrieval-raw.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d[\"questions\"])} questions'); print(f'{sum(len(q[\"retrieved_chunks\"]) for q in d[\"questions\"])} total chunks')"
```

**Step 3: Commit**

```bash
git add evaluation/generate-answer-golden-set.ts
git commit -m "feat(eval): add golden set pipeline - retrieve phase"
```

---

### Task 3: Pipeline Script — Phase: Label

**Files:**
- Modify: `evaluation/generate-answer-golden-set.ts`

**Step 1: Add the labeling phase**

Add to the same file after `phaseRetrieve`. Uses OpenAI API via fetch (matching the pattern in `src/app/api/answer/route.ts`). Sends all 10 chunks per question in one call.

```typescript
// --- Phase: Label ---

async function phaseLabel(): Promise<void> {
  console.log('Phase: LABEL');

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  const raw: RetrievalRaw = JSON.parse(fs.readFileSync(RETRIEVAL_RAW_PATH, 'utf-8'));
  console.log(`Loaded ${raw.questions.length} questions from retrieval results\n`);

  const labels: LabelsReview = {
    labeled_at: new Date().toISOString(),
    questions: [],
  };

  for (const q of raw.questions) {
    console.log(`  Labeling: ${q.id} (${q.retrieved_chunks.length} chunks)`);

    const chunksForPrompt = q.retrieved_chunks.map((c, i) => (
      `CHUNK ${i + 1}:\n  chunk_id: ${c.chunk_id}\n  doc_id: ${c.doc_id}\n  title: ${c.title}\n  score: ${c.score}\n  content: ${c.content}\n`
    )).join('\n---\n');

    const systemPrompt = `You are an expert research librarian evaluating retrieval results for a research Q&A system focused on urban sustainability, climate, and development topics (World Resources Institute corpus).

For each retrieved chunk, assess whether it contains information that would be useful for answering the given question. Consider:
- Does the chunk contain facts, evidence, or analysis directly relevant to the question?
- Would this chunk contribute meaningfully to a synthesized answer?
- Is the relevance direct or tangential?

Label each chunk as:
- "relevant": Contains information directly useful for answering the question
- "partially_relevant": From a relevant document but this specific passage is tangential or only loosely connected
- "not_relevant": Not useful for answering the question

Rate your confidence as "high", "medium", or "low".
Provide a one-sentence rationale.

Respond with a JSON array (no markdown fencing) where each element has:
{ "chunk_index": <1-based>, "label": "relevant"|"partially_relevant"|"not_relevant", "confidence": "high"|"medium"|"low", "rationale": "..." }`;

    const userPrompt = `QUESTION: ${q.question}\n\n${chunksForPrompt}\n\nLabel each chunk. Respond with a JSON array only.`;

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
      const err = await response.text();
      console.error(`    OpenAI error: ${response.status} - ${err}`);
      // Write empty labels for this question, continue
      labels.questions.push({
        id: q.id,
        question: q.question,
        query_type: q.query_type,
        difficulty: q.difficulty,
        chunks: q.retrieved_chunks.map(c => ({
          ...c,
          label: 'not_relevant' as const,
          confidence: 'low' as const,
          rationale: 'LLM labeling failed',
          human_override: null,
        })),
      });
      continue;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '[]';

    let llmLabels: Array<{
      chunk_index: number;
      label: string;
      confidence: string;
      rationale: string;
    }>;
    try {
      llmLabels = JSON.parse(content.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    } catch {
      console.error(`    Failed to parse LLM response for ${q.id}`);
      llmLabels = [];
    }

    const labeledChunks: LabeledChunk[] = q.retrieved_chunks.map((c, i) => {
      const llm = llmLabels.find(l => l.chunk_index === i + 1);
      return {
        ...c,
        label: (llm?.label as LabeledChunk['label']) || 'not_relevant',
        confidence: (llm?.confidence as LabeledChunk['confidence']) || 'low',
        rationale: llm?.rationale || 'No LLM label',
        human_override: null,
      };
    });

    const relevant = labeledChunks.filter(c => c.label === 'relevant').length;
    const partial = labeledChunks.filter(c => c.label === 'partially_relevant').length;
    const needsReview = labeledChunks.filter(c => c.confidence !== 'high').length;
    console.log(`    ${relevant} relevant, ${partial} partial, ${needsReview} need review`);

    labels.questions.push({
      id: q.id,
      question: q.question,
      query_type: q.query_type,
      difficulty: q.difficulty,
      chunks: labeledChunks,
    });

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  fs.writeFileSync(LABELS_REVIEW_PATH, JSON.stringify(labels, null, 2));
  console.log(`\nSaved: ${LABELS_REVIEW_PATH}`);

  const totalNeedsReview = labels.questions.reduce(
    (sum, q) => sum + q.chunks.filter(c => c.confidence !== 'high').length, 0
  );
  console.log(`\nTotal chunks needing human review: ${totalNeedsReview}`);
  console.log('Start review server: npx tsx evaluation/serve-label-review.ts');
}
```

**Step 2: Test manually**

```bash
# Requires OPENAI_API_KEY set and answer-retrieval-raw.json present
npx tsx evaluation/generate-answer-golden-set.ts --phase label
# Expected: Creates evaluation/answer-labels-review.json
cat evaluation/answer-labels-review.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
for q in d['questions']:
    labels = [c['label'] for c in q['chunks']]
    needs = sum(1 for c in q['chunks'] if c['confidence'] != 'high')
    print(f\"{q['id']}: {labels.count('relevant')}R {labels.count('partially_relevant')}P {labels.count('not_relevant')}N | {needs} need review\")
"
```

**Step 3: Commit**

```bash
git add evaluation/generate-answer-golden-set.ts
git commit -m "feat(eval): add golden set pipeline - label phase with LLM classification"
```

---

### Task 4: Pipeline Script — Phase: Assemble

**Files:**
- Modify: `evaluation/generate-answer-golden-set.ts`

**Step 1: Add the assembly phase**

Reads reviewed labels, maps to the existing `AnswerGoldenDataset` schema from `evaluation/lib/types.ts`.

```typescript
// --- Phase: Assemble ---

import type { AnswerGoldenDataset, AnswerTestCase, ExpectedPassage } from './lib/types';

function phaseAssemble(): void {
  console.log('Phase: ASSEMBLE');

  const labels: LabelsReview = JSON.parse(fs.readFileSync(LABELS_REVIEW_PATH, 'utf-8'));
  console.log(`Loaded ${labels.questions.length} labeled questions\n`);

  const testCases: AnswerTestCase[] = [];

  for (const q of labels.questions) {
    // Final label: human_override takes precedence
    const finalChunks = q.chunks.map(c => ({
      ...c,
      finalLabel: c.human_override || c.label,
    }));

    const relevantChunks = finalChunks.filter(c => c.finalLabel === 'relevant');
    const partialChunks = finalChunks.filter(c => c.finalLabel === 'partially_relevant');

    // Validation warnings
    if (relevantChunks.length === 0) {
      console.warn(`  WARNING: ${q.id} has 0 relevant chunks — consider removing or revising this question`);
    }
    if (relevantChunks.length === q.chunks.length) {
      console.warn(`  WARNING: ${q.id} has ALL chunks relevant — suspiciously easy`);
    }

    // expected_passages: only "relevant" chunks
    const expectedPassages: ExpectedPassage[] = relevantChunks.map(c => ({
      doc_id: c.doc_id,
      chunk_id: c.chunk_id,
      page: c.page,
      text_snippet: c.content,  // full chunk content, no truncation
    }));

    // expected_doc_ids: superset of relevant + partially_relevant
    const expectedDocIds = [
      ...new Set([
        ...relevantChunks.map(c => c.doc_id),
        ...partialChunks.map(c => c.doc_id),
      ]),
    ];

    console.log(`  ${q.id}: ${expectedPassages.length} passages, ${expectedDocIds.length} docs`);

    testCases.push({
      id: q.id,
      question: q.question,
      query_type: q.query_type,
      difficulty: q.difficulty,
      retrieval_ground_truth: {
        expected_passages: expectedPassages,
        expected_doc_ids: expectedDocIds,
      },
      synthesis_ground_truth: {
        canonical_answer: '',
        key_facts: [],
      },
    });
  }

  const goldenSet: AnswerGoldenDataset = {
    version: '2.0',
    description: 'Answer mode golden set - chunk-first, human-validated',
    test_cases: testCases,
    metadata: {
      status: 'production',
      generated_at: new Date().toISOString(),
      question_count: testCases.length,
      labeling_method: 'llm_assisted_human_override',
    },
  };

  fs.writeFileSync(GOLDEN_DATASET_PATH, JSON.stringify(goldenSet, null, 2));
  console.log(`\nSaved: ${GOLDEN_DATASET_PATH}`);
  console.log(`\nRun eval: npm run eval:answer-retrieval`);
}
```

**Step 2: Add CLI arg parsing and main function**

```typescript
// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const phaseIdx = args.indexOf('--phase');
  const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : 'all';

  switch (phase) {
    case 'retrieve':
      await phaseRetrieve();
      break;
    case 'label':
      await phaseLabel();
      break;
    case 'assemble':
      phaseAssemble();
      break;
    case 'all':
      await phaseRetrieve();
      await phaseLabel();
      console.log('\n--- Human review step ---');
      console.log('Start review server: npx tsx evaluation/serve-label-review.ts');
      console.log('After reviewing, run: npx tsx evaluation/generate-answer-golden-set.ts --phase assemble');
      break;
    default:
      console.error(`Unknown phase: ${phase}. Use: retrieve, label, assemble`);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
```

**Step 3: Test manually**

```bash
# Requires answer-labels-review.json present (from Task 3)
npx tsx evaluation/generate-answer-golden-set.ts --phase assemble
# Expected: Overwrites evaluation/answer-golden-dataset.json
cat evaluation/answer-golden-dataset.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Version: {d[\"version\"]}')
print(f'Test cases: {len(d[\"test_cases\"])}')
for tc in d['test_cases']:
    p = len(tc['retrieval_ground_truth']['expected_passages'])
    d_count = len(tc['retrieval_ground_truth']['expected_doc_ids'])
    print(f'  {tc[\"id\"]}: {p} passages, {d_count} docs')
"
```

**Step 4: Commit**

```bash
git add evaluation/generate-answer-golden-set.ts
git commit -m "feat(eval): add golden set pipeline - assemble phase and CLI entry point"
```

---

### Task 5: Review Server

**Files:**
- Create: `evaluation/serve-label-review.ts`

**Step 1: Write the review server**

Uses Node built-in `http` module. Serves a self-contained HTML page at `/eval/review-labels` and a JSON API at `/api/labels` for reading/writing label overrides. No new dependencies.

```typescript
/**
 * Label Review Server
 *
 * Serves a web UI for reviewing and overriding LLM-generated chunk labels.
 * Reads/writes evaluation/answer-labels-review.json.
 *
 * Usage: npx tsx evaluation/serve-label-review.ts
 * URL:   http://localhost:3001/eval/review-labels
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = 3001;
const LABELS_PATH = path.join(path.dirname(__filename), 'answer-labels-review.json');

function readLabels(): any {
  return JSON.parse(fs.readFileSync(LABELS_PATH, 'utf-8'));
}

function writeLabels(data: any): void {
  fs.writeFileSync(LABELS_PATH, JSON.stringify(data, null, 2));
}

function getReviewHtml(): string {
  // Returns the full self-contained HTML page
  // See Step 2 for the complete HTML
  return REVIEW_HTML;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Serve the review UI
  if (url.pathname === '/eval/review-labels' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getReviewHtml());
    return;
  }

  // API: Get all labels
  if (url.pathname === '/api/labels' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readLabels()));
    return;
  }

  // API: Update a single chunk's human_override (autosave)
  if (url.pathname === '/api/labels/override' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { question_id, chunk_id, override } = JSON.parse(body);
        const data = readLabels();
        const question = data.questions.find((q: any) => q.id === question_id);
        if (!question) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Question not found' }));
          return;
        }
        const chunk = question.chunks.find((c: any) => c.chunk_id === chunk_id);
        if (!chunk) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Chunk not found' }));
          return;
        }
        chunk.human_override = override; // 'relevant' | 'partially_relevant' | 'not_relevant' | null
        writeLabels(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Label review server running at http://localhost:${PORT}/eval/review-labels`);
});
```

**Step 2: Write the embedded HTML**

The `REVIEW_HTML` constant is a self-contained HTML page with inline CSS and JavaScript. Key behaviors:

- On load: fetches `/api/labels` and renders the page
- Collapsible question sections (all collapsed by default, click to expand)
- Within each question: "Needs Review" section (expanded) and "Auto-labeled" section (collapsed)
- Each chunk card: doc title, score badge, page number, collapsible full text, LLM rationale, three label buttons
- Label button click: sends POST to `/api/labels/override` (autosave), updates UI immediately
- Summary bar at top: "X/Y questions reviewed · Z chunks labeled"
- "Needs review" badge count per question in the sidebar

The HTML should be written as a template literal string in the TypeScript file. The page uses vanilla JS (no React/framework) since it's a standalone review tool.

Chunk cards show:
- Title and doc_id in the header
- Score as a colored badge (green > 0.7, yellow > 0.4, red otherwise)
- Page number
- Content: first 200 chars visible, "Show full text" toggle to expand
- LLM label + confidence + rationale in muted text below
- Three buttons: [Relevant] [Partial] [Not Relevant] — active button highlighted based on current effective label (human_override ?? label)

**Step 3: Test manually**

```bash
# Requires answer-labels-review.json present
npx tsx evaluation/serve-label-review.ts
# Open http://localhost:3001/eval/review-labels in browser
# Click through a few labels, verify autosave works:
cat evaluation/answer-labels-review.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
overrides = sum(1 for q in d['questions'] for c in q['chunks'] if c['human_override'])
print(f'Human overrides: {overrides}')
"
```

**Step 4: Commit**

```bash
git add evaluation/serve-label-review.ts
git commit -m "feat(eval): add label review server with autosave UI"
```

---

### Task 6: Add npm Scripts

**Files:**
- Modify: `package.json`

**Step 1: Add scripts**

Add these entries to the `"scripts"` section of `package.json`:

```json
"eval:golden-retrieve": "npx tsx evaluation/generate-answer-golden-set.ts --phase retrieve",
"eval:golden-label": "npx tsx evaluation/generate-answer-golden-set.ts --phase label",
"eval:golden-assemble": "npx tsx evaluation/generate-answer-golden-set.ts --phase assemble",
"eval:golden-review": "npx tsx evaluation/serve-label-review.ts"
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "feat(eval): add npm scripts for golden set pipeline"
```

---

### Task 7: End-to-End Smoke Test

**Step 1: Run full pipeline**

```bash
# Start hybrid service if not running
npm run hybrid &

# Phase 1: Retrieve
npm run eval:golden-retrieve
# Expected: evaluation/answer-retrieval-raw.json with 9 questions × 10 chunks

# Phase 2: Label
npm run eval:golden-label
# Expected: evaluation/answer-labels-review.json with LLM labels

# Phase 3b: Review
npm run eval:golden-review
# Open browser, spot-check a few labels, override one to verify autosave

# Phase 4: Assemble
npm run eval:golden-assemble
# Expected: evaluation/answer-golden-dataset.json with production data

# Verify existing eval still works
npm run eval:answer-retrieval
# Expected: Runs against the new golden set, prints P/R/F1
```

**Step 2: Verify golden set schema compatibility**

```bash
cat evaluation/answer-golden-dataset.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['version'] == '2.0'
assert d['metadata']['status'] == 'production'
for tc in d['test_cases']:
    assert 'retrieval_ground_truth' in tc
    assert 'expected_passages' in tc['retrieval_ground_truth']
    assert 'expected_doc_ids' in tc['retrieval_ground_truth']
    assert 'synthesis_ground_truth' in tc
    for p in tc['retrieval_ground_truth']['expected_passages']:
        assert p['chunk_id'], f'Missing chunk_id in {tc[\"id\"]}'
        assert p['doc_id'], f'Missing doc_id in {tc[\"id\"]}'
        assert len(p['text_snippet']) > 50, f'Snippet too short in {tc[\"id\"]}'
print('Schema validation passed')
"
```

**Step 3: Commit**

```bash
git add evaluation/answer-golden-dataset.json
git commit -m "feat(eval): generate production answer golden set (9 questions, chunk-first)"
```

---

### Task 8: Update Eval README

**Files:**
- Modify: `evaluation/README.md`

**Step 1: Update the golden dataset status section**

Replace the stub status note with production documentation. Update the "Golden Dataset Status" section and add the golden set generation workflow.

Change:
```
The answer mode golden dataset (`answer-golden-dataset.json`) is currently a **stub** with synthetic test cases. Replace the stub entries with validated Q&A pairs when available.
```

To:
```
### Golden Dataset Generation

The answer golden set is generated via a chunk-first pipeline that queries the live index and uses LLM-assisted labeling with human review.

**Regenerating the golden set** (e.g., after re-chunking the index):

\`\`\`bash
npm run eval:golden-retrieve    # query hybrid service
npm run eval:golden-label       # LLM labels each chunk
npm run eval:golden-review      # open review UI, validate labels
npm run eval:golden-assemble    # build final golden dataset
\`\`\`

**Design doc:** `docs/plans/2026-02-20-answer-golden-set-generation-design.md`
```

**Step 2: Commit**

```bash
git add evaluation/README.md
git commit -m "docs(eval): update README with golden set generation workflow"
```
