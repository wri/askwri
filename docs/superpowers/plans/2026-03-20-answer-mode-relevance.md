# Answer Mode Relevance: Tier Labels, Nano Coverage Pre-Check, and Evaluation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give answer mode color-coded relevance tiers (Strong/Partial/Weak) matching cite mode's visual language, an absolute corpus-coverage signal via `gpt-5.4-nano`, and validated evaluation comparing before/after synthesis quality.

**Architecture:** The synthesis LLM (GPT-5.4) judges each source as strong/partial/weak during its existing call — zero additional latency. A parallel `gpt-5.4-nano` call provides an absolute query-level coverage rating (good/limited/poor) that grounds the tiers. Both signals flow to the frontend: tier badges on each passage (color-coded like cite mode) and coverage warnings when the corpus lacks material. Evaluation captures baseline on `main`, runs the new pipeline, and compares on 5 synthesis dimensions + tier accuracy + coverage detection.

**Tech Stack:** Next.js API routes (TypeScript), gpt-5.4-nano for coverage pre-check, gpt-5.4 for synthesis, existing eval pipeline (capture + LLM eval)

**Cite mode pattern to match:** Strong → `success` (green Tag), Partial → `warning` (yellow Tag), Weak → `info-grey` (grey Tag). No scores shown. See `src/app/components/results/SelectableResultRow.tsx:155-157`.

**Branch:** `gutelius/answer-mode-scoring` (continue from existing work)

**Spec:** `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md`

---

### Task 1: Add coverage pre-check API route

A new `/api/answer-coverage` route calls `gpt-5.4-nano` with the query + top-5 passage titles/snippets. Returns a coverage rating (good/limited/poor) and a one-sentence explanation. This runs in parallel with synthesis — the frontend fires both calls after retrieval.

**Files:**
- Create: `src/app/api/answer-coverage/route.ts`

- [ ] **Step 1: Create the coverage pre-check route**

```typescript
// src/app/api/answer-coverage/route.ts
/* eslint-disable */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MODEL = (
  process.env.OPENAI_MODEL_COVERAGE ??
  process.env.OPENAI_MODEL_WHY ??
  'gpt-5.4-nano'
).trim()

const SYSTEM_PROMPT = `You are a research librarian assessing whether a set of retrieved passages can adequately answer a research question.

Given a question and the titles + opening excerpts of the top retrieved passages, rate corpus coverage:

- "good": Multiple passages directly address the question with specific evidence or data
- "limited": Some passages touch on the topic but lack specific answers or direct evidence
- "poor": Passages are tangentially related at best; the corpus likely does not contain material to answer this question

Respond with JSON only:
{"coverage": "good"|"limited"|"poor", "explanation": "One sentence explaining your assessment."}`

export async function POST(req: NextRequest) {
  try {
    const { query, passages } = await req.json()
    const key = process.env.OPENAI_API_KEY?.trim()

    if (!key || !query || !Array.isArray(passages) || passages.length === 0) {
      return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Insufficient data for coverage assessment.' })
    }

    // Format top-5 passages compactly for nano model
    const passageText = passages.slice(0, 5).map((p: any, i: number) =>
      `[${i + 1}] "${p.title}" — ${(p.snippet || '').slice(0, 150)}`
    ).join('\n')

    const userPrompt = `Question: "${query}"\n\nTop retrieved passages:\n${passageText}\n\nRate corpus coverage.`

    const isGPT5 = /^gpt-5/i.test(MODEL)
    const body: any = {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }
    if (isGPT5) {
      body.max_completion_tokens = 200
    } else {
      body.max_tokens = 200
      body.temperature = 0.1
    }

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })

    if (!r.ok) {
      console.error(`[Coverage] API error: ${r.status}`)
      return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Coverage check failed.' })
    }

    const data = await r.json()
    const content = data.choices?.[0]?.message?.content || ''

    try {
      const cleaned = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
      const parsed = JSON.parse(cleaned.slice(s, e + 1))
      const coverage = ['good', 'limited', 'poor'].includes(parsed.coverage) ? parsed.coverage : 'unknown'
      return NextResponse.json({
        ok: true,
        coverage,
        explanation: parsed.explanation || '',
        model: MODEL,
      })
    } catch {
      console.error('[Coverage] Failed to parse response:', content.slice(0, 200))
      return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Could not parse coverage assessment.' })
    }
  } catch (err: any) {
    console.error('[Coverage] Error:', err.message)
    return NextResponse.json({ ok: true, coverage: 'unknown', explanation: 'Coverage check error.' })
  }
}
```

- [ ] **Step 2: Verify route compiles**

Run: `./node_modules/.bin/tsc --noEmit 2>&1 | grep answer-coverage`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/answer-coverage/route.ts
git commit -m "feat: add /api/answer-coverage nano pre-check route"
```

---

### Task 2: Refine synthesis prompt tier definitions

The current synthesis prompt already asks GPT-5.4 for `source_relevance` with strong/partial/weak tiers. The tier definitions need tightening to be less arbitrary and more aligned with cite mode's semantics. The response parsing already maps tiers to doc_ids — keep that logic.

**Files:**
- Modify: `src/app/api/answer/route.ts`

- [ ] **Step 1: Update tier definitions in both SYS prompt variants**

In `src/app/api/answer/route.ts`, replace the tier definitions block in both prompt variants (~lines 50-53 and ~lines 73-75) with grounded definitions that match cite mode's semantics:

```
Tier definitions (match these exactly):
- "strong": Information from this source appears in your synthesis. You directly used it.
- "partial": Source is on-topic and could support the answer, but you did not directly use it.
- "weak": Source does not meaningfully address the question.
```

This makes "strong" verifiable (did the synthesis use it?) and "partial" meaningful (on-topic but not cited).

- [ ] **Step 2: Verify the existing response parsing is correct**

The route already has `rawSourceRelevance` → `sourceRelevance` mapping (~lines 420-441) that maps 1-indexed IDs to doc_ids with tiers. Verify this code is intact and produces `synthesis.source_relevance` as an array of `{doc_id, tier}` objects.

Also verify `isLowCoverage` detection uses `strongOrPartial` count correctly. The existing logic should be:
```typescript
const strongOrPartial = rawSourceRelevance.filter(s => s.tier === 'strong' || s.tier === 'partial').length
const isLowCoverage = parsed.low_coverage === true || strongOrPartial === 0
```

- [ ] **Step 3: Verify route compiles**

Run: `./node_modules/.bin/tsc --noEmit 2>&1 | grep "route.ts"`
Expected: no errors from answer route

- [ ] **Step 4: Commit**

```bash
git add src/app/api/answer/route.ts
git commit -m "feat: tighten answer mode tier definitions to match cite mode semantics"
```

---

### Task 3: Wire coverage + tier labels through frontend

Update `AIResearchModal` to fire the coverage pre-check in parallel with synthesis, store both results, and pass them to `SupportingCitations`. Update `SupportingCitations` to show color-coded tier badges matching cite mode's visual language (Strong=green, Partial=yellow, Weak=grey). No scores shown.

**Files:**
- Modify: `src/app/components/AnswerMode/AIResearchModal.tsx`
- Modify: `src/app/components/AnswerMode/SupportingCitations.tsx`
- Modify: `src/app/components/AnswerMode/AnswerPanel.tsx`
- Modify: `src/app/components/AnswerMode/types.ts`

**Reference:** Cite mode uses the same pattern in `src/app/components/results/SelectableResultRow.tsx:155-157`:
- Strong → Tag variant `success`
- Partial → Tag variant `warning`
- Weak → Tag variant `info-grey`

- [ ] **Step 1: Update types**

In `src/app/components/AnswerMode/types.ts`:

Update `SupportingCitationsProps` — keep `sourceRelevance` (doc_id → tier map), add coverage:
```typescript
export interface SupportingCitationsProps {
  supportingDocs: DocMeta[]
  setFirstDocHowRelevant: (why: string) => void
  page?: number
  setPage?: (p: number) => void
  sourceRelevance?: Record<string, string>  // doc_id → 'strong' | 'partial' | 'weak'
  coverageRating?: string                   // 'good' | 'limited' | 'poor' | 'unknown'
  coverageExplanation?: string
}
```

Add coverage to `AnswerPanelProps`:
```typescript
  coverageRating?: string
  coverageExplanation?: string
```

- [ ] **Step 2: Update AIResearchModal state and parallel calls**

In `src/app/components/AnswerMode/AIResearchModal.tsx`:

Keep the existing `sourceRelevance` state. Add coverage state:
```typescript
const [coverageRating, setCoverageRating] = useState<string>('')
const [coverageExplanation, setCoverageExplanation] = useState<string>('')
```

After `validDocs` is computed (~line 150, after the `docs.filter(...)` call — NOT line 143 where `validDocs` is not yet defined), fire the coverage pre-check in parallel with synthesis:

```typescript
      // Fire coverage pre-check in parallel with synthesis (does not block)
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

After synthesis completes, await coverage and store:
```typescript
      const coverageResult = await coveragePromise
      setCoverageRating(coverageResult.coverage || 'unknown')
      setCoverageExplanation(coverageResult.explanation || '')
```

The existing `source_relevance` extraction (setting `sourceRelevance` state from `synthesis.source_relevance`) stays as-is.

- [ ] **Step 3: Update SupportingCitations props pass-through**

In `AIResearchModal.tsx`, add coverage props to the existing `<SupportingCitations>`:

```tsx
<SupportingCitations
  setFirstDocHowRelevant={setFirstDocHowRelevant}
  supportingDocs={supportingDocs}
  page={supportingCitationsPage}
  setPage={setSupportingCitationsPage}
  sourceRelevance={sourceRelevance}
  coverageRating={coverageRating}
  coverageExplanation={coverageExplanation}
/>
```

Also pass `coverageRating` to `<AnswerPanel>`.

- [ ] **Step 4: Update AnswerPanel to show coverage tag**

In `src/app/components/AnswerMode/AnswerPanel.tsx`, next to the alignment tag, add:

```tsx
{coverageRating === 'poor' && (
  <Tag
    icon={<FaInfoCircle />}
    label="Low corpus coverage"
    variant="default"
  />
)}
{coverageRating === 'limited' && (
  <Tag
    icon={<FaInfoCircle />}
    label="Limited corpus coverage"
    variant="info-white"
  />
)}
```

- [ ] **Step 5: Update SupportingCitations to show color-coded tier badges**

In `src/app/components/AnswerMode/SupportingCitations.tsx`:

Replace the existing tier/relevance display block with cite-mode-matching color-coded Tags. Match `SelectableResultRow.tsx:155-157` pattern exactly:

```tsx
{/* Relevance tier from synthesis LLM */}
{paginatedItems[0] && (() => {
  const tier = sourceRelevance?.[paginatedItems[0].doc.doc_id]
  if (tier) {
    return (
      <Box display='flex' alignItems='center' gap='2' marginBottom='4'>
        <Tag
          label={tier === 'strong' ? 'Strong' : tier === 'partial' ? 'Partial' : 'Weak'}
          variant={
            tier === 'strong' ? 'success'
              : tier === 'partial' ? 'warning'
                : 'info-grey'
          }
        />
      </Box>
    )
  }
  // Fallback while synthesis is loading — show spinner or nothing
  return (
    <Box display='flex' alignItems='center' gap='2' marginBottom='4'>
      <Text fontSize='xs' fontWeight='medium' color={getThemedColor('neutral', 500)}>
        Evaluating relevance...
      </Text>
    </Box>
  )
})()}
```

No scores shown — just the color-coded tag, matching cite mode.

Also show coverage explanation at top of citations panel when coverage is poor/limited:

```tsx
{(coverageRating === 'poor' || coverageRating === 'limited') && coverageExplanation && (
  <Box padding='2' marginBottom='2'>
    <InlineMessage
      variant='warning'
      label={coverageRating === 'poor' ? 'Low corpus coverage' : 'Limited corpus coverage'}
      caption={coverageExplanation}
    />
  </Box>
)}
```

- [ ] **Step 6: Verify compilation**

Run: `./node_modules/.bin/tsc --noEmit 2>&1 | grep -E "AnswerPanel|SupportingCitations|AIResearchModal|types.ts"`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/app/components/AnswerMode/ src/app/api/answer/route.ts
git commit -m "feat: color-coded tier labels + coverage pre-check in answer mode UI"
```

---

### Task 4: Capture baseline synthesis outputs

Run the existing capture pipeline against the live services with the OLD prompt (before our changes) to get a baseline. This requires reverting the answer route temporarily or using git stash.

**Files:**
- No file changes — this task runs eval scripts

- [ ] **Step 1: Start services**

Ensure both services are running:
- Search service on :8000 (see `search-service/` README)
- Next.js on :3000

- [ ] **Step 2: Capture baseline on main branch**

Stash current changes or use a worktree on `main`:

```bash
git stash
git checkout main
```

Run baseline capture:
```bash
npx tsx --env-file-if-exists=.env evaluation/run-answer-synthesis-capture.ts
```

Copy output to a timestamped baseline file:
```bash
cp evaluation/answer-synthesis-raw.json evaluation/results/answer-synthesis-baseline-$(date +%Y%m%dT%H%M%S).json
```

Return to branch:
```bash
git checkout gutelius/answer-mode-scoring
git stash pop
```

- [ ] **Step 3: Verify baseline file exists**

Run: `ls -la evaluation/results/answer-synthesis-baseline-*.json`
Expected: one file with reasonable size (>10KB)

---

### Task 5: Capture new synthesis outputs and run evaluation

Run the capture pipeline with the new prompt, then run LLM eval on both baseline and new outputs. Compare on 5 synthesis dimensions + new metrics.

**Files:**
- Create: `evaluation/compare-synthesis-evals.ts` (comparison script)

- [ ] **Step 1: Start services with new code**

Ensure both services running with the updated answer route on :3000.

- [ ] **Step 2: Capture new synthesis**

```bash
npx tsx --env-file-if-exists=.env evaluation/run-answer-synthesis-capture.ts
```

This overwrites `answer-synthesis-raw.json` with new prompt results. Copy to timestamped file:
```bash
cp evaluation/answer-synthesis-raw.json evaluation/results/answer-synthesis-new-$(date +%Y%m%dT%H%M%S).json
```

- [ ] **Step 3: Run LLM eval on new synthesis**

**Important:** Per CLAUDE.md, do not use inline env var assignment (`ENVVAR=value cmd`). Export first:

```bash
export SYNTHESIS_EVAL_MODEL=gpt-5.4
```
```bash
npx tsx --env-file-if-exists=.env evaluation/run-answer-synthesis-llm-eval.ts
```

Copy result:
```bash
cp evaluation/answer-synthesis-llm-eval.json evaluation/results/answer-synthesis-eval-new-$(date +%Y%m%dT%H%M%S).json
```

- [ ] **Step 4: Run LLM eval on baseline**

First, find the exact baseline filename (do NOT use glob with `cp` — it fails if multiple matches):

```bash
ls evaluation/results/answer-synthesis-baseline-*.json
```

Then copy the specific file (replace FILENAME with the actual name from ls):

```bash
cp evaluation/results/FILENAME evaluation/answer-synthesis-raw.json
```
```bash
npx tsx --env-file-if-exists=.env evaluation/run-answer-synthesis-llm-eval.ts
```
```bash
cp evaluation/answer-synthesis-llm-eval.json evaluation/results/answer-synthesis-eval-baseline-$(date +%Y%m%dT%H%M%S).json
```

- [ ] **Step 5: Write comparison script**

Create `evaluation/compare-synthesis-evals.ts` that:
1. Loads both eval JSONs (baseline and new)
2. Prints side-by-side table of 5 dimensions per query
3. Computes aggregate improvement/regression per dimension
4. Reports new metrics not in baseline:
   - **Tier distribution**: How many sources marked strong/partial/weak per query
   - **Tier accuracy**: Cross-reference tiers with LLM labels from `answer-labels-review.json` — does GPT-5.4-as-synthesizer agree with GPT-5.4-as-labeler?
   - **Coverage detection**: Which queries triggered `low_coverage` or coverage rating `poor`/`limited`
   - **Source selectivity**: How many sources used per query (strong tier count)

Expected outcomes:
- Faithfulness: should improve or stay same (LLM is more selective)
- Completeness: watch for regression (fewer sources used)
- Conciseness: should improve (less noise in input)
- Coherence: should improve (more focused synthesis)
- Citation accuracy: should improve (only using sources it actually cites)
- Coverage: ans_002 and ans_006 should get `limited` or `poor` rating

Usage: `npx tsx --env-file-if-exists=.env evaluation/compare-synthesis-evals.ts --baseline results/answer-synthesis-eval-baseline-TIMESTAMP.json --new results/answer-synthesis-eval-new-TIMESTAMP.json`

- [ ] **Step 6: Run comparison and review**

```bash
npx tsx --env-file-if-exists=.env evaluation/compare-synthesis-evals.ts --baseline evaluation/results/answer-synthesis-eval-baseline-TIMESTAMP.json --new evaluation/results/answer-synthesis-eval-new-TIMESTAMP.json
```

Review output. If completeness regressed significantly (>0.1 average drop), consider adjusting the synthesis prompt to be less aggressive about ignoring sources.

- [ ] **Step 7: Commit eval results and comparison script**

```bash
git add evaluation/compare-synthesis-evals.ts evaluation/results/answer-synthesis-*.json
git commit -m "eval: before/after synthesis comparison with tier labels and coverage pre-check"
```

---

### Task 6: Documentation sweep

Update all documentation that references answer mode relevance, thresholds, or filtering to reflect the new approach. This is critical — stale docs mislead future contributors.

**Files:**
- Modify: `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md`
- Modify: `search-service/README.md`
- Modify: `evaluation/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Update design spec with final implementation**

In `docs/superpowers/specs/2026-03-20-answer-mode-scoring-design.md`, add a "Final Implementation" section summarizing:
- **Nano coverage pre-check**: `gpt-5.4-nano` provides absolute query-level coverage rating (good/limited/poor)
- **Synthesis LLM tier labels**: GPT-5.4 assigns strong/partial/weak to each source during synthesis (zero extra latency)
- **Color-coded UI**: Matching cite mode — Strong (green), Partial (yellow), Weak (grey)
- **Gated logit floor**: Inactive in search service, retained for future use with better calibration data
- **Eval results summary**: Include key numbers from the comparison

Update the Files Changed table and Sequence to reflect actual implementation.

- [ ] **Step 2: Update search-service/README.md**

Add an "Answer Mode Relevance" section explaining:
- Answer mode does NOT use reranker logit thresholds (unlike cite mode) — calibration showed score distributions overlap
- Relevance tiers come from the synthesis LLM (GPT-5.4), not the reranker
- Gated config exists (`answer_use_logit_floor`, etc.) but is inactive
- Coverage assessment uses `gpt-5.4-nano` in the Next.js layer

- [ ] **Step 3: Update evaluation/README.md**

Update the answer mode evaluation section:
- Default `SYNTHESIS_EVAL_MODEL` is now `gpt-5.4` (not `gpt-5.2`)
- New metrics: tier distribution, tier accuracy, coverage detection, source selectivity
- Reference `compare-synthesis-evals.ts` for before/after comparison
- Note that `answer-labels-review.json` was re-labeled with GPT-5.4 (debiased methodology)

- [ ] **Step 4: Add OPENAI_MODEL_COVERAGE to .env.example**

In `.env.example`, add:
```
# Answer mode corpus coverage pre-check (absolute signal)
# Optional: defaults to OPENAI_MODEL_WHY, then gpt-5.4-nano if neither is set
# OPENAI_MODEL_COVERAGE=gpt-5.4-nano
```

- [ ] **Step 5: Commit**

```bash
git add docs/ search-service/README.md evaluation/README.md .env.example
git commit -m "docs: comprehensive update for answer mode tier labels and coverage pre-check"
```
