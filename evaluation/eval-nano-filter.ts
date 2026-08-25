/**
 * Evaluate nano filter accuracy against GPT-5.4 debiased labels.
 * Runs the nano classifier on the golden query set and compares
 * its strong/partial/weak assignments with the label ground truth.
 *
 * Usage: npx tsx evaluation/eval-nano-filter.ts
 * Requires: OPENAI_API_KEY env var, search service on port 8000, Next.js on port 3000
 */

import fs from 'fs'
import path from 'path'

const NEXTJS_URL = process.env.NEXTJS_URL || 'http://localhost:3000'
const SERVICE_URL =
  process.env.LLAMAINDEX_SERVICE_URL || 'http://localhost:8000'

// Load golden queries — file structure: { test_cases: [{ test_case_id, question, ... }] }
const rawData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-synthesis-raw.json'), 'utf-8'),
)
const goldenSet = rawData.test_cases

// Load GPT-5.4 debiased labels — file structure: { questions: [{ id, chunks: [{ chunk_id, doc_id, label }] }] }
const labelFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-labels-review.json'), 'utf-8'),
)
// Build chunk-level labels AND doc-level labels (max label per doc for a given query)
const chunkLabels: Record<string, Record<string, string>> = {}
const docLabels: Record<string, Record<string, string>> = {}
const tierRank: Record<string, number> = {
  relevant: 2,
  partially_relevant: 1,
  not_relevant: 0,
}
for (const q of labelFile.questions) {
  chunkLabels[q.id] = {}
  docLabels[q.id] = {}
  for (const chunk of q.chunks) {
    chunkLabels[q.id][chunk.chunk_id] = chunk.label
    // Doc-level: take the max (most relevant) label across all chunks in this doc
    const existing = docLabels[q.id][chunk.doc_id]
    if (!existing || (tierRank[chunk.label] || 0) > (tierRank[existing] || 0)) {
      docLabels[q.id][chunk.doc_id] = chunk.label
    }
  }
}

// Map label categories to our tier vocabulary
function labelToTier(label: string): 'strong' | 'partial' | 'weak' {
  if (label === 'relevant') return 'strong'
  if (label === 'partially_relevant') return 'partial'
  return 'weak'
}

async function getSearchResults(query: string): Promise<any[]> {
  const resp = await fetch(`${SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'answer',
      vector_top_k: 150,
      sparse_top_k: 150,
      alpha: 0.5,
      rerank: true,
      rerank_top_n: 50,
      max_results: 15,
    }),
  })
  if (!resp.ok) throw new Error(`Search service error: ${resp.status}`)
  const data = await resp.json()
  return data.docs || []
}

async function getSynthesisWithNanoFilter(
  query: string,
  docs: any[],
): Promise<any> {
  const resp = await fetch(`${NEXTJS_URL}/api/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, docs }),
  })
  if (!resp.ok) throw new Error(`Answer route error: ${resp.status}`)
  return resp.json()
}

async function main() {
  console.log('=== Nano Filter Accuracy Evaluation ===\n')

  const confusion = {
    ss: 0,
    sp: 0,
    sw: 0,
    ps: 0,
    pp: 0,
    pw: 0,
    ws: 0,
    wp: 0,
    ww: 0,
  }
  let totalCompared = 0
  let totalAgreed = 0
  let filterPrecisionSum = 0
  let filterRecallSum = 0

  for (const q of goldenSet) {
    console.log(`\n--- ${q.test_case_id}: ${q.question} ---`)

    const searchResults = await getSearchResults(q.question)
    const result = await getSynthesisWithNanoFilter(q.question, searchResults)

    const nanoTiers: Record<string, string> = {}
    if (result.synthesis?.source_relevance) {
      for (const sr of result.synthesis.source_relevance) {
        nanoTiers[sr.doc_id] = sr.tier
      }
    }

    const queryDocLabels = docLabels[q.test_case_id] || {}

    // Compare nano tiers with ground truth at DOC level
    // (nano filter assigns tiers per doc_id; ground truth aggregated to max label per doc)
    const seenDocs = new Set<string>()
    let relevant = 0,
      nanoStrong = 0,
      nanoStrongAndRelevant = 0

    for (const r of searchResults.slice(0, 15)) {
      const docId = r.doc_id
      if (seenDocs.has(docId)) continue
      seenDocs.add(docId)

      const groundTruth = labelToTier(queryDocLabels[docId] || 'not_relevant')
      const nanoTier = nanoTiers[docId] || 'weak'

      const key = `${groundTruth[0]}${nanoTier[0]}` as keyof typeof confusion
      if (key in confusion) confusion[key]++

      if (groundTruth === nanoTier) totalAgreed++
      totalCompared++

      if (groundTruth === 'strong' || groundTruth === 'partial') relevant++
      if (nanoTier === 'strong' || nanoTier === 'partial') nanoStrong++
      if (
        (nanoTier === 'strong' || nanoTier === 'partial') &&
        (groundTruth === 'strong' || groundTruth === 'partial')
      )
        nanoStrongAndRelevant++
    }

    const filterPrecision =
      nanoStrong > 0 ? nanoStrongAndRelevant / nanoStrong : 0
    const filterRecall = relevant > 0 ? nanoStrongAndRelevant / relevant : 0
    filterPrecisionSum += filterPrecision
    filterRecallSum += filterRecall

    console.log(`  Coverage: ${result.synthesis?.coverage || 'unknown'}`)
    console.log(
      `  Filter precision: ${filterPrecision.toFixed(2)} (${nanoStrongAndRelevant}/${nanoStrong})`,
    )
    console.log(
      `  Filter recall: ${filterRecall.toFixed(2)} (${nanoStrongAndRelevant}/${relevant})`,
    )
    console.log(
      `  Synthesis docs: ${result.synthesis?.sentences?.length || 0} sentences`,
    )
  }

  const n = goldenSet.length
  console.log('\n=== SUMMARY ===')
  console.log(
    `Agreement rate: ${((totalAgreed / totalCompared) * 100).toFixed(1)}% (${totalAgreed}/${totalCompared})`,
  )
  console.log(`Avg filter precision: ${(filterPrecisionSum / n).toFixed(3)}`)
  console.log(`Avg filter recall: ${(filterRecallSum / n).toFixed(3)}`)
  console.log(`\nConfusion matrix (rows=ground_truth, cols=nano):`)
  console.log(`         strong  partial  weak`)
  console.log(
    `strong   ${confusion.ss.toString().padStart(5)}  ${confusion.sp.toString().padStart(7)}  ${confusion.sw.toString().padStart(4)}`,
  )
  console.log(
    `partial  ${confusion.ps.toString().padStart(5)}  ${confusion.pp.toString().padStart(7)}  ${confusion.pw.toString().padStart(4)}`,
  )
  console.log(
    `weak     ${confusion.ws.toString().padStart(5)}  ${confusion.wp.toString().padStart(7)}  ${confusion.ww.toString().padStart(4)}`,
  )

  // Save results
  const outDir = path.join(__dirname, 'results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = path.join(outDir, `nano-filter-eval-${timestamp}.json`)
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        agreement_rate: totalAgreed / totalCompared,
        avg_filter_precision: filterPrecisionSum / n,
        avg_filter_recall: filterRecallSum / n,
        confusion,
        success_criteria: {
          precision_target: 0.85,
          precision_met: filterPrecisionSum / n >= 0.85,
        },
      },
      null,
      2,
    ),
  )
  console.log(`\nResults saved to ${outPath}`)
}

main().catch(console.error)
