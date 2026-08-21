#!/usr/bin/env node
// Minimal eval runner — calls the gateway, computes attainable recall per query.
// Avoids the harness's fetch hang by using child_process curl per query.

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const TARGET = process.env.EVAL_TARGET || 'http://127.0.0.1:3000'
const evalsetPath = process.argv[2]

if (!evalsetPath) {
  console.error('Usage: npx tsx eval-minimal.ts <evalset.json>')
  process.exit(1)
}

// AP regression gate — compare a flag-on candidate report against a
// flag-off baseline. Asserts per-query `candidate AP ≥ baseline AP − AP_TOL`
// (catches ranking regressions like d3 AP 100→25 with aR flat, which the
// recall-only gate misses) AND macro `candidate aR ≥ baseline aR − AR_TOL`
// (the existing recall gate). Tolerance via env AP_TOL (default 0.05),
// AR_TOL (default 0 = strict, matching today's rule). Exits 1 on regression.
// Usage: `tsx eval-minimal.ts --compare <baseline.json> <candidate.json>`.
if (process.argv[2] === '--compare') {
  const baseline = process.argv[3]
  const candidate = process.argv[4]
  if (!baseline || !candidate) {
    console.error(
      'Usage: npx tsx eval-minimal.ts --compare <baseline.json> <candidate.json>',
    )
    process.exit(1)
  }
  runCompare(baseline, candidate)
}

function curlJson(url: string, opts?: { method?: string; body?: string }) {
  const method = opts?.method || 'GET'
  const body = opts?.body ? `-d '${opts.body.replace(/'/g, "'\\''")}'` : ''
  const cmd = `curl -s --max-time 30 ${method === 'POST' ? '-X POST' : ''} -H 'Content-Type: application/json' ${body} '${url}'`
  const out = execSync(cmd, { encoding: 'utf-8', timeout: 35000 })
  return JSON.parse(out)
}

function runCompare(baselinePath: string, candidatePath: string) {
  const AP_TOL = parseFloat(process.env.AP_TOL ?? '0.05')
  const AR_TOL = parseFloat(process.env.AR_TOL ?? '0')
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
  const cand = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'))
  const bById = new Map<string, any>(
    (base.results ?? []).map((r: any) => [r.id, r]),
  )
  const cById = new Map<string, any>(
    (cand.results ?? []).map((r: any) => [r.id, r]),
  )
  const pct = (v: any) =>
    v === null || v === undefined
      ? '  —'
      : `${(v * 100).toFixed(0).padStart(3)}%`
  const pp = (d: number) => `${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}pp`

  console.log('AP/aR regression gate — candidate vs baseline')
  console.log(`  baseline:  ${baselinePath}`)
  console.log(`  candidate: ${candidatePath}`)
  if (base.evalset && cand.evalset && base.evalset !== cand.evalset)
    console.log(`  ⚠ evalset mismatch: ${base.evalset} vs ${cand.evalset}`)
  console.log(`  AP_TOL=${AP_TOL}  AR_TOL=${AR_TOL}\n`)

  const apRegressions: { id: string; delta: number; b: number; c: number }[] =
    []
  console.log('Per-query (candidate vs baseline):')
  for (const [id, cr] of cById) {
    const br = bById.get(id)
    if (!br) continue
    if (cr.polarity === 'positive' && br.polarity === 'positive') {
      const dAp = (cr.ap ?? 0) - (br.ap ?? 0)
      const dAr = (cr.aRecall ?? 0) - (br.aRecall ?? 0)
      const apBad = dAp < -AP_TOL
      const arBad = dAr < -AR_TOL
      const flag = apBad ? ' ❌ AP regression' : arBad ? ' ⚠ aR drop' : ' OK'
      console.log(
        `  ${id.padEnd(40)} AP ${pct(cr.ap)} vs ${pct(br.ap)} ${pp(dAp)}  aR ${pct(cr.aRecall)} vs ${pct(br.aRecall)} ${pp(dAr)}${flag}`,
      )
      if (apBad)
        apRegressions.push({ id, delta: dAp, b: br.ap ?? 0, c: cr.ap ?? 0 })
    } else if (cr.polarity === 'negative' && br.polarity === 'negative') {
      const cn = cr.retrieved?.length ?? 0
      const bn = br.retrieved?.length ?? 0
      const note = cr.abstained
        ? 'abstained'
        : `returned ${cn} docs` + (bn !== cn ? ` (baseline ${bn})` : '')
      console.log(`  ${id.padEnd(40)} ${note}`)
    }
  }

  const mapDelta = (cand.overall_map ?? 0) - (base.overall_map ?? 0)
  const arDelta =
    (cand.overall_attainable_recall ?? 0) -
    (base.overall_attainable_recall ?? 0)
  const recallGateOk = arDelta >= -AR_TOL

  console.log(`\n${'='.repeat(72)}`)
  console.log(
    `MAP ${(cand.overall_map * 100).toFixed(1)}% vs ${(base.overall_map * 100).toFixed(1)}%  ${pp(mapDelta)}`,
  )
  console.log(
    `aR  ${(cand.overall_attainable_recall * 100).toFixed(1)}% vs ${(base.overall_attainable_recall * 100).toFixed(1)}%  ${pp(arDelta)}  ${recallGateOk ? 'PASS' : 'FAIL'}`,
  )

  if (apRegressions.length) {
    console.log(`\nAP regressions beyond tol (${(AP_TOL * 100).toFixed(0)}pp):`)
    for (const r of apRegressions)
      console.log(
        `  - ${r.id}: ${(r.delta * 100).toFixed(1)}pp (${(r.b * 100).toFixed(0)}% → ${(r.c * 100).toFixed(0)}%)`,
      )
  }

  const pass = recallGateOk && apRegressions.length === 0
  console.log(`\nGATE ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
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
const mode = 'cite'

console.log(
  `\n${path.basename(evalsetPath)} — ${cases.length} cases [mode: ${mode}]\n`,
)

const results: any[] = []

for (const tc of cases) {
  const expected = tc.expected_external_ids ?? []
  const polarity = expected.length === 0 ? 'negative' : 'positive'
  const missing = expected.filter((id: string) => !corpusIds.has(id))
  const attainable = expected.filter((id: string) => !missing.includes(id))

  try {
    const resp = curlJson(`${TARGET}/api/llamaindex`, {
      method: 'POST',
      body: JSON.stringify({ query: tc.question, mode }),
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
