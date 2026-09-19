// Schema check for the experts labeled set. Keys are author keys from
// src/lib/experts/authorKey.ts: "family, given" lowercase.
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface LabeledQuery {
  id: string
  query: string
  expected_top3: string[]
  notes: string
}
export interface LabeledSet {
  version: number
  status: 'skeleton' | 'labeled'
  queries: LabeledQuery[]
}

export interface ValidateOptions {
  /**
   * Require every query to carry exactly 3 well-formed author keys. Off by
   * default so the committed skeleton (empty expected_top3 arrays) stays a
   * legal, buildable state. Turn on to assert the set is genuinely labeled
   * (spec §10) — e.g. when the file's own `status` field claims "labeled".
   */
  strict?: boolean
}

const KEY_RE = /^[^,]+, [^,]+$|^[^,\s]+$/

export function validateQueries(
  raw: any,
  opts: ValidateOptions = {},
): string[] {
  const { strict = false } = opts
  const errors: string[] = []
  if (raw?.version !== 1) errors.push('version must be 1')
  if (raw?.status !== 'skeleton' && raw?.status !== 'labeled')
    errors.push('status must be "skeleton" or "labeled"')
  if (!Array.isArray(raw?.queries))
    return [...errors, 'queries must be an array']
  const ids = new Set<string>()
  for (const q of raw.queries) {
    if (!q.id || ids.has(q.id)) errors.push(`duplicate or missing id: ${q.id}`)
    ids.add(q.id)
    if (typeof q.query !== 'string' || !q.query.trim())
      errors.push(`${q.id}: query is required`)
    if (!Array.isArray(q.expected_top3)) {
      errors.push(`${q.id}: expected_top3 must be an array`)
      continue
    }
    if (strict && q.expected_top3.length !== 3)
      errors.push(
        `${q.id}: expected_top3 must have exactly 3 entries in strict mode (has ${q.expected_top3.length})`,
      )
    q.expected_top3.forEach((k: unknown, i: number) => {
      if (typeof k !== 'string' || !KEY_RE.test(k) || k !== k.toLowerCase())
        errors.push(
          `${q.id}: expected_top3[${i}] "${k}" is not an author key (family, given)`,
        )
    })
  }
  return errors
}

if (require.main === module) {
  const strict = process.argv.includes('--strict')
  const raw = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf8'),
  )
  const errs = validateQueries(raw, { strict })
  if (errs.length) {
    console.error(errs.join('\n'))
    process.exit(1)
  }
  console.log(
    `ok: ${raw.queries.length} queries (${strict ? 'strict' : 'skeleton'} mode)`,
  )
}
