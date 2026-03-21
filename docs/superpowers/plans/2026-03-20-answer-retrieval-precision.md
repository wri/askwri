# Answer Retrieval Precision Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maximize precision of passages reaching answer synthesis by tightening retrieval params and adding a GPT-5.4-nano per-chunk relevance filter.

**Architecture:** Phase 1 adjusts retrieval config (alpha, rerankTopN, remove normalized threshold). Phase 2 adds a nano classifier inline in the answer route that filters chunks before synthesis and provides tier labels + coverage signal to the frontend.

**Tech Stack:** TypeScript/Next.js (answer route, frontend), Python/FastAPI (search service), GPT-5.4-nano (relevance filter), GPT-5.4 (synthesis).

**Spec:** `docs/superpowers/specs/2026-03-20-answer-retrieval-precision-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config/retrieval.ts` | Modify | Update ANSWER_PRESET params |
| `src/app/api/answer/route.ts` | Modify | Remove normalized threshold, add nano filter, simplify synthesis prompt |
| `src/app/components/AnswerMode/AIResearchModal.tsx` | Modify | Remove coverage pre-check, remove getTopQualityDocs, wire nano tier labels |
| `src/app/api/answer-coverage/route.ts` | Delete | Subsumed by inline nano filter |
| `search-service/app/config.py` | Modify | Remove answer_logit_floor configs |
| `search-service/app/main.py` | Modify | Remove gated logit floor block in answer branch |
| `evaluation/sweep-answer-retrieval.ts` | Create | Alpha × rerankTopN precision sweep |
| `evaluation/eval-nano-filter.ts` | Create | Nano filter accuracy vs GPT-5.4 labels |

---

### Task 1: Phase 1 — Tighten Retrieval Parameters

**Files:**
- Modify: `src/config/retrieval.ts:11-19`
- Modify: `src/app/api/answer/route.ts:224-235`
- Modify: `src/app/components/AnswerMode/AIResearchModal.tsx:59-64,191-192`

- [ ] **Step 1: Update ANSWER_PRESET in retrieval.ts**

Change `src/config/retrieval.ts` lines 11-19:

```typescript
export const ANSWER_PRESET: RetrievalParams = {
  retrievalMode: "hybrid",
  denseTopK: 150,
  sparseTopK: 150,
  alpha: 0.5,         // Will be updated after alpha sweep (Task 3)
  rerank: true,
  rerankTopN: 50,     // Rerank 50 candidates (up from 20) for better pool
  maxResults: 15,     // Return top 15 (down from 20) — tighter
};
```

- [ ] **Step 2: Remove normalized threshold from answer route**

In `src/app/api/answer/route.ts`, replace lines 224-235:

```typescript
    // DYNAMIC FILTERING: Only use high-relevance documents (>0.75 threshold)
    const RELEVANCE_THRESHOLD = 0.75
    const maxDocs = IS_GPT5 ? 8 : 6 // Reduced for concise answers
    const maxSnippetLen = IS_GPT5 ? 400 : 350 // Shorter snippets

    // Filter by relevance first, then take top N
    const filteredDocs = (Array.isArray(docs) ? docs : [])
      .filter((d: any) => {
        const relevance = d.kps?.[0]?.kp_relevance || d.score || 0
        return relevance >= RELEVANCE_THRESHOLD
      })
      .slice(0, maxDocs)
```

With:

```typescript
    // Phase 2 nano filter handles relevance filtering — just cap at maxDocs here
    const maxDocs = IS_GPT5 ? 8 : 6
    const maxSnippetLen = IS_GPT5 ? 400 : 350

    const filteredDocs = (Array.isArray(docs) ? docs : []).slice(0, maxDocs)
```

- [ ] **Step 3: Remove getTopQualityDocs from AIResearchModal.tsx**

In `src/app/components/AnswerMode/AIResearchModal.tsx`:

Delete the `getTopQualityDocs` function (lines 59-64):
```typescript
  // DELETE THIS FUNCTION — no longer needed
  const getTopQualityDocs = (docs: any[], maxDocs: number = 8): any[] => {
    if (!docs.length) return []
    const sortedDocs = [...docs].sort((a, b) => (b.score || 0) - (a.score || 0))
    const top40Percent = Math.max(1, Math.ceil(sortedDocs.length * 0.4))
    const finalCount = Math.min(top40Percent, maxDocs)
    return sortedDocs.slice(0, finalCount)
  }
```

Replace lines 191-197:
```typescript
      // Step 2: Get top quality docs for synthesis (top 40%, max 6)
      const topQualityDocs = getTopQualityDocs(validDocs, 6)

      const synthesisResponse = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), docs: topQualityDocs }),
      })
```

With:
```typescript
      // Send all valid docs to answer route — nano filter handles relevance
      const synthesisResponse = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), docs: validDocs }),
      })
```

- [ ] **Step 4: Verify Next.js compiles**

Run: `npx next build --no-lint`
Expected: Build succeeds (or only pre-existing warnings)

- [ ] **Step 5: Commit**

```bash
git add src/config/retrieval.ts src/app/api/answer/route.ts src/app/components/AnswerMode/AIResearchModal.tsx
git commit -m "feat: tighten answer retrieval params — rerank 50, return 15, remove normalized threshold"
```

---

### Task 2: Phase 1 — Cleanup Obsolete Answer Scoring Code

**Files:**
- Modify: `search-service/app/config.py:31-35`
- Modify: `search-service/app/main.py:1199-1217`

- [ ] **Step 1: Remove answer logit floor config from config.py**

In `search-service/app/config.py`, delete lines 31-35:

```python
    # Answer mode reranker logit thresholds (values set after calibration)
    answer_logit_floor: float = -999.0        # disabled until calibrated
    answer_strong_threshold: float = -999.0
    answer_partial_threshold: float = -999.0
    answer_use_logit_floor: bool = False       # gate — flip after calibration validates
```

- [ ] **Step 2: Remove gated logit floor block from main.py**

In `search-service/app/main.py`, replace lines 1199-1217 (keep the `else:` on line 1198):

```python
        else:
            # Answer mode: optionally apply logit floor + tier assignment (gated)
            if settings.answer_use_logit_floor:
                pre_floor = len(stage2_results)
                stage2_results = [n for n in stage2_results
                                  if n.score >= settings.answer_logit_floor]
                logger.info(f"Stage 3 (Answer Logit Floor {settings.answer_logit_floor}): {pre_floor} → {len(stage2_results)} chunks")

                # Assign relevance tiers based on raw logit score
                for node in stage2_results:
                    raw = node.score
                    if raw >= settings.answer_strong_threshold:
                        tier = "strong"
                    elif raw >= settings.answer_partial_threshold:
                        tier = "partial"
                    else:
                        tier = "weak"
                    node.node.metadata["relevance_tier"] = tier

            filtered_results = stage2_results[:request.max_results]
```

With:

```python
        else:
            # Answer mode: return top results as-is
            # Relevance filtering happens in the Next.js answer route (nano LLM filter)
            filtered_results = stage2_results[:request.max_results]
```

- [ ] **Step 3: Verify search service starts**

Run from `search-service/` directory: `python3 -c "from app.config import get_settings; s = get_settings(); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add search-service/app/config.py search-service/app/main.py
git commit -m "cleanup: remove obsolete answer logit floor experiment from search service"
```

---

### Task 3: Phase 1 — Alpha × RerankTopN Precision Sweep

**Files:**
- Create: `evaluation/sweep-answer-retrieval.ts`

This task creates and runs a sweep to find the optimal alpha value. The sweep calls the search service with varying alpha and rerankTopN values, then measures precision@K using the GPT-5.4 debiased labels.

- [ ] **Step 1: Create the sweep script**

Create `evaluation/sweep-answer-retrieval.ts`:

```typescript
/**
 * Alpha × RerankTopN precision sweep for answer mode retrieval.
 * Measures precision@K using GPT-5.4 debiased labels.
 *
 * Usage: npx tsx evaluation/sweep-answer-retrieval.ts
 * Requires: search service running on LLAMAINDEX_SERVICE_URL (default http://localhost:8000)
 */

import fs from 'fs'
import path from 'path'

const SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://localhost:8000'

// Load golden queries — file structure: { test_cases: [{ test_case_id, question, ... }] }
const rawData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-synthesis-raw.json'), 'utf-8')
)
const goldenSet = rawData.test_cases

// Load GPT-5.4 debiased labels — file structure: { questions: [{ id, chunks: [{ chunk_id, label }] }] }
const labels: Record<string, Record<string, string>> = {}
const labelFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-labels-review.json'), 'utf-8')
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
  maxResults: number
): Promise<Array<{ chunk_id: string; score: number }>> {
  const resp = await fetch(`${SERVICE_URL}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'answer',
      vector_top_k: 150,
      sparse_top_k: 150,
      alpha,
      rerank: true,
      rerank_top_n: rerankTopN,
      max_results: maxResults,
    }),
  })

  if (!resp.ok) throw new Error(`Search service error: ${resp.status}`)
  const data = await resp.json()
  return (data.results || []).map((r: any) => ({
    chunk_id: r.chunk_id || r.metadata?.chunk_id || `${r.doc_id}_chunk_${r.metadata?.chunk_index}`,
    score: r.score,
  }))
}

function computePrecisionAtK(
  results: Array<{ chunk_id: string }>,
  queryLabels: Record<string, string>,
  k: number
): number {
  const topK = results.slice(0, k)
  if (topK.length === 0) return 0
  const relevant = topK.filter(r => {
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
        const results = await runQuery(q.question, alpha, rerankTopN, Math.max(...PRECISION_AT_K))
        const queryLabels = labels[q.test_case_id] || {}

        for (const k of PRECISION_AT_K) {
          precisionSums[k] += computePrecisionAtK(results, queryLabels, k)
        }

        perQuery.push({
          queryId: q.test_case_id,
          question: q.question,
          precisionAt8: computePrecisionAtK(results, queryLabels, 8),
          relevantInTop8: results.slice(0, 8).filter(r => {
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

      console.log(`  P@8=${precisionAtK[8].toFixed(3)}  P@10=${precisionAtK[10].toFixed(3)}  P@12=${precisionAtK[12].toFixed(3)}  P@15=${precisionAtK[15].toFixed(3)}`)

      allResults.push({ alpha, rerankTopN, precisionAtK, perQuery })
    }
  }

  // Find best config
  const best = allResults.reduce((a, b) =>
    (a.precisionAtK[8] > b.precisionAtK[8]) ? a : b
  )
  console.log(`\n=== BEST CONFIG ===`)
  console.log(`alpha=${best.alpha}, rerankTopN=${best.rerankTopN}`)
  console.log(`P@8=${best.precisionAtK[8].toFixed(3)}`)
  console.log(`\nPer-query breakdown:`)
  for (const q of best.perQuery) {
    console.log(`  ${q.queryId}: P@8=${q.precisionAt8.toFixed(2)} (${q.relevantInTop8}/8)`)
  }

  // Save results
  const outDir = path.join(__dirname, 'results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = path.join(outDir, `answer-retrieval-sweep-${timestamp}.json`)
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    sweep_params: { alphas: ALPHA_VALUES, rerankTopNs: RERANK_TOP_N_VALUES, precisionAtK: PRECISION_AT_K },
    best: { alpha: best.alpha, rerankTopN: best.rerankTopN, precisionAtK: best.precisionAtK },
    all_results: allResults,
  }, null, 2))
  console.log(`\nResults saved to ${outPath}`)
}

main().catch(console.error)
```

- [ ] **Step 2: Run the sweep**

Requires search service running on port 8000.

Run: `npx tsx evaluation/sweep-answer-retrieval.ts`

Expected: Completes with a table of precision@K for each alpha × rerankTopN combination. Best config printed.

- [ ] **Step 3: Update alpha in retrieval.ts based on sweep results**

If the sweep finds that `alpha=0.65` (or another value) meaningfully improves P@8 over 0.5, update `src/config/retrieval.ts` with the winning value. If no significant improvement, keep `alpha=0.5`.

The success criterion from the spec: **P@8 improves from ~60% to ≥70%**.

- [ ] **Step 4: Commit**

```bash
git add evaluation/sweep-answer-retrieval.ts src/config/retrieval.ts
git commit -m "eval: alpha × rerankTopN precision sweep — update alpha to optimal value"
```

---

### Task 4: Phase 2 — Nano Relevance Filter in Answer Route

**Files:**
- Modify: `src/app/api/answer/route.ts`

This is the core change. Add a GPT-5.4-nano call inline in the answer route that classifies each chunk as strong/partial/weak before synthesis.

- [ ] **Step 1: Add nano filter constants and helper at top of route.ts**

After the existing `MODEL` constant (line 11), add:

```typescript
const NANO_MODEL = (process.env.OPENAI_MODEL_NANO ?? 'gpt-5.4-nano').trim()

const NANO_SYSTEM_PROMPT = `Given a research question and a set of passages, classify each passage's relevance to the question.

For each passage, classify as:
- "strong": Directly answers or provides specific evidence for the question
- "partial": Related to the topic but does not directly address the question
- "weak": Not meaningfully relevant to the question

Also rate overall corpus coverage for this question:
- "good": Multiple passages directly address the question
- "limited": Some relevant material but significant gaps exist
- "poor": No passages adequately address the question

Return JSON only:
{"relevance":[{"id":1,"tier":"strong"},{"id":2,"tier":"partial"}],"coverage":"good"}`

interface NanoFilterResult {
  relevance: Array<{ id: number; tier: 'strong' | 'partial' | 'weak' }>
  coverage: 'good' | 'limited' | 'poor'
}

async function runNanoFilter(
  query: string,
  docs: Array<{ id: number; title: string; key_finding: string }>,
  apiKey: string
): Promise<NanoFilterResult | null> {
  try {
    // Shuffle docs to prevent position bias (Fisher-Yates)
    const shuffled = [...docs]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    const passageText = shuffled
      .map(d => `[${d.id}] "${d.title}" — ${d.key_finding}`)
      .join('\n\n')

    const userPrompt = `Question: ${query}\n\nPassages (presented in random order):\n${passageText}`

    const isGPT5 = /^gpt-5/i.test(NANO_MODEL)
    const body: any = {
      model: NANO_MODEL,
      messages: [
        { role: 'system', content: NANO_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }
    if (isGPT5) {
      body.max_completion_tokens = 500
    } else {
      body.max_tokens = 500
      body.temperature = 0.1
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!r.ok) {
      console.error(`[Nano Filter] API error: ${r.status}`)
      return null
    }

    const data = await r.json()
    const content = data.choices?.[0]?.message?.content || ''
    const parsed = safeParse(content, false)

    if (!Array.isArray(parsed.relevance)) {
      console.error('[Nano Filter] Invalid response structure')
      return null
    }

    const coverage = ['good', 'limited', 'poor'].includes(parsed.coverage)
      ? parsed.coverage
      : 'limited'

    return { relevance: parsed.relevance, coverage }
  } catch (err) {
    console.error('[Nano Filter] Error:', err)
    return null
  }
}
```

- [ ] **Step 2: Wire nano filter into the POST handler**

Replace the **entire** filtering section written in Task 1 Step 2 (the `maxDocs`, `maxSnippetLen`, `filteredDocs`, and `docList` blocks — everything from the comment `// Phase 2 nano filter handles relevance filtering` through to the `debugInfo.docListCreated` block at ~line 252). This new code replaces ALL of that with nano-filter-aware logic:

```typescript
    // Build doc list from all incoming docs (no threshold filter)
    const maxSnippetLen = IS_GPT5 ? 400 : 350
    const allDocs = (Array.isArray(docs) ? docs : []).slice(0, 15) // Cap at 15 from search service

    const docList = allDocs.map((d: any, idx: number) => ({
      id: idx + 1,
      title: d.title || 'Untitled',
      authors: d.authors,
      year: d.year,
      doc_id: d.doc_id || '',
      key_finding: String(d.kps?.[0]?.snippet ?? '').slice(0, maxSnippetLen),
      relevance: d.kps?.[0]?.kp_relevance || d.score || 0,
    }))

    // Run nano relevance filter
    const nanoResult = await runNanoFilter(
      query,
      docList.map(d => ({ id: d.id, title: d.title, key_finding: d.key_finding })),
      key
    )

    let filteredDocs: typeof docList
    let coverageRating: string = 'unknown'
    let sourceRelevanceFromNano: Array<{ doc_id: string; tier: string }> = []

    if (nanoResult) {
      // Build tier map: id → tier
      const tierMap = new Map<number, string>()
      for (const r of nanoResult.relevance) {
        tierMap.set(r.id, r.tier)
      }

      // Filter: keep strong + partial, drop weak
      filteredDocs = docList.filter(d => {
        const tier = tierMap.get(d.id) || 'weak'
        return tier === 'strong' || tier === 'partial'
      })

      // Build source_relevance for frontend (all docs, not just filtered)
      sourceRelevanceFromNano = docList.map(d => ({
        doc_id: d.doc_id,
        tier: tierMap.get(d.id) || 'weak',
      })).filter(sr => sr.doc_id)

      coverageRating = nanoResult.coverage
      const maxDocs = IS_GPT5 ? 8 : 6
      filteredDocs = filteredDocs.slice(0, maxDocs)

      console.log(`[Nano Filter] ${docList.length} → ${filteredDocs.length} docs (coverage: ${coverageRating})`)

      // Edge case: all weak → skip synthesis, return low coverage
      if (filteredDocs.length === 0) {
        return NextResponse.json({
          ok: true,
          synthesis: {
            sentences: ['The available sources do not contain sufficient information to answer this question.'],
            source_relevance: sourceRelevanceFromNano,
            warning: 'low_coverage',
            warningMessage: 'The available sources do not adequately cover this topic.',
            coverage: coverageRating,
          },
          debug: { ...debugInfo, nanoFilter: 'all_weak', coverage: coverageRating },
        })
      }
    } else {
      // Nano filter failed — fall back to all docs capped at maxDocs
      console.warn('[Nano Filter] Failed, falling back to unfiltered docs')
      const maxDocs = IS_GPT5 ? 8 : 6
      filteredDocs = docList.slice(0, maxDocs)
    }
```

- [ ] **Step 3: Update synthesis response to include nano tier labels and coverage**

In the response-building section (after synthesis call), replace the source_relevance extraction. The nano filter's tiers take precedence over synthesis LLM tiers:

Find the block starting with `// Extract source relevance tiers from synthesis LLM` (~line 422) and replace with:

```typescript
    // Source relevance: prefer nano filter tiers (absolute), fall back to synthesis LLM tiers (relative)
    let sourceRelevance: Array<{ doc_id: string; tier: string }> = []
    if (sourceRelevanceFromNano.length > 0) {
      sourceRelevance = sourceRelevanceFromNano
    } else {
      // Fallback: use synthesis LLM tiers
      const rawSourceRelevance: {id: number, tier: string}[] = Array.isArray(parsed.source_relevance)
        ? parsed.source_relevance
        : []
      sourceRelevance = rawSourceRelevance.map(sr => {
        const doc = filteredDocs[sr.id - 1]
        return {
          doc_id: doc?.doc_id || '',
          tier: sr.tier || 'weak',
        }
      }).filter(sr => sr.doc_id)
    }
    if (sourceRelevance.length > 0) {
      synthesis.source_relevance = sourceRelevance
    }
    if (coverageRating && coverageRating !== 'unknown') {
      synthesis.coverage = coverageRating
    }
```

Also update the low-coverage detection to use nano coverage:

```typescript
    // Low coverage: from nano filter or synthesis LLM
    const isLowCoverage = coverageRating === 'poor' || coverageRating === 'limited' ||
      parsed.low_coverage === true
```

- [ ] **Step 4: Simplify synthesis system prompt**

Since the nano filter handles relevance evaluation, remove the "EVALUATE FIRST" instruction from the synthesis prompt. In the `SYS` constant at line 34-57 (GPT-5 branch, the first template literal), replace:

```
- EVALUATE FIRST: Before synthesizing, assess each source's relevance to the question. Only use sources that directly address the question. Ignore tangentially related material.
```

With:

```
- TRUST SOURCES: The provided sources have been pre-filtered for relevance. Focus on synthesizing their key findings.
```

Keep the `source_relevance` output requirement in the prompt — it serves as a confirmation/adjustment of the nano filter's judgment.

- [ ] **Step 5: Verify build**

Run: `npx next build --no-lint`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/app/api/answer/route.ts
git commit -m "feat: add GPT-5.4-nano relevance filter to answer route — per-chunk strong/partial/weak classification"
```

---

### Task 5: Frontend — Remove Coverage Pre-check, Wire Nano Tiers

**Files:**
- Modify: `src/app/components/AnswerMode/AIResearchModal.tsx:159-170,276-300`
- Delete: `src/app/api/answer-coverage/route.ts`

- [ ] **Step 1: Remove coverage pre-check fetch from AIResearchModal**

In `src/app/components/AnswerMode/AIResearchModal.tsx`, delete lines 159-170 (the coveragePromise):

```typescript
      // DELETE THIS BLOCK — coverage now comes from nano filter in answer route
      const coveragePromise = fetch('/api/answer-coverage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          passages: validDocs.slice(0, 5).map((d: any) => ({
            title: d.title,
            snippet: d.kps?.[0]?.snippet?.slice(0, 150) || '',
          })),
        }),
      }).then(r => r.json()).catch(() => ({ coverage: 'unknown', explanation: '' }))
```

- [ ] **Step 2: Update coverage handling to read from synthesis response**

Replace lines 297-300:
```typescript
        // Await coverage result (should already be done since it ran in parallel)
        const coverageResult = await coveragePromise
        setCoverageRating(coverageResult.coverage || 'unknown')
        setCoverageExplanation(coverageResult.explanation || '')
```

With:
```typescript
        // Coverage comes from nano filter (returned in synthesis response)
        if (synthesisResult.synthesis?.coverage) {
          setCoverageRating(synthesisResult.synthesis.coverage)
          // Generate explanation from coverage rating (SupportingCitations.tsx renders this)
          const explanations: Record<string, string> = {
            good: '',
            limited: 'Some passages touch on the topic but lack specific answers.',
            poor: 'The corpus likely does not contain material to adequately answer this question.',
          }
          setCoverageExplanation(explanations[synthesisResult.synthesis.coverage] || '')
        }
```

- [ ] **Step 3: Delete the answer-coverage route**

Delete the entire file: `src/app/api/answer-coverage/route.ts`

- [ ] **Step 4: Verify build**

Run: `npx next build --no-lint`
Expected: Build succeeds. No references to `/api/answer-coverage` remain.

- [ ] **Step 5: Verify no remaining references**

Run: `grep -r "answer-coverage" src/`
Expected: No results (or only comments)

- [ ] **Step 6: Commit**

```bash
git add -u src/app/api/answer-coverage/route.ts
git add src/app/components/AnswerMode/AIResearchModal.tsx
git commit -m "cleanup: remove answer-coverage route — subsumed by inline nano filter"
```

---

### Task 6: Phase 2 — Nano Filter Accuracy Eval

**Files:**
- Create: `evaluation/eval-nano-filter.ts`

- [ ] **Step 1: Create the eval script**

Create `evaluation/eval-nano-filter.ts`:

```typescript
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
const SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://localhost:8000'

// Load golden queries — file structure: { test_cases: [{ test_case_id, question, ... }] }
const rawData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-synthesis-raw.json'), 'utf-8')
)
const goldenSet = rawData.test_cases

// Load GPT-5.4 debiased labels — file structure: { questions: [{ id, chunks: [{ chunk_id, doc_id, label }] }] }
const labelFile = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'answer-labels-review.json'), 'utf-8')
)
// Build chunk-level labels AND doc-level labels (max label per doc for a given query)
const chunkLabels: Record<string, Record<string, string>> = {}
const docLabels: Record<string, Record<string, string>> = {}
const tierRank: Record<string, number> = { relevant: 2, partially_relevant: 1, not_relevant: 0 }
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
      alpha: 0.5, // Use current config
      rerank: true,
      rerank_top_n: 50,
      max_results: 15,
    }),
  })
  if (!resp.ok) throw new Error(`Search service error: ${resp.status}`)
  const data = await resp.json()
  return data.results || []
}

async function getSynthesisWithNanoFilter(query: string, docs: any[]): Promise<any> {
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

  const confusion = { ss: 0, sp: 0, sw: 0, ps: 0, pp: 0, pw: 0, ws: 0, wp: 0, ww: 0 }
  let totalCompared = 0
  let totalAgreed = 0
  let filterPrecisionSum = 0
  let filterRecallSum = 0

  for (const q of goldenSet) {
    console.log(`\n--- ${q.query_id}: ${q.question} ---`)

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
    let relevant = 0, nanoStrong = 0, nanoStrongAndRelevant = 0

    for (const r of searchResults.slice(0, 15)) {
      const docId = r.doc_id
      if (seenDocs.has(docId)) continue // One comparison per doc
      seenDocs.add(docId)

      const groundTruth = labelToTier(queryDocLabels[docId] || 'not_relevant')
      const nanoTier = nanoTiers[docId] || 'weak'

      // Confusion matrix
      const key = `${groundTruth[0]}${nanoTier[0]}` as keyof typeof confusion
      if (key in confusion) confusion[key]++

      if (groundTruth === nanoTier) totalAgreed++
      totalCompared++

      if (groundTruth === 'strong' || groundTruth === 'partial') relevant++
      if (nanoTier === 'strong' || nanoTier === 'partial') nanoStrong++
      if ((nanoTier === 'strong' || nanoTier === 'partial') &&
          (groundTruth === 'strong' || groundTruth === 'partial')) nanoStrongAndRelevant++
    }

    const filterPrecision = nanoStrong > 0 ? nanoStrongAndRelevant / nanoStrong : 0
    const filterRecall = relevant > 0 ? nanoStrongAndRelevant / relevant : 0
    filterPrecisionSum += filterPrecision
    filterRecallSum += filterRecall

    console.log(`  Coverage: ${result.synthesis?.coverage || 'unknown'}`)
    console.log(`  Filter precision: ${filterPrecision.toFixed(2)} (${nanoStrongAndRelevant}/${nanoStrong})`)
    console.log(`  Filter recall: ${filterRecall.toFixed(2)} (${nanoStrongAndRelevant}/${relevant})`)
    console.log(`  Synthesis docs: ${result.synthesis?.sentences?.length || 0} sentences`)
  }

  const n = goldenSet.length
  console.log('\n=== SUMMARY ===')
  console.log(`Agreement rate: ${(totalAgreed / totalCompared * 100).toFixed(1)}% (${totalAgreed}/${totalCompared})`)
  console.log(`Avg filter precision: ${(filterPrecisionSum / n).toFixed(3)}`)
  console.log(`Avg filter recall: ${(filterRecallSum / n).toFixed(3)}`)
  console.log(`\nConfusion matrix (rows=ground_truth, cols=nano):`)
  console.log(`         strong  partial  weak`)
  console.log(`strong   ${confusion.ss.toString().padStart(5)}  ${confusion.sp.toString().padStart(7)}  ${confusion.sw.toString().padStart(4)}`)
  console.log(`partial  ${confusion.ps.toString().padStart(5)}  ${confusion.pp.toString().padStart(7)}  ${confusion.pw.toString().padStart(4)}`)
  console.log(`weak     ${confusion.ws.toString().padStart(5)}  ${confusion.wp.toString().padStart(7)}  ${confusion.ww.toString().padStart(4)}`)

  // Save results
  const outDir = path.join(__dirname, 'results')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outPath = path.join(outDir, `nano-filter-eval-${timestamp}.json`)
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    agreement_rate: totalAgreed / totalCompared,
    avg_filter_precision: filterPrecisionSum / n,
    avg_filter_recall: filterRecallSum / n,
    confusion,
    success_criteria: {
      precision_target: 0.85,
      precision_met: (filterPrecisionSum / n) >= 0.85,
    },
  }, null, 2))
  console.log(`\nResults saved to ${outPath}`)
}

main().catch(console.error)
```

- [ ] **Step 2: Run the eval**

Requires: search service on :8000, Next.js on :3000, OPENAI_API_KEY set.

Run: `npx tsx evaluation/eval-nano-filter.ts`

Expected: Per-query filter precision and recall, confusion matrix, overall agreement rate. Success criterion from spec: **avg filter precision ≥ 85%**.

- [ ] **Step 3: Commit**

```bash
git add evaluation/eval-nano-filter.ts
git commit -m "eval: nano filter accuracy evaluation against GPT-5.4 debiased labels"
```

---

### Task 7: Documentation Updates

**Files:**
- Modify: `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md`
- Modify: `search-service/README.md`

- [ ] **Step 1: Add deprecation note to old spec**

At the top of `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md`, add:

```markdown
> **SUPERSEDED**: This spec has been superseded by `2026-03-20-answer-retrieval-precision-design.md`. The logit floor approach was invalidated by calibration — score distributions overlap too much for answer mode. The replacement uses a GPT-5.4-nano per-chunk relevance filter instead.
```

- [ ] **Step 2: Update search-service README with new retrieval parameters**

In `search-service/README.md`, find the answer mode configuration section and update to reflect:
- `rerankTopN: 50` (was 20)
- `maxResults: 15` (was 20)
- `alpha: <value from sweep>` (was 0.5)
- Note that relevance filtering now happens in the Next.js answer route, not the search service

- [ ] **Step 3: Add OPENAI_MODEL_NANO to .env.example**

If `.env.example` exists, add:
```
# Nano model for answer mode relevance filter (default: gpt-5.4-nano)
OPENAI_MODEL_NANO=gpt-5.4-nano
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md search-service/README.md .env.example
git commit -m "docs: update specs, README, and env config for answer retrieval precision changes"
```
