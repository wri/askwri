import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const isProduction = process.env.NODE_ENV === 'production';
const BUCKET = process.env.DOCUMENTS_S3_BUCKET || '';
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/';
const EVAL_DIR = path.join(process.cwd(), 'evaluation');

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

export async function readEvalFile(filename: string): Promise<object | null> {
  if (isProduction) {
    try {
      const client = getS3Client();
      const resp = await client.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: `${PREFIX}${filename}`,
      }));
      const body = await resp.Body?.transformToString('utf-8');
      return body ? JSON.parse(body) : null;
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  const filePath = path.join(EVAL_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export async function writeEvalFile(filename: string, data: object): Promise<void> {
  const jsonStr = JSON.stringify(data, null, 2) + '\n';

  if (isProduction) {
    const client = getS3Client();
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${PREFIX}${filename}`,
      Body: jsonStr,
      ContentType: 'application/json',
    }));
    return;
  }

  const filePath = path.join(EVAL_DIR, filename);
  fs.writeFileSync(filePath, jsonStr, 'utf-8');
}

export async function evalFileExists(filename: string): Promise<boolean> {
  if (isProduction) {
    try {
      const client = getS3Client();
      await client.send(new HeadObjectCommand({
        Bucket: BUCKET,
        Key: `${PREFIX}${filename}`,
      }));
      return true;
    } catch {
      return false;
    }
  }

  return fs.existsSync(path.join(EVAL_DIR, filename));
}
