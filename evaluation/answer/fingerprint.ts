import { createHash } from 'node:crypto'
import { CaptureArtifact } from './types'

/**
 * Identity of a capture for resume safety and label binding: the cases, not
 * the provenance (a re-capture with identical answers is legitimately the
 * same work). The capture stage writes this into the artifact as
 * `capture_fingerprint` so cross-language readers (the eval-review labels
 * notebook) copy it instead of re-hashing — Python and Node disagree on
 * float formatting below 1e-4, so a re-hash is not portable.
 */
export const captureFingerprint = (
  capture: Pick<CaptureArtifact, 'cases'>,
): string =>
  createHash('sha256').update(JSON.stringify(capture.cases)).digest('hex')
