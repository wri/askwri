/**
 * Upload eval data files to S3 for QA reviewer access.
 *
 * Usage:
 *   npm run eval:upload                              # upload all files
 *   npm run eval:upload -- --file answer-labels-review.json  # upload one
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const EVAL_DIR = __dirname;
const RESULTS_DIR = path.join(EVAL_DIR, 'results');

const BUCKET = process.env.DOCUMENTS_S3_BUCKET;
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';

const EVAL_FILES = [
  'answer-labels-review.json',
  'answer-synthesis-eval-final.json',
  'answer-synthesis-raw.json',
];

async function uploadFile(client: S3Client, localPath: string, s3Key: string): Promise<boolean> {
  if (!fs.existsSync(localPath)) {
    console.log(`  SKIP: ${path.basename(localPath)} (not found)`);
    return false;
  }
  const body = fs.readFileSync(localPath, 'utf-8');
  await client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    Body: body,
    ContentType: 'application/json',
  }));
  console.log(`  OK: ${path.basename(localPath)} → s3://${BUCKET}/${s3Key}`);
  return true;
}

function findLatestCiteReport(): string | null {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('eval-report-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(RESULTS_DIR, files[0]) : null;
}

async function main() {
  if (!BUCKET) {
    console.error('DOCUMENTS_S3_BUCKET not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const singleFile = fileIdx >= 0 ? args[fileIdx + 1] : null;

  const client = new S3Client({});
  let uploaded = 0;

  console.log(`Uploading to s3://${BUCKET}/${PREFIX}\n`);

  if (singleFile) {
    const ok = await uploadFile(client, path.join(EVAL_DIR, singleFile), `${PREFIX}${singleFile}`);
    if (ok) uploaded++;
  } else {
    for (const file of EVAL_FILES) {
      const ok = await uploadFile(client, path.join(EVAL_DIR, file), `${PREFIX}${file}`);
      if (ok) uploaded++;
    }

    // Upload latest cite report
    const citeReport = findLatestCiteReport();
    if (citeReport) {
      const ok = await uploadFile(client, citeReport, `${PREFIX}cite-report-latest.json`);
      if (ok) uploaded++;
    }
  }

  console.log(`\nUploaded ${uploaded} file(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
