/**
 * `/query` does not return the retrieved chunk as `content` — it returns a
 * passage WINDOW built by the search service's `get_passage_with_context`:
 * up to ~150 characters of the text PRECEDING the chunk, then the chunk itself
 * wrapped in `**[ ... ]**`, then ~150 characters of trailing text.
 *
 * Rendering that window verbatim is what makes non-English excerpts unreadable:
 * the excerpt opens on whatever happened to precede the passage — routinely a
 * table tail, a page number, or the PDF's running header repeating the document
 * title that the citation card already shows — and the marker syntax plus the
 * parser's bold runs and `![img-N.jpeg]` placeholders leak into the UI as
 * literal characters. It also costs the synthesis model ~150 of its 400
 * `key_finding` characters before the real passage starts.
 *
 * So keep only the marked span. That span IS the cited chunk, and it is what
 * "Excerpt (Page N)" promises the reader.
 *
 * Note this cannot repair running headers that the parse stage baked INTO the
 * chunk text itself; those need the pending Mistral re-parse of the pypdf docs.
 */

const OPEN = '**['
const CLOSE = ']**'
// The search service appends this when it cannot locate the chunk in the full
// document text (e.g. OpenCC-normalized chunks vs. an un-normalized full text).
const MATCH_FAILED = '(context match failed)'

/** Drop parser artefacts that carry no meaning for a reader or a prompt. */
const tidy = (text: string): string =>
  text
    // Image placeholders: `![img-20.jpeg](img-20.jpeg)`
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // The same placeholder with its leading `!` lost, which happens whenever the
    // chunk boundary fell between the `!` and the `[` so the `!` stayed behind in
    // the discarded context. Requires an image extension so real markdown links
    // survive.
    .replace(/!?\[[^\]]*\.(?:jpe?g|png|gif|svg|webp)\]\([^)]*\)/gi, ' ')
    // A placeholder the chunk boundary cut in half, so the closing `)` never
    // arrives: `… ![img-105.jpeg](img-105.` at the very end of the passage.
    // Anchored to the end — mid-string this pattern would eat real text.
    .replace(/!?\[[^\]]*\.(?:jpe?g|png|gif|svg|webp)\][^)]*$/i, ' ')
    // Bold runs from the PDF conversion — `**激进情景**`, `**Buses**`
    .replace(/\*\*/g, ' ')
    .replace(/\s+/g, ' ')
    // A lone trailing `!` is the head of a placeholder whose `[` fell past the
    // boundary. Whitespace-separated only, so real prose ending in `!` is safe.
    .replace(/\s+!$/, '')
    .trim()

/**
 * The cited passage, without the surrounding context window or the markers.
 * Returns '' for empty input, and the tidied whole string when no markers are
 * present (so a future search-service change that stops windowing still works).
 */
export const extractPassage = (content?: string | null): string => {
  let text = String(content ?? '')
  if (!text.trim()) return ''

  const failed = text.lastIndexOf(MATCH_FAILED)
  if (failed !== -1) text = text.slice(0, failed)

  const start = text.indexOf(OPEN)
  if (start !== -1) {
    const end = text.lastIndexOf(CLOSE)
    text =
      end > start
        ? text.slice(start + OPEN.length, end)
        : text.slice(start + OPEN.length)
  }

  return tidy(text)
}
