import { SignJWT, jwtVerify } from 'jose'

export interface SessionPayload {
  userId: string
  username: string
  role: 'admin' | 'editor'
}

export const SESSION_COOKIE = 'askwri_session'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be set and >= 32 chars')
  }
  return new TextEncoder().encode(secret)
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(secretKey())
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey())
    const { userId, username, role } = payload as Record<string, unknown>
    if (typeof userId !== 'string' || typeof username !== 'string') return null
    if (role !== 'admin' && role !== 'editor') return null
    return { userId, username, role }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  }
}
