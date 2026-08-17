import { AppDataSource } from '../data-source'
import { AuditLog } from '../entities/AuditLog.entity'
import type { EntityManager } from 'typeorm'

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'tag_decision'
  | 'tag_create'
  | 'tag_update'
  | 'tag_delete'
  | 'tag_merge'
  | 'tag_import'
  | 'reclassify_enqueue'
  | 'tag_embeddings_rebuild'
  | 'lifecycle'
  | 'collection_change'
  | 'import'

export interface AuditEntry {
  actorUserId: string | null
  source: 'human' | 'system'
  action: AuditAction
  entityType: string
  entityId: string | null
  before?: Record<string, any> | null
  after?: Record<string, any> | null
}

export async function writeAudit(
  entry: AuditEntry,
  manager: EntityManager = AppDataSource.manager,
): Promise<void> {
  await manager.getRepository(AuditLog).insert({
    actorUserId: entry.actorUserId,
    source: entry.source,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  })
}
