import { AppDataSource } from '../data-source'
import { AuditLog } from '../entities/AuditLog.entity'

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'tag_decision'
  | 'tag_create'
  | 'tag_update'
  | 'tag_delete'
  | 'tag_merge'
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

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const repo = AppDataSource.getRepository(AuditLog)
  await repo.insert({
    actorUserId: entry.actorUserId,
    source: entry.source,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  })
}
