import { AppDataSource } from '../data-source'
import { Collection } from '../entities/Collection.entity'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

export interface CollectionWithCount {
  id: string
  name: string
  slug: string
  description: string | null
  documentCount: number
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function listCollectionsWithCounts(): Promise<
  CollectionWithCount[]
> {
  return AppDataSource.query(`
    SELECT c.id, c.name, c.slug, c.description,
           count(dc.document_id)::int AS "documentCount"
    FROM collections c
    LEFT JOIN document_collections dc ON dc.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `)
}

export async function createCollection(
  name: string,
  description: string | null,
  identity: AdminIdentity,
): Promise<Collection | { error: string }> {
  const repo = AppDataSource.getRepository(Collection)
  const slug = slugify(name)
  if (!slug) return { error: 'name must contain letters or numbers' }
  if (await repo.findOne({ where: { slug } }))
    return { error: 'a collection with this slug exists' }
  const collection = await repo.save(repo.create({ name, slug, description }))
  await writeAudit({
    ...auditActor(identity),
    action: 'create',
    entityType: 'collection',
    entityId: collection.id,
    after: { name, slug },
  })
  return collection
}

export async function updateCollection(
  id: string,
  patch: Partial<{ name: string; description: string | null }>,
  identity: AdminIdentity,
): Promise<Collection | null> {
  const repo = AppDataSource.getRepository(Collection)
  const collection = await repo.findOne({ where: { id } })
  if (!collection) return null
  const before: Record<string, any> = {}
  const after: Record<string, any> = {}
  for (const key of ['name', 'description'] as const) {
    if (
      key in patch &&
      patch[key] !== undefined &&
      patch[key] !== collection[key]
    ) {
      before[key] = collection[key]
      after[key] = patch[key]
      ;(collection as any)[key] = patch[key]
    }
  }
  // Regenerate the slug when the name changes (N-D fix: previously the slug
  // was never updated on rename, leaving a stale slug forever).
  if (after.name !== undefined) {
    const newSlug = slugify(after.name)
    before.slug = collection.slug
    after.slug = newSlug
    collection.slug = newSlug
  }
  if (Object.keys(after).length === 0) return collection
  await repo.save(collection)
  await writeAudit({
    ...auditActor(identity),
    action: 'update',
    entityType: 'collection',
    entityId: id,
    before,
    after,
  })
  return collection
}

/** Add documents to a collection (idempotent); returns how many were newly added. */
export async function addDocumentsToCollection(
  collectionId: string,
  documentIds: string[],
  identity: AdminIdentity,
): Promise<{ added: number } | { error: string }> {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!documentIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    return { error: 'documentIds must be UUIDs' }
  }
  const collection = await AppDataSource.getRepository(Collection).findOne({
    where: { id: collectionId },
  })
  if (!collection) return { error: 'collection not found' }
  const addedBy = identity.kind === 'user' ? identity.username : 'api-token'
  // RETURNING makes the newly-added count reliable: raw query() yields the
  // returned rows, so length = rows actually inserted (conflicts excluded).
  const result = await AppDataSource.query(
    `INSERT INTO document_collections (document_id, collection_id, added_by)
     SELECT d.id, $1, $2 FROM documents d WHERE d.id = ANY($3::uuid[])
     ON CONFLICT DO NOTHING
     RETURNING document_id`,
    [collectionId, addedBy, documentIds],
  )
  const rows: { document_id: string }[] = Array.isArray(result) ? result : []
  await writeAudit({
    ...auditActor(identity),
    action: 'collection_change',
    entityType: 'collection',
    entityId: collectionId,
    after: { addedDocumentIds: rows.map((r) => r.document_id) },
  })
  return { added: rows.length }
}

export async function removeDocumentFromCollection(
  collectionId: string,
  documentId: string,
  identity: AdminIdentity,
): Promise<void> {
  // pg driver returns [rows, rowCount] for DELETE
  const [deletedRows] = await AppDataSource.query(
    `DELETE FROM document_collections WHERE collection_id = $1 AND document_id = $2
     RETURNING document_id`,
    [collectionId, documentId],
  )
  if (!Array.isArray(deletedRows) || deletedRows.length === 0) return
  await writeAudit({
    ...auditActor(identity),
    action: 'collection_change',
    entityType: 'collection',
    entityId: collectionId,
    before: { removedDocumentId: documentId },
  })
}
