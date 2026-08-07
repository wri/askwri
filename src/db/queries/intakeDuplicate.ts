import { AppDataSource } from '../data-source'

export interface IntakeDuplicate {
  /** external_id of the document the upload duplicated. */
  externalId: string
  /** documents.id, or null when the audit row names a doc that no longer exists. */
  docId: string | null
  title: string | null
}

/**
 * Resolve what an intake upload was rejected as a duplicate OF.
 *
 * The worker's content-hash dedup (search-service/worker/intake_s3.py:28-35)
 * skips the file and writes an audit row rather than creating a documents row:
 *   {"intake": "<filename>.pdf", "result": "duplicate_skipped", "of": "<external_id>"}
 * That audit row is the ONLY record of the relationship — there is no documents
 * row for the rejected upload to hang it off. Without this lookup the upload UI
 * can only infer "likely duplicate" from the absence of a registration and
 * cannot say what it matched.
 *
 * Matches on the filename as written to intake/, which is what the worker
 * records. Returns the most recent decision: the same filename can be dropped
 * more than once, and only the latest attempt is the one on screen.
 *
 * docId is resolved separately (and may be null) because audit rows outlive the
 * documents they name — a later delete would otherwise strand this lookup.
 */
export async function findIntakeDuplicate(
  filename: string,
): Promise<IntakeDuplicate | null> {
  const rows = await AppDataSource.query(
    `SELECT a.after->>'of' AS external_id, d.id::text AS doc_id, d.title AS title
       FROM audit_log a
       LEFT JOIN documents d ON d.external_id = a.after->>'of'
      WHERE a.action = 'import'
        AND a.entity_type = 'documents'
        AND a.after->>'result' = 'duplicate_skipped'
        AND a.after->>'intake' = $1
      ORDER BY a.at DESC
      LIMIT 1`,
    [filename],
  )
  if (rows.length === 0) return null
  const row = rows[0]
  if (!row.external_id) return null
  return {
    externalId: row.external_id,
    docId: row.doc_id ?? null,
    title: row.title ?? null,
  }
}
