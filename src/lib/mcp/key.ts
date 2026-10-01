import { timingSafeEqual } from 'node:crypto'

const BEARER = /^Bearer\s+(.+)$/i

/**
 * Is this request allowed in?
 *
 * The key arrives one of two ways. As a credential:
 *
 *     Authorization: Bearer <key>
 *
 * or as part of the address:
 *
 *     https://<address>/api/mcp?key=<key>
 *
 * Both are needed. Claude Desktop's connector screen has no field for a
 * credential, so for Claude and ChatGPT the address form is the only one
 * available; tools that do take a header can use the neater form.
 *
 * With no key configured, nothing is allowed. An unset key means the door is
 * shut, never that it is open.
 */
export function isAuthorized(request: Request): boolean {
  const configured = process.env.MCP_SHARED_KEY
  if (!configured) return false

  const presented = presentedKey(request)
  return presented !== null && sameString(presented, configured)
}

function presentedKey(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header) {
    const match = header.match(BEARER)
    if (match) return match[1].trim()
  }
  try {
    return new URL(request.url).searchParams.get('key')
  } catch {
    return null
  }
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
