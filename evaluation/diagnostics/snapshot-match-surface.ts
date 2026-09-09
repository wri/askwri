/**
 * Snapshot the corpus match surface that the abstain gate consults.
 *
 * The service checks documents.title/title_en/authors + tags/tag_aliases
 * (search-service/app/main.py, core_topic_in_corpus). The catalog API
 * exposes file_name / meta.metadata / meta.summary per item — a documented
 * APPROXIMATION: a superset of the title surface, blind to tags/aliases
 * (q7 clears via tags and is invisible to this snapshot). The service-side
 * debug.abstention fields are the exact source once queried directly.
 *
 * Snapshots are timestamped so every blast-radius table can name the corpus
 * state it was computed against (same provenance principle as the harness's
 * submodule pinning).
 *
 * Usage:
 *   npx tsx evaluation/diagnostics/snapshot-match-surface.ts
 *   EVAL_TARGET=https://... npx tsx evaluation/diagnostics/snapshot-match-surface.ts
 */
import * as fs from 'fs'
import * as path from 'path'

const TARGET = process.env.EVAL_TARGET || 'https://qa.askwri-app.org'
const OUT_DIR = path.join(__dirname, 'snapshots')

async function main() {
  const res = await fetch(`${TARGET}/api/catalog`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`GET ${TARGET}/api/catalog → ${res.status}`)
  const data = await res.json()

  const items = (data.items ?? []).map((it: any) => {
    const meta = it.meta ?? {}
    const text = [
      it.file_name ?? '',
      String(meta.metadata ?? ''),
      meta.summary ?? '',
    ]
      .filter((p) => p && p !== 'null')
      .join(' | ')
      .toLowerCase()
    return { file_name: it.file_name ?? '', text }
  })

  const snapshot = {
    target: TARGET,
    fetched_at: new Date().toISOString(),
    item_count: items.length,
    approximation:
      'Catalog surface (file_name + meta.metadata + meta.summary), not the exact service surface (title/title_en/authors/tags/aliases). Superset of titles; blind to tags/aliases.',
    items,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, `match-surface-${Date.now()}.json`)
  fs.writeFileSync(out, JSON.stringify(snapshot))
  console.log(`Snapshot: ${path.relative(process.cwd(), out)}`)
  console.log(`  ${items.length} items from ${TARGET} @ ${snapshot.fetched_at}`)
}

main().catch((error) => {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
})
