/**
 * Re-label answer mode chunks with GPT-5.4, fixing three problems
 * from the original labeling:
 *   1. Scores removed from prompt (prevents reranker bias)
 *   2. All 100 chunks labeled (not just top 30)
 *   3. Chunks shuffled before labeling (prevents rank-position bias)
 *
 * Reads: evaluation/answer-retrieval-raw.json (existing retrieval data)
 * Writes: evaluation/answer-labels-review.json (overwrites old labels)
 *
 * Usage: npx tsx --env-file-if-exists=.env evaluation/relabel-answer-chunks.ts
 */

import * as fs from 'fs'
import * as path from 'path'

const EVAL_DIR = __dirname
const RAW_PATH = path.join(EVAL_DIR, 'answer-retrieval-raw.json')
const LABELS_PATH = path.join(EVAL_DIR, 'answer-labels-review.json')
const BACKUP_PATH = path.join(EVAL_DIR, 'answer-labels-review.backup.json')

const MODEL = process.env.RELABEL_MODEL || 'gpt-5.4'
const BATCH_SIZE = 20 // chunks per LLM call (100 chunks / 5 batches)

interface RetrievedChunk {
  chunk_id: string
  doc_id: string
  title: string
  content: string
  score: number
  page: number
}

interface RawQuestion {
  id: string
  question: string
  query_type: string
  difficulty: string
  retrieved_chunks: RetrievedChunk[]
}

interface LabelResult {
  chunk_index: number
  label: 'relevant' | 'partially_relevant' | 'not_relevant'
  confidence: 'high' | 'medium' | 'low'
  rationale: string
}

// Prompt deliberately omits scores and reranker info
const SYSTEM_PROMPT = `You are an expert research librarian evaluating whether text passages are relevant to a research question.

For each passage, evaluate ONLY based on its content — whether it provides useful information for answering the question. Ignore passage ordering; passages are presented in random order.

Labels:
- "relevant": Directly answers the question or provides key evidence, data, or findings
- "partially_relevant": Provides useful background or tangentially related information
- "not_relevant": Does not help answer the question

Be selective. A passage about the same broad topic is NOT automatically relevant — it must contribute specific information toward answering the question. Many passages will be not_relevant.

For each passage, respond with:
- chunk_index: the passage number shown
- label: one of the three labels above
- confidence: "high", "medium", or "low"
- rationale: 1 sentence explaining your decision

Respond with ONLY a JSON array:
[{"chunk_index": 1, "label": "relevant", "confidence": "high", "rationale": "..."}]`

function shuffle<T>(arr: T[]): { shuffled: T[]; originalIndices: number[] } {
  const indices = arr.map((_, i) => i)
  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return {
    shuffled: indices.map((i) => arr[i]),
    originalIndices: indices,
  }
}

async function labelBatch(
  apiKey: string,
  question: string,
  chunks: RetrievedChunk[],
  startIndex: number,
): Promise<LabelResult[]> {
  // No scores, no doc_ids, no metadata that could bias — just content and title
  const chunkDescriptions = chunks.map(
    (c, idx) =>
      `Passage ${startIndex + idx + 1}:\nTitle: ${c.title}\n${c.content}`,
  )

  const userPrompt = `Research question: "${question}"

${chunkDescriptions.join('\n\n---\n\n')}

Evaluate each of the ${chunks.length} passages above. Be selective — many may be not_relevant.`

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_completion_tokens: 8000,
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${errText}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || ''

  // Parse JSON from response
  try {
    // Try direct parse first
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Extract JSON array from text
    const match = content.match(/\[[\s\S]*\]/)
    if (match) {
      try {
        return JSON.parse(match[0])
      } catch {
        console.error('  Failed to parse extracted JSON')
        return []
      }
    }
    console.error('  No JSON array found in response')
    return []
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY required')
    process.exit(1)
  }

  // Load existing retrieval data
  const raw: { questions: RawQuestion[] } = JSON.parse(
    fs.readFileSync(RAW_PATH, 'utf-8'),
  )
  console.log(`\nRelabeling Answer Chunks with ${MODEL}`)
  console.log(`==========================================`)
  console.log(`Questions: ${raw.questions.length}`)
  console.log(`Chunks per question: 100`)
  console.log(`Batch size: ${BATCH_SIZE}`)
  console.log(
    `Fixes: no scores in prompt, all chunks labeled, shuffled order\n`,
  )

  // Backup old labels
  if (fs.existsSync(LABELS_PATH)) {
    fs.copyFileSync(LABELS_PATH, BACKUP_PATH)
    console.log(`Backed up old labels to ${path.basename(BACKUP_PATH)}\n`)
  }

  const output: any = {
    labeled_at: new Date().toISOString(),
    labeler_model: MODEL,
    labeling_fixes: [
      'scores_removed',
      'all_100_chunks_labeled',
      'shuffled_order',
    ],
    questions: [],
  }

  for (let qi = 0; qi < raw.questions.length; qi++) {
    const q = raw.questions[qi]
    console.log(
      `[${qi + 1}/${raw.questions.length}] ${q.id}: "${q.question.slice(0, 60)}..."`,
    )

    // Shuffle chunks to prevent rank-position bias
    const { shuffled, originalIndices } = shuffle(q.retrieved_chunks)

    // Label in batches
    const allLabels: Map<number, LabelResult> = new Map()
    const numBatches = Math.ceil(shuffled.length / BATCH_SIZE)

    for (let b = 0; b < numBatches; b++) {
      const batchStart = b * BATCH_SIZE
      const batch = shuffled.slice(batchStart, batchStart + BATCH_SIZE)
      process.stdout.write(`  batch ${b + 1}/${numBatches}... `)

      try {
        const labels = await labelBatch(apiKey, q.question, batch, batchStart)
        for (const l of labels) {
          // Map shuffled index back to original index
          const shuffledIdx = l.chunk_index - 1 // 1-indexed in prompt
          if (
            shuffledIdx >= batchStart &&
            shuffledIdx < batchStart + batch.length
          ) {
            const originalIdx = originalIndices[shuffledIdx]
            allLabels.set(originalIdx, l)
          }
        }
        console.log(`${labels.length} labels`)
      } catch (err: any) {
        console.error(`FAILED: ${err.message}`)
      }

      // Small delay between batches to avoid rate limits
      if (b < numBatches - 1) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    // Build labeled chunks in original order
    const labeledChunks = q.retrieved_chunks.map((chunk, idx) => {
      const label = allLabels.get(idx)
      return {
        chunk_id: chunk.chunk_id,
        doc_id: chunk.doc_id,
        title: chunk.title,
        content: chunk.content,
        score: chunk.score,
        page: chunk.page,
        label: (label?.label || 'not_relevant') as
          'relevant' | 'partially_relevant' | 'not_relevant',
        confidence: (label?.confidence || 'low') as string,
        rationale: label?.rationale || 'No label returned by LLM',
        human_override: null,
      }
    })

    const relevant = labeledChunks.filter((c) => c.label === 'relevant').length
    const partial = labeledChunks.filter(
      (c) => c.label === 'partially_relevant',
    ).length
    const notRel = labeledChunks.filter(
      (c) => c.label === 'not_relevant',
    ).length
    console.log(
      `  → ${relevant} relevant, ${partial} partial, ${notRel} not_relevant\n`,
    )

    output.questions.push({
      id: q.id,
      question: q.question,
      query_type: q.query_type,
      difficulty: q.difficulty,
      chunks: labeledChunks,
    })
  }

  // Write new labels
  fs.writeFileSync(LABELS_PATH, JSON.stringify(output, null, 2))
  console.log(`\nLabels written to ${path.basename(LABELS_PATH)}`)

  // Summary
  console.log(`\n=== Summary ===`)
  for (const q of output.questions) {
    const rel = q.chunks.filter((c: any) => c.label === 'relevant').length
    const part = q.chunks.filter(
      (c: any) => c.label === 'partially_relevant',
    ).length
    console.log(
      `  ${q.id}: ${rel} relevant, ${part} partial, ${100 - rel - part} not_relevant`,
    )
  }
}

main().catch((err) => {
  console.error('Relabeling failed:', err)
  process.exit(1)
})
