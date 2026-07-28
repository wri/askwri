/**
 * Cite mode logit threshold calibration.
 *
 * Sweeps floor thresholds against the cite golden set to find
 * the best tradeoff between recall (priority) and precision.
 * Also recommends tier boundaries (strong/partial/weak).
 *
 * Prerequisites: search service running on :8000
 * Usage: npx tsx --env-file-if-exists=.env evaluation/calibrate-cite-thresholds.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { checkPythonService, PYTHON_SERVICE_URL } from './lib/service-client'

// --- Types ---

interface GoldenTestCase {
  id: string
  question: string
  task_description?: string
  expected_urls: string[]
}

interface ScoredDoc {
  query_id: string
  doc_url: string
  raw_score: number
  is_expected: boolean
}

interface SweepPoint {
  threshold: number
  recall: number
  precision: number
  f1: number
  docs_retained: number
  docs_dropped: number
  true_positives: number
  false_negatives: number
}

interface CalibrationReport {
  timestamp: string
  mode: 'cite'
  golden_queries: number
  golden_expected_docs: number
  total_retrieved_docs: number
  recommended: {
    floor: number
    floor_recall: number
    floor_precision: number
    strong_threshold: number
    partial_threshold: number
  }
  f1_optimal: {
    floor: number
    recall: number
    precision: number
    f1: number
  }
  sweep_data: SweepPoint[]
  score_distribution: {
    relevant: {
      min: number
      max: number
      median: number
      p25: number
      p75: number
    }
    not_relevant: {
      min: number
      max: number
      median: number
      p25: number
      p75: number
    }
  }
  raw_docs: ScoredDoc[]
}

// --- Helpers ---

function extractUrlSlug(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname.replace(/\/$/, '').toLowerCase()
  } catch {
    return url.toLowerCase().replace(/\/$/, '')
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// --- Main ---

async function main() {
  // Check service
  const healthy = await checkPythonService()
  if (!healthy) {
    console.error('ERROR: Search service not available at', PYTHON_SERVICE_URL)
    process.exit(1)
  }

  // Load golden dataset
  const goldenPath = path.join(__dirname, 'golden-dataset.json')
  const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'))
  const testCases: GoldenTestCase[] = goldenData.test_cases

  console.log(`\nCite Threshold Calibration`)
  console.log(`=========================`)
  console.log(`Golden set: ${testCases.length} queries\n`)

  // Collect all scored docs
  const allDocs: ScoredDoc[] = []

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}... `)

    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: tc.task_description
          ? `${tc.question}\n\nTask: ${tc.task_description}`
          : tc.question,
        mode: 'cite',
        max_results: 200,
        rerank: true,
        rerank_top_n: 250,
        include_metadata: true,
      }),
    })

    if (!response.ok) {
      console.error(`FAILED (${response.status})`)
      continue
    }

    const data = await response.json()
    const docs = data.docs || []

    // Dedupe by doc URL (keep best score per doc)
    const byUrl = new Map<string, number>()
    for (const doc of docs) {
      const url = doc.metadata?.url
      if (!url) continue
      const rawScore = doc.metadata?.raw_score ?? doc.score
      const slug = extractUrlSlug(url)
      const existing = byUrl.get(slug)
      if (existing === undefined || rawScore > existing) {
        byUrl.set(slug, rawScore)
      }
    }

    let matched = 0
    for (const [slug, rawScore] of byUrl) {
      const isExpected = tc.expected_urls.some(
        (eu) => extractUrlSlug(eu) === slug,
      )
      if (isExpected) matched++
      allDocs.push({
        query_id: tc.id,
        doc_url: slug,
        raw_score: rawScore,
        is_expected: isExpected,
      })
    }

    console.log(
      `${byUrl.size} docs, ${matched}/${tc.expected_urls.length} expected found`,
    )
  }

  // Score distributions
  const relevantScores = allDocs
    .filter((d) => d.is_expected)
    .map((d) => d.raw_score)
    .sort((a, b) => a - b)
  const notRelevantScores = allDocs
    .filter((d) => !d.is_expected)
    .map((d) => d.raw_score)
    .sort((a, b) => a - b)

  console.log(`\nScore distributions:`)
  console.log(
    `  Relevant (${relevantScores.length}): min=${relevantScores[0]?.toFixed(2)}, median=${percentile(relevantScores, 50).toFixed(2)}, max=${relevantScores[relevantScores.length - 1]?.toFixed(2)}`,
  )
  console.log(
    `  Not relevant (${notRelevantScores.length}): min=${notRelevantScores[0]?.toFixed(2)}, median=${percentile(notRelevantScores, 50).toFixed(2)}, max=${notRelevantScores[notRelevantScores.length - 1]?.toFixed(2)}`,
  )

  // Total expected docs (unique per query)
  const totalExpected = testCases.reduce(
    (sum, tc) => sum + tc.expected_urls.length,
    0,
  )

  // Sweep thresholds
  const allScores = allDocs.map((d) => d.raw_score).sort((a, b) => a - b)
  const minScore = allScores[0]
  const maxScore = allScores[allScores.length - 1]

  // Coarse sweep: 0.25 increments
  const coarseCandidates: number[] = []
  for (let t = Math.floor(minScore); t <= Math.ceil(maxScore); t += 0.25) {
    coarseCandidates.push(t)
  }

  function evaluateThreshold(threshold: number): SweepPoint {
    let tp = 0,
      fn = 0,
      retained = 0,
      dropped = 0

    for (const doc of allDocs) {
      if (doc.raw_score >= threshold) {
        retained++
        if (doc.is_expected) tp++
      } else {
        dropped++
        if (doc.is_expected) fn++
      }
    }

    const recall = totalExpected > 0 ? tp / totalExpected : 0
    const precision = retained > 0 ? tp / retained : 0
    const f1 =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0

    return {
      threshold,
      recall,
      precision,
      f1,
      docs_retained: retained,
      docs_dropped: dropped,
      true_positives: tp,
      false_negatives: fn,
    }
  }

  // Coarse sweep
  const coarseResults = coarseCandidates.map(evaluateThreshold)

  // Find region of interest: around where recall crosses 75%
  const recallTarget = 0.75
  let bestCoarse = coarseResults[0]
  for (const r of coarseResults) {
    if (r.recall >= recallTarget && r.threshold > bestCoarse.threshold) {
      bestCoarse = r
    }
  }

  // Fine sweep: 0.1 increments around the best coarse point
  const fineCandidates: number[] = []
  for (
    let t = bestCoarse.threshold - 2;
    t <= bestCoarse.threshold + 2;
    t += 0.1
  ) {
    fineCandidates.push(Math.round(t * 10) / 10)
  }

  const fineResults = fineCandidates.map(evaluateThreshold)
  const allSweep = [...coarseResults, ...fineResults]
    .sort((a, b) => a.threshold - b.threshold)
    // Dedupe by threshold
    .filter(
      (v, i, arr) =>
        i === 0 || Math.abs(v.threshold - arr[i - 1].threshold) > 0.01,
    )

  // Find recommended floor: most aggressive threshold with recall >= 75%
  const passingPoints = allSweep.filter((p) => p.recall >= recallTarget)
  const recommendedFloor =
    passingPoints.length > 0
      ? passingPoints.reduce((best, p) =>
          p.threshold > best.threshold ? p : best,
        )
      : allSweep[0]

  // Find F1-optimal
  const f1Optimal = allSweep.reduce((best, p) => (p.f1 > best.f1 ? p : best))

  // Tier thresholds: based on relevant score distribution
  // Strong = top ~30% of relevant scores
  // Partial = above floor but below strong
  const strongThreshold =
    relevantScores.length > 0 ? percentile(relevantScores, 70) : 3.0
  const partialThreshold =
    relevantScores.length > 0 ? percentile(relevantScores, 25) : 0.0

  // Print results
  console.log(`\n--- Sweep Results ---\n`)
  console.log(
    `${'Threshold'.padStart(10)} ${'Recall'.padStart(8)} ${'Precision'.padStart(10)} ${'F1'.padStart(8)} ${'Retained'.padStart(10)} ${'Dropped'.padStart(9)}`,
  )
  console.log('-'.repeat(60))
  for (const p of allSweep) {
    const marker =
      Math.abs(p.threshold - recommendedFloor.threshold) < 0.01
        ? ' ← FLOOR'
        : Math.abs(p.threshold - f1Optimal.threshold) < 0.01
          ? ' ← F1-OPT'
          : ''
    console.log(
      `${p.threshold.toFixed(1).padStart(10)} ${(p.recall * 100).toFixed(1).padStart(7)}% ${(p.precision * 100).toFixed(1).padStart(9)}% ${(p.f1 * 100).toFixed(1).padStart(7)}% ${String(p.docs_retained).padStart(10)} ${String(p.docs_dropped).padStart(9)}${marker}`,
    )
  }

  console.log(`\n--- Recommendations ---\n`)
  console.log(
    `  Floor (recall >= 75%): ${recommendedFloor.threshold.toFixed(2)} → recall=${(recommendedFloor.recall * 100).toFixed(1)}%, precision=${(recommendedFloor.precision * 100).toFixed(1)}%`,
  )
  console.log(
    `  F1-optimal:           ${f1Optimal.threshold.toFixed(2)} → recall=${(f1Optimal.recall * 100).toFixed(1)}%, precision=${(f1Optimal.precision * 100).toFixed(1)}%, F1=${(f1Optimal.f1 * 100).toFixed(1)}%`,
  )
  console.log(
    `  Strong threshold:     ${strongThreshold.toFixed(2)} (p70 of relevant scores)`,
  )
  console.log(
    `  Partial threshold:    ${partialThreshold.toFixed(2)} (p25 of relevant scores)`,
  )

  // Save report
  const report: CalibrationReport = {
    timestamp: new Date().toISOString(),
    mode: 'cite',
    golden_queries: testCases.length,
    golden_expected_docs: totalExpected,
    total_retrieved_docs: allDocs.length,
    recommended: {
      floor: Math.round(recommendedFloor.threshold * 100) / 100,
      floor_recall: Math.round(recommendedFloor.recall * 1000) / 1000,
      floor_precision: Math.round(recommendedFloor.precision * 1000) / 1000,
      strong_threshold: Math.round(strongThreshold * 100) / 100,
      partial_threshold: Math.round(partialThreshold * 100) / 100,
    },
    f1_optimal: {
      floor: Math.round(f1Optimal.threshold * 100) / 100,
      recall: Math.round(f1Optimal.recall * 1000) / 1000,
      precision: Math.round(f1Optimal.precision * 1000) / 1000,
      f1: Math.round(f1Optimal.f1 * 1000) / 1000,
    },
    sweep_data: allSweep,
    score_distribution: {
      relevant: {
        min: relevantScores[0] ?? 0,
        max: relevantScores[relevantScores.length - 1] ?? 0,
        median: percentile(relevantScores, 50),
        p25: percentile(relevantScores, 25),
        p75: percentile(relevantScores, 75),
      },
      not_relevant: {
        min: notRelevantScores[0] ?? 0,
        max: notRelevantScores[notRelevantScores.length - 1] ?? 0,
        median: percentile(notRelevantScores, 50),
        p25: percentile(notRelevantScores, 25),
        p75: percentile(notRelevantScores, 75),
      },
    },
    raw_docs: allDocs,
  }

  const resultsDir = path.join(__dirname, 'results')
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = path.join(
    resultsDir,
    `cite-threshold-calibration-${timestamp}.json`,
  )
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\nReport saved: ${outPath}`)
}

main().catch((err) => {
  console.error('Calibration failed:', err)
  process.exit(1)
})
