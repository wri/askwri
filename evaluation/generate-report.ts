/**
 * Generate human-readable HTML report from evaluation results
 */

import * as fs from 'fs';
import * as path from 'path';

interface TestResult {
  test_case_id: string;
  question: string;
  task_description: string;
  expected_count: number;
  retrieved_count: number;
  expected_urls: string[];
  retrieved_urls: string[];
  matched_urls: string[];
  precision: number;
  recall: number;
  f1: number;
  false_positives: string[];
  false_negatives: string[];
  execution_time_ms: number;
  error?: string;
}

interface EvalReport {
  timestamp: string;
  test_cases_total: number;
  test_cases_passed: number;
  test_cases_failed: number;
  overall_precision: number;
  overall_recall: number;
  overall_f1: number;
  results: TestResult[];
  summary_by_query_type: Record<string, any>;
}

function generateHtmlReport(report: EvalReport): string {
  const timestamp = new Date(report.timestamp).toLocaleString();

  // Recalculate pass count based on current thresholds (75% recall, 15% precision, 25% F1)
  const actualPassedCount = report.results.filter(r => r.recall >= 0.75 && r.precision >= 0.15 && r.f1 >= 0.25).length;
  const passRate = (actualPassedCount / report.test_cases_total * 100).toFixed(1);

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>AskWRI Cite Mode Evaluation Report</title>
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
    h1 {
      margin: 0 0 10px 0;
      color: #333;
    }
    .timestamp {
      color: #666;
      font-size: 14px;
    }
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
    }
    .test-metrics {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
    }
    .test-metric {
      font-size: 14px;
    }
    .test-metric strong {
      color: #333;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge.pass { background: #dcfce7; color: #166534; }
    .badge.fail { background: #fee2e2; color: #991b1b; }

    .url-section {
      margin-top: 15px;
    }
    .url-section h4 {
      font-size: 14px;
      margin-bottom: 8px;
      color: #666;
    }
    .url-list {
      font-size: 13px;
      line-height: 1.8;
    }
    .url-item {
      padding: 4px 0;
      word-break: break-all;
    }
    .url-item.matched { color: #22c55e; }
    .url-item.missed { color: #ef4444; }
    .url-item.extra { color: #f59e0b; }

    .summary-table {
      width: 100%;
      background: white;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 20px;
    }
    .summary-table table {
      width: 100%;
      border-collapse: collapse;
    }
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

    .progress-bar {
      height: 8px;
      background: #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 10px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #22c55e, #16a34a);
      transition: width 0.3s;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎯 AskWRI Cite Mode Evaluation Report</h1>
    <div class="timestamp">Generated: ${timestamp}</div>
  </div>

  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Pass Rate</div>
      <div class="metric-value ${report.overall_f1 >= 0.25 ? 'good' : report.overall_f1 >= 0.18 ? 'medium' : 'bad'}">${passRate}%</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${passRate}%"></div>
      </div>
    </div>

    <div class="metric-card">
      <div class="metric-label">Precision</div>
      <div class="metric-value ${report.overall_precision >= 0.15 ? 'good' : report.overall_precision >= 0.10 ? 'medium' : 'bad'}">${(report.overall_precision * 100).toFixed(1)}%</div>
      <div style="font-size: 12px; color: #666; margin-top: 5px;">Retrieved docs that are correct</div>
    </div>

    <div class="metric-card">
      <div class="metric-label">Recall</div>
      <div class="metric-value ${report.overall_recall >= 0.75 ? 'good' : report.overall_recall >= 0.60 ? 'medium' : 'bad'}">${(report.overall_recall * 100).toFixed(1)}%</div>
      <div style="font-size: 12px; color: #666; margin-top: 5px;">Expected docs that were found</div>
    </div>

    <div class="metric-card">
      <div class="metric-label">F1 Score</div>
      <div class="metric-value ${report.overall_f1 >= 0.25 ? 'good' : report.overall_f1 >= 0.18 ? 'medium' : 'bad'}">${(report.overall_f1 * 100).toFixed(1)}%</div>
      <div style="font-size: 12px; color: #666; margin-top: 5px;">Harmonic mean of P & R</div>
    </div>
  </div>

  <div class="summary-table">
    <table>
      <thead>
        <tr>
          <th>Query Type</th>
          <th>Test Cases</th>
          <th>Avg Precision</th>
          <th>Avg Recall</th>
          <th>Avg F1</th>
        </tr>
      </thead>
      <tbody>
`;

  for (const [type, stats] of Object.entries(report.summary_by_query_type)) {
    html += `
        <tr>
          <td><strong>${type.replace(/_/g, ' ')}</strong></td>
          <td>${stats.count}</td>
          <td>${(stats.avg_precision * 100).toFixed(1)}%</td>
          <td>${(stats.avg_recall * 100).toFixed(1)}%</td>
          <td>${(stats.avg_f1 * 100).toFixed(1)}%</td>
        </tr>
`;
  }

  html += `
      </tbody>
    </table>
  </div>

  <h2 style="margin-top: 30px; margin-bottom: 15px;">Test Case Results</h2>
`;

  for (const result of report.results) {
    // Cite mode thresholds: 75% recall, 15% precision, 25% F1
    const isPassing = result.recall >= 0.75 && result.precision >= 0.15 && result.f1 >= 0.25;
    const badge = isPassing ? '<span class="badge pass">✓ PASS</span>' : '<span class="badge fail">✗ FAIL</span>';

    html += `
  <div class="test-case">
    <div class="test-header">
      <div style="flex: 1;">
        <div class="test-question">${result.question}</div>
        <div style="font-size: 13px; color: #666; margin-top: 8px; font-style: italic;">${result.task_description}</div>
        <div class="test-id" style="margin-top: 8px;">${result.test_case_id}</div>
      </div>
      ${badge}
    </div>

    <div class="test-metrics">
      <div class="test-metric">
        <strong>Precision:</strong> ${(result.precision * 100).toFixed(1)}%
      </div>
      <div class="test-metric">
        <strong>Recall:</strong> ${(result.recall * 100).toFixed(1)}%
      </div>
      <div class="test-metric">
        <strong>F1:</strong> ${(result.f1 * 100).toFixed(1)}%
      </div>
      <div class="test-metric">
        <strong>Retrieved:</strong> ${result.retrieved_count}/${result.expected_count}
      </div>
      <div class="test-metric">
        <strong>Time:</strong> ${(result.execution_time_ms / 1000).toFixed(2)}s
      </div>
    </div>
`;

    if (result.matched_urls.length > 0) {
      html += `
    <div class="url-section">
      <h4>✅ Correctly Retrieved (${result.matched_urls.length})</h4>
      <div class="url-list">
${result.matched_urls.map(url => `        <div class="url-item matched">• ${url}</div>`).join('\n')}
      </div>
    </div>
`;
    }

    if (result.false_negatives.length > 0) {
      html += `
    <div class="url-section">
      <h4>❌ Missed (Should have retrieved) (${result.false_negatives.length})</h4>
      <div class="url-list">
${result.false_negatives.map(url => `        <div class="url-item missed">• ${url}</div>`).join('\n')}
      </div>
    </div>
`;
    }

    if (result.false_positives.length > 0) {
      html += `
    <div class="url-section">
      <h4>⚠️ Extra Retrievals (Not in golden set) (${result.false_positives.length})</h4>
      <div class="url-list">
${result.false_positives.map(url => `        <div class="url-item extra">• ${url}</div>`).join('\n')}
      </div>
    </div>
`;
    }

    if (result.error) {
      html += `
    <div class="url-section">
      <h4>💥 Error</h4>
      <div style="color: #ef4444; font-family: monospace; font-size: 13px;">${result.error}</div>
    </div>
`;
    }

    html += `
  </div>
`;
  }

  html += `
</body>
</html>
`;

  return html;
}

/**
 * Find the most recent evaluation report
 */
function findLatestReport(): string | null {
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) return null;

  const files = fs.readdirSync(resultsDir)
    .filter(f => f.startsWith('eval-report-') && f.endsWith('.json'))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(resultsDir, files[0]) : null;
}

/**
 * Generate HTML report from latest evaluation
 */
function generateLatestReport() {
  const reportPath = findLatestReport();
  if (!reportPath) {
    console.error('No evaluation reports found in evaluation/results/');
    process.exit(1);
  }

  console.log(`📊 Generating HTML report from: ${reportPath}`);

  const report: EvalReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const html = generateHtmlReport(report);

  const htmlPath = reportPath.replace('.json', '.html');
  fs.writeFileSync(htmlPath, html);

  console.log(`✅ HTML report generated: ${htmlPath}`);
  console.log(`\n🌐 Open in browser: file://${htmlPath}`);
}

// Run if called directly
if (require.main === module) {
  generateLatestReport();
}

export { generateHtmlReport, generateLatestReport };
