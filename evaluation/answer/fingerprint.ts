import { createHash } from 'node:crypto'
import { CaptureArtifact } from './types'

/** The capture schemas the read paths (`run-judge`, `run-score`, label
 * binding) accept — ruling 1 of the two-step plan: `@1` artifacts (no
 * selection block, pre-selection-mode captures) stay valid alongside the
 * `@2` the capture stage writes. */
export const READABLE_CAPTURE_SCHEMAS = [
  'answer-eval/capture@1',
  'answer-eval/capture@2',
] as const

/** Fail loudly when a file handed to `--capture` is not a readable
 * capture (a judged artifact, a future `@3`, anything else), naming where
 * it came from — a raw JSON.parse would otherwise fail much later and far
 * more confusingly (judge.ts would find no cases; score.ts would read
 * `provenance.fixture` off the wrong shape). */
export function assertReadableCaptureSchema(
  capture: unknown,
  origin: string,
): void {
  const schema = (capture as { schema?: unknown } | null | undefined)?.schema
  if (
    typeof schema !== 'string' ||
    !READABLE_CAPTURE_SCHEMAS.includes(
      schema as (typeof READABLE_CAPTURE_SCHEMAS)[number],
    )
  ) {
    throw new Error(
      `${origin}: not a readable capture (schema ` +
        `${schema === undefined ? 'missing' : JSON.stringify(schema)}; ` +
        `readable: ${READABLE_CAPTURE_SCHEMAS.join(', ')})`,
    )
  }
}

/**
 * Identity of a capture for resume safety and label binding: the cases
 * (plus the selection block when present — not the provenance; a
 * re-capture with identical answers is legitimately the same work). The
 * capture stage writes this into the artifact as `capture_fingerprint` so
 * cross-language readers (the eval-review labels notebook) copy it
 * instead of re-hashing — Python and Node disagree on float formatting
 * below 1e-4, so a re-hash is not portable.
 *
 * Ruling 4 (two-step plan): selection-less captures keep the historical
 * formula byte-for-byte — the committed pin and every @1 judged/label
 * binding must not move. A selection-bearing capture hashes its selection
 * too, so a re-capture under the same label with a different mode or doc
 * set cannot reuse stale verdicts or labels.
 */
export const captureFingerprint = (
  capture: Pick<CaptureArtifact, 'cases' | 'selection'>,
): string => {
  const hash = createHash('sha256').update(JSON.stringify(capture.cases))
  if (capture.selection !== undefined) {
    hash.update(JSON.stringify(capture.selection))
  }
  return hash.digest('hex')
}
