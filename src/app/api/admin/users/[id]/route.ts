import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase, AppDataSource } from '../../../../../db/data-source'
import { updateUser } from '../../../../../db/queries/users'
import { requireIdentity, auditActor } from '../../../../../lib/auth/identity'
import { writeAudit } from '../../../../../db/queries/audit'
import { User } from '../../../../../db/entities/User.entity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    const body = (await req.json().catch(() => ({}))) ?? {}
    const { role, active, password } = body as {
      role?: unknown
      active?: unknown
      password?: unknown
    }

    if (role !== undefined && role !== 'admin' && role !== 'editor') {
      return NextResponse.json({ ok: false, error: 'role must be admin or editor' }, { status: 400 })
    }

    await initializeDatabase()
    const existing = await AppDataSource.getRepository(User).findOne({ where: { id } })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'user not found' }, { status: 404 })
    }

    const patch: Partial<{ role: 'admin' | 'editor'; active: boolean; passwordHash: string }> = {}
    const auditAfter: Record<string, any> = {}

    if (role !== undefined) {
      patch.role = role as 'admin' | 'editor'
      auditAfter.role = role
    }
    if (active !== undefined) {
      patch.active = Boolean(active)
      auditAfter.active = Boolean(active)
    }
    if (password !== undefined) {
      if (String(password).length < 12) {
        return NextResponse.json(
          { ok: false, error: 'password must be at least 12 characters' },
          { status: 400 },
        )
      }
      patch.passwordHash = await bcrypt.hash(String(password), 12)
      auditAfter.password = '<reset>'
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: false, error: 'no valid fields to update' }, { status: 400 })
    }

    await updateUser(id, patch)
    await writeAudit({
      ...auditActor(identity!),
      action: 'update',
      entityType: 'user',
      entityId: id,
      after: auditAfter,
    })

    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
