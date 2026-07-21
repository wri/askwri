import { NextResponse } from 'next/server'

/** Log the real error server-side; return a generic 500 to the client. */
export function internalError(err: unknown): NextResponse {
  console.error('[admin-api]', err)
  return NextResponse.json({ ok: false, error: 'internal error' }, { status: 500 })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
