/**
 * Projection stage: one frozen retrieval becomes the four route payloads the UI
 * sends. Every payload is built with the shipped builders in
 * `src/app/utils/utils.tsx` rather than with copies of them, so a sweep cannot
 * drift from what a user's click actually posts.
 *
 * The frozen case's doc list is the retrieval the UI would have sent, so the
 * payload sizes here are the user-facing ones (design §2).
 */
import {
  authorsFrom,
  buildAlignmentSummary,
  buildCatalogIndex,
  matchCatalogRow,
  normalizeCatalogRow,
  titleFrom,
  yearFrom,
} from '@/app/utils/utils'
import type { FrozenCase, RouteName } from './types'

type CatalogIndex = ReturnType<typeof buildCatalogIndex>

/**
 * The target's catalog index, built the way `src/lib/catalog-cache.ts` builds
 * it — except that the fetch is absolute, because the sweep runs in node
 * against a deployed host rather than in the browser at its own origin.
 *
 * Any failure is null, never a throw: the index only enriches titles, authors
 * and the alignment summary's language list (`buildAlignmentSummary` takes it
 * optionally), and a sweep that reported nothing because a catalog call failed
 * would be worth less than one that recorded payloads built without it.
 */
export async function fetchCatalogIndex(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogIndex | null> {
  const base = target.replace(/\/+$/, '')
  try {
    const res = await fetchImpl(`${base}/api/catalog`)
    if (!res.ok) return null
    const body = (await res.json()) as { items?: unknown }
    if (!Array.isArray(body?.items)) return null
    return buildCatalogIndex(body.items.map(normalizeCatalogRow))
  } catch {
    return null
  }
}

/** The passage the Sources panel shows for a document: its best-scoring kp.
 * A cite-mode doc carries exactly one, but the panel sorts rather than assumes
 * that, and so does this. */
function bestSnippet(doc: any): string {
  const best = [...(doc.kps || [])].sort(
    (a: any, b: any) => b.kp_relevance - a.kp_relevance,
  )[0]
  return best?.snippet ?? ''
}

const nonAscii = (s: string) => /[^\p{ASCII}]/u.test(s)

export function buildPayloads(
  c: FrozenCase,
  index: CatalogIndex | null,
): Record<RouteName, unknown> {
  const rows = c.docs.map((d) =>
    index ? matchCatalogRow(d, index) : undefined,
  )
  const snippets = c.docs.map(bestSnippet)

  return {
    // SupportingCitations.tsx:155 — same fields, same `mode`. The shipped
    // component posts `query: 'answer'`, a placeholder, because it does not
    // hold the real query; the sweep deliberately sends the real question
    // (design doc, Known limits), so a clean sweep here is necessary but not
    // sufficient for what users get.
    'batch-why': {
      query: c.question,
      mode: 'answer',
      passages: c.docs.map((d, i) => ({
        docTitle: titleFrom(d, rows[i]) || 'Document',
        snippet: snippets[i],
      })),
    },
    // results/page.tsx:355-380.
    'batch-relates': {
      query: c.question,
      docs: c.docs.map((d, i) => ({
        title: titleFrom(d, rows[i]),
        authors: authorsFrom(d, rows[i]),
        year: yearFrom(d, rows[i]),
        snippet: snippets[i],
      })),
    },
    // results/page.tsx:419.
    alignment: {
      query: c.question,
      resultsSummary: buildAlignmentSummary(c.question, c.docs, index),
    },
    // CitationCard.tsx:109 translates one snippet. The shipped card only ever
    // offers a translation for a document whose catalog language is not `en`,
    // so the sweep takes the first non-ASCII snippet; when a case has none it
    // falls back to the first snippet, and the payload itself shows which one
    // it got.
    translate: {
      text: snippets.find(nonAscii) ?? snippets[0] ?? '',
    },
  }
}
