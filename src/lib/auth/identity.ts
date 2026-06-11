import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from './session'

export type AdminIdentity =
  | { kind: 'user'; userId: string; username: string; role: 'admin' | 'editor' }
  | { kind: 'token'; role: 'admin' }

export interface IdentityResult {
  identity?: AdminIdentity
  response?: NextResponse
}

export async function getIdentity(req: NextRequest): Promise<AdminIdentity | null> {
  const apiToken = process.env.ADMIN_API_TOKEN
  const bearer = req.headers.get('authorization')
  if (apiToken && bearer === `Bearer ${apiToken}`) {
    return { kind: 'token', role: 'admin' }
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await verifySession(token)
  if (!session) return null
  return { kind: 'user', ...session }
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
