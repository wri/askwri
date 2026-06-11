import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session'

const PUBLIC_PATHS = new Set(['/admin/login', '/api/admin/auth/login'])

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()

  const apiToken = process.env.ADMIN_API_TOKEN
  // Plain === is fine here: this is only an edge-runtime pre-filter; the real
  // gate is the timing-safe check in requireIdentity inside each handler.
  if (apiToken && req.headers.get('authorization') === `Bearer ${apiToken}`) {
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
