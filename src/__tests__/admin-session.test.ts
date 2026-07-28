/** @jest-environment node */
import {
  signSession,
  verifySession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '@/lib/auth/session'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
})

describe('session sign/verify', () => {
  const payload = { userId: 'u-1', username: 'alice', role: 'admin' as const }

  it('round-trips a valid session', async () => {
    const token = await signSession(payload)
    expect(await verifySession(token)).toEqual(payload)
  })

  it('rejects a tampered token', async () => {
    const token = await signSession(payload)
    // Flip a mid-signature char (guaranteed different; the final base64url
    // char has ignored padding bits, so appending 'xx' was flaky).
    const i = token.length - 3
    const tampered =
      token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1)
    expect(await verifySession(tampered)).toBeNull()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(payload)
    process.env.SESSION_SECRET = 'another-secret-another-secret-another-00'
    expect(await verifySession(token)).toBeNull()
    process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234'
  })

  it('rejects payloads with unknown roles', async () => {
    const token = await signSession({ ...payload, role: 'root' as any })
    expect(await verifySession(token)).toBeNull()
  })

  it('cookie options are httpOnly + lax', () => {
    const opts = sessionCookieOptions()
    expect(opts.httpOnly).toBe(true)
    expect(opts.sameSite).toBe('lax')
    expect(SESSION_COOKIE).toBe('askwri_session')
  })
})
