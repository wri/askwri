/**
 * Label Review Server
 *
 * Standalone HTTP server for reviewing and overriding LLM-generated chunk labels
 * in the answer golden set generation pipeline.
 *
 * Usage:
 *   npx tsx evaluation/serve-label-review.ts
 *
 * Routes:
 *   GET  /eval/review-labels    → HTML review page
 *   GET  /api/labels            → full answer-labels-review.json
 *   POST /api/labels/override   → set human_override on a chunk
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const PORT = 3001;
const LABELS_PATH = path.join(__dirname, 'answer-labels-review.json');

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

const REVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label Review - AskWRI Answer Golden Set</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f5f6f8;
    color: #1a1a1a;
    line-height: 1.5;
  }

  /* Summary bar */
  .summary-bar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: #fff;
    border-bottom: 1px solid #ddd;
    padding: 12px 24px;
    display: flex;
    gap: 24px;
    align-items: center;
    font-size: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .summary-bar .stat { color: #555; }
  .summary-bar .stat b { color: #1a1a1a; }
  .summary-bar .title-text {
    font-weight: 600;
    font-size: 15px;
    color: #1a1a1a;
    margin-right: 8px;
  }

  /* Main container */
  .container { max-width: 1100px; margin: 0 auto; padding: 20px 16px; }

  /* Question section */
  .question-section {
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    margin-bottom: 12px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .question-header {
    padding: 14px 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 12px;
    user-select: none;
  }
  .question-header:hover { background: #fafafa; }
  .question-header .chevron {
    font-size: 12px;
    color: #888;
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .question-header .chevron.open { transform: rotate(90deg); }
  .question-id {
    font-size: 12px;
    font-family: monospace;
    background: #eee;
    padding: 2px 6px;
    border-radius: 3px;
    color: #555;
    flex-shrink: 0;
  }
  .question-text {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
  }
  .needs-review-badge {
    font-size: 11px;
    font-weight: 600;
    background: #f59e0b;
    color: #fff;
    padding: 2px 8px;
    border-radius: 10px;
    flex-shrink: 0;
  }
  .needs-review-badge.done {
    background: #22c55e;
  }
  .question-body { display: none; padding: 0 18px 18px; }
  .question-body.open { display: block; }

  /* Sub-sections */
  .sub-section { margin-bottom: 14px; }
  .sub-section-header {
    font-size: 13px;
    font-weight: 600;
    color: #555;
    padding: 8px 0;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid #eee;
    margin-bottom: 8px;
  }
  .sub-section-header .chevron {
    font-size: 10px;
    color: #888;
    transition: transform 0.15s;
  }
  .sub-section-header .chevron.open { transform: rotate(90deg); }
  .sub-section-body { display: none; }
  .sub-section-body.open { display: block; }
  .sub-section-count {
    font-weight: 400;
    color: #999;
    font-size: 12px;
  }

  /* Chunk card */
  .chunk-card {
    border: 1px solid #e5e5e5;
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 10px;
    background: #fafafa;
  }
  .chunk-header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .chunk-title { font-weight: 600; font-size: 13px; }
  .chunk-doc-id { font-size: 11px; color: #888; font-family: monospace; }
  .score-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 10px;
    color: #fff;
  }
  .score-green { background: #22c55e; }
  .score-yellow { background: #eab308; }
  .score-red { background: #ef4444; }
  .chunk-page { font-size: 11px; color: #888; }

  .chunk-content {
    font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace;
    font-size: 12px;
    line-height: 1.6;
    color: #333;
    white-space: pre-wrap;
    word-break: break-word;
    background: #fff;
    border: 1px solid #eee;
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 8px;
    max-height: none;
  }
  .content-toggle {
    font-size: 12px;
    color: #2563eb;
    cursor: pointer;
    user-select: none;
    margin-bottom: 8px;
    display: inline-block;
  }
  .content-toggle:hover { text-decoration: underline; }

  .llm-assessment {
    font-size: 11px;
    color: #888;
    margin-bottom: 10px;
    line-height: 1.4;
  }

  /* Label buttons */
  .label-buttons {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .label-btn {
    font-size: 12px;
    font-weight: 500;
    padding: 5px 14px;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
    background: #fff;
    color: #555;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .label-btn:hover { border-color: #999; }
  .label-btn.active-relevant {
    background: #22c55e;
    color: #fff;
    border-color: #22c55e;
  }
  .label-btn.active-partial {
    background: #f59e0b;
    color: #fff;
    border-color: #f59e0b;
  }
  .label-btn.active-not-relevant {
    background: #9ca3af;
    color: #fff;
    border-color: #9ca3af;
  }
  .save-flash {
    font-size: 11px;
    color: #22c55e;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.2s;
    margin-left: 6px;
  }
  .save-flash.show { opacity: 1; }

  .empty-state {
    text-align: center;
    color: #aaa;
    padding: 32px;
    font-size: 14px;
  }
  .error-banner {
    background: #fef2f2;
    color: #dc2626;
    padding: 12px 18px;
    border-radius: 6px;
    margin-bottom: 12px;
    font-size: 13px;
    display: none;
  }
</style>
</head>
<body>

<div class="summary-bar">
  <span class="title-text">Label Review</span>
  <span class="stat" id="stat-questions"><b>0</b>/0 questions reviewed</span>
  <span class="stat" id="stat-chunks"><b>0</b> total chunks</span>
  <span class="stat" id="stat-need-review"><b>0</b> need review</span>
</div>

<div class="container">
  <div class="error-banner" id="error-banner"></div>
  <div id="app"><div class="empty-state">Loading...</div></div>
</div>

<script>
(function() {
  let data = null;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function effectiveLabel(chunk) {
    return chunk.human_override || chunk.label;
  }

  function needsReview(chunk) {
    return chunk.confidence !== 'high' && !chunk.human_override;
  }

  function isQuestionReviewed(q) {
    return q.chunks.every(c => c.confidence === 'high' || c.human_override);
  }

  function updateSummary() {
    if (!data) return;
    const totalQ = data.questions.length;
    const reviewedQ = data.questions.filter(isQuestionReviewed).length;
    let totalChunks = 0;
    let needReviewCount = 0;
    data.questions.forEach(q => {
      q.chunks.forEach(c => {
        totalChunks++;
        if (needsReview(c)) needReviewCount++;
      });
    });
    document.getElementById('stat-questions').innerHTML = '<b>' + reviewedQ + '</b>/' + totalQ + ' questions reviewed';
    document.getElementById('stat-chunks').innerHTML = '<b>' + totalChunks + '</b> total chunks';
    document.getElementById('stat-need-review').innerHTML = '<b>' + needReviewCount + '</b> need review';
  }

  function scoreBadgeClass(score) {
    if (score > 0.7) return 'score-green';
    if (score > 0.4) return 'score-yellow';
    return 'score-red';
  }

  function activeClass(label) {
    if (label === 'relevant') return 'active-relevant';
    if (label === 'partially_relevant') return 'active-partial';
    return 'active-not-relevant';
  }

  function renderChunkCard(chunk, questionId) {
    const eff = effectiveLabel(chunk);
    const truncated = chunk.content.length > 200;
    const preview = truncated ? chunk.content.slice(0, 200) + '...' : chunk.content;
    const chunkId = chunk.chunk_id;
    const cardId = 'card-' + questionId + '-' + chunkId.replace(/[^a-zA-Z0-9_-]/g, '_');

    return '<div class="chunk-card" id="' + escapeHtml(cardId) + '">' +
      '<div class="chunk-header">' +
        '<span class="chunk-title">' + escapeHtml(chunk.title || 'Untitled') + '</span>' +
        '<span class="chunk-doc-id">' + escapeHtml(chunk.doc_id) + '</span>' +
        '<span class="score-badge ' + scoreBadgeClass(chunk.score) + '">' + (chunk.score != null ? chunk.score.toFixed(3) : '?') + '</span>' +
        '<span class="chunk-page">p.' + (chunk.page != null ? chunk.page : '?') + '</span>' +
      '</div>' +
      '<div class="chunk-content" data-full="' + escapeHtml(chunk.content) + '" data-preview="' + escapeHtml(preview) + '" data-expanded="false">' +
        escapeHtml(preview) +
      '</div>' +
      (truncated ?
        '<span class="content-toggle" data-card="' + escapeHtml(cardId) + '">Show full text &#9660;</span>' : '') +
      '<div class="llm-assessment">LLM: ' + escapeHtml(chunk.label) + ' (confidence: ' + escapeHtml(chunk.confidence) + ') &mdash; ' + escapeHtml(chunk.rationale || '') + '</div>' +
      '<div class="label-buttons">' +
        '<button class="label-btn' + (eff === 'relevant' ? ' ' + activeClass('relevant') : '') + '" data-q="' + escapeHtml(questionId) + '" data-c="' + escapeHtml(chunkId) + '" data-val="relevant">Relevant</button>' +
        '<button class="label-btn' + (eff === 'partially_relevant' ? ' ' + activeClass('partially_relevant') : '') + '" data-q="' + escapeHtml(questionId) + '" data-c="' + escapeHtml(chunkId) + '" data-val="partially_relevant">Partial</button>' +
        '<button class="label-btn' + (eff === 'not_relevant' ? ' ' + activeClass('not_relevant') : '') + '" data-q="' + escapeHtml(questionId) + '" data-c="' + escapeHtml(chunkId) + '" data-val="not_relevant">Not Relevant</button>' +
        '<span class="save-flash" data-flash="' + escapeHtml(questionId) + '-' + escapeHtml(chunkId) + '">Saved &#10003;</span>' +
      '</div>' +
    '</div>';
  }

  function renderQuestion(q, idx) {
    const reviewChunks = q.chunks.filter(needsReview);
    const autoChunks = q.chunks.filter(c => !needsReview(c));
    const reviewCount = reviewChunks.length;
    const badgeClass = reviewCount === 0 ? 'needs-review-badge done' : 'needs-review-badge';
    const badgeText = reviewCount === 0 ? 'Done' : reviewCount + ' need review';
    const qSafeId = 'q-' + idx;

    let html = '<div class="question-section" id="' + qSafeId + '">';
    html += '<div class="question-header" data-target="' + qSafeId + '-body">';
    html += '<span class="chevron" id="' + qSafeId + '-chev">&#9654;</span>';
    html += '<span class="question-id">' + escapeHtml(q.id) + '</span>';
    html += '<span class="question-text">' + escapeHtml(q.question) + '</span>';
    html += '<span class="' + badgeClass + '" id="' + qSafeId + '-badge">' + badgeText + '</span>';
    html += '</div>';
    html += '<div class="question-body" id="' + qSafeId + '-body">';

    // Needs review subsection
    html += '<div class="sub-section">';
    html += '<div class="sub-section-header" data-target="' + qSafeId + '-needs">';
    html += '<span class="chevron open" id="' + qSafeId + '-needs-chev">&#9654;</span>';
    html += 'Needs Review <span class="sub-section-count">(' + reviewChunks.length + ')</span>';
    html += '</div>';
    html += '<div class="sub-section-body open" id="' + qSafeId + '-needs">';
    if (reviewChunks.length === 0) {
      html += '<div class="empty-state">All chunks reviewed</div>';
    } else {
      reviewChunks.forEach(c => { html += renderChunkCard(c, q.id); });
    }
    html += '</div></div>';

    // Auto-labeled subsection
    html += '<div class="sub-section">';
    html += '<div class="sub-section-header" data-target="' + qSafeId + '-auto">';
    html += '<span class="chevron" id="' + qSafeId + '-auto-chev">&#9654;</span>';
    html += 'Auto-labeled (high confidence) <span class="sub-section-count">(' + autoChunks.length + ')</span>';
    html += '</div>';
    html += '<div class="sub-section-body" id="' + qSafeId + '-auto">';
    if (autoChunks.length === 0) {
      html += '<div class="empty-state">No auto-labeled chunks</div>';
    } else {
      autoChunks.forEach(c => { html += renderChunkCard(c, q.id); });
    }
    html += '</div></div>';

    html += '</div></div>';
    return html;
  }

  function render() {
    if (!data || !data.questions) {
      document.getElementById('app').innerHTML = '<div class="empty-state">No data loaded</div>';
      return;
    }
    let html = '';
    data.questions.forEach((q, idx) => { html += renderQuestion(q, idx); });
    document.getElementById('app').innerHTML = html;
    updateSummary();
    bindEvents();
  }

  function bindEvents() {
    // Question headers toggle
    document.querySelectorAll('.question-header').forEach(el => {
      el.addEventListener('click', function() {
        const targetId = this.getAttribute('data-target');
        const body = document.getElementById(targetId);
        const chev = this.querySelector('.chevron');
        if (body.classList.contains('open')) {
          body.classList.remove('open');
          chev.classList.remove('open');
        } else {
          body.classList.add('open');
          chev.classList.add('open');
        }
      });
    });

    // Sub-section headers toggle
    document.querySelectorAll('.sub-section-header').forEach(el => {
      el.addEventListener('click', function() {
        const targetId = this.getAttribute('data-target');
        const body = document.getElementById(targetId);
        const chev = this.querySelector('.chevron');
        if (body.classList.contains('open')) {
          body.classList.remove('open');
          chev.classList.remove('open');
        } else {
          body.classList.add('open');
          chev.classList.add('open');
        }
      });
    });

    // Content toggle
    document.querySelectorAll('.content-toggle').forEach(el => {
      el.addEventListener('click', function() {
        const cardId = this.getAttribute('data-card');
        const card = document.getElementById(cardId);
        if (!card) return;
        const contentEl = card.querySelector('.chunk-content');
        const expanded = contentEl.getAttribute('data-expanded') === 'true';
        if (expanded) {
          contentEl.textContent = contentEl.getAttribute('data-preview');
          contentEl.setAttribute('data-expanded', 'false');
          this.innerHTML = 'Show full text &#9660;';
        } else {
          contentEl.textContent = contentEl.getAttribute('data-full');
          contentEl.setAttribute('data-expanded', 'true');
          this.innerHTML = 'Hide &#9650;';
        }
      });
    });

    // Label buttons
    document.querySelectorAll('.label-btn').forEach(el => {
      el.addEventListener('click', function() {
        const questionId = this.getAttribute('data-q');
        const chunkId = this.getAttribute('data-c');
        const val = this.getAttribute('data-val');
        handleLabelClick(questionId, chunkId, val, this);
      });
    });
  }

  function findChunk(questionId, chunkId) {
    for (const q of data.questions) {
      if (q.id === questionId) {
        for (const c of q.chunks) {
          if (c.chunk_id === chunkId) return c;
        }
      }
    }
    return null;
  }

  function handleLabelClick(questionId, chunkId, val, btnEl) {
    const chunk = findChunk(questionId, chunkId);
    if (!chunk) return;

    const currentEffective = effectiveLabel(chunk);
    let overrideVal;

    // If clicking the currently active button and it matches the LLM label, reset override
    if (val === currentEffective && val === chunk.label) {
      overrideVal = null;
    } else if (val === currentEffective && chunk.human_override === val) {
      // Clicking the already active override that differs from LLM => reset to LLM
      overrideVal = null;
    } else {
      overrideVal = val;
    }

    // Optimistic update
    chunk.human_override = overrideVal;

    // Update button states in the same card
    const card = btnEl.closest('.chunk-card');
    const eff = effectiveLabel(chunk);
    card.querySelectorAll('.label-btn').forEach(b => {
      b.className = 'label-btn';
      if (b.getAttribute('data-val') === eff) {
        b.classList.add(activeClass(eff));
      }
    });

    updateSummary();
    // Update question badge
    updateQuestionBadges();

    // Save
    const flashKey = questionId + '-' + chunkId;
    fetch('/api/labels/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_id: questionId, chunk_id: chunkId, override: overrideVal })
    })
    .then(r => {
      if (!r.ok) throw new Error('Save failed: ' + r.status);
      return r.json();
    })
    .then(() => {
      showFlash(flashKey);
    })
    .catch(err => {
      showError('Failed to save: ' + err.message);
    });
  }

  function updateQuestionBadges() {
    data.questions.forEach((q, idx) => {
      const reviewCount = q.chunks.filter(needsReview).length;
      const badge = document.getElementById('q-' + idx + '-badge');
      if (badge) {
        if (reviewCount === 0) {
          badge.className = 'needs-review-badge done';
          badge.textContent = 'Done';
        } else {
          badge.className = 'needs-review-badge';
          badge.textContent = reviewCount + ' need review';
        }
      }
    });
  }

  function showFlash(key) {
    const el = document.querySelector('[data-flash="' + CSS.escape(key) + '"]');
    if (!el) return;
    el.classList.add('show');
    setTimeout(() => { el.classList.remove('show'); }, 1200);
  }

  function showError(msg) {
    const banner = document.getElementById('error-banner');
    banner.textContent = msg;
    banner.style.display = 'block';
    setTimeout(() => { banner.style.display = 'none'; }, 5000);
  }

  // Load data
  fetch('/api/labels')
    .then(r => {
      if (!r.ok) throw new Error('Failed to load labels: ' + r.status);
      return r.json();
    })
    .then(d => {
      data = d;
      render();
    })
    .catch(err => {
      document.getElementById('app').innerHTML = '<div class="empty-state">Error loading data: ' + escapeHtml(err.message) + '</div>';
    });
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function readLabels(): unknown {
  const raw = fs.readFileSync(LABELS_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeLabels(data: unknown): void {
  fs.writeFileSync(LABELS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res: http.ServerResponse, content: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // GET /eval/review-labels → serve HTML page
    if (req.method === 'GET' && pathname === '/eval/review-labels') {
      html(res, REVIEW_HTML);
      return;
    }

    // GET /api/labels → return labels JSON
    if (req.method === 'GET' && pathname === '/api/labels') {
      const data = readLabels();
      json(res, 200, data);
      return;
    }

    // POST /api/labels/override → update human_override
    if (req.method === 'POST' && pathname === '/api/labels/override') {
      const body = await collectBody(req);
      let parsed: { question_id: string; chunk_id: string; override: string | null };
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { error: 'Invalid JSON' });
        return;
      }

      const { question_id, chunk_id, override: overrideVal } = parsed;
      if (!question_id || !chunk_id) {
        json(res, 400, { error: 'Missing question_id or chunk_id' });
        return;
      }

      const validOverrides = ['relevant', 'partially_relevant', 'not_relevant', null];
      if (!validOverrides.includes(overrideVal)) {
        json(res, 400, { error: 'Invalid override value' });
        return;
      }

      const data = readLabels() as {
        questions: Array<{
          id: string;
          chunks: Array<{ chunk_id: string; human_override: string | null }>;
        }>;
      };

      let found = false;
      for (const q of data.questions) {
        if (q.id === question_id) {
          for (const c of q.chunks) {
            if (c.chunk_id === chunk_id) {
              c.human_override = overrideVal;
              found = true;
              break;
            }
          }
          break;
        }
      }

      if (!found) {
        json(res, 404, { error: 'Chunk not found' });
        return;
      }

      writeLabels(data);
      json(res, 200, { ok: true });
      return;
    }

    // 404
    json(res, 404, { error: 'Not found' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Server error:', message);
    json(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Label review server running at http://localhost:${PORT}/eval/review-labels`);
});
