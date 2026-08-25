/**
 * Stage 4: Assemble synthesis ground truth.
 *
 * Reads answer-synthesis-eval-final.json (with human reviews),
 * writes canonical_answer and key_facts back into answer-golden-dataset.json
 * for test cases meeting the quality threshold.
 *
 * Usage: npx tsx evaluation/assemble-synthesis-ground-truth.ts [--threshold 0.7]
 */

import * as fs from 'fs'
import * as path from 'path'
import type {
  AnswerGoldenDataset,
  SynthesisEvalFinalFile,
  SynthesisScores,
} from './lib/types'

const EVAL_DIR = __dirname
const EVAL_FINAL_PATH = path.join(EVAL_DIR, 'answer-synthesis-eval-final.json')
const GOLDEN_PATH = path.join(EVAL_DIR, 'answer-golden-dataset.json')

function avgScore(scores: SynthesisScores): number {
  const vals = Object.values(scores)
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

function main() {
  const args = process.argv.slice(2)
  const threshIdx = args.indexOf('--threshold')
  const threshold = threshIdx >= 0 ? parseFloat(args[threshIdx + 1]) : 0.7

  console.log('=== Stage 4: Assemble Synthesis Ground Truth ===')
  console.log(`Quality threshold: ${threshold}\n`)

  if (!fs.existsSync(EVAL_FINAL_PATH)) {
    console.error(`Missing: ${EVAL_FINAL_PATH}`)
    console.error('Run stages 1-3 first.')
    process.exit(1)
  }

  const evalData: SynthesisEvalFinalFile = JSON.parse(
    fs.readFileSync(EVAL_FINAL_PATH, 'utf-8'),
  )
  const golden: AnswerGoldenDataset = JSON.parse(
    fs.readFileSync(GOLDEN_PATH, 'utf-8'),
  )

  const goldenMap = new Map(golden.test_cases.map((tc) => [tc.id, tc]))

  let updated = 0
  let skippedNotReviewed = 0
  let skippedBelowThreshold = 0

  for (const tc of evalData.test_cases) {
    const goldenTc = goldenMap.get(tc.test_case_id)
    if (!goldenTc) {
      console.warn(`  ${tc.test_case_id}: not in golden dataset, skipping`)
      continue
    }

    if (!tc.human_eval.reviewed) {
      console.log(`  ${tc.test_case_id}: not yet reviewed, skipping`)
      skippedNotReviewed++
      continue
    }

    const humanAvg = avgScore(tc.human_eval.scores)
    if (humanAvg < threshold) {
      console.log(
        `  ${tc.test_case_id}: human avg ${humanAvg.toFixed(2)} < ${threshold}, skipping`,
      )
      skippedBelowThreshold++
      continue
    }

    const keyFacts = [
      ...tc.human_eval.key_facts_confirmed,
      ...tc.human_eval.key_facts_added,
    ]

    goldenTc.synthesis_ground_truth = {
      canonical_answer: tc.synthesis_text,
      key_facts: keyFacts,
    }

    console.log(
      `  ${tc.test_case_id}: updated (avg=${humanAvg.toFixed(2)}, ${keyFacts.length} key facts)`,
    )
    updated++
  }

  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2))

  console.log('\n=== Summary ===')
  console.log(`  Updated: ${updated}`)
  console.log(`  Skipped (not reviewed): ${skippedNotReviewed}`)
  console.log(`  Skipped (below threshold): ${skippedBelowThreshold}`)
  console.log(`  Golden dataset saved: ${GOLDEN_PATH}`)
}

main()
