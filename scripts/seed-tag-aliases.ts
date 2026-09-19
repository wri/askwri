import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
import { AppDataSource } from '../src/db/data-source'

/**
 * Seed tag_aliases from scripts/tag-aliases-seed.json (P2 alias lane,
 * design 2026-08-19 §4.3). App-owned table; idempotent (ON CONFLICT DO
 * NOTHING). Exits 1 if any entry matches no tag, so a taxonomy drift is
 * loud, not silent.
 */
async function main() {
  const file = path.join(__dirname, 'tag-aliases-seed.json')
  const { entries } = JSON.parse(fs.readFileSync(file, 'utf8'))
  await AppDataSource.initialize()
  let inserted = 0
  let skipped = 0
  const missing: string[] = []
  for (const e of entries) {
    const rows = await AppDataSource.query(
      `SELECT id FROM tags WHERE facet = $1 AND lower(value_id) = lower($2)`,
      [e.facet, e.value_id],
    )
    if (rows.length === 0) {
      missing.push(`${e.facet}:${e.value_id}`)
      continue
    }
    for (const alias of e.aliases) {
      const res = await AppDataSource.query(
        `INSERT INTO tag_aliases (tag_id, alias) VALUES ($1, $2)
         ON CONFLICT (tag_id, alias) DO NOTHING RETURNING tag_id`,
        [rows[0].id, alias],
      )
      if (res.length > 0) inserted += 1
      else skipped += 1
    }
  }
  console.log(
    `tag_aliases seed: ${inserted} inserted, ${skipped} already present, ` +
      `${missing.length} unmatched tag(s)${missing.length ? ': ' + missing.join(', ') : ''}`,
  )
  await AppDataSource.destroy()
  if (missing.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
