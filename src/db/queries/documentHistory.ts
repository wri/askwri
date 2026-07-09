import { AppDataSource } from '../data-source'

export interface HistoryEntry {
  at: string
  action: string
  entityType: string
  actor: string // username, or the row's source ('human'|'system') when unattributed
  source: string
  before: Record<string, any> | null
  after: Record<string, any> | null
}

export interface DocumentHistoryResult {
  total: number
  entries: HistoryEntry[]
}

// Matches every audit row attributable to the document. Deliberately excluded
// (no recoverable document reference in the row): bulk CSV-import summary rows
// (entity_id NULL, counts only) and intake duplicate-skip rows (external_id
// string in after->>'of' only). Python writers use entity_type='documents'
// (plural) — both spellings are matched.
// TODO: switch to UNION ALL (+ GIN on after->'addedDocumentIds') if audit_log seq scans become hot — the OR defeats the (entity_type, entity_id) index.
const SCOPE = `
  (al.entity_type IN ('document', 'documents', 'document_summary') AND al.entity_id = $1)
  OR (al.entity_type = 'ingestion_job'
      AND al.entity_id IN (SELECT id FROM ingestion_jobs WHERE document_id = $1))
  OR (al.entity_type = 'collection'
      AND (al.after -> 'addedDocumentIds' @> to_jsonb($1::text)
           OR al.before ->> 'removedDocumentId' = $1::text))`

export async function getDocumentHistory(
  documentId: string,
  { limit = 20, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<DocumentHistoryResult> {
  const entries = await AppDataSource.query(
    `SELECT al.at, al.action, al.entity_type AS "entityType",
            COALESCE(u.username, al.source) AS actor,
            al.source, al.before, al.after
     FROM audit_log al
     LEFT JOIN users u ON u.id = al.actor_user_id
     WHERE ${SCOPE}
     ORDER BY al.at DESC, al.id DESC
     LIMIT $2 OFFSET $3`,
    [documentId, limit, offset],
  )
  const [row] = await AppDataSource.query(
    `SELECT count(*)::int AS total FROM audit_log al WHERE ${SCOPE}`,
    [documentId],
  )
  return { total: row?.total ?? 0, entries }
}
