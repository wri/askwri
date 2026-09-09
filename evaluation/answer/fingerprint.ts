import { createHash } from 'node:crypto'
import { CaptureArtifact } from './types'

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
