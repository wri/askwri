import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase } from '../../../../../db/data-source'
import { findActiveUserByUsername, touchLastLogin } from '../../../../../db/queries/users'
import { signSession, SESSION_COOKIE, sessionCookieOptions } from '../../../../../lib/auth/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { username, password } = (await req.json().catch(() => ({}))) ?? {}
    if (!username || !password) {
      return NextResponse.json(
        { ok: false, error: 'username and password are required' },
        { status: 400 },
      )
    }
    await initializeDatabase()
    const user = await findActiveUserByUsername(String(username))
    const ok = user && (await bcrypt.compare(String(password), user.passwordHash))
    if (!ok) {
      return NextResponse.json({ ok: false, error: 'invalid credentials' }, { status: 401 })
    }
    await touchLastLogin(user.id)
    const token = await signSession({
      userId: user.id,
      username: user.username,
      role: user.role as 'admin' | 'editor',
    })
    const res = NextResponse.json({ ok: true, user: { username: user.username, role: user.role } })
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return res
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
  }
}
