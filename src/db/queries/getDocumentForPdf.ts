import { AppDataSource } from '../data-source'

export interface DocumentForPdf {
  s3Key: string
  status: string
}

/**
 * Look up a document by its external_id (the PDF filename without .pdf)
 * for public PDF serving. Returns the s3_key and status so the route can
 * (a) serve from S3 via the stored key (works under any DOCUMENTS_S3_PREFIX)
 * and (b) 404 withdrawn documents.
 */
export async function getDocumentForPdf(
  externalId: string,
): Promise<DocumentForPdf | null> {
  const [row] = await AppDataSource.query(
    `SELECT s3_key AS "s3Key", status FROM documents WHERE external_id = $1 LIMIT 1`,
    [externalId],
  )
  return row ?? null
}
