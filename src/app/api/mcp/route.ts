import { createMcpHandler } from 'mcp-handler'
import { isAuthorized } from '@/lib/mcp/key'
import {
  SEARCH_TOOL_DESCRIPTION,
  SEARCH_TOOL_NAME,
  runSearchWri,
  searchToolInputSchema,
} from '@/lib/mcp/search-tool'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Only used if a client somehow arrives without a usable request URL. */
const FALLBACK_ORIGIN = 'https://askwri.invalid'

/**
 * The tool surface: one read-only tool. Nothing here writes to AskWRI.
 *
 * The handler is mounted at `/api/mcp` and speaks both the current MCP
 * specification and 2025-era clients from the same entry point.
 */
const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      SEARCH_TOOL_NAME,
      {
        title: 'Search the WRI corpus',
        description: SEARCH_TOOL_DESCRIPTION,
        inputSchema: searchToolInputSchema,
      },
      async (args, ctx) => ({
        content: [
          {
            type: 'text',
            text: await runSearchWri(args, {
              baseUrl: originOf(ctx?.http?.req),
            }),
          },
        ],
      }),
    )
  },
  { serverInfo: { name: 'askwri', version: '1.0.0' } },
)

/** The address the caller actually connected to, so citation links point back there. */
function originOf(request: Request | undefined): string {
  try {
    if (request?.url) return new URL(request.url).origin
  } catch {
    // fall through to the warning below
  }
  // Every link in this reply is about to be dead. That is worth a loud line: it
  // means the deployment handed us no usable address.
  console.warn(
    `[MCP] no request address available — citation links will point at ${FALLBACK_ORIGIN}`,
  )
  return FALLBACK_ORIGIN
}

/** Readable on purpose: "wrong key" must be distinguishable from "service down". */
const NEEDS_KEY =
  'This service needs a key. Add it as a credential (Authorization: Bearer <key>) or as a key parameter on the address (?key=<key>).'

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    // One line so probing is visible in whatever log the deployment has. The
    // value presented is never written down.
    console.warn(
      `[MCP] refused ${request.method} — no valid key presented (${requestPointer(request)})`,
    )
    return new Response(NEEDS_KEY, {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  return handler(request)
}

/** The address without its query string: enough to see the traffic, no key in it. */
function requestPointer(request: Request): string {
  try {
    return new URL(request.url).pathname
  } catch {
    return 'unparseable-address'
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request)
}

export async function POST(request: Request): Promise<Response> {
  return handle(request)
}
