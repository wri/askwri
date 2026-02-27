/**
 * Stage 2: LLM evaluation of synthesis quality.
 *
 * For each captured test case, sends the question + passages + synthesis
 * to an evaluator LLM (thinking mode) for multi-dimensional scoring.
 *
 * Prerequisites: OPENAI_API_KEY set, answer-synthesis-raw.json present
 *
 * Usage: npx tsx evaluation/run-answer-synthesis-llm-eval.ts
 *
 * Environment:
 *   SYNTHESIS_EVAL_MODEL  — evaluator model (default: gpt-4o)
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

const EVAL_DIR = __dirname;
const INPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-raw.json');
const OUTPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-llm-eval.json');

const EVALUATOR_MODEL = process.env.SYNTHESIS_EVAL_MODEL || 'gpt-5.2';

const SYSTEM_PROMPT = `You are an expert evaluator assessing the quality of AI-generated research synthesis. You will be given:
1. A research question
2. The source passages the AI had access to
3. The synthesis the AI produced

Score each dimension from 0.0 to 1.0 (one decimal place):

- **faithfulness**: Is every claim in the synthesis grounded in the provided passages? 0 = hallucinated claims, 1 = all claims traceable to specific passages.
- **completeness**: Does the synthesis cover the key information from the passages, given the 2-3 sentence constraint? 0 = misses major findings that could fit in 2-3 sentences, 1 = makes excellent use of the limited space to touch on the most important findings. Do NOT penalize for omitting details that would require more than 3 sentences to include.
- **conciseness**: Is the synthesis appropriately brief without filler? 0 = verbose/repetitive, 1 = every word earns its place (2-3 sentences expected).
- **coherence**: Does it read as a unified, well-structured answer? 0 = disjointed facts, 1 = smooth narrative that synthesizes rather than concatenates.
- **citation_accuracy**: Could each claim in the synthesis be attributed to specific source passages? 0 = claims cannot be traced to sources, 1 = each claim clearly maps to passage(s).

Also:
- Provide qualitative feedback: what is good, what is missing, what is wrong.
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

// Mirror the answer route's filtering so the judge only sees passages the model saw
const RELEVANCE_THRESHOLD = 0.75;
const MAX_DOCS = 8;
const MAX_SNIPPET_LEN = 400;

function formatPassages(entry: SynthesisCaptureFile['test_cases'][0]): string {
  const filtered = entry.retrieved_passages
    .filter(p => p.score >= RELEVANCE_THRESHOLD)
    .slice(0, MAX_DOCS);

  return filtered
    .map((p, i) =>
      `[${i + 1}] "${p.title}" (doc: ${p.doc_id}, score: ${p.score.toFixed(3)})\n${p.snippet.slice(0, MAX_SNIPPET_LEN)}`
    )
    .join('\n\n---\n\n');
}

async function evaluateWithLLM(
  question: string,
  passagesText: string,
  synthesisText: string,
  apiKey: string,
): Promise<Omit<LLMEvalEntry, 'test_case_id'>> {
  const userPrompt = buildUserPrompt(question, passagesText, synthesisText);

  const isThinking = /^(gpt-5|o[1-9])/.test(EVALUATOR_MODEL);

  const body: Record<string, unknown> = {
    model: EVALUATOR_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  };

  if (isThinking) {
    body.max_completion_tokens = 4000;
    body.reasoning_effort = 'high';
  } else {
    body.max_tokens = 4000;
    body.temperature = 0.1;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;

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
    console.error('  Raw:', content.slice(0, 300));
    parsed = {
      scores: { faithfulness: 0, completeness: 0, conciseness: 0, coherence: 0, citation_accuracy: 0 },
      qualitative_feedback: `Parse error. Raw content: ${content.slice(0, 500)}`,
      flagged_issues: [],
      key_facts_extracted: [],
    };
  }

  const requiredDims: (keyof SynthesisScores)[] = ['faithfulness', 'completeness', 'conciseness', 'coherence', 'citation_accuracy'];
  for (const dim of requiredDims) {
    if (typeof parsed.scores?.[dim] !== 'number' || parsed.scores[dim] < 0 || parsed.scores[dim] > 1) {
      console.warn(`  Missing or invalid score for ${dim}, defaulting to 0`);
      if (!parsed.scores) parsed.scores = {} as SynthesisScores;
      parsed.scores[dim] = 0;
    }
  }

  return {
    scores: parsed.scores,
    qualitative_feedback: parsed.qualitative_feedback || '',
    flagged_issues: parsed.flagged_issues || [],
    key_facts_extracted: parsed.key_facts_extracted || [],
    model: EVALUATOR_MODEL,
    reasoning_tokens: reasoningTokens,
  };
}

async function main() {
  console.log('=== Stage 2: LLM Evaluation ===\n');
  console.log(`Evaluator model: ${EVALUATOR_MODEL}\n`);

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

  let failures = 0;
  for (const tc of captured.test_cases) {
    console.log(`Evaluating: ${tc.test_case_id}`);
    console.log(`  Synthesis: ${tc.synthesis.full_text.slice(0, 100)}...`);

    try {
      const passagesText = formatPassages(tc);
      const result = await evaluateWithLLM(
        tc.question,
        passagesText,
        tc.synthesis.full_text,
        apiKey,
      );

      const entry: LLMEvalEntry = {
        test_case_id: tc.test_case_id,
        ...result,
      };

      const s = entry.scores;
      const avg = (s.faithfulness + s.completeness + s.conciseness + s.coherence + s.citation_accuracy) / 5;
      console.log(`  Scores: F=${s.faithfulness} Co=${s.completeness} Cn=${s.conciseness} Ch=${s.coherence} Ci=${s.citation_accuracy} (avg=${avg.toFixed(2)})`);
      console.log(`  Key facts: ${entry.key_facts_extracted.length}, Issues: ${entry.flagged_issues.length}`);

      output.test_cases.push(entry);
    } catch (err) {
      console.error(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
    }

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.test_cases.length} evaluations to ${OUTPUT_PATH}`);
  if (failures) console.log(`WARNING: ${failures} test case(s) failed`);

  // Print summary
  const dims: (keyof SynthesisScores)[] = ['faithfulness', 'completeness', 'conciseness', 'coherence', 'citation_accuracy'];
  console.log('\n=== AGGREGATE SCORES ===');
  for (const dim of dims) {
    const avg = output.test_cases.reduce((sum, tc) => sum + tc.scores[dim], 0) / output.test_cases.length;
    console.log(`  ${dim}: ${avg.toFixed(2)}`);
  }

  console.log('\nNext step: npx tsx evaluation/prepare-synthesis-review.ts');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
