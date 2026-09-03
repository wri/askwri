export const CITE_REPORT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cite Eval Report - AskWRI</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f6f8; color: #1a1a2e; padding: 24px; }
  .container { max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 20px; }
  .summary-bar { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; padding: 16px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .stat { text-align: center; min-width: 100px; }
  .stat-value { font-size: 28px; font-weight: 700; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
  .green { color: #22c55e; } .yellow { color: #eab308; } .red { color: #ef4444; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th { background: #f0f0f5; text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; }
  td { padding: 10px 12px; border-top: 1px solid #eee; font-size: 13px; }
  tr:hover { background: #fafafa; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-pass { background: #dcfce7; color: #166534; }
  .badge-fail { background: #fee2e2; color: #991b1b; }
  .pct { font-variant-numeric: tabular-nums; }
  .empty-state { text-align: center; padding: 60px 20px; color: #888; font-size: 15px; }
  .criteria { font-size: 12px; color: #888; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="container">
  <h1>Cite Mode Evaluation Report</h1>
  <div class="subtitle" id="timestamp"></div>
  <div class="criteria">Pass criteria: Recall &ge; 75% AND Precision &ge; 15% AND F1 &ge; 25%</div>
  <div class="summary-bar" id="summary"></div>
  <div id="app"><div class="empty-state">Loading...</div></div>
</div>
<script>
(function() {
  function pct(v) { return (v * 100).toFixed(1) + '%'; }
  function scoreColor(v, threshold) { return v >= threshold ? 'green' : v >= threshold * 0.6 ? 'yellow' : 'red'; }

  fetch('/api/eval/cite-report')
    .then(function(r) { return r.ok ? r.json() : Promise.reject('No cite report data'); })
    .then(function(report) {
      document.getElementById('timestamp').textContent = 'Run: ' + new Date(report.timestamp).toLocaleString();

      var passed = report.results.filter(function(r) { return r.recall >= 0.75 && r.precision >= 0.15 && r.f1 >= 0.25; }).length;
      var total = report.test_cases_total;

      var sh = '';
      sh += '<div class="stat"><div class="stat-value ' + scoreColor(report.overall_precision, 0.15) + '">' + pct(report.overall_precision) + '</div><div class="stat-label">Precision</div></div>';
      sh += '<div class="stat"><div class="stat-value ' + scoreColor(report.overall_recall, 0.75) + '">' + pct(report.overall_recall) + '</div><div class="stat-label">Recall</div></div>';
      sh += '<div class="stat"><div class="stat-value ' + scoreColor(report.overall_f1, 0.25) + '">' + pct(report.overall_f1) + '</div><div class="stat-label">F1</div></div>';
      sh += '<div class="stat"><div class="stat-value ' + (passed === total ? 'green' : 'yellow') + '">' + passed + '/' + total + '</div><div class="stat-label">Passed</div></div>';
      document.getElementById('summary').innerHTML = sh;

      var h = '<table><thead><tr><th>Query</th><th>Type</th><th>Precision</th><th>Recall</th><th>F1</th><th>Expected</th><th>Retrieved</th><th>Result</th></tr></thead><tbody>';
      report.results.forEach(function(r) {
        var pass = r.recall >= 0.75 && r.precision >= 0.15 && r.f1 >= 0.25;
        h += '<tr>';
        h += '<td>' + r.question.slice(0, 80) + (r.question.length > 80 ? '...' : '') + '</td>';
        h += '<td style="font-size:11px;color:#888">' + (r.test_case_id || '') + '</td>';
        h += '<td class="pct">' + pct(r.precision) + '</td>';
        h += '<td class="pct">' + pct(r.recall) + '</td>';
        h += '<td class="pct">' + pct(r.f1) + '</td>';
        h += '<td>' + r.expected_count + '</td>';
        h += '<td>' + r.retrieved_count + '</td>';
        h += '<td><span class="badge ' + (pass ? 'badge-pass' : 'badge-fail') + '">' + (pass ? 'PASS' : 'FAIL') + '</span></td>';
        h += '</tr>';
      });
      h += '</tbody></table>';
      document.getElementById('app').innerHTML = h;
    })
    .catch(function(err) {
      document.getElementById('app').innerHTML = '<div class="empty-state">No cite report data available. Run eval:cite, then place cite-report-latest.json in eval storage.</div>';
    });
})();
</script>
</body>
</html>`
