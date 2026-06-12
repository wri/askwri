import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

const PUBLIC_PATHS = new Set(['/admin/login', '/api/admin/auth/login'])

// Edge-compatible constant-time string comparison: hash both sides with
// SHA-256 (fixed-length output hides length differences) and XOR-accumulate
// over the hex digests so the comparison takes the same time regardless of
// where they differ.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])
  const toHex = (buf: ArrayBuffer) =>
    Array.from(new Uint8Array(buf), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const hexA = toHex(digestA)
  const hexB = toHex(digestB)
  let diff = 0
  for (let i = 0; i < hexA.length; i++) {
    diff |= hexA.charCodeAt(i) ^ hexB.charCodeAt(i)
  }
  return diff === 0
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  // Bearer-token path must stay: bearer-only API calls have no session cookie,
  // so removing this would 401 them here before the handler ever runs.
  const apiToken = process.env.ADMIN_API_TOKEN
  const authHeader = req.headers.get('authorization')
  if (
    apiToken &&
    authHeader &&
    (await timingSafeEqual(authHeader, `Bearer ${apiToken}`))
  ) {
    return NextResponse.next()
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token && (await verifySession(token))) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/admin/login'
  loginUrl.searchParams.set('next', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*', '/api/import-documents'],
}
