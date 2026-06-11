/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { User } from '@/db/entities/User.entity'
import { Tag } from '@/db/entities/Tag.entity'
import { AuditLog } from '@/db/entities/AuditLog.entity'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('admin entities (DB integration)', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

  it('users entity maps the table', async () => {
    const repo = AppDataSource.getRepository(User)
    const u = await repo.save(
      repo.create({ username: `t_${Date.now()}`, passwordHash: 'x', role: 'editor' }),
    )
    expect(u.id).toBeTruthy()
    expect(u.active).toBe(true)
    await repo.delete(u.id)
  })

  it('tags entity reads seeded taxonomy', async () => {
    const tags = await AppDataSource.getRepository(Tag).find({ take: 5 })
    expect(tags.length).toBeGreaterThan(0)
    expect(tags[0].facet).toBeTruthy()
  })

  it('audit_log entity inserts', async () => {
    const repo = AppDataSource.getRepository(AuditLog)
    const row = await repo.save(
      repo.create({
        actorUserId: null,
        source: 'system',
        action: 'create',
        entityType: 'test',
        entityId: null,
        before: null,
        after: { ok: true },
      }),
    )
    expect(row.id).toBeTruthy()
    await repo.delete(row.id)
  })
})
