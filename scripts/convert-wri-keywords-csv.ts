/**
 * Convert a raw WRI keyword CSV into the managed topic-taxonomy CSV format.
 *
 * Spec §10.2 (issue #323): "the raw WRI CSV loads once into the managed format
 * (seed step)". The managed importer (`POST /api/admin/topics/import`) expects a
 * header `label,description,aliases,parent,facet,id` (spec §7.2). The WRI file
 * is headerless — one keyword per line, optionally quoted when it contains
 * commas (e.g. `"Water, Sanitation, and Hygiene",,,`), with trailing empty
 * fields. Feeding the raw WRI file directly to the importer made it read line 1
 * as the header, find no `label` column, and return a wall of N "empty label"
 * conflicts. This converter is the documented seed step.
 *
 * Pure core (`convertWriKeywordsCsv`) + thin CLI:
 *   npm run convert:wri-keywords < DETagKeywords.csv > topics.managed.csv
 *   npm run convert:wri-keywords -- DETagKeywords.csv > topics.managed.csv
 *
 * No new dependencies: CSV parsing mirrors `parseTopicsCsv`'s quote-aware state
 * machine (handles embedded commas, doubled quotes, embedded newlines), and
 * emission follows RFC 4180 (quote fields containing comma/quote/newline).
 */
import * as fs from 'fs'

/** Output header for the managed topic-taxonomy CSV (spec §7.2). */
export const MANAGED_HEADER = 'label,description,aliases,parent,facet,id'

/**
 * Parse a headerless WRI keyword CSV into a list of non-empty keyword strings.
 * Mirrors the quote-aware state machine in `parseTopicsCsv` so quoted keywords
 * containing commas (and even embedded newlines) are preserved. Returns only
 * the first field of each row; trailing empty fields are ignored. Blank rows
 * and rows whose first field trims to empty are skipped.
 */
function parseWriKeywords(text: string): string[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else {
        field += ch
      }
    } else {
      if (ch === '"') inQ = true
      else if (ch === ',') {
        pushField()
        // Stop consuming the rest of this row's fields — only the keyword
        // (first field) matters, and the trailing empties carry no meaning.
        // Scan to end of line.
        while (i + 1 < text.length && text[i + 1] !== '\n') i++
      } else if (ch === '\n') {
        pushField()
        pushRow()
      } else if (ch !== '\r') {
        field += ch
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    pushField()
    pushRow()
  }

  const keywords: string[] = []
  for (const r of rows) {
    const kw = (r[0] ?? '').trim()
    if (kw) keywords.push(kw)
  }
  return keywords
}

/** RFC 4180: quote a CSV field if it contains comma, quote, CR, or LF. */
function csvEscape(s: string): string {
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Convert raw WRI keyword CSV text into managed topic-taxonomy CSV text.
 * Each keyword becomes a row: `<label>,,,,topic,` (label, empty description,
 * empty aliases, empty parent, facet=topic, empty id). Throws if the input
 * has no non-blank keywords (nothing to seed). Pure: no I/O, no deps.
 */
export function convertWriKeywordsCsv(text: string): string {
  const keywords = parseWriKeywords(text)
  if (keywords.length === 0) {
    throw new Error(
      'WRI keyword CSV is empty (no non-blank keyword rows found) — nothing to seed',
    )
  }
  const body = keywords
    .map((kw) => [csvEscape(kw), '', '', '', 'topic', ''].join(','))
    .join('\n')
  return `${MANAGED_HEADER}\n${body}\n`
}

/**
 * CLI entrypoint. Reads from a file path argument if given, else stdin; writes
 * the managed CSV to stdout. Errors go to stderr with a non-zero exit.
 *
 *   npm run convert:wri-keywords -- DETagKeywords.csv > topics.managed.csv
 *   cat DETagKeywords.csv | npm run convert:wri-keywords > topics.managed.csv
 */
async function main(): Promise<void> {
  const arg = process.argv[2]
  let input: string
  if (arg && arg !== '-') {
    input = await fs.promises.readFile(arg, 'utf8')
  } else {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    input = Buffer.concat(chunks).toString('utf8')
  }
  process.stdout.write(convertWriKeywordsCsv(input))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(
      'convert-wri-keywords:',
      err instanceof Error ? err.message : String(err),
    )
    process.exit(1)
  })
}
