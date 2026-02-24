# Answer Synthesis Evaluation — Design

**Date:** 2026-02-24
**Status:** Draft
**Depends on:** Track 1 retrieval human evals completing (in progress)
**Scope:** Evaluate synthesis quality using actual system outputs, LLM evaluation, and human review

## Problem

The answer golden dataset has 9 test cases with retrieval ground truth but empty `synthesis_ground_truth`. We need a repeatable evaluation pipeline that measures how well the `/api/answer` endpoint synthesizes answers from retrieved passages.

Unlike the retrieval eval (which compares passage sets), synthesis eval is qualitative: does the generated answer faithfully, completely, and coherently represent what the passages say?

## Approach: System Output → LLM Eval → Human Review

Rather than hand-writing canonical answers and comparing against them (brittle, subjective), we:

1. Capture actual system outputs (passages selected + synthesis + citation traces)
2. Have GPT-5.2 (thinking mode) score the synthesis on 5 dimensions
3. Have a human reviewer validate/adjust scores and add feedback
4. Use the best-scoring answers as canonical ground truth for future regression testing

```
End-to-end system run
        │
        ▼
answer-synthesis-raw.json
  (question, passages, synthesis, citation traces)
        │
        ▼
GPT-5.2 thinking evaluation
        │
        ▼
answer-synthesis-llm-eval.json
  (5 dimension scores + qualitative feedback per test case)
        │
        ▼
Human review UI (:3001/eval/review-synthesis)
        │
        ▼
answer-synthesis-eval-final.json        answer-golden-dataset.json
  (LLM + human scores, feedback)          (synthesis_ground_truth populated)
```

## Stage 1: System Output Capture

For each test case in `answer-golden-dataset.json`, run the full pipeline and capture everything the system produces.

**Process:**
- Call hybrid service (`POST /query`, mode=answer) to retrieve passages
- Call `/api/answer` with the retrieved passages
- Capture the full response including `synthesis.sentences` and any citation metadata

**Captured per test case:**

```json
{
  "test_case_id": "ans_001",
  "question": "What role do land value capture mechanisms play in...",
  "retrieved_passages": [
    {
      "doc_id": "doc_000139",
      "chunk_id": "doc_000139_chunk_0",
      "title": "Urban Land Value Capture...",
      "snippet": "...",
      "score": 0.847,
      "page": 1
    }
  ],
  "synthesis": {
    "sentences": ["Sentence 1.", "Sentence 2.", "Sentence 3."],
    "full_text": "Sentence 1. Sentence 2. Sentence 3."
  },
  "citation_traces": [],
  "timestamp": "2026-02-24T...",
  "model": "gpt-4o-mini"
}
```

**Output:** `evaluation/answer-synthesis-raw.json`

**Prerequisites:** Hybrid service on `:8002`, Next.js on `:3000`

## Stage 2: LLM Evaluation (GPT-5.2 thinking)

For each test case, send the question, passages, and synthesis to GPT-5.2 with reasoning enabled. The LLM evaluates the synthesis on 5 dimensions.

### Scoring Dimensions (each 0–1)

| Dimension | What it measures | 0 (bad) | 1 (perfect) |
|-----------|-----------------|---------|-------------|
| **Faithfulness** | Every claim grounded in the provided passages | Hallucinated claims, unsupported assertions | All claims traceable to specific passages |
| **Completeness** | Key information from passages is represented | Misses major findings, ignores relevant passages | Covers the most important information across passages |
| **Conciseness** | Appropriately brief, no filler | Verbose, repetitive, or padded | Every word earns its place; 2-3 sentences as designed |
| **Coherence** | Reads as a unified, well-structured answer | Disjointed list of facts, poor flow | Smooth narrative that synthesizes rather than concatenates |
| **Citation accuracy** | Citation traces correctly map claims to source passages | Citations missing, wrong, or misleading | Each claim cites the correct passage(s) |

### LLM Evaluation Prompt Structure

```
System: You are an expert evaluator assessing the quality of AI-generated
research synthesis. You will be given a research question, the source
passages the AI had access to, and the synthesis it produced.

Score each dimension 0.0–1.0 with one decimal place precision.
Provide qualitative feedback: what's good, what's missing, what's wrong.
If a claim appears unsupported by the passages, flag it specifically.

Respond with JSON (no markdown fencing):
{
  "scores": {
    "faithfulness": 0.0,
    "completeness": 0.0,
    "conciseness": 0.0,
    "coherence": 0.0,
    "citation_accuracy": 0.0
  },
  "qualitative_feedback": "...",
  "flagged_issues": [
    {"type": "unsupported_claim", "text": "...", "detail": "..."},
    {"type": "missing_info", "text": "...", "detail": "..."}
  ],
  "key_facts_extracted": ["fact 1", "fact 2", "..."]
}
```

The `key_facts_extracted` field captures the key factual claims present in the synthesis — these become candidates for `synthesis_ground_truth.key_facts` after human validation.

**Model:** GPT-5.2 with thinking/reasoning enabled (high-quality structured evaluation)

**Output per test case:**

```json
{
  "test_case_id": "ans_001",
  "scores": {
    "faithfulness": 0.8,
    "completeness": 0.7,
    "conciseness": 0.9,
    "coherence": 0.8,
    "citation_accuracy": 0.6
  },
  "qualitative_feedback": "The synthesis captures the main findings about...",
  "flagged_issues": [],
  "key_facts_extracted": ["Land value capture mechanisms include...", "..."],
  "model": "gpt-5.2",
  "reasoning_tokens": 1234
}
```

**Output:** `evaluation/answer-synthesis-llm-eval.json`

## Stage 3: Human Review

Extend the existing review server (`:3001`) with a new route for synthesis evaluation review.

**URL:** `http://localhost:3001/eval/review-synthesis`

### Layout

Single scrollable page, one section per test case. Each section shows:

1. **Question** (header)
2. **Retrieved passages** (collapsible, shows titles + snippets)
3. **System synthesis** (the 2-3 sentence answer, prominently displayed)
4. **LLM evaluation:**
   - 5 dimension scores displayed as a bar/badge row
   - Qualitative feedback
   - Flagged issues (if any) highlighted
   - Extracted key facts listed
5. **Human evaluation:**
   - 5 slider/input controls for human scores (pre-filled with LLM scores)
   - Qualitative feedback text area
   - Checkboxes next to each extracted key fact (confirm/reject)
   - Option to add additional key facts

### Interaction

- Human sees LLM evaluation first, adjusts scores as needed
- Every change autosaves to `answer-synthesis-eval-final.json`
- Summary bar at top: "X/9 reviewed" with average scores across dimensions

### Persistence

Same pattern as label review: autosave on every interaction, reads/writes a JSON file.

**Output:** `evaluation/answer-synthesis-eval-final.json`

```json
{
  "evaluated_at": "2026-02-24T...",
  "system_model": "gpt-4o-mini",
  "evaluator_model": "gpt-5.2",
  "test_cases": [
    {
      "test_case_id": "ans_001",
      "question": "...",
      "synthesis_text": "...",
      "passage_count": 5,
      "llm_eval": {
        "scores": { "faithfulness": 0.8, ... },
        "qualitative_feedback": "...",
        "flagged_issues": [],
        "key_facts_extracted": ["..."]
      },
      "human_eval": {
        "scores": { "faithfulness": 0.9, ... },
        "qualitative_feedback": "...",
        "key_facts_confirmed": ["..."],
        "key_facts_added": ["..."]
      }
    }
  ]
}
```

## Stage 4: Golden Dataset Update

After human review is complete, an assembly step writes back to the golden dataset:

- `synthesis_ground_truth.canonical_answer` ← the system-generated synthesis text (for test cases scoring above a threshold, e.g. avg human score >= 0.7)
- `synthesis_ground_truth.key_facts` ← human-confirmed key facts

This enables regression testing: future changes to the synthesis pipeline can be compared against these validated outputs.

For test cases scoring below threshold, the canonical answer is left empty — the qualitative feedback documents what needs to improve.

## Files

| File | Status | Purpose |
|------|--------|---------|
| `evaluation/run-answer-synthesis-capture.ts` | New | Stage 1: run system, capture outputs |
| `evaluation/run-answer-synthesis-llm-eval.ts` | New | Stage 2: GPT-5.2 evaluation |
| `evaluation/serve-label-review.ts` | Modify | Stage 3: add `/eval/review-synthesis` route |
| `evaluation/assemble-synthesis-ground-truth.ts` | New | Stage 4: write back to golden dataset |
| `evaluation/answer-synthesis-raw.json` | Generated | System outputs |
| `evaluation/answer-synthesis-llm-eval.json` | Generated | LLM scores + feedback |
| `evaluation/answer-synthesis-eval-final.json` | Generated | LLM + human scores |

## CLI Interface

```bash
# Stage 1: Capture system outputs (needs hybrid + Next.js running)
npx tsx evaluation/run-answer-synthesis-capture.ts

# Stage 2: LLM evaluation (needs OPENAI_API_KEY)
npx tsx evaluation/run-answer-synthesis-llm-eval.ts

# Stage 3: Human review
npx tsx evaluation/serve-label-review.ts
# → http://localhost:3001/eval/review-synthesis

# Stage 4: Assemble ground truth
npx tsx evaluation/assemble-synthesis-ground-truth.ts
```

## Relationship to Existing Code

- `run-answer-synthesis-eval.py` (RAGAS-based) becomes supplementary. It can still run against populated `synthesis_ground_truth` for automated regression, but the primary evaluation is this human-in-the-loop pipeline.
- `evaluation/lib/ragas_adapter.py` remains useful for automated regression after ground truth is populated.
- No changes to the retrieval eval pipeline (Track 1).

## Dependencies

- **Track 1 human evals must complete first** — we need the final retrieval ground truth so that system outputs are evaluated against the production retrieval configuration.
- GPT-5.2 API access with thinking/reasoning mode.
- OPENAI_API_KEY environment variable.
