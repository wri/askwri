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
// LIMITATION, stated because it is not obvious: getPathMatch is an
// approximation of what ships. Next compiles config.matcher at BUILD time into
// .next/server/functions-config-manifest.json and matches with
// `new RegExp(m.regexp)` — no flags, so case-SENSITIVE — after wrapping the
// pattern with _next/data prefix and .json/.rsc suffix handling. getPathMatch
// defaults to sensitive:false (path-match.js:16). They therefore disagree on
// case: '/api/admin/INTAKE' is excluded here but matched by the shipped regex.
// That is inert (Next's own route dispatch is case-sensitive, so /INTAKE 404s
// before auth matters either way), but a future matcher edit could land
// somewhere this divergence bites. Asserting against the manifest instead
// would couple these tests to a prior `next build`, which unit tests must not
// require — so the compiled regex was verified by hand at fix time.
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

  // Side effect of moving from '/api/admin/:path*' to a regex segment: :path*
  // allowed zero segments, the regex requires at least one character. Inert —
  // nothing is routed at the bare path — but pinned so the change is visible
  // if someone ever adds a handler there and wonders why it is unauthenticated.
  it('no longer matches the bare /api/admin path', () => {
    expect(matchesProxy('/api/admin')).toBe(false)
  })
})
