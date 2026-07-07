import { AppDataSource } from '../data-source'
import { s3ClientConfig } from '../../lib/s3'

export interface WorkerHealth {
  /** Open (queued + running) ingestion jobs. */
  queueDepth: number
  /** Most recent job transition (updated_at across all jobs), ISO string or null. */
  lastProcessedAt: string | null
  /** Files in the S3 intake/ prefix that have no registered documents row yet. */
  intakeBacklog: number
  /** Worker status inferred from the above: 'idle' | 'processing' | 'stale'. */
  status: 'idle' | 'processing' | 'stale'
}

/**
 * Worker health from DB + S3 state (no heartbeat needed).
 *
 * - `processing`: open jobs exist (queued/running) → the worker is active.
 * - `idle`: no open jobs AND no intake backlog → the worker is caught up.
 * - `stale`: files sit in intake/ with no open job → the worker is down or
 *   not picking them up (the exact "uploads vanish" symptom).
 *
 * The `stale` signal is what makes this diagnosable: it catches the case
 * where the intake route dropped files in S3 but the worker never registered
 * them (e.g. the worker is not running), which is invisible without this.
 */
export async function getWorkerHealth(): Promise<WorkerHealth> {
  const [row] = await AppDataSource.query(`
    SELECT
      count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS "queueDepth",
      max(updated_at) AS "lastProcessedAt"
    FROM ingestion_jobs
  `)
  const queueDepth: number = row?.queueDepth ?? 0
  const lastProcessedAt: string | null = row?.lastProcessedAt ?? null

  const intakeBacklog = await countIntakeBacklog()

  let status: WorkerHealth['status']
  if (queueDepth > 0) {
    status = 'processing'
  } else if (intakeBacklog > 0) {
    status = 'stale'
  } else {
    status = 'idle'
  }

  return { queueDepth, lastProcessedAt, intakeBacklog, status }
}

/**
 * Count objects in the S3 intake/ prefix that have no matching documents row
 * (by external_id = filename stem). A backlog here means the worker is not
 * registering dropped files.
 *
 * Returns 0 if S3 is not configured (local INTAKE_LOCAL_DIR mode is not
 * covered by this check — the worker sweeps it directly).
 */
async function countIntakeBacklog(): Promise<number> {
  const bucket = process.env.DOCUMENTS_S3_BUCKET
  if (!bucket) return 0
  const prefix = process.env.INTAKE_S3_PREFIX || 'intake/'
  try {
    const { ListObjectsV2Command, S3Client } = await import('@aws-sdk/client-s3')
    const s3 = new S3Client(s3ClientConfig())
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
    const keys = (resp.Contents ?? [])
      .map((o) => o.Key ?? '')
      .filter((k) => k.toLowerCase().endsWith('.pdf'))
    if (keys.length === 0) return 0
    // external_id = filename stem (matches worker intake_s3._register)
    const stems = keys.map((k) => k.split('/').pop()!.replace(/\.pdf$/i, ''))
    // Which of these have NO documents row?
    const placeholders = stems.map((_, i) => `$${i + 1}`).join(',')
    const rows: { external_id: string }[] = await AppDataSource.query(
      `SELECT external_id FROM documents WHERE external_id IN (${placeholders})`,
      stems,
    )
    const known = new Set(rows.map((r) => r.external_id))
    return stems.filter((s) => !known.has(s)).length
  } catch {
    // If S3 is unreachable, don't fail the health check — return 0 (unknown).
    return 0
  }
}
