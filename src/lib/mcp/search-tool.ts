import { NextRequest } from 'next/server'
import { z } from 'zod'
import { POST as searchRoute } from '@/app/api/llamaindex/route'
import { UNREACHABLE_TEXT, formatSearchResults } from './search-results'

export const SEARCH_TOOL_NAME = 'search_wri'
export const DEFAULT_MAX_RESULTS = 10
export const MAX_MAX_RESULTS = 20

/**
 * The only lever we have on whether citations survive into someone else's
 * answer: an instruction. It is a request to a model, not a guarantee.
 */
export const SEARCH_TOOL_DESCRIPTION = `Search WRI's published research corpus. Returns passages from WRI reports and
publications, each with a relevance label and a link that opens the page it came
from. Use it for any question about what WRI has published. The label is strong,
partial, or weak: strong means the passage directly addresses the question, weak
means it is tangential. When you use a passage in an answer, always name the
document and give the page link. When the results say the corpus is thin on the
topic, say so rather than answering as if it were well covered.`

export const searchToolInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("The question or topic, in the person's own words."),
  year_from: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .optional()
    .describe('Earliest publication year. Set this only if the person named one.'),
  year_to: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .optional()
    .describe('Latest publication year. Set this only if the person named one.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_RESULTS)
    .optional()
    .describe(
      `How many passages to return. Defaults to ${DEFAULT_MAX_RESULTS}, at most ${MAX_MAX_RESULTS}.`,
    ),
})

export interface SearchArgs {
  query: string
  year_from?: number
  year_to?: number
  max_results?: number
}

export interface SearchContext {
  /** The address the caller connected to, so citation links point where they came from. */
  baseUrl: string
}

// The route handler only reads the request body, never the origin, so this can be
// any well-formed URL. Calling the handler in-process avoids a loop back out
// through the load balancer.
const INTERNAL_URL = 'http://askwri.internal/api/llamaindex'

/**
 * Search the corpus and return the text an assistant hands to a person.
 *
 * Never throws: a failure becomes a sentence saying the search could not be
 * reached, so the caller always has something readable to pass on.
 */
export async function runSearchWri(
  args: SearchArgs,
  ctx: SearchContext,
): Promise<string> {
  try {
    const body: Record<string, unknown> = {
      query: args.query,
      mode: 'cite',
      max_results: clampMaxResults(args.max_results),
    }
    if (args.year_from !== undefined) body.min_year = args.year_from
    if (args.year_to !== undefined) body.max_year = args.year_to

    const response = await searchRoute(
      new NextRequest(INTERNAL_URL, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    )
    const json = await response.json()
    return formatSearchResults(args.query, json, ctx.baseUrl)
  } catch (error) {
    console.error('[MCP] search_wri failed:', error)
    return UNREACHABLE_TEXT
  }
}

function clampMaxResults(requested: number | undefined): number {
  if (!Number.isFinite(requested) || requested === undefined) {
    return DEFAULT_MAX_RESULTS
  }
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_MAX_RESULTS)
}
