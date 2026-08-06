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
    Array.from(new Uint8Array(buf), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
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
  // RFC 7235: the auth scheme token is case-insensitive.
  const apiToken = process.env.ADMIN_API_TOKEN
  const authHeader = req.headers.get('authorization')
  if (
    apiToken &&
    authHeader &&
    authHeader.toLowerCase().startsWith('bearer ') &&
    (await timingSafeEqual(authHeader.toLowerCase(), `bearer ${apiToken}`))
  ) {
    return NextResponse.next()
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token && (await verifySession(token))) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401 },
    )
  }
  const loginUrl = req.nextUrl.clone()
  loginUrl.pathname = '/admin/login'
  loginUrl.searchParams.set('next', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // /api/admin/intake is deliberately excluded (the `(?!intake$)` lookahead).
  // Matching it here does not just run this function — next-server tees the
  // whole request body into two in-memory PassThroughs before calling the
  // handler (next/dist/server/body-streams.js:87-101), and this proxy never
  // reads its copy, so nothing drains it. That doubled a 79MB upload to ~158MB
  // of buffer on the 512MB qa task and OOM-killed it (exit 137, 2026-08-06):
  // with desired_count=1 every request 502s until the replacement task passes
  // health checks, which is why small files in the same batch failed too.
  //
  // Auth is NOT weakened: the route calls requireIdentity() itself
  // (app/api/admin/intake/route.ts:32), which is stricter than this proxy —
  // it revalidates the session against the users table so deactivations take
  // effect immediately. Any new unauthenticated route must not be added under
  // this exemption. Covered by __tests__/proxy-matcher.test.ts.
  matcher: [
    '/admin/:path*',
    '/api/admin/((?!intake$).*)',
    '/api/import-documents',
  ],
}
