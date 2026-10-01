import { createMcpHandler } from 'mcp-handler'
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
 *
 * NOTE: no shared-key check yet. Until it lands this route is ungated and must
 * not be exposed publicly.
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
    return request ? new URL(request.url).origin : FALLBACK_ORIGIN
  } catch {
    return FALLBACK_ORIGIN
  }
}

export { handler as GET, handler as POST }
