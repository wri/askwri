# Answer Retrieval HTML Report Enhancement

**Date:** 2026-02-15
**Status:** Approved
**Purpose:** Make answer retrieval evaluation reports easier to verify against golden dataset by showing document titles, chunk snippets, and relevance scores

## Problem

Current HTML reports only show chunk IDs (e.g., `doc_000109_chunk_4`). To verify results against the golden set, evaluators need to:
- See the actual text content of retrieved chunks
- Understand which document each chunk came from (title)
- Know the relevance score the system assigned to each chunk
- Compare retrieved snippets against expected golden snippets

## Solution

Enhance HTML reports to display full chunk details in a flat list sorted by relevance score, matching how Answer mode retrieval actually works (chunk-level, not document-level).

## Data Collection Changes

### Current State
`run-answer-retrieval-eval.ts` receives `rawDocs` from the hybrid service with:
- `doc_id`
- `title`
- `content` (text snippet)
- `score`
- `chunk_id`

Currently discards everything except `chunk_id` and `doc_id`.

### New Structure
Extend `RetrievalTestResult` type to include:

```typescript
retrieved_chunks_detail: Array<{
  chunk_id: string;
  doc_id: string;
  title: string;
  snippet: string;
  score: number;
}>;
```

Sort by score descending before saving to JSON.

### Implementation
1. Update `lib/types.ts` to add `retrieved_chunks_detail` field
2. Modify `run-answer-retrieval-eval.ts` to map `rawDocs` to this structure
3. Sort by score before saving to result

## HTML Display Structure

### Layout Per Test Case

**1. Expected Chunks Section (top)**
- Header: "Expected Chunks from Golden Set (N chunks)"
- For each expected passage from golden dataset:
  - Chunk ID badge
  - Text snippet from `expected_passages[].text_snippet`
  - Visual indicator: ✓ green if found in retrieved results, ✗ red if missed

**2. Retrieved Chunks Section (below)**
- Header: "Retrieved Chunks (N chunks, sorted by relevance)"
- Flat list sorted by score (highest first)
- For each chunk:
  - Match indicator icon: ✓ (exact), ~ (adjacent), empty (extra)
  - Score badge: color-coded pill
  - Chunk ID: monospace
  - Document title: in parentheses
  - Text snippet: ~250 chars max, truncated with "..."

## Visual Design

### Score Badge
- Pill shape, fixed width (~60px)
- Colors:
  - Green (≥0.5): `#22c55e` bg, `#166534` text
  - Yellow (0.3-0.5): `#f59e0b` bg, `#92400e` text
  - Gray (<0.3): `#9ca3af` bg, `#374151` text
- Format: "0.XXX" (3 decimals)

### Chunk Cards
- White background, 8px radius, subtle shadow
- Left border: 4px solid (green/blue/gray by match type)
- Padding: 16px
- Margin-bottom: 12px

### Expected Chunks Styling
- Light green background: `#f0fdf4`
- Green ✓ or red ✗ icon
- Slightly smaller font than retrieved

### Text Content
- Snippet: 13px, line-height 1.6, `#374151`
- Chunk ID: 12px monospace, `#6b7280`
- Doc title: 13px regular, `#111827`

## Benefits

1. **Quick verification**: See if golden chunks appear in retrieved list via visual indicators
2. **Debugging**: Understand what was retrieved instead by reading actual content
3. **Semantic comparison**: Compare golden snippets with retrieved snippets to assess similarity
4. **Score transparency**: Understand what the system ranked highest
5. **Context**: Document titles help identify sources without external lookups

## Files Changed

- `evaluation/lib/types.ts` - Add `retrieved_chunks_detail` to `RetrievalTestResult`
- `evaluation/run-answer-retrieval-eval.ts` - Capture and sort chunk details
- `evaluation/generate-answer-report.ts` - Render enhanced HTML with snippets and scores
