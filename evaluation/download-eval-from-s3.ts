/**
 * Download eval data files from S3 (after human review on QA).
 *
 * Usage: npm run eval:download
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const EVAL_DIR = __dirname;
const BUCKET = process.env.DOCUMENTS_S3_BUCKET;
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';

const DOWNLOAD_FILES = [
  'answer-labels-review.json',
  'answer-synthesis-eval-final.json',
];

async function downloadFile(client: S3Client, s3Key: string, localPath: string): Promise<boolean> {
  try {
    const resp = await client.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
    }));
    const body = await resp.Body?.transformToString('utf-8');
    if (!body) return false;
    fs.writeFileSync(localPath, body, 'utf-8');
    console.log(`  OK: s3://${BUCKET}/${s3Key} → ${path.basename(localPath)}`);
    return true;
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log(`  SKIP: ${path.basename(localPath)} (not in S3)`);
      return false;
    }
    throw err;
  }
}

async function main() {
  if (!BUCKET) {
    console.error('DOCUMENTS_S3_BUCKET not set');
    process.exit(1);
  }

  const client = new S3Client({});
  let downloaded = 0;

  console.log(`Downloading from s3://${BUCKET}/${PREFIX}\n`);

  for (const file of DOWNLOAD_FILES) {
    const ok = await downloadFile(client, `${PREFIX}${file}`, path.join(EVAL_DIR, file));
    if (ok) downloaded++;
  }

  console.log(`\nDownloaded ${downloaded} file(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
