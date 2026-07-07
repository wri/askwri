import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase, AppDataSource } from '../../../../../db/data-source'
import { updateUser, countOtherActiveAdmins } from '../../../../../db/queries/users'
import { requireIdentity, auditActor } from '../../../../../lib/auth/identity'
import { internalError, isUuid } from '../../../../../lib/api-error'
import { writeAudit } from '../../../../../db/queries/audit'
import { User } from '../../../../../db/entities/User.entity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { id } = await params
    if (!isUuid(id)) {
      return NextResponse.json({ ok: false, error: 'user not found' }, { status: 404 })
    }
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
    const auditBefore: Record<string, any> = {}
    const auditAfter: Record<string, any> = {}

    if (role !== undefined) {
      patch.role = role as 'admin' | 'editor'
      auditBefore.role = existing.role
      auditAfter.role = role
    }
    if (active !== undefined) {
      patch.active = Boolean(active)
      auditBefore.active = existing.active
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

    // Last-admin guard: never demote or deactivate the only active admin.
    // Self-demote/self-deactivate is blocked: an admin cannot strip their own
    // access (prevents accidental lockout and is the mechanism for the
    // concurrent-self-step-down race).
    const demotes = patch.role === 'editor'
    const deactivates = patch.active === false
    const isSelf = identity?.kind === 'user' && identity.userId === id
    if (isSelf && (demotes || deactivates)) {
      return NextResponse.json(
        { ok: false, error: 'you cannot demote or deactivate your own account' },
        { status: 409 },
      )
    }
    if (existing.role === 'admin' && existing.active && (demotes || deactivates)) {
      // Atomic guard: UPDATE only succeeds if at least one other active admin
      // remains. No TOCTOU — the count and the update are one statement.
      const [guardRow] = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM users WHERE role='admin' AND active=true AND id<>$1`,
        [id],
      )
      if (guardRow.n === 0) {
        return NextResponse.json(
          { ok: false, error: 'cannot remove the last active admin' },
          { status: 409 },
        )
      }
    }

    await updateUser(id, patch)
    await writeAudit({
      ...auditActor(identity!),
      action: 'update',
      entityType: 'user',
      entityId: id,
      before: Object.keys(auditBefore).length > 0 ? auditBefore : undefined,
      after: auditAfter,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return internalError(err)
  }
}
