/** @jest-environment node */
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import { config } from '@/proxy'

// The matcher decides whether Next runs the proxy at all, and running it is
// what costs memory: next-server calls cloneBodyStream() BEFORE invoking the
// handler (next/dist/server/body-streams.js:87), teeing the whole request body
// into two in-memory PassThroughs. The proxy never reads its copy, so nothing
// drains it. For a 79MB upload that is ~158MB of pure waste on a 512MB task —
// the OOM (exit 137) that 502'd the intake batch on 2026-08-06.
//
// /api/admin/intake must therefore never match. It loses nothing: the route
// calls requireIdentity() itself (app/api/admin/intake/route.ts:32), which is
// STRICTER than the proxy — it revalidates the session against the users table.
function matchesProxy(pathname: string): boolean {
  return config.matcher.some((m) => getPathMatch(m)(pathname) !== false)
}

describe('proxy matcher', () => {
  it('does not match /api/admin/intake (body would be cloned into memory)', () => {
    expect(matchesProxy('/api/admin/intake')).toBe(false)
  })

  it('still matches every other admin API route', () => {
    expect(matchesProxy('/api/admin/review-queue')).toBe(true)
    expect(matchesProxy('/api/admin/documents')).toBe(true)
    expect(matchesProxy('/api/admin/documents/abc123/status')).toBe(true)
    expect(matchesProxy('/api/admin/auth/me')).toBe(true)
  })

  it('still matches admin pages and the bearer-token import route', () => {
    expect(matchesProxy('/admin/review')).toBe(true)
    expect(matchesProxy('/admin/upload')).toBe(true)
    expect(matchesProxy('/api/import-documents')).toBe(true)
  })

  it('exempts only the exact intake endpoint, not paths beneath it', () => {
    expect(matchesProxy('/api/admin/intake/anything')).toBe(true)
  })
})
