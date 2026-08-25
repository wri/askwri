/**
 * Alpha × RerankTopN precision sweep for answer mode retrieval.
 * Measures precision@K using GPT-5.4 debiased labels.
 *
 * Usage: npx tsx evaluation/sweep-answer-retrieval.ts
 * Requires: search service running on LLAMAINDEX_SERVICE_URL (default http://localhost:8000)
 */

import fs from 'fs'
import path from 'path'

const SERVICE_URL =
  process.env.LLAMAINDEX_SERVICE_URL || 'http://localhost:8000'

// Load golden queries — file structure: { test_cases: [{ test_case_id, question, ... }] }
const rawData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-synthesis-raw.json'), 'utf-8'),
)
const goldenSet = rawData.test_cases

// Load GPT-5.4 debiased labels — file structure: { questions: [{ id, chunks: [{ chunk_id, label }] }] }
const labels: Record<string, Record<string, string>> = {}
const labelFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-labels-review.json'), 'utf-8'),
)
for (const q of labelFile.questions) {
  labels[q.id] = {}
  for (const chunk of q.chunks) {
    labels[q.id][chunk.chunk_id] = chunk.label
  }
}

// Sweep parameters
const ALPHA_VALUES = [0.5, 0.6, 0.65, 0.7]
const RERANK_TOP_N_VALUES = [20, 30, 40, 50]
const PRECISION_AT_K = [8, 10, 12, 15]

interface SweepResult {
  alpha: number
  rerankTopN: number
  precisionAtK: Record<number, number>
  perQuery: Array<{
    queryId: string
    question: string
    precisionAt8: number
    relevantInTop8: number
    totalRetrieved: number
  }>
}

async function runQuery(
  query: string,
  alpha: number,
  rerankTopN: number,
  maxResults: number,
): Promise<Array<{ chunk_id: string; score: number }>> {
  const resp = await fetch(`${SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'answer',
      vector_top_k: 150,
      bm25_top_k: 150,
      dense_weight: alpha,
      sparse_weight: 1.0 - alpha,
      rerank: true,
      rerank_top_n: rerankTopN,
      max_results: maxResults,
    }),
  })

  if (!resp.ok) throw new Error(`Search service error: ${resp.status}`)
  const data = await resp.json()
  return (data.docs || []).map((r: any) => ({
    chunk_id: r.chunk_id || `${r.doc_id}_chunk_${r.metadata?.chunk_index}`,
    score: r.score,
  }))
}

function computePrecisionAtK(
  results: Array<{ chunk_id: string }>,
  queryLabels: Record<string, string>,
  k: number,
): number {
  const topK = results.slice(0, k)
  if (topK.length === 0) return 0
  const relevant = topK.filter((r) => {
    const label = queryLabels[r.chunk_id]
    return label === 'relevant' || label === 'partially_relevant'
  })
  return relevant.length / topK.length
}

async function main() {
  console.log('=== Answer Mode Retrieval Precision Sweep ===\n')
  console.log(`Service: ${SERVICE_URL}`)
  console.log(`Golden queries: ${goldenSet.length}`)
  console.log(`Alpha values: ${ALPHA_VALUES.join(', ')}`)
  console.log(`RerankTopN values: ${RERANK_TOP_N_VALUES.join(', ')}\n`)

  const allResults: SweepResult[] = []

  for (const alpha of ALPHA_VALUES) {
    for (const rerankTopN of RERANK_TOP_N_VALUES) {
      console.log(`--- alpha=${alpha}, rerankTopN=${rerankTopN} ---`)

      const precisionSums: Record<number, number> = {}
      for (const k of PRECISION_AT_K) precisionSums[k] = 0

      const perQuery: SweepResult['perQuery'] = []

      for (const q of goldenSet) {
        const results = await runQuery(
          q.question,
          alpha,
          rerankTopN,
          Math.max(...PRECISION_AT_K),
        )
        const queryLabels = labels[q.test_case_id] || {}

        for (const k of PRECISION_AT_K) {
          precisionSums[k] += computePrecisionAtK(results, queryLabels, k)
        }

        perQuery.push({
          queryId: q.test_case_id,
          question: q.question,
          precisionAt8: computePrecisionAtK(results, queryLabels, 8),
          relevantInTop8: results.slice(0, 8).filter((r) => {
            const l = queryLabels[r.chunk_id]
            return l === 'relevant' || l === 'partially_relevant'
          }).length,
          totalRetrieved: results.length,
        })
      }

      const precisionAtK: Record<number, number> = {}
      for (const k of PRECISION_AT_K) {
        precisionAtK[k] = precisionSums[k] / goldenSet.length
      }

      console.log(
        `  P@8=${precisionAtK[8].toFixed(3)}  P@10=${precisionAtK[10].toFixed(3)}  P@12=${precisionAtK[12].toFixed(3)}  P@15=${precisionAtK[15].toFixed(3)}`,
      )

      allResults.push({ alpha, rerankTopN, precisionAtK, perQuery })
    }
  }

  // Find best config
  const best = allResults.reduce((a, b) =>
    a.precisionAtK[8] > b.precisionAtK[8] ? a : b,
  )
  console.log(`\n=== BEST CONFIG ===`)
  console.log(`alpha=${best.alpha}, rerankTopN=${best.rerankTopN}`)
  console.log(`P@8=${best.precisionAtK[8].toFixed(3)}`)
  console.log(`\nPer-query breakdown:`)
  for (const q of best.perQuery) {
    console.log(
      `  ${q.queryId}: P@8=${q.precisionAt8.toFixed(2)} (${q.relevantInTop8}/8)`,
    )
  }

  // Save results
  const outDir = path.join(__dirname, 'results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = path.join(outDir, `answer-retrieval-sweep-${timestamp}.json`)
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        sweep_params: {
          alphas: ALPHA_VALUES,
          rerankTopNs: RERANK_TOP_N_VALUES,
          precisionAtK: PRECISION_AT_K,
        },
        best: {
          alpha: best.alpha,
          rerankTopN: best.rerankTopN,
          precisionAtK: best.precisionAtK,
        },
        all_results: allResults,
      },
      null,
      2,
    ),
  )
  console.log(`\nResults saved to ${outPath}`)
}

main().catch(console.error)
