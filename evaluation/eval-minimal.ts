#!/usr/bin/env node
// Minimal eval runner — calls the gateway, computes attainable recall per query.
// Avoids the harness's fetch hang by using child_process curl per query.

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const TARGET = process.env.EVAL_TARGET || 'http://127.0.0.1:3000'
const evalsetPath = process.argv[2]
const mode = process.env.EVAL_MODE || 'cite' // cite (recall-first) | answer (precision-first)
// 5a sweep knob: override the per-mode expansion-lane weight for data-driven
// tuning. Undefined -> per-mode config default (cite 1.0 / answer 0.25).
const expansionLaneWeight = process.env.EVAL_EXPANSION_LANE_WEIGHT
  ? Number(process.env.EVAL_EXPANSION_LANE_WEIGHT)
  : undefined

if (!evalsetPath) {
  console.error('Usage: npx tsx eval-minimal.ts <evalset.json>')
  process.exit(1)
}

function curlJson(url: string, opts?: { method?: string; body?: string }) {
  const method = opts?.method || 'GET'
  const body = opts?.body ? `-d '${opts.body.replace(/'/g, "'\\''")}'` : ''
  const cmd = `curl -s --max-time 30 ${method === 'POST' ? '-X POST' : ''} -H 'Content-Type: application/json' ${body} '${url}'`
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 35000 })
  return JSON.parse(out)
}

// Fetch corpus ids
const catalog = curlJson(`${TARGET}/api/catalog`)
const corpusIds = new Set<string>()
for (const item of catalog.items ?? []) {
  const fp = item.meta?.file_path
  if (fp) corpusIds.add(path.basename(fp).replace(/\.pdf$/, ''))
}
console.log(`Corpus: ${corpusIds.size} documents`)

const evalset = JSON.parse(fs.readFileSync(evalsetPath, 'utf-8'))
const cases = evalset.test_cases ?? []

console.log(
  `\n${path.basename(evalsetPath)} — ${cases.length} cases [mode: ${mode}]\n`,
)

const results: any[] = []

for (const tc of cases) {
  const expected =
    tc.expected_external_ids ??
    tc.retrieval_ground_truth?.expected_external_ids ??
    []
  const polarity = expected.length === 0 ? 'negative' : 'positive'
  const missing = expected.filter((id: string) => !corpusIds.has(id))
  const attainable = expected.filter((id: string) => !missing.includes(id))

  try {
    const resp = curlJson(`${TARGET}/api/llamaindex`, {
      method: 'POST',
      body: JSON.stringify({
        query: tc.question,
        mode,
        ...(expansionLaneWeight !== undefined && {
          expansion_lane_weight: expansionLaneWeight,
        }),
      }),
    })

    if (!resp.ok) throw new Error(resp.error || 'gateway ok:false')
    const docs = resp.docs ?? []
    const seen = new Set<string>()
    const retrieved: string[] = []
    for (const d of docs) {
      if (seen.has(d.doc_id)) continue
      seen.add(d.doc_id)
      retrieved.push(d.doc_id)
    }

    if (polarity === 'negative') {
      const abstained = retrieved.length === 0
      console.log(
        `  ${tc.id.padEnd(40)} ${abstained ? 'abstained' : `returned ${retrieved.length} docs`}`,
      )
      results.push({ id: tc.id, polarity: 'negative', abstained, retrieved })
      continue
    }

    const retrievedSet = new Set(retrieved)
    const hits = attainable.filter((id: string) => retrievedSet.has(id)).length
    const aRecall = attainable.length > 0 ? hits / attainable.length : null

    // Average precision
    const expectedSet = new Set(attainable)
    const found = new Set<string>()
    let sum = 0
    for (let i = 0; i < retrieved.length; i++) {
      if (!expectedSet.has(retrieved[i]) || found.has(retrieved[i])) continue
      found.add(retrieved[i])
      sum += found.size / (i + 1)
    }
    const ap = attainable.length > 0 ? sum / attainable.length : null

    const pct = (v: number | null) =>
      v === null ? '  —' : `${(v * 100).toFixed(0).padStart(3)}%`
    const capped =
      missing.length > 0
        ? ` (ceiling ${((attainable.length / expected.length) * 100).toFixed(0)}%)`
        : ''
    // Applied hard facets — surfaced so a facet misfire (e.g. "in Chinese cities"
    // -> language=zh silently filtering golden docs) is visible in gate output,
    // not just a recall drop with no clue why. Gateway passes query_understanding
    // through (route.ts:222); the harness previously ignored it.
    const appliedFacets = (resp.query_understanding?.facets ?? [])
      .filter((f: any) => f.action === 'hard')
      .map((f: any) => `${f.facet}=${f.value}`)
    const facetStr = appliedFacets.length
      ? `  [facets: ${appliedFacets.join(',')}]`
      : ''
    console.log(
      `  ${tc.id.padEnd(40)} AP ${pct(ap)}  aR ${pct(aRecall)}${capped}${facetStr}`,
    )

    results.push({
      id: tc.id,
      polarity: 'positive',
      ap,
      aRecall,
      attainable: attainable.length,
      hits,
      expected: expected.length,
      missing: missing.length,
    })
  } catch (e: any) {
    console.log(`  ${tc.id.padEnd(40)} ERROR: ${e.message}`)
    results.push({
      id: tc.id,
      polarity,
      error: e.message,
      ap: polarity === 'positive' ? 0 : null,
      aRecall: polarity === 'positive' ? 0 : null,
    })
  }
}

// Summary
const positives = results.filter((r) => r.polarity === 'positive')
const negatives = results.filter((r) => r.polarity === 'negative')
const map =
  positives.reduce((s, r) => s + (r.ap ?? 0), 0) / (positives.length || 1)
const recall =
  positives.reduce((s, r) => s + (r.aRecall ?? 0), 0) / (positives.length || 1)
const totalExpected = positives.reduce((s, r) => s + (r.attainable ?? 0), 0)
const totalRetrieved = positives.reduce((s, r) => s + (r.hits ?? 0), 0)

console.log(`\n${'='.repeat(72)}`)
console.log(
  `${positives.length} positive   MAP ${(map * 100).toFixed(1)}%   Attainable recall ${(recall * 100).toFixed(1)}% (${totalRetrieved}/${totalExpected} attainable docs retrieved)`,
)
if (negatives.length) {
  const abstained = negatives.filter((r) => r.abstained).length
  console.log(
    `${negatives.length} negative   ${abstained}/${negatives.length} correctly returned nothing`,
  )
  for (const r of negatives.filter((r) => !r.abstained)) {
    console.log(`  - ${r.id}: ${r.retrieved?.length ?? 0} docs`)
  }
}

// Save report
const reportPath = path.join(
  __dirname,
  'results',
  `minimal-${path.basename(evalsetPath, '.json')}-${Date.now()}.json`,
)
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(
  reportPath,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      target: TARGET,
      evalset: path.basename(evalsetPath),
      results,
      overall_map: map,
      overall_attainable_recall: recall,
    },
    null,
    2,
  ),
)
console.log(`Report: ${reportPath}`)
