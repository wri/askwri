import { NextRequest, NextResponse } from 'next/server'
import { requireIdentity } from '../../../../../lib/auth/identity'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { identity, response } = await requireIdentity(req)
  if (response) return response
  return NextResponse.json({
    ok: true,
    identity:
      identity!.kind === 'user'
        ? { kind: 'user', username: identity!.username, role: identity!.role }
        : { kind: 'token', role: 'admin' },
  })
}
