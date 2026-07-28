import { AppDataSource } from '../data-source'
import { s3ClientConfig } from '../../lib/s3'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

export interface WorkerHealth {
  /** Open (queued + running) ingestion jobs. */
  queueDepth: number
  /** Most recent job transition (updated_at across all jobs), ISO string or null. */
  lastProcessedAt: string | null
  /** Files in the S3 intake/ prefix that have no registered documents row yet. */
  intakeBacklog: number
  /** Worker status inferred from the above: 'idle' | 'processing' | 'pending' | 'stale'. */
  status: 'idle' | 'processing' | 'pending' | 'stale'
}

/** Default staleness threshold for intake files (2× the worker poll cycle). */
const DEFAULT_STALE_THRESHOLD_SECONDS = 20

/**
 * Worker health from DB + S3 state (no heartbeat needed).
 *
 * - `processing`: open jobs exist (queued/running) → the worker is active.
 * - `pending`: files sit in intake/ but were dropped < threshold ago → the
 *   worker likely just hasn't polled yet (polls every ~10s). NOT an error.
 * - `stale`: files sit in intake/ older than the threshold with no open job →
 *   the worker is down or not picking them up (the "uploads vanish" symptom).
 * - `idle`: no open jobs AND no intake backlog → the worker is caught up.
 *
 * The `stale` signal (vs `pending`) is what makes this diagnosable without
 * false alarms: right after an upload, intakeBacklog=1 + queueDepth=0 looks
 * like "stale" if you don't account for the file's age, but the worker just
 * hasn't polled yet. Only after the file has sat there > threshold is it truly
 * stale (the worker is down or broken).
 */
export async function getWorkerHealth(
  options: { staleThresholdSeconds?: number } = {},
): Promise<WorkerHealth> {
  const staleThresholdSeconds =
    options.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS

  const [row] = await AppDataSource.query(`
    SELECT
      count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS "queueDepth",
      max(updated_at) AS "lastProcessedAt"
    FROM ingestion_jobs
  `)
  const queueDepth: number = row?.queueDepth ?? 0
  const lastProcessedAt: string | null = row?.lastProcessedAt ?? null

  const { count, oldestAgeSeconds } = await countIntakeBacklog(
    staleThresholdSeconds,
  )

  let status: WorkerHealth['status']
  if (queueDepth > 0) {
    status = 'processing'
  } else if (count > 0) {
    // Intake files exist with no job — distinguish "just dropped" from "stale"
    // using the oldest unregistered file's age (from S3 LastModified).
    status = oldestAgeSeconds > staleThresholdSeconds ? 'stale' : 'pending'
  } else {
    status = 'idle'
  }

  return { queueDepth, lastProcessedAt, intakeBacklog: count, status }
}

/**
 * Count objects in the S3 intake/ prefix that have no matching documents row
 * (by external_id = filename stem). Also returns the age (in seconds) of the
 * oldest unregistered intake PDF, computed from the S3 object's LastModified.
 *
 * Returns { count: 0, oldestAgeSeconds: 0 } if S3 is not configured.
 */
async function countIntakeBacklog(
  _staleThresholdSeconds: number,
): Promise<{ count: number; oldestAgeSeconds: number }> {
  const bucket = process.env.DOCUMENTS_S3_BUCKET
  if (!bucket) return { count: 0, oldestAgeSeconds: 0 }
  const prefix = process.env.INTAKE_S3_PREFIX || 'intake/'
  try {
    const s3 = new S3Client(s3ClientConfig())
    const resp = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
    )
    const objects = (resp.Contents ?? []).filter((o) =>
      (o.Key ?? '').toLowerCase().endsWith('.pdf'),
    )
    if (objects.length === 0) return { count: 0, oldestAgeSeconds: 0 }
    // external_id = filename stem (matches worker intake_s3._register)
    const stems = objects.map((o) =>
      (o.Key ?? '')
        .split('/')
        .pop()!
        .replace(/\.pdf$/i, ''),
    )
    // Which of these have NO documents row?
    const placeholders = stems.map((_, i) => `$${i + 1}`).join(',')
    const rows: { external_id: string }[] = await AppDataSource.query(
      `SELECT external_id FROM documents WHERE external_id IN (${placeholders})`,
      stems,
    )
    const known = new Set(rows.map((r) => r.external_id))
    // Filter to unregistered objects; track the oldest LastModified among them
    const now = Date.now()
    let oldestAgeSeconds = 0
    let count = 0
    for (let i = 0; i < objects.length; i++) {
      if (!known.has(stems[i])) {
        count++
        const lastMod = objects[i].LastModified
        if (lastMod) {
          const age = (now - lastMod.getTime()) / 1000
          if (age > oldestAgeSeconds) oldestAgeSeconds = age
        }
      }
    }
    return { count, oldestAgeSeconds }
  } catch {
    // If S3 is unreachable, don't fail the health check — return 0 (unknown).
    return { count: 0, oldestAgeSeconds: 0 }
  }
}
