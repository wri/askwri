/**
 * Merge capture + LLM eval data into the review-ready format.
 *
 * Reads answer-synthesis-raw.json and answer-synthesis-llm-eval.json,
 * produces answer-synthesis-eval-final.json with empty human_eval fields
 * ready for the review UI.
 *
 * Preserves existing human reviews if the output file already exists.
 *
 * Usage: npx tsx evaluation/prepare-synthesis-review.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  SynthesisCaptureFile,
  LLMEvalFile,
  SynthesisEvalFinalFile,
  SynthesisEvalFinalEntry,
  HumanEval,
} from './lib/types'

const EVAL_DIR = __dirname
const CAPTURE_PATH = path.join(EVAL_DIR, 'answer-synthesis-raw.json')
const LLM_EVAL_PATH = path.join(EVAL_DIR, 'answer-synthesis-llm-eval.json')
const OUTPUT_PATH = path.join(EVAL_DIR, 'answer-synthesis-eval-final.json')

function emptyHumanEval(): HumanEval {
  return {
    scores: {
      faithfulness: 0,
      completeness: 0,
      conciseness: 0,
      coherence: 0,
      citation_accuracy: 0,
    },
    qualitative_feedback: '',
    key_facts_confirmed: [],
    key_facts_added: [],
    reviewed: false,
  }
}

function main() {
  console.log('=== Preparing Synthesis Review Data ===\n')

  if (!fs.existsSync(CAPTURE_PATH)) {
    console.error(`Missing: ${CAPTURE_PATH}`)
    console.error(
      'Run stage 1 first: npx tsx evaluation/run-answer-synthesis-capture.ts',
    )
    process.exit(1)
  }
  if (!fs.existsSync(LLM_EVAL_PATH)) {
    console.error(`Missing: ${LLM_EVAL_PATH}`)
    console.error(
      'Run stage 2 first: npx tsx evaluation/run-answer-synthesis-llm-eval.ts',
    )
    process.exit(1)
  }

  const captured: SynthesisCaptureFile = JSON.parse(
    fs.readFileSync(CAPTURE_PATH, 'utf-8'),
  )
  const llmEval: LLMEvalFile = JSON.parse(
    fs.readFileSync(LLM_EVAL_PATH, 'utf-8'),
  )

  const evalMap = new Map(llmEval.test_cases.map((tc) => [tc.test_case_id, tc]))

  // Preserve existing human reviews
  let existingHumanEvals = new Map<string, HumanEval>()
  if (fs.existsSync(OUTPUT_PATH)) {
    const existing: SynthesisEvalFinalFile = JSON.parse(
      fs.readFileSync(OUTPUT_PATH, 'utf-8'),
    )
    existingHumanEvals = new Map(
      existing.test_cases
        .filter((tc) => tc.human_eval.reviewed)
        .map((tc) => [tc.test_case_id, tc.human_eval]),
    )
    console.log(
      `Preserving ${existingHumanEvals.size} existing human reviews\n`,
    )
  }

  const entries: SynthesisEvalFinalEntry[] = []

  for (const tc of captured.test_cases) {
    const llm = evalMap.get(tc.test_case_id)
    if (!llm) {
      console.warn(`  WARNING: No LLM eval for ${tc.test_case_id}, skipping`)
      continue
    }

    const existingHuman = existingHumanEvals.get(tc.test_case_id)

    entries.push({
      test_case_id: tc.test_case_id,
      question: tc.question,
      synthesis_text: tc.synthesis.full_text,
      passage_count: tc.retrieved_passages.length,
      llm_eval: llm,
      human_eval: existingHuman || emptyHumanEval(),
    })

    console.log(
      `  ${tc.test_case_id}: ${existingHuman ? 'preserved human review' : 'awaiting review'}`,
    )
  }

  const output: SynthesisEvalFinalFile = {
    evaluated_at: new Date().toISOString(),
    system_model: captured.system_model,
    evaluator_model: llmEval.evaluator_model,
    test_cases: entries,
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2))
  console.log(`\nSaved ${entries.length} entries to ${OUTPUT_PATH}`)
  console.log('\nNext step: npx tsx evaluation/serve-label-review.ts')
  console.log('Then open: http://localhost:3001/eval/review-synthesis')
}

main()
