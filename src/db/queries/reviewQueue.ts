import { AppDataSource } from '../data-source'

export interface ReviewQueueItem {
  id: string
  externalId: string
  title: string | null
  language: string | null
  status: string
  extractionConfidence: number | null
  jobStatus: string | null
  jobError: string | null
  jobAttempts: number | null
  suggestedTagCount: number
  createdAt: string
}

/**
 * Documents needing human attention: status needs_review/error, or whose
 * latest ingestion job errored out (job exhausted retries while the document
 * may still sit in draft/processing).
 */
export async function getReviewQueue(): Promise<ReviewQueueItem[]> {
  return AppDataSource.query(`
    SELECT d.id,
           d.external_id            AS "externalId",
           d.title,
           d.language,
           d.status,
           d.extraction_confidence::float AS "extractionConfidence",
           j.status                 AS "jobStatus",
           j.error                  AS "jobError",
           j.attempts               AS "jobAttempts",
           COALESCE(st.n, 0)        AS "suggestedTagCount",
           d.created_at             AS "createdAt"
    FROM documents d
    LEFT JOIN LATERAL (
      SELECT status, error, attempts
      FROM ingestion_jobs
      WHERE document_id = d.id
      ORDER BY created_at DESC
      LIMIT 1
    ) j ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM document_tags dt
      WHERE dt.document_id = d.id AND dt.status = 'suggested'
    ) st ON true
    WHERE d.status IN ('needs_review', 'error')
       OR j.status = 'error'
    ORDER BY d.created_at DESC
  `)
}
