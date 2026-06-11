import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase } from '../../../../db/data-source'
import { listUsers, createUser } from '../../../../db/queries/users'
import { requireIdentity, auditActor } from '../../../../lib/auth/identity'
import { writeAudit } from '../../../../db/queries/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    await initializeDatabase()
    return NextResponse.json({ ok: true, users: await listUsers() })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { identity, response } = await requireIdentity(req, 'admin')
  if (response) return response
  try {
    const { username, email, password, role } = (await req.json().catch(() => ({}))) ?? {}
    if (!username || !password || (role !== 'admin' && role !== 'editor')) {
      return NextResponse.json(
        { ok: false, error: 'username, password, and role (admin|editor) are required' },
        { status: 400 },
      )
    }
    if (String(password).length < 12) {
      return NextResponse.json(
        { ok: false, error: 'password must be at least 12 characters' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const user = await createUser({
      username: String(username),
      email: email ?? null,
      passwordHash: await bcrypt.hash(String(password), 12),
      role,
    })
    await writeAudit({
      ...auditActor(identity!),
      action: 'create',
      entityType: 'user',
      entityId: user.id,
      after: { username: user.username, role: user.role },
    })
    return NextResponse.json({ ok: true, user })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
