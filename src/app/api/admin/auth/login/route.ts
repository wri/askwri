import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { initializeDatabase } from '../../../../../db/data-source'
import { findActiveUserByUsername, touchLastLogin } from '../../../../../db/queries/users'
import { signSession, SESSION_COOKIE, sessionCookieOptions } from '../../../../../lib/auth/session'
import { internalError } from '../../../../../lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Compared against when the user lookup misses, so unknown-username and
// wrong-password requests take the same time (no username timing oracle).
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 12)

// Minimal in-memory failed-login limiter. Per-instance only: it resets on
// deploy/restart and is not shared across ECS tasks — acceptable for an
// internal tool.
const MAX_FAILED_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000
const failedAttempts = new Map<string, { count: number; windowStart: number }>()

function isThrottled(username: string): boolean {
  const entry = failedAttempts.get(username)
  if (!entry) return false
  if (Date.now() - entry.windowStart > WINDOW_MS) {
    failedAttempts.delete(username)
    return false
  }
  return entry.count >= MAX_FAILED_ATTEMPTS
}

function recordFailure(username: string): void {
  // Don't let absurdly long usernames bloat the limiter map; the login itself
  // is still processed normally.
  if (username.length > 256) return
  const now = Date.now()
  // Bound the map: sweep expired windows once it grows past 10k entries.
  if (failedAttempts.size > 10_000) {
    for (const [key, value] of failedAttempts) {
      if (now - value.windowStart > WINDOW_MS) failedAttempts.delete(key)
    }
  }
  const entry = failedAttempts.get(username)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    failedAttempts.set(username, { count: 1, windowStart: now })
  } else {
    entry.count++
  }
}

export async function POST(req: NextRequest) {
  try {
    const { username, password } = (await req.json().catch(() => ({}))) ?? {}
    if (!username || !password) {
      return NextResponse.json(
        { ok: false, error: 'username and password are required' },
        { status: 400 },
      )
    }
    if (isThrottled(String(username))) {
      return NextResponse.json(
        { ok: false, error: 'too many attempts; try again later' },
        { status: 429 },
      )
    }
    await initializeDatabase()
    const user = await findActiveUserByUsername(String(username))
    // Always run a bcrypt compare so a missing user costs the same as a
    // wrong password.
    const ok = await bcrypt.compare(String(password), user ? user.passwordHash : DUMMY_HASH)
    if (!user || !ok) {
      recordFailure(String(username))
      return NextResponse.json({ ok: false, error: 'invalid credentials' }, { status: 401 })
    }
    failedAttempts.delete(String(username))
    await touchLastLogin(user.id)
    const token = await signSession({
      userId: user.id,
      username: user.username,
      role: user.role as 'admin' | 'editor',
    })
    const res = NextResponse.json({ ok: true, user: { username: user.username, role: user.role } })
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions())
    return res
  } catch (err) {
    return internalError(err)
  }
}
