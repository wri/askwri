# Answer Retrieval HTML Report Enhancement - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance answer retrieval HTML reports to show document titles, chunk text snippets, and relevance scores sorted by score to enable easier verification against golden dataset.

**Architecture:** Extend data collection in eval runner to preserve title/snippet/score from raw service response, pass through JSON results, and render enhanced HTML with two sections: expected chunks (from golden set) and retrieved chunks (sorted by score).

**Tech Stack:** TypeScript, HTML/CSS (no JS needed for this enhancement)

---

## Task 1: Update Type Definitions

**Files:**
- Modify: `evaluation/lib/types.ts:38-62`

**Step 1: Add retrieved_chunks_detail to RetrievalTestResult**

Add new field after line 59 (after `adjacent_matches`):

```typescript
export interface RetrievalTestResult {
  test_case_id: string;
  question: string;
  // Chunk-level metrics (strict)
  chunk_precision: number;
  chunk_recall: number;
  chunk_f1: number;
  // Chunk-level metrics (with adjacent tolerance)
  chunk_precision_adjacent: number;
  chunk_recall_adjacent: number;
  chunk_f1_adjacent: number;
  // Doc-level metrics (coarse grain)
  doc_precision: number;
  doc_recall: number;
  doc_f1: number;
  // Details
  expected_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  expected_doc_ids: string[];
  retrieved_doc_ids: string[];
  exact_matches: string[];
  adjacent_matches: string[];
  retrieved_chunks_detail: Array<{
    chunk_id: string;
    doc_id: string;
    title: string;
    snippet: string;
    score: number;
  }>;
  execution_time_ms: number;
  error?: string;
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit type changes**

```bash
git add evaluation/lib/types.ts
git commit -m "feat(evals): add retrieved_chunks_detail to RetrievalTestResult type"
```

---

## Task 2: Capture Chunk Details in Eval Runner

**Files:**
- Modify: `evaluation/run-answer-retrieval-eval.ts:48-95`

**Step 1: Build retrieved_chunks_detail array**

After line 56 (after `retrievedDocIds`), add:

```typescript
    // Build detailed chunk info sorted by score
    const retrievedChunksDetail = rawDocs
      .map(d => ({
        chunk_id: d.metadata?.chunk_id || d.chunk_id || 'unknown',
        doc_id: d.doc_id,
        title: d.title,
        snippet: d.content,
        score: d.score,
      }))
      .sort((a, b) => b.score - a.score); // Sort descending by score
```

**Step 2: Add field to return statement**

In the return statement around line 76, add `retrieved_chunks_detail` after `adjacent_matches`:

```typescript
    return {
      test_case_id: tc.id,
      question: tc.question,
      chunk_precision: chunkMetrics.precision,
      chunk_recall: chunkMetrics.recall,
      chunk_f1: chunkMetrics.f1,
      chunk_precision_adjacent: chunkMetrics.precision_with_adjacent,
      chunk_recall_adjacent: chunkMetrics.recall_with_adjacent,
      chunk_f1_adjacent: chunkMetrics.f1_with_adjacent,
      doc_precision: docMetrics.precision,
      doc_recall: docMetrics.recall,
      doc_f1: docMetrics.f1,
      expected_chunk_ids: expectedChunks.map(c => c.chunk_id),
      retrieved_chunk_ids: retrievedChunks.map(c => c.chunk_id),
      expected_doc_ids: expectedDocIds,
      retrieved_doc_ids: retrievedDocIds,
      exact_matches: chunkMetrics.exact_matches,
      adjacent_matches: chunkMetrics.adjacent_matches,
      retrieved_chunks_detail: retrievedChunksDetail,
      execution_time_ms: elapsed,
    };
```

**Step 3: Add field to error return**

In the error catch block around line 104, add empty array:

```typescript
      retrieved_chunks_detail: [],
```

**Step 4: Test data collection**

Run: `npm run eval:answer-retrieval`
Expected: JSON output includes `retrieved_chunks_detail` with title, snippet, score

**Step 5: Verify JSON structure**

Run: `jq '.results[0].retrieved_chunks_detail[0]' evaluation/results/answer-retrieval-*.json | tail -n 20`
Expected: Shows object with chunk_id, doc_id, title, snippet, score

**Step 6: Commit data collection changes**

```bash
git add evaluation/run-answer-retrieval-eval.ts
git commit -m "feat(evals): capture chunk titles, snippets, and scores in results"
```

---

## Task 3: Load Golden Dataset in Report Generator

**Files:**
- Modify: `evaluation/generate-answer-report.ts:1-10`

**Step 1: Import golden dataset type**

Add to imports at top:

```typescript
import type { RetrievalEvalReport, RetrievalTestResult } from './lib/types';
import type { AnswerGoldenDataset } from './lib/types';
```

**Step 2: Load golden dataset in generateHtmlReport**

Modify `generateHtmlReport` function signature and add loading logic at start:

```typescript
function generateHtmlReport(report: RetrievalEvalReport, goldenDataPath: string): string {
  const goldenData: AnswerGoldenDataset = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));
```

**Step 3: Update caller in generateLatestReport**

Around line 385, pass golden data path:

```typescript
function generateLatestReport() {
  const reportPath = findLatestReport();
  if (!reportPath) {
    console.error('No answer retrieval reports found in evaluation/results/');
    process.exit(1);
  }

  console.log(`Generating HTML report from: ${reportPath}`);

  const report: RetrievalEvalReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const goldenDataPath = path.join(__dirname, 'answer-golden-dataset.json');
  const html = generateHtmlReport(report, goldenDataPath);

  const htmlPath = reportPath.replace('.json', '.html');
  fs.writeFileSync(htmlPath, html);

  console.log(`HTML report generated: ${htmlPath}`);
  console.log(`Open in browser: file://${htmlPath}`);
}
```

**Step 4: Update run-answer-retrieval-eval.ts caller**

Modify around line 226 to pass golden path:

```typescript
  // Generate HTML report
  const htmlPath = reportPath.replace('.json', '.html');
  const goldenDataPath = path.join(__dirname, 'answer-golden-dataset.json');
  fs.writeFileSync(htmlPath, generateHtmlReport(report, goldenDataPath));
  console.log(`HTML report: ${htmlPath}`);
```

**Step 5: Export type from generate-answer-report**

Update export at bottom:

```typescript
export { generateHtmlReport };
```

**Step 6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit golden dataset loading**

```bash
git add evaluation/generate-answer-report.ts evaluation/run-answer-retrieval-eval.ts
git commit -m "feat(evals): load golden dataset in report generator"
```

---

## Task 4: Add CSS Styles for Enhanced Display

**Files:**
- Modify: `evaluation/generate-answer-report.ts:52-206` (style section)

**Step 1: Add expected chunks styles**

Add after `.metric-sub` style (around line 75):

```css
    .expected-section {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    .expected-section h3 {
      margin: 0 0 15px 0;
      font-size: 16px;
      color: #333;
    }
    .expected-chunk {
      background: #f0fdf4;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 10px;
      border-left: 4px solid #22c55e;
    }
    .expected-chunk.missed {
      border-left-color: #ef4444;
      background: #fef2f2;
    }
    .expected-chunk-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .match-icon {
      font-size: 16px;
      font-weight: bold;
    }
    .match-icon.found { color: #22c55e; }
    .match-icon.missed { color: #ef4444; }
    .expected-chunk-id {
      font-family: monospace;
      font-size: 11px;
      color: #6b7280;
    }
    .expected-snippet {
      font-size: 12px;
      line-height: 1.6;
      color: #374151;
    }
```

**Step 2: Add retrieved chunks styles**

Continue adding after expected styles:

```css
    .retrieved-section {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    .retrieved-section h3 {
      margin: 0 0 15px 0;
      font-size: 16px;
      color: #333;
    }
    .chunk-card {
      background: white;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      border-left: 4px solid #9ca3af;
    }
    .chunk-card.exact-match {
      border-left-color: #22c55e;
    }
    .chunk-card.adjacent-match {
      border-left-color: #3b82f6;
    }
    .chunk-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .match-indicator {
      font-size: 14px;
      font-weight: bold;
      min-width: 20px;
    }
    .match-indicator.exact { color: #22c55e; }
    .match-indicator.adjacent { color: #3b82f6; }
    .score-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      min-width: 60px;
      text-align: center;
    }
    .score-badge.high {
      background: #22c55e;
      color: #166534;
    }
    .score-badge.medium {
      background: #f59e0b;
      color: #92400e;
    }
    .score-badge.low {
      background: #9ca3af;
      color: #374151;
    }
    .chunk-id {
      font-family: monospace;
      font-size: 12px;
      color: #6b7280;
    }
    .doc-title {
      font-size: 13px;
      color: #111827;
    }
    .chunk-snippet {
      font-size: 13px;
      line-height: 1.6;
      color: #374151;
      margin-top: 8px;
    }
```

**Step 3: Verify CSS compiles in HTML**

No test needed - will verify in next task when rendering HTML

**Step 4: Commit CSS changes**

```bash
git add evaluation/generate-answer-report.ts
git commit -m "feat(evals): add CSS for expected and retrieved chunk displays"
```

---

## Task 5: Render Expected Chunks Section

**Files:**
- Modify: `evaluation/generate-answer-report.ts` (inside test case loop, ~line 330)

**Step 1: Add helper function for snippet truncation**

Add before `generateHtmlReport` function:

```typescript
function truncateSnippet(text: string, maxLength: number = 250): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}
```

**Step 2: Add expected chunks section rendering**

Inside the test case loop (after `<div class="test-case">` and before retrieved docs section), add:

```typescript
  for (const r of report.results) {
    const testCase = goldenData.test_cases.find(tc => tc.id === r.test_case_id);
    if (!testCase) continue;

    const expectedSet = new Set(r.expected_chunk_ids);
    const retrievedSet = new Set(r.retrieved_chunk_ids);
    const exactSet = new Set(r.exact_matches);
    const adjSet = new Set(r.adjacent_matches);

    html += `
  <div class="test-case">
    <div class="test-header">
      <div style="flex: 1;">
        <div class="test-question">${r.question}</div>
        <div class="test-id">${r.test_case_id}</div>
      </div>
    </div>

    <div class="metric-row">
      <div><strong>Doc:</strong> P=${pct(r.doc_precision)} R=${pct(r.doc_recall)} F1=${pct(r.doc_f1)}</div>
      <div><strong>Chunk:</strong> P=${pct(r.chunk_precision)} R=${pct(r.chunk_recall)} F1=${pct(r.chunk_f1)}</div>
      <div><strong>Adj:</strong> P=${pct(r.chunk_precision_adjacent)} R=${pct(r.chunk_recall_adjacent)} F1=${pct(r.chunk_f1_adjacent)}</div>
      <div><strong>Time:</strong> ${(r.execution_time_ms / 1000).toFixed(2)}s</div>
    </div>

    <div class="expected-section">
      <h3>Expected Chunks from Golden Set (${testCase.retrieval_ground_truth.expected_passages.length} chunks)</h3>
`;

    for (const passage of testCase.retrieval_ground_truth.expected_passages) {
      const wasFound = retrievedSet.has(passage.chunk_id) || adjSet.has(passage.chunk_id);
      const chunkClass = wasFound ? 'expected-chunk' : 'expected-chunk missed';
      const icon = wasFound ? '<span class="match-icon found">✓</span>' : '<span class="match-icon missed">✗</span>';

      html += `
      <div class="${chunkClass}">
        <div class="expected-chunk-header">
          ${icon}
          <span class="expected-chunk-id">${passage.chunk_id}</span>
        </div>
        <div class="expected-snippet">${passage.text_snippet}</div>
      </div>
`;
    }

    html += `
    </div>
`;
```

**Step 3: Test expected chunks rendering**

Run: `npm run eval:answer-report`
Expected: HTML shows expected chunks section with green ✓ or red ✗

**Step 4: Open HTML in browser and verify**

Run: `open evaluation/results/answer-retrieval-*.html` (or check manually)
Expected: See expected chunks with snippets and match indicators

**Step 5: Commit expected chunks rendering**

```bash
git add evaluation/generate-answer-report.ts
git commit -m "feat(evals): render expected chunks section with golden snippets"
```

---

## Task 6: Render Retrieved Chunks Section

**Files:**
- Modify: `evaluation/generate-answer-report.ts` (continue in test case loop)

**Step 1: Add retrieved chunks section**

After the expected chunks `</div>`, add:

```typescript
    html += `
    <div class="retrieved-section">
      <h3>Retrieved Chunks (${r.retrieved_chunks_detail.length} chunks, sorted by relevance)</h3>
`;

    for (const chunk of r.retrieved_chunks_detail) {
      const isExact = exactSet.has(chunk.chunk_id);
      const isAdjacent = adjSet.has(chunk.chunk_id);

      let cardClass = 'chunk-card';
      let matchIndicator = '';

      if (isExact) {
        cardClass += ' exact-match';
        matchIndicator = '<span class="match-indicator exact">✓</span>';
      } else if (isAdjacent) {
        cardClass += ' adjacent-match';
        matchIndicator = '<span class="match-indicator adjacent">~</span>';
      }

      // Score badge color
      let scoreClass = 'score-badge low';
      if (chunk.score >= 0.5) scoreClass = 'score-badge high';
      else if (chunk.score >= 0.3) scoreClass = 'score-badge medium';

      html += `
      <div class="${cardClass}">
        <div class="chunk-header">
          ${matchIndicator}
          <span class="${scoreClass}">${chunk.score.toFixed(3)}</span>
          <span class="chunk-id">${chunk.chunk_id}</span>
          <span class="doc-title">(${chunk.title})</span>
        </div>
        <div class="chunk-snippet">${truncateSnippet(chunk.snippet)}</div>
      </div>
`;
    }

    html += `
    </div>
  </div>
`;
  }
```

**Step 2: Remove old chunk display code**

Delete the old chunk/doc sections that showed just IDs (starting around line 290 in original). Keep only the new sections.

**Step 3: Test full rendering**

Run: `npm run eval:answer-retrieval`
Expected: New eval creates HTML with both expected and retrieved sections

**Step 4: Verify in browser**

Open HTML and check:
- Expected chunks show at top with ✓/✗ and golden snippets
- Retrieved chunks sorted by score (highest first)
- Score badges color-coded
- Match indicators (✓ ~) on retrieved chunks
- Document titles in parentheses
- Snippets truncated to ~250 chars

**Step 5: Commit retrieved chunks rendering**

```bash
git add evaluation/generate-answer-report.ts
git commit -m "feat(evals): render retrieved chunks with scores, titles, and snippets"
```

---

## Task 7: Final Testing and Cleanup

**Files:**
- Test: `evaluation/run-answer-retrieval-eval.ts`
- Test: `evaluation/generate-answer-report.ts`

**Step 1: Run full eval**

Run: `npm run eval:answer-retrieval`
Expected: Completes successfully, generates both JSON and HTML

**Step 2: Verify JSON structure**

Run: `jq '.results[0] | {test_case_id, retrieved_chunks_count: (.retrieved_chunks_detail | length), first_chunk: .retrieved_chunks_detail[0]}' evaluation/results/answer-retrieval-*.json | tail -n 15`
Expected: Shows retrieved_chunks_detail with title, snippet, score

**Step 3: Verify HTML report**

Open latest HTML report in browser and verify:
- [ ] Expected chunks section at top
- [ ] Golden snippets visible
- [ ] ✓/✗ indicators on expected chunks
- [ ] Retrieved chunks sorted by score (descending)
- [ ] Score badges color-coded correctly
- [ ] Match indicators (✓ ~) on retrieved
- [ ] Document titles in parentheses
- [ ] Snippets truncated appropriately

**Step 4: Test standalone report generator**

Run: `npm run eval:answer-report`
Expected: Regenerates HTML from latest JSON successfully

**Step 5: Verify types are correct**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 6: Clean up any temporary test files**

Run: `git status`
Expected: Only expected changes in git status

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat(evals): complete answer retrieval HTML enhancement

- Add expected chunks section with golden snippets
- Show retrieved chunks sorted by relevance score
- Display document titles, chunk snippets, and scores
- Color-coded score badges and match indicators
- Enable easier verification against golden dataset"
```

**Step 8: Verify all tests pass (if any exist)**

Run: `npm test` (if applicable)
Expected: All tests pass

---

## Verification Checklist

After completing all tasks, verify:

- [ ] Types compile without errors
- [ ] Eval runner captures title, snippet, score
- [ ] JSON output includes retrieved_chunks_detail
- [ ] HTML shows expected chunks with golden snippets
- [ ] HTML shows retrieved chunks sorted by score
- [ ] Score badges color-coded (green/yellow/gray)
- [ ] Match indicators (✓ ~ ) display correctly
- [ ] Document titles appear in parentheses
- [ ] Snippets truncated to ~250 chars
- [ ] Both `npm run eval:answer-retrieval` and `npm run eval:answer-report` work
- [ ] All changes committed with descriptive messages

## Notes

- No tests exist for HTML generation, so manual browser verification is required
- Golden dataset is currently a stub with 2 test cases - enhancement works with any size dataset
- Score sorting happens in data collection (Task 2) to ensure JSON is also sorted
- HTML requires no JavaScript - all functionality is static CSS
