/**
 * Publish the newest cite-mode eval report for QA reviewers.
 *
 * Usage:
 *   npm run eval:upload-cite
 *
 * Uploads the latest evaluation/results/eval-report-*.json (written by
 * eval:cite) to s3://$DOCUMENTS_S3_BUCKET/${EVAL_S3_PREFIX}cite-report-latest.json,
 * which /api/eval/cite-report reads and /api/eval/review-cite renders.
 * Cite-only successor to the deleted upload-eval-to-s3.ts (answer-eval
 * overhaul spec §3 amendment) — the gen-1 answer-eval files it also carried
 * no longer exist.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import * as fs from 'fs'
import * as path from 'path'

const RESULTS_DIR = path.join(__dirname, 'results')
const REPORT_KEY = 'cite-report-latest.json'

/** Newest eval-report-*.json by name (the names are timestamped), or null. */
export function findLatestCiteReport(resultsDir: string): string | null {
  if (!fs.existsSync(resultsDir)) return null
  const files = fs
    .readdirSync(resultsDir)
    .filter((f) => f.startsWith('eval-report-') && f.endsWith('.json'))
    .sort()
  return files.length > 0
    ? path.join(resultsDir, files[files.length - 1])
    : null
}

export interface PutParams {
  Bucket: string
  Key: string
  Body: string
  ContentType: string
}

/** Upload the latest report; returns the S3 key written. `put` is the S3
 * seam (injected by tests). */
export async function uploadCiteReport(opts: {
  resultsDir: string
  bucket: string
  prefix: string
  put: (p: PutParams) => Promise<void>
}): Promise<string> {
  const report = findLatestCiteReport(opts.resultsDir)
  if (!report) {
    throw new Error(
      `no eval-report-*.json under ${opts.resultsDir} — run eval:cite first`,
    )
  }
  const key = `${opts.prefix}${REPORT_KEY}`
  await opts.put({
    Bucket: opts.bucket,
    Key: key,
    Body: fs.readFileSync(report, 'utf-8'),
    ContentType: 'application/json',
  })
  console.log(`OK: ${path.basename(report)} → s3://${opts.bucket}/${key}`)
  return key
}

async function main(): Promise<void> {
  const bucket = process.env.DOCUMENTS_S3_BUCKET
  if (!bucket) {
    console.error('DOCUMENTS_S3_BUCKET not set')
    process.exit(1)
  }
  const client = new S3Client({})
  await uploadCiteReport({
    resultsDir: RESULTS_DIR,
    bucket,
    prefix: process.env.EVAL_S3_PREFIX || 'eval-data/',
    put: async (p) => {
      await client.send(new PutObjectCommand(p))
    },
  })
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
