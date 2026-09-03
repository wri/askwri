/**
 * Capture CLI: parse controls → preflight (abort gate) → run cases × passes →
 * write the capture artifact. Usage:
 *
 *   npm run eval:answer-capture -- <evalset.json> [--passes 2 --knob k=v ...]
 *
 * The artifact lands in evaluation/answer/artifacts/capture-<label>.json
 * (never committed). Aborts non-zero when preflight fails, before any
 * capture-pass call.
 */
import * as path from 'path'
import { parseControls } from './cli'
import {
  PreflightAbortError,
  runCapture,
  writeCaptureArtifact,
} from './capture'
import { fetchJson } from './http'

async function main(): Promise<void> {
  const ctl = parseControls(process.argv.slice(2), 'capture')
  let artifact
  try {
    artifact = await runCapture(ctl, { http: fetchJson })
  } catch (e) {
    if (e instanceof PreflightAbortError) {
      console.error(e.message)
      process.exit(1)
    }
    throw e
  }

  const file = writeCaptureArtifact(
    path.join(__dirname, 'artifacts'),
    ctl.label,
    artifact,
  )

  // Per-case one-liners, run-evalset's tone.
  for (const c of artifact.cases) {
    for (const p of c.passes) {
      const cost = p.retrieval.cost_usd
      const err = p.retrieval.error
        ? `  ERROR ${p.retrieval.error}`
        : p.answer.error
          ? `  ERROR ${p.answer.error}`
          : ''
      console.log(
        `${c.case_id} pass ${p.pass} … ` +
          `${p.retrieval.chunks.length} chunks  ` +
          `${p.answer.passages_sent.length} sent  ` +
          `${p.answer.sentences.length} sentences  ` +
          `${cost == null ? '-' : `$${cost.toFixed(4)}`}` +
          err,
      )
    }
  }
  console.log(`\nwrote ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
