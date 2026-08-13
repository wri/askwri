import { AppDataSource } from '../data-source'

export interface RelationDocSummary {
  externalId: string
  title: string | null
  language: string | null
}

export interface RelationRow {
  id: string
  documentId: string
  relatedDocumentId: string
  relationType: string
  status: string
  source: string
  confidence: number | null
  signals: Record<string, unknown>
  createdAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  translation: RelationDocSummary
  original: RelationDocSummary
}

const SELECT = `
  SELECT r.id, r.document_id AS "documentId", r.related_document_id AS "relatedDocumentId",
         r.relation_type AS "relationType", r.status, r.source,
         r.confidence::float AS confidence, r.signals,
         r.created_at AS "createdAt", r.reviewed_by AS "reviewedBy", r.reviewed_at AS "reviewedAt",
         dt.external_id AS "tExternalId", COALESCE(dt.title_en, dt.title) AS "tTitle", dt.language AS "tLanguage",
         do_.external_id AS "oExternalId", COALESCE(do_.title_en, do_.title) AS "oTitle", do_.language AS "oLanguage"
    FROM document_relations r
    JOIN documents dt ON dt.id = r.document_id
    JOIN documents do_ ON do_.id = r.related_document_id`

function toRow(r: any): RelationRow {
  return {
    id: r.id,
    documentId: r.documentId,
    relatedDocumentId: r.relatedDocumentId,
    relationType: r.relationType,
    status: r.status,
    source: r.source,
    confidence: r.confidence ?? null,
    signals: r.signals ?? {},
    createdAt: r.createdAt,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    translation: {
      externalId: r.tExternalId,
      title: r.tTitle,
      language: r.tLanguage,
    },
    original: {
      externalId: r.oExternalId,
      title: r.oTitle,
      language: r.oLanguage,
    },
  }
}

async function audit(
  relationId: string,
  reviewer: string,
  before: object,
  after: object,
) {
  await AppDataSource.query(
    `INSERT INTO audit_log (source, actor_user_id, action, entity_type, entity_id, before, after)
     VALUES ('human', NULL, 'relation_review', 'document_relation', $1, $2, $3)`,
    [
      relationId,
      JSON.stringify({ ...before, reviewer }),
      JSON.stringify(after),
    ],
  )
}

export async function listRelations(status?: string): Promise<RelationRow[]> {
  const where = status ? ` WHERE r.status = $1` : ''
  const rows = await AppDataSource.query(
    `${SELECT}${where} ORDER BY r.created_at DESC`,
    status ? [status] : [],
  )
  return rows.map(toRow)
}

async function getRaw(id: string) {
  const rows = await AppDataSource.query(
    `SELECT id, document_id, related_document_id, status FROM document_relations WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

export async function reviewRelation(
  id: string,
  action: 'confirm' | 'reject' | 'flip',
  reviewer: string,
): Promise<RelationRow | null> {
  const before = await getRaw(id)
  if (!before) return null
  if (action === 'flip') {
    await AppDataSource.query(
      `UPDATE document_relations
          SET document_id = related_document_id, related_document_id = document_id,
              reviewed_by = $2, reviewed_at = now()
        WHERE id = $1`,
      [id, reviewer],
    )
  } else {
    await AppDataSource.query(
      `UPDATE document_relations
          SET status = $2, reviewed_by = $3, reviewed_at = now()
        WHERE id = $1`,
      [id, action === 'confirm' ? 'confirmed' : 'rejected', reviewer],
    )
  }
  const after = await getRaw(id)
  await audit(id, reviewer, before, after)
  const rows = await AppDataSource.query(`${SELECT} WHERE r.id = $1`, [id])
  return rows.length ? toRow(rows[0]) : null
}

export async function unlinkRelation(
  id: string,
  reviewer: string,
): Promise<RelationRow | null> {
  const before = await getRaw(id)
  if (!before || before.status !== 'confirmed') return null
  await AppDataSource.query(
    `UPDATE document_relations SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
      WHERE id = $1`,
    [id, reviewer],
  )
  const after = await getRaw(id)
  await audit(id, reviewer, before, after)
  const rows = await AppDataSource.query(`${SELECT} WHERE r.id = $1`, [id])
  return rows.length ? toRow(rows[0]) : null
}

export async function createManualRelation(
  translationDocId: string,
  originalDocId: string,
  reviewer: string,
): Promise<RelationRow> {
  const [row] = await AppDataSource.query(
    `INSERT INTO document_relations
       (document_id, related_document_id, source, status, reviewed_by, reviewed_at)
     VALUES ($1, $2, 'human', 'confirmed', $3, now())
     RETURNING id`,
    [translationDocId, originalDocId, reviewer],
  )
  await audit(
    row.id,
    reviewer,
    {},
    {
      status: 'confirmed',
      document_id: translationDocId,
      related_document_id: originalDocId,
    },
  )
  const rows = await AppDataSource.query(`${SELECT} WHERE r.id = $1`, [row.id])
  return toRow(rows[0])
}
