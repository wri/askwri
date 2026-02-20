# Answer Mode Golden Set Generation — Design

**Date:** 2026-02-20
**Status:** Approved
**Scope:** Retrieval ground truth only (Track 1). Synthesis ground truth (Track 2) deferred.

## Problem

The answer mode golden dataset (`answer-golden-dataset.json`) contains 2 stub test cases — enough to prove the eval machinery works, but not enough for meaningful retrieval quality measurement. We need 20–30 validated test cases with real chunk-level and doc-level ground truth from the current index.

## Approach: Chunk-First Pipeline

Rather than generating passages from full documents and mapping them back to chunks (fragile), we query the live hybrid service to get real chunks, then label which ones are true positives. This guarantees chunk_ids exist in the index and text_snippets are verbatim.

### Pipeline Phases

```
Question Bank → Live Retrieval → LLM Labeling → Human Review → Assembly
     (1)             (2)             (3)            (3b)          (4)
```

## Phase 1: Question Bank

**File:** `evaluation/answer-question-bank.json`

```json
{
  "questions": [
    {
      "id": "ans_001",
      "question": "What role do land value capture mechanisms play in more equitable urban development?",
      "query_type": "mechanism_role",
      "difficulty": "medium",
      "source": "human"
    }
  ]
}
```

**Scale:** Start with ~10 questions. 9 human-written anchor questions provided by domain experts, supplemented by LLM-generated questions seeded from corpus themes to fill query type gaps.

**Question characteristics:** Answer-mode queries are more specific than cite-mode queries. They demand multi-document synthesis — a single question should surface relevant chunks from 2–4 different documents.

**Query types:**
- `mechanism_role` — "What role does X play in Y?"
- `causal` — "Are denser cities more sustainable? Why?"
- `policy_integration` — "How can governments integrate X into Y?"
- `intervention_design` — "How do we improve X?"
- `financing` — "How can cities pay for X?"
- `conceptual` — "What are X and how can they improve Y?"
- `impact_assessment` — "How does X affect Y?"
- `opportunity_identification` — "What are key opportunities for X?"

**Difficulty levels:** `easy` (single-doc answer likely), `medium` (2–3 docs needed), `hard` (cross-cutting synthesis across 4+ docs).

The question bank is a separate file so it can be edited directly and the pipeline re-run without regenerating questions.

## Phase 2: Live Retrieval

For each question, call the hybrid service with the same parameters the real Answer mode uses.

**Service call:**
- Endpoint: `POST /query` via existing `callPythonService()`
- Mode: `answer`
- Params: `vector_top_k: 150`, `bm25_top_k: 150`, `rerank_top_n: 10` (ANSWER_PRESET, capped to top 10 for review)

**Captured per chunk:** `chunk_id`, `doc_id`, `title`, `content` (full chunk text), `score` (reranker score), `page`.

**Output:** `evaluation/answer-retrieval-raw.json`

```json
{
  "retrieved_at": "2026-02-20T...",
  "questions": [
    {
      "id": "ans_001",
      "question": "What role do land value capture...",
      "retrieved_chunks": [
        {
          "chunk_id": "chunk_abc_123",
          "doc_id": "doc_000017",
          "title": "Land Value Capture...",
          "content": "full chunk text...",
          "score": 0.847,
          "page": 12
        }
      ]
    }
  ]
}
```

Saving the intermediate allows re-labeling without re-querying the service.

**Prerequisite:** Hybrid service running on `:8002`.

## Phase 3: LLM Labeling

For each question, send all 10 retrieved chunks in a single LLM call. The LLM labels each chunk:

- **Relevance label:** `relevant` / `partially_relevant` / `not_relevant`
- **Confidence:** `high` / `medium` / `low`
- **Rationale:** 1 sentence (aids human review)

Batching all chunks per question in one call is cheaper, faster, and gives the LLM context to distinguish "adds new information" from "redundant with another chunk."

**LLM choice:** Anthropic or OpenAI API (whichever key is in the environment). Labeling is straightforward classification.

**Output:** `evaluation/answer-labels-review.json`

```json
{
  "labeled_at": "2026-02-20T...",
  "questions": [
    {
      "id": "ans_001",
      "question": "What role do land value capture...",
      "chunks": [
        {
          "chunk_id": "chunk_abc_123",
          "doc_id": "doc_000017",
          "label": "relevant",
          "confidence": "high",
          "rationale": "Directly discusses LVC mechanisms in São Paulo context",
          "human_override": null
        }
      ]
    }
  ]
}
```

### Phase 3b: Human Review UI

A web page served on the dev server for reviewers to validate and override LLM labels.

**URL:** `http://localhost:3001/eval/review-labels`

**Layout:**
- Single scrollable page, one collapsible section per question
- Each section shows ~10 chunk cards
- "Needs review" badge on questions with low/medium confidence labels

**Per-chunk card:**
- Doc title, reranker score, page number
- Full chunk text (collapsible — truncated by default, expand to read)
- LLM label, confidence, rationale (muted text)
- Three buttons: **Relevant** / **Partial** / **Not Relevant** — pre-selected to LLM's label, click to override

**Sections within each question:**
- **Needs Review** (expanded by default) — medium/low confidence chunks
- **Auto-labeled** (collapsed by default) — high confidence chunks for spot-checking

**Persistence:** Autosave on every label click. No save button. Reviewer can close the browser and come back — progress is persisted to `answer-labels-review.json`.

## Phase 4: Assembly

Reads `answer-labels-review.json` with human overrides applied. For each chunk, the final label is `human_override` if set, otherwise the LLM label.

**Label → ground truth mapping:**
- `relevant` → included in `expected_passages` AND `expected_doc_ids`
- `partially_relevant` → included in `expected_doc_ids` only (doc-level, not chunk-level)
- `not_relevant` → excluded

**Output:** Overwrites `evaluation/answer-golden-dataset.json`

```json
{
  "version": "2.0",
  "description": "Answer mode golden set - chunk-first, human-validated",
  "metadata": {
    "status": "production",
    "generated_at": "2026-02-20T...",
    "question_count": 10,
    "labeling_method": "llm_assisted_human_override"
  },
  "test_cases": [
    {
      "id": "ans_001",
      "question": "What role do land value capture...",
      "query_type": "mechanism_role",
      "difficulty": "medium",
      "retrieval_ground_truth": {
        "expected_passages": [
          {
            "doc_id": "doc_000017",
            "chunk_id": "chunk_abc_123",
            "page": 12,
            "text_snippet": "full chunk content stored verbatim"
          }
        ],
        "expected_doc_ids": ["doc_000017", "doc_000045", "doc_000092"]
      },
      "synthesis_ground_truth": {
        "canonical_answer": "",
        "key_facts": []
      }
    }
  ]
}
```

**Key details:**
- `text_snippet` stores the full chunk content verbatim (chunks are ~400 tokens; no truncation)
- `expected_doc_ids` is the superset of docs from both `relevant` and `partially_relevant` chunks
- `synthesis_ground_truth` left empty (deferred to Track 2)
- Schema matches the existing `AnswerGoldenDataset` type — eval runner works with zero changes

**Validation:** Assembly warns if any question has zero relevant chunks (bad question) or all chunks are relevant (suspiciously easy).

## CLI Interface

```bash
# Full pipeline
npx tsx evaluation/generate-answer-golden-set.ts

# Individual phases
npx tsx evaluation/generate-answer-golden-set.ts --phase retrieve
npx tsx evaluation/generate-answer-golden-set.ts --phase label
npx tsx evaluation/generate-answer-golden-set.ts --phase assemble

# Review server
npx tsx evaluation/serve-label-review.ts
# → http://localhost:3001/eval/review-labels
```

**Environment variables:**
- `LLAMAINDEX_SERVICE_URL` — hybrid service (default `http://127.0.0.1:8002`)
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` — for LLM labeling phase

## Files

| File | Status | Purpose |
|------|--------|---------|
| `evaluation/answer-question-bank.json` | New | Input questions |
| `evaluation/answer-retrieval-raw.json` | New | Intermediate retrieval results |
| `evaluation/answer-labels-review.json` | New | Labels + human overrides |
| `evaluation/generate-answer-golden-set.ts` | New | Pipeline script |
| `evaluation/serve-label-review.ts` | New | Review UI server |
| `evaluation/answer-golden-dataset.json` | Existing | Final output (overwritten) |

No changes to the existing eval runner, types, metrics, or report generator.

## End-to-End Workflow

1. Edit `answer-question-bank.json` (9 human questions pre-loaded)
2. Run `--phase retrieve` (needs hybrid service)
3. Run `--phase label` (needs LLM API key)
4. Reviewer opens review UI, labels flagged chunks
5. Run `--phase assemble` → produces final `answer-golden-dataset.json`
6. Run `npm run eval:answer-retrieval` → existing eval against new golden set
