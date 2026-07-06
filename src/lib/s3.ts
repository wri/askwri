import type { S3ClientConfig } from '@aws-sdk/client-s3'

// Local dev (MinIO): AWS_ENDPOINT_URL points every S3 client at the local
// endpoint, and path-style addressing is required there — virtual-host style
// would try to resolve `<bucket>.localhost`. Unset (production ECS): empty
// config, SDK defaults (task-role credentials, real S3). SDK v3 has no env
// var for forcePathStyle, hence this helper instead of plain `new S3Client({})`.
export function s3ClientConfig(): S3ClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL
  return endpoint ? { endpoint, forcePathStyle: true } : {}
}
