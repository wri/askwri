import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { s3ClientConfig } from './s3'
import * as fs from 'fs'
import * as path from 'path'

const isProduction = process.env.NODE_ENV === 'production'
const BUCKET = process.env.DOCUMENTS_S3_BUCKET || ''
const PREFIX = process.env.EVAL_S3_PREFIX || 'eval-data/'
const EVAL_DIR = path.join(process.cwd(), 'evaluation')

let s3Client: S3Client | null = null

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client(s3ClientConfig())
  }
  return s3Client
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename)
  if (!base || base !== filename || filename.includes('..')) {
    throw new Error(`Invalid eval filename: ${filename}`)
  }
  return base
}

export async function readEvalFile(filename: string): Promise<object | null> {
  filename = sanitizeFilename(filename)

  // In production, try S3 first (reviewer edits persist there across deploys)
  if (isProduction && BUCKET) {
    try {
      const client = getS3Client()
      const resp = await client.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: `${PREFIX}${filename}`,
        }),
      )
      const body = await resp.Body?.transformToString('utf-8')
      if (body) return JSON.parse(body)
    } catch (err: any) {
      if (err.name !== 'NoSuchKey' && err.$metadata?.httpStatusCode !== 404) {
        console.warn(
          `[eval-storage] S3 read failed for ${filename}:`,
          err.message,
        )
      }
      // Fall through to filesystem
    }
  }

  // Fall back to filesystem (committed seed data, or local dev)
  const filePath = path.join(EVAL_DIR, filename)
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  }

  return null
}

export async function writeEvalFile(
  filename: string,
  data: object,
): Promise<void> {
  filename = sanitizeFilename(filename)
  const jsonStr = JSON.stringify(data, null, 2) + '\n'

  // Always write to filesystem
  const filePath = path.join(EVAL_DIR, filename)
  fs.writeFileSync(filePath, jsonStr, 'utf-8')

  // Also write to S3 if available in production
  if (isProduction && BUCKET) {
    try {
      const client = getS3Client()
      await client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: `${PREFIX}${filename}`,
          Body: jsonStr,
          ContentType: 'application/json',
        }),
      )
    } catch (err: any) {
      console.warn(
        `[eval-storage] S3 write failed for ${filename}:`,
        err.message,
      )
    }
  }
}

export async function evalFileExists(filename: string): Promise<boolean> {
  filename = sanitizeFilename(filename)
  if (isProduction) {
    try {
      const client = getS3Client()
      await client.send(
        new HeadObjectCommand({
          Bucket: BUCKET,
          Key: `${PREFIX}${filename}`,
        }),
      )
      return true
    } catch {
      return false
    }
  }

  return fs.existsSync(path.join(EVAL_DIR, filename))
}
