import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { SESSION_COOKIE, verifySession } from './session'
import { initializeDatabase } from '../../db/data-source'
import { findUserById } from '../../db/queries/users'

export type AdminIdentity =
  | { kind: 'user'; userId: string; username: string; role: 'admin' | 'editor' }
  | { kind: 'token'; role: 'admin' }

export interface IdentityResult {
  identity?: AdminIdentity
  response?: NextResponse
}

/** Constant-time string comparison via sha256 digests (lengths may differ). */
function timingSafeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}

export async function getIdentity(req: NextRequest): Promise<AdminIdentity | null> {
  const apiToken = process.env.ADMIN_API_TOKEN
  const bearer = req.headers.get('authorization')
  if (apiToken && bearer && timingSafeStringEqual(bearer, `Bearer ${apiToken}`)) {
    return { kind: 'token', role: 'admin' }
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await verifySession(token)
  if (!session) return null
  // Revalidate the session against the DB so deactivation/role changes take
  // effect immediately instead of after the 7-day token TTL. The DB role wins
  // over whatever the token says.
  await initializeDatabase()
  const user = await findUserById(session.userId)
  if (!user || user.active === false) return null
  const role = user.role === 'admin' ? 'admin' : 'editor'
  return { kind: 'user', userId: session.userId, username: session.username, role }
}

/**
 * Route-handler guard. Usage:
 *   const { identity, response } = await requireIdentity(req, 'admin')
 *   if (response) return response
 */
export async function requireIdentity(
  req: NextRequest,
  role?: 'admin',
): Promise<IdentityResult> {
  const identity = await getIdentity(req)
  if (!identity) {
    return {
      response: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
    }
  }
  if (role === 'admin' && identity.role !== 'admin') {
    return {
      response: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }),
    }
  }
  return { identity }
}

/** Map an identity to audit_log actor fields. */
export function auditActor(identity: AdminIdentity): {
  actorUserId: string | null
  source: 'human' | 'system'
} {
  return identity.kind === 'user'
    ? { actorUserId: identity.userId, source: 'human' }
    : { actorUserId: null, source: 'system' }
}
