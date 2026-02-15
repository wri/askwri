/**
 * Generate human-readable HTML report from answer retrieval evaluation results.
 *
 * Called automatically after eval runs, or standalone:
 *   npx tsx evaluation/generate-answer-report.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RetrievalEvalReport, RetrievalTestResult } from './lib/types';
import type { AnswerGoldenDataset } from './lib/types';

function pct(v: number): string {
  return (v * 100).toFixed(1) + '%';
}

function colorClass(value: number, good: number, medium: number): string {
  if (value >= good) return 'good';
  if (value >= medium) return 'medium';
  return 'bad';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function truncateSnippet(text: string, maxLength: number = 250): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

function generateHtmlReport(report: RetrievalEvalReport, goldenDataPath: string): string {
  let goldenData: AnswerGoldenDataset;
  try {
    goldenData = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));
  } catch (error: any) {
    throw new Error(`Failed to load golden dataset from ${goldenDataPath}: ${error.message}`);
  }
  const timestamp = new Date(report.timestamp).toLocaleString();
  const agg = report.aggregate;

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AskWRI Answer Retrieval Evaluation Report</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .header {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    h1 { margin: 0 0 10px 0; color: #333; }
    h2 { margin-top: 30px; margin-bottom: 15px; }
    .timestamp { color: #666; font-size: 14px; }

    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .metric-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .metric-value {
      font-size: 32px;
      font-weight: bold;
      margin-top: 5px;
    }
    .metric-value.good { color: #22c55e; }
    .metric-value.medium { color: #f59e0b; }
    .metric-value.bad { color: #ef4444; }
    .metric-sub { font-size: 12px; color: #666; margin-top: 5px; }

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

    .section-label {
      font-size: 13px;
      font-weight: 600;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }

    .summary-table {
      width: 100%;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    .summary-table table { width: 100%; border-collapse: collapse; }
    .summary-table th {
      background: #f9fafb;
      padding: 12px;
      text-align: left;
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .summary-table td {
      padding: 12px;
      border-top: 1px solid #e5e7eb;
    }

    .test-case {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 15px;
    }
    .test-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 15px;
    }
    .test-question {
      font-size: 18px;
      font-weight: 600;
      color: #333;
      flex: 1;
    }
    .test-id {
      font-size: 12px;
      color: #666;
      font-family: monospace;
      margin-top: 8px;
    }

    .metric-row {
      display: flex;
      gap: 20px;
      margin-bottom: 10px;
      font-size: 14px;
    }
    .metric-row strong { color: #333; }

    .chunk-section { margin-top: 15px; }
    .chunk-section h4 {
      font-size: 14px;
      margin-bottom: 8px;
      color: #666;
    }
    .chunk-list {
      font-size: 13px;
      line-height: 1.8;
      font-family: monospace;
    }
    .chunk-item { padding: 2px 0; }
    .chunk-item.exact { color: #22c55e; }
    .chunk-item.adjacent { color: #3b82f6; }
    .chunk-item.missed { color: #ef4444; }
    .chunk-item.extra { color: #f59e0b; }

    .doc-tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      margin: 2px;
    }
    .doc-tag.expected { background: #dcfce7; color: #166534; }
    .doc-tag.extra { background: #fef3c7; color: #92400e; }
    .doc-tag.missed { background: #fee2e2; color: #991b1b; }
  </style>
</head>
<body>
  <div class="header">
    <h1>AskWRI Answer Retrieval Evaluation Report</h1>
    <div class="timestamp">Generated: ${timestamp}</div>
    <div class="timestamp">Test cases: ${report.test_cases_total}</div>
  </div>

  <div class="section-label">Doc-Level Metrics (Coarse Grain)</div>
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Doc Precision</div>
      <div class="metric-value ${colorClass(agg.doc.avg_precision, 0.5, 0.25)}">${pct(agg.doc.avg_precision)}</div>
      <div class="metric-sub">Retrieved docs that are relevant</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Doc Recall</div>
      <div class="metric-value ${colorClass(agg.doc.avg_recall, 0.8, 0.6)}">${pct(agg.doc.avg_recall)}</div>
      <div class="metric-sub">Expected docs that were found</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Doc F1</div>
      <div class="metric-value ${colorClass(agg.doc.avg_f1, 0.5, 0.3)}">${pct(agg.doc.avg_f1)}</div>
      <div class="metric-sub">Harmonic mean of P &amp; R</div>
    </div>
  </div>

  <div class="section-label">Chunk-Level Metrics (Strict)</div>
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Chunk Precision</div>
      <div class="metric-value ${colorClass(agg.chunk.avg_precision, 0.3, 0.15)}">${pct(agg.chunk.avg_precision)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Chunk Recall</div>
      <div class="metric-value ${colorClass(agg.chunk.avg_recall, 0.8, 0.6)}">${pct(agg.chunk.avg_recall)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Chunk F1</div>
      <div class="metric-value ${colorClass(agg.chunk.avg_f1, 0.3, 0.15)}">${pct(agg.chunk.avg_f1)}</div>
    </div>
  </div>

  <div class="section-label">Chunk-Level Metrics (Adjacent Tolerance)</div>
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Adj. Precision</div>
      <div class="metric-value ${colorClass(agg.chunk_adjacent.avg_precision, 0.3, 0.15)}">${pct(agg.chunk_adjacent.avg_precision)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Adj. Recall</div>
      <div class="metric-value ${colorClass(agg.chunk_adjacent.avg_recall, 0.8, 0.6)}">${pct(agg.chunk_adjacent.avg_recall)}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Adj. F1</div>
      <div class="metric-value ${colorClass(agg.chunk_adjacent.avg_f1, 0.3, 0.15)}">${pct(agg.chunk_adjacent.avg_f1)}</div>
    </div>
  </div>
`;

  // Summary by query type table
  if (Object.keys(report.summary_by_query_type).length > 0) {
    html += `
  <h2>Summary by Query Type</h2>
  <div class="summary-table">
    <table>
      <thead>
        <tr>
          <th>Query Type</th>
          <th>Count</th>
          <th>Doc P / R / F1</th>
          <th>Chunk P / R / F1</th>
          <th>Adj. P / R / F1</th>
        </tr>
      </thead>
      <tbody>
`;
    for (const [type, stats] of Object.entries(report.summary_by_query_type) as [string, any][]) {
      html += `
        <tr>
          <td><strong>${type.replace(/_/g, ' ')}</strong></td>
          <td>${stats.count}</td>
          <td>${pct(stats.doc.avg_precision)} / ${pct(stats.doc.avg_recall)} / ${pct(stats.doc.avg_f1)}</td>
          <td>${pct(stats.chunk.avg_precision)} / ${pct(stats.chunk.avg_recall)} / ${pct(stats.chunk.avg_f1)}</td>
          <td>${pct(stats.chunk_adjacent.avg_precision)} / ${pct(stats.chunk_adjacent.avg_recall)} / ${pct(stats.chunk_adjacent.avg_f1)}</td>
        </tr>
`;
    }
    html += `
      </tbody>
    </table>
  </div>
`;
  }

  // Individual test cases
  html += `\n  <h2>Test Case Results</h2>\n`;

  for (const r of report.results) {
    const testCase = goldenData.test_cases.find(tc => tc.id === r.test_case_id);

    const expectedSet = new Set(r.expected_chunk_ids);
    const retrievedSet = new Set(r.retrieved_chunk_ids);
    const exactSet = new Set(r.exact_matches);
    const adjSet = new Set(r.adjacent_matches);

    const expectedDocSet = new Set(r.expected_doc_ids);
    const retrievedDocSet = new Set(r.retrieved_doc_ids);
    const matchedDocs = r.retrieved_doc_ids.filter(d => expectedDocSet.has(d));
    const extraDocs = r.retrieved_doc_ids.filter(d => !expectedDocSet.has(d));
    const missedDocs = r.expected_doc_ids.filter(d => !retrievedDocSet.has(d));

    const missedChunks = r.expected_chunk_ids.filter(c => !retrievedSet.has(c) && !adjSet.has(c));

    html += `
  <div class="test-case">
    <div class="test-header">
      <div style="flex: 1;">
        <div class="test-question">${escapeHtml(r.question)}</div>
        <div class="test-id">${escapeHtml(r.test_case_id)}</div>
      </div>
    </div>

    <div class="metric-row">
      <div><strong>Doc:</strong> P=${pct(r.doc_precision)} R=${pct(r.doc_recall)} F1=${pct(r.doc_f1)}</div>
      <div><strong>Chunk:</strong> P=${pct(r.chunk_precision)} R=${pct(r.chunk_recall)} F1=${pct(r.chunk_f1)}</div>
      <div><strong>Adj:</strong> P=${pct(r.chunk_precision_adjacent)} R=${pct(r.chunk_recall_adjacent)} F1=${pct(r.chunk_f1_adjacent)}</div>
      <div><strong>Time:</strong> ${(r.execution_time_ms / 1000).toFixed(2)}s</div>
    </div>
`;

    if (testCase && testCase.retrieval_ground_truth.expected_passages.length > 0) {
      html += `
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
          <span class="expected-chunk-id">${escapeHtml(passage.chunk_id)}</span>
        </div>
        <div class="expected-snippet">${escapeHtml(truncateSnippet(passage.text_snippet))}</div>
      </div>
`;
      }

      html += `
    </div>
`;
    }

    html += `
    <div class="chunk-section">
      <h4>Documents (${matchedDocs.length} matched, ${extraDocs.length} extra, ${missedDocs.length} missed)</h4>
      <div>
${matchedDocs.map(d => `        <span class="doc-tag expected">${escapeHtml(d)}</span>`).join('\n')}
${extraDocs.map(d => `        <span class="doc-tag extra">${escapeHtml(d)}</span>`).join('\n')}
${missedDocs.map(d => `        <span class="doc-tag missed">${escapeHtml(d)}</span>`).join('\n')}
      </div>
    </div>
`;

    if (r.exact_matches.length > 0) {
      html += `
    <div class="chunk-section">
      <h4>Exact Chunk Matches (${r.exact_matches.length})</h4>
      <div class="chunk-list">
${r.exact_matches.map(c => `        <div class="chunk-item exact">${escapeHtml(c)}</div>`).join('\n')}
      </div>
    </div>
`;
    }

    if (r.adjacent_matches.length > 0) {
      html += `
    <div class="chunk-section">
      <h4>Adjacent Chunk Matches (${r.adjacent_matches.length})</h4>
      <div class="chunk-list">
${r.adjacent_matches.map(c => `        <div class="chunk-item adjacent">${escapeHtml(c)}</div>`).join('\n')}
      </div>
    </div>
`;
    }

    if (missedChunks.length > 0) {
      html += `
    <div class="chunk-section">
      <h4>Missed Chunks (${missedChunks.length})</h4>
      <div class="chunk-list">
${missedChunks.map(c => `        <div class="chunk-item missed">${escapeHtml(c)}</div>`).join('\n')}
      </div>
    </div>
`;
    }

    if (r.error) {
      html += `
    <div class="chunk-section">
      <h4>Error</h4>
      <div style="color: #ef4444; font-family: monospace; font-size: 13px;">${escapeHtml(r.error)}</div>
    </div>
`;
    }

    html += `  </div>\n`;
  }

  html += `</body>\n</html>`;
  return html;
}

// --- Standalone runner ---

function findLatestReport(): string | null {
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) return null;

  const files = fs.readdirSync(resultsDir)
    .filter(f => f.startsWith('answer-retrieval-') && f.endsWith('.json'))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(resultsDir, files[0]) : null;
}

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

if (require.main === module) {
  generateLatestReport();
}

export { generateHtmlReport };
