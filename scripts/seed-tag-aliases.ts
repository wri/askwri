import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
import { AppDataSource } from '../src/db/data-source'
import {
  seedTagAliases,
  type AliasSeedEntry,
} from '../src/db/queries/tagAliases'

/**
 * Seed tag_aliases from scripts/tag-aliases-seed.json (P2 alias lane,
 * design 2026-08-19 §4.3). App-owned table; idempotent (ON CONFLICT DO
 * NOTHING). Exits 1 if any entry matches no tag, so a taxonomy drift is
 * loud, not silent.
 *
 * The work itself lives in seedTagAliases() so it can be tested. It also sets
 * tags.needs_reembed — without that the worker never rebuilds the tag's
 * embedding and the alias never reaches the vector (issue #512).
 */
async function main() {
  const file = path.join(__dirname, 'tag-aliases-seed.json')
  const { entries } = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    entries: AliasSeedEntry[]
  }
  await AppDataSource.initialize()
  const { inserted, skipped, missing, flagged } = await seedTagAliases(entries)
  console.log(
    `tag_aliases seed: ${inserted} inserted, ${skipped} already present, ` +
      `${flagged} tag(s) flagged for re-embed, ` +
      `${missing.length} unmatched tag(s)${missing.length ? ': ' + missing.join(', ') : ''}`,
  )
  await AppDataSource.destroy()
  if (missing.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
