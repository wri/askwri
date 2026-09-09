/**
 * The abstention tuning instrument: the blast-radius table.
 *
 * For every eval case, runs the candidate policy (evaluation/lib/
 * abstention-candidates.ts, a mirror of the service's core_topic_in_corpus)
 * against a surface snapshot and reports the FULL effect of a policy change:
 * which negatives still abstain, which positives clear, which positives are
 * at risk of false abstention, and what flips between policies.
 *
 * Any PR that changes the abstain surface or the candidate policy MUST carry
 * this table. The table exists so fixes are chosen on the full case set, not
 * on the case that motivated them (2026-09-09: the stop-word filter fixed d9
 * and silently flipped q5/q6 — this table is what caught it).
 *
 * Usage:
 *   npx tsx evaluation/diagnostics/abstention-blast-radius.ts \
 *     [--snapshot <path>] [--policy current] [--policy stopword-filtered] ...
 *
 * Defaults: newest snapshot in evaluation/diagnostics/snapshots/, policy
 * 'current'. Run snapshot-match-surface.ts and refresh-core-topics.ts first.
 */
import * as fs from 'fs'
import * as path from 'path'

import { CandidatePolicy, candidatesFor } from '../lib/abstention-candidates'

const SNAP_DIR = path.join(__dirname, 'snapshots')
const EXTRACTIONS = path.join(__dirname, '..', 'extractions', 'core-topics.json')

interface SnapshotItem {
  file_name: string
  text: string
}

function argValues(flag: string): (string | undefined)[] {
  const out: string[] = []
  const args = process.argv.slice(2)
  for (let i = args.indexOf(flag); i !== -1; i = args.indexOf(flag, i + 1)) {
    if (args[i + 1]) out.push(args[i + 1])
  }
  return out
}

function newestSnapshot(explicit?: string): string {
  if (explicit) return explicit
  const files = fs
    .readdirSync(SNAP_DIR)
    .filter((f) => f.startsWith('match-surface-'))
    .sort()
  if (!files.length) throw new Error(`no snapshots in ${SNAP_DIR} — run snapshot-match-surface.ts`)
  return path.join(SNAP_DIR, files[files.length - 1])
}

function main() {
  const snapshotPath = newestSnapshot(argValues('--snapshot')[0])
  const policies = (argValues('--policy').length ? argValues('--policy') : ['current']) as CandidatePolicy[]

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
  const items: SnapshotItem[] = snapshot.items
  const extractions = JSON.parse(fs.readFileSync(EXTRACTIONS, 'utf-8'))
  const cases = extractions.cases

  const hit = (term: string) => items.some((it) => it.text.includes(term))
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))

  console.log(`Blast radius — ${Object.keys(cases).length} cases x ${policies.length} polic${policies.length > 1 ? 'ies' : 'y'}`)
  console.log(`  surface: ${path.basename(snapshotPath)} (${items.length} items, ${snapshot.fetched_at})`)
  console.log(`  extractions: ${extractions.updated} (modal of ${extractions.samples_per_case} samples, model ${extractions.model})`)
  console.log(`  NOTE: snapshot is the catalog approximation — blind to tags/aliases (see snapshot-match-surface.ts)`)
  console.log()

  const summary = new Map<string, { negAbstain: number; negTotal: number; posClear: number; posTotal: number; atRisk: string[] }>()
  for (const p of policies) summary.set(p, { negAbstain: 0, negTotal: 0, posClear: 0, posTotal: 0, atRisk: [] })

  console.log(
    pad('case', 38) + pad('pol', 4) + pad('flaky', 6) + policies.map((p) => pad(p, 20)).join(''),
  )
  for (const [id, c] of Object.entries(cases)) {
    const flaky = new Set(c.samples.filter(Boolean)).size > 1 ? 'FLAKY' : ''
    const core = c.modal ?? ''
    const cells = policies.map((p) => {
      const cands = candidatesFor(core, p)
      const hits = cands.filter(hit)
      const s = summary.get(p)!
      if (c.polarity === 'negative') {
        s.negTotal++
        if (!hits.length) s.negAbstain++
        return hits.length ? `HIT ${hits[0]}` : 'abstains'
      }
      s.posTotal++
      if (hits.length) {
        s.posClear++
        return `clear (${hits[0]})`
      }
      s.atRisk.push(id)
      return 'AT RISK'
    })
    console.log(pad(id, 38) + pad(c.polarity === 'negative' ? 'neg' : 'pos', 4) + pad(flaky, 6) + cells.map((x) => pad(x, 20)).join(''))
  }

  console.log()
  for (const p of policies) {
    const s = summary.get(p)!
    console.log(
      `[${p}] negatives abstaining ${s.negAbstain}/${s.negTotal} | positives cleared ${s.posClear}/${s.posTotal} | at-risk positives: ${s.atRisk.length}${s.atRisk.length ? ' -> ' + s.atRisk.join(', ') : ''}`,
    )
  }
  console.log()
  console.log('Read as: an at-risk positive = false abstention under this policy (the banner shown on a query the corpus answers).')
  console.log('A negative that HITs = abstention guardrail missed (docs served with no banner).')
}

try {
  main()
} catch (error: any) {
  console.error(`FATAL: ${error.message}`)
  process.exit(1)
}
