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

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const PORT = 3001
const LABELS_PATH = path.join(__dirname, 'answer-labels-review.json')
const SYNTHESIS_EVAL_PATH = path.join(
  __dirname,
  'answer-synthesis-eval-final.json',
)
const SYNTHESIS_RAW_PATH = path.join(__dirname, 'answer-synthesis-raw.json')

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
  .container { max-width: 1400px; margin: 0 auto; padding: 20px 16px; }

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
    white-space: normal;
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

  /* Methodology note */
  .methodology-toggle {
    display: flex; align-items: center; gap: 6px; padding: 8px 16px;
    background: #eef2ff; border-bottom: 1px solid #c7d2fe; cursor: pointer;
    user-select: none; font-size: 13px; color: #4338ca; font-weight: 500;
  }
  .methodology-toggle:hover { background: #e0e7ff; }
  .methodology-toggle .chevron { font-size: 10px; color: #6366f1; transition: transform 0.15s; }
  .methodology-toggle .chevron.open { transform: rotate(90deg); }
  .methodology-note {
    display: none; max-width: 820px; margin: 0 auto; padding: 20px 24px 16px;
    background: #fafaff; border-bottom: 1px solid #e0e0e0; font-size: 13px; line-height: 1.65; color: #333;
  }
  .methodology-note.open { display: block; }
  .methodology-note h3 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #1a1a1a; }
  .methodology-note p { margin-bottom: 10px; }
  .methodology-note table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 13px; }
  .methodology-note td { padding: 6px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  .methodology-note td:first-child { width: 130px; white-space: nowrap; }
  .methodology-note ol { padding-left: 20px; margin: 6px 0 12px; }
  .methodology-note li { margin-bottom: 4px; }
</style>
</head>
<body>

<div class="summary-bar">
  <span class="title-text">Label Review</span>
  <span class="stat" id="stat-questions"><b>0</b>/0 questions reviewed</span>
  <span class="stat" id="stat-chunks"><b>0</b> total chunks</span>
  <span class="stat" id="stat-need-review"><b>0</b> need review</span>
</div>

<div class="methodology-toggle" id="methodology-toggle">
  <span class="chevron" id="methodology-chevron">&#9654;</span> Methodology &amp; Review Guide
</div>
<div class="methodology-note" id="methodology-note">
<h3>Methodology</h3>

<p><strong>How it works.</strong> For each test question, the system retrieves passage chunks from WRI's document corpus through hybrid search (dense and sparse retrieval with cross-encoder reranking). An LLM then labels each chunk as <em>relevant</em>, <em>partially relevant</em>, or <em>not relevant</em> to the question, with a brief rationale. Your job is to verify or override these labels.</p>

<p><strong>What the labels mean.</strong></p>
<table>
<tr><td><strong>Relevant</strong></td><td>The chunk directly answers or substantially informs the question. A good synthesis would draw on this passage.</td></tr>
<tr><td><strong>Partial</strong></td><td>The chunk relates to the topic but lacks a direct answer. It provides useful context without being essential.</td></tr>
<tr><td><strong>Not relevant</strong></td><td>The chunk does not help answer the question, even indirectly.</td></tr>
</table>

<p><strong>How to review.</strong></p>
<ol>
<li>Expand a question to see its retrieved chunks.</li>
<li>Read each chunk's text and the LLM's rationale.</li>
<li>If you agree with the label, move on. If not, click the correct label button. Your override takes precedence.</li>
<li>Focus on chunks the LLM flagged as needing review — these have the lowest confidence.</li>
</ol>

<p><strong>What to watch for.</strong> The LLM tends to over-label tangentially related passages as "relevant." If a chunk discusses the right topic but does not address the specific question, mark it "partial." Conversely, the LLM sometimes misses chunks with indirect but valuable evidence — a passage about a related city or policy may still inform the answer.</p>
</div>

<div class="container">
  <div class="error-banner" id="error-banner"></div>
  <div id="app"><div class="empty-state">Loading...</div></div>
</div>

<script>
(function() {
  // Methodology toggle
  document.getElementById('methodology-toggle').addEventListener('click', function() {
    var note = document.getElementById('methodology-note');
    var chev = document.getElementById('methodology-chevron');
    var open = note.classList.toggle('open');
    if (open) { chev.classList.add('open'); } else { chev.classList.remove('open'); }
  });

  let data = null;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function effectiveLabel(chunk) {
    return chunk.human_override || chunk.label;
  }

  function wasLabeled(chunk) {
    return chunk.rationale && !chunk.rationale.startsWith('Not labeled (outside top');
  }

  function needsReview(chunk) {
    return wasLabeled(chunk) && chunk.confidence !== 'high' && !chunk.human_override;
  }

  function isQuestionReviewed(q) {
    var labeled = q.chunks.filter(wasLabeled);
    return labeled.every(c => c.confidence === 'high' || c.human_override);
  }

  function updateSummary() {
    if (!data) return;
    const totalQ = data.questions.length;
    const reviewedQ = data.questions.filter(isQuestionReviewed).length;
    let totalChunks = 0;
    let needReviewCount = 0;
    data.questions.forEach(q => {
      q.chunks.filter(wasLabeled).forEach(c => {
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
      '<div class="chunk-content" data-full="' + escapeHtml(chunk.content) + '" data-preview="' + escapeHtml(preview) + '" data-expanded="true">' +
        escapeHtml(chunk.content) +
      '</div>' +
      '<div class="llm-assessment">LLM: ' + escapeHtml(chunk.label) + ' (confidence: ' + escapeHtml(chunk.confidence) + ') &mdash; ' + escapeHtml(chunk.rationale || '') + '</div>' +
      '<div class="label-buttons">' +
        '<button class="label-btn' + (eff === 'relevant' ? ' ' + activeClass('relevant') : '') + '" data-q="' + escapeHtml(questionId) + '" data-c="' + escapeHtml(chunkId) + '" data-val="relevant">Relevant</button>' +
        '<button class="label-btn' + (eff === 'partially_relevant' ? ' ' + activeClass('partially_relevant') : '') + '" data-q="' + escapeHtml(questionId) + '" data-c="' + escapeHtml(chunkId) + '" data-val="partially_relevant">Partial</button>' +
        '<button class="label-btn' + (eff === 'not_relevant' ? ' ' + activeClass('not_relevant') : '') + '" data-q="' + escapeHtml(questionId) + '" data-c="' + escapeHtml(chunkId) + '" data-val="not_relevant">Not Relevant</button>' +
        '<span class="save-flash" data-flash="' + escapeHtml(questionId) + '-' + escapeHtml(chunkId) + '">Saved &#10003;</span>' +
      '</div>' +
    '</div>';
  }

  // Track which questions have been lazily rendered
  const renderedQuestions = new Set();

  function renderQuestion(q, idx) {
    const reviewChunks = q.chunks.filter(needsReview);
    const reviewCount = reviewChunks.length;
    const badgeClass = reviewCount === 0 ? 'needs-review-badge done' : 'needs-review-badge';
    const badgeText = reviewCount === 0 ? 'Done' : reviewCount + ' need review';
    const qSafeId = 'q-' + idx;

    let html = '<div class="question-section" id="' + qSafeId + '">';
    html += '<div class="question-header" data-target="' + qSafeId + '-body" data-qidx="' + idx + '">';
    html += '<span class="chevron" id="' + qSafeId + '-chev">&#9654;</span>';
    html += '<span class="question-id">' + escapeHtml(q.id) + '</span>';
    html += '<span class="question-text">' + escapeHtml(q.question) + '</span>';
    html += '<span class="' + badgeClass + '" id="' + qSafeId + '-badge">' + badgeText + '</span>';
    html += '</div>';
    // Body starts empty — chunk cards are lazily rendered on first expand
    html += '<div class="question-body" id="' + qSafeId + '-body">';
    html += '<div class="empty-state">Click to load chunks...</div>';
    html += '</div></div>';
    return html;
  }

  function renderQuestionBody(idx) {
    if (renderedQuestions.has(idx)) return;
    renderedQuestions.add(idx);

    const q = data.questions[idx];
    const qSafeId = 'q-' + idx;
    const labeled = q.chunks.filter(wasLabeled);
    const reviewChunks = labeled.filter(needsReview);
    const autoChunks = labeled.filter(c => !needsReview(c));

    let html = '';

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

    const body = document.getElementById(qSafeId + '-body');
    body.innerHTML = html;

    // Bind events for newly rendered chunk cards
    bindChunkEvents(body);
  }

  function bindChunkEvents(container) {
    // Sub-section headers toggle
    container.querySelectorAll('.sub-section-header').forEach(el => {
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
    container.querySelectorAll('.content-toggle').forEach(el => {
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
    container.querySelectorAll('.label-btn').forEach(el => {
      el.addEventListener('click', function() {
        const questionId = this.getAttribute('data-q');
        const chunkId = this.getAttribute('data-c');
        const val = this.getAttribute('data-val');
        handleLabelClick(questionId, chunkId, val, this);
      });
    });
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
    // Question headers toggle — lazy-render chunk cards on first expand
    document.querySelectorAll('.question-header').forEach(el => {
      el.addEventListener('click', function() {
        const targetId = this.getAttribute('data-target');
        const qIdx = parseInt(this.getAttribute('data-qidx'), 10);
        const body = document.getElementById(targetId);
        const chev = this.querySelector('.chevron');
        if (body.classList.contains('open')) {
          body.classList.remove('open');
          chev.classList.remove('open');
        } else {
          // Lazy render on first expand
          renderQuestionBody(qIdx);
          body.classList.add('open');
          chev.classList.add('open');
        }
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
</html>`

// ---------------------------------------------------------------------------
// Synthesis Review HTML (Task 6 — will replace this placeholder)
// ---------------------------------------------------------------------------

const SYNTHESIS_REVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synthesis Review - AskWRI Answer Eval</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #f5f6f8; color: #1a1a1a; line-height: 1.5;
  }
  .summary-bar {
    position: sticky; top: 0; z-index: 100; background: #fff;
    border-bottom: 1px solid #ddd; padding: 12px 24px;
    display: flex; gap: 24px; align-items: center; font-size: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08); flex-wrap: wrap;
  }
  .summary-bar .title-text { font-weight: 600; font-size: 15px; margin-right: 8px; }
  .summary-bar .stat { color: #555; }
  .summary-bar .stat b { color: #1a1a1a; }
  .container { max-width: 1400px; margin: 0 auto; padding: 20px 16px; }
  .tc-section {
    background: #fff; border: 1px solid #e0e0e0; border-radius: 8px;
    margin-bottom: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.04);
  }
  .tc-header {
    padding: 14px 18px; cursor: pointer; display: flex;
    align-items: center; gap: 12px; user-select: none;
  }
  .tc-header:hover { background: #fafafa; }
  .chevron { font-size: 12px; color: #888; transition: transform 0.15s; flex-shrink: 0; }
  .chevron.open { transform: rotate(90deg); }
  .tc-id { font-size: 12px; font-family: monospace; background: #eee; padding: 2px 6px; border-radius: 3px; color: #555; }
  .tc-question { flex: 1; font-size: 14px; font-weight: 500; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; color: #fff; }
  .badge-pending { background: #f59e0b; }
  .badge-done { background: #22c55e; }
  .tc-body { display: none; padding: 0 18px 18px; }
  .tc-body.open { display: block; }

  .panel { margin-bottom: 16px; }
  .panel-title {
    font-size: 13px; font-weight: 600; color: #555; padding: 8px 0;
    cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px;
    border-bottom: 1px solid #eee; margin-bottom: 8px;
  }

  .synthesis-box {
    background: #f0f7ff; border: 1px solid #bfdbfe; border-radius: 6px;
    padding: 14px 16px; font-size: 14px; line-height: 1.7; margin-bottom: 16px;
  }

  .passage-card {
    border: 1px solid #e5e5e5; border-radius: 6px; padding: 10px 12px;
    margin-bottom: 8px; background: #fafafa; font-size: 12px;
  }
  .passage-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .passage-title { font-weight: 600; font-size: 12px; }
  .passage-meta { font-size: 11px; color: #888; font-family: monospace; }
  .score-badge { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; color: #fff; }
  .score-green { background: #22c55e; }
  .score-yellow { background: #eab308; }
  .score-red { background: #ef4444; }
  .passage-snippet {
    font-family: monospace; font-size: 11px; line-height: 1.5; color: #333;
    white-space: normal; word-break: break-word; background: #fff;
    border: 1px solid #eee; border-radius: 4px; padding: 6px 8px; max-height: none;
  }
  .passage-snippet.expanded { max-height: none; }
  .snippet-toggle { font-size: 11px; color: #2563eb; cursor: pointer; user-select: none; display: inline-block; margin-top: 4px; }
  .snippet-toggle:hover { text-decoration: underline; }

  .scores-row { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .score-item { display: flex; flex-direction: column; align-items: center; min-width: 80px; }
  .score-label { font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 2px; }
  .score-value { font-size: 18px; font-weight: 700; }
  .sv-green { color: #22c55e; }
  .sv-yellow { color: #eab308; }
  .sv-red { color: #ef4444; }

  .feedback-block { font-size: 13px; color: #444; background: #f9f9f9; border-left: 3px solid #ddd; padding: 8px 12px; margin-bottom: 10px; }
  .issue-card { font-size: 12px; background: #fef3c7; border: 1px solid #fcd34d; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }
  .issue-type { font-weight: 600; color: #92400e; text-transform: uppercase; font-size: 10px; }
  .key-fact-list { list-style: none; padding: 0; }
  .key-fact-list li { font-size: 13px; padding: 4px 0; border-bottom: 1px solid #f0f0f0; }

  .human-panel { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; }
  .slider-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .slider-label { font-size: 12px; font-weight: 500; width: 120px; flex-shrink: 0; }
  .slider-row input[type=range] { flex: 1; }
  .slider-val { font-size: 13px; font-weight: 600; width: 32px; text-align: right; }
  .feedback-textarea { width: 100%; min-height: 60px; font-size: 13px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; font-family: inherit; }
  .kf-check { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; }
  .kf-check input { margin-top: 3px; }
  .kf-check label { font-size: 13px; cursor: pointer; }
  .add-fact-row { display: flex; gap: 6px; margin-top: 8px; }
  .add-fact-input { flex: 1; font-size: 13px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; }
  .add-fact-btn { font-size: 12px; padding: 6px 12px; background: #2563eb; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  .add-fact-btn:hover { background: #1d4ed8; }
  .reviewed-btn {
    display: inline-block; margin-top: 12px; padding: 8px 20px; font-size: 13px; font-weight: 600;
    background: #22c55e; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .reviewed-btn:hover { background: #16a34a; }
  .reviewed-btn.active { background: #86efac; color: #166534; cursor: default; }
  .save-flash { font-size: 11px; color: #22c55e; font-weight: 600; opacity: 0; transition: opacity 0.2s; margin-left: 8px; }
  .save-flash.show { opacity: 1; }
  .error-banner { background: #fef2f2; color: #dc2626; padding: 12px 18px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; display: none; }
  .empty-state { text-align: center; color: #aaa; padding: 32px; font-size: 14px; }
  .section-label { font-size: 12px; font-weight: 600; color: #888; text-transform: uppercase; margin: 12px 0 6px; }

  /* Methodology note */
  .methodology-toggle {
    display: flex; align-items: center; gap: 6px; padding: 8px 16px;
    background: #eef2ff; border-bottom: 1px solid #c7d2fe; cursor: pointer;
    user-select: none; font-size: 13px; color: #4338ca; font-weight: 500;
  }
  .methodology-toggle:hover { background: #e0e7ff; }
  .methodology-toggle .chevron { font-size: 10px; color: #6366f1; transition: transform 0.15s; }
  .methodology-toggle .chevron.open { transform: rotate(90deg); }
  .methodology-note {
    display: none; max-width: 820px; margin: 0 auto; padding: 20px 24px 16px;
    background: #fafaff; border-bottom: 1px solid #e0e0e0; font-size: 13px; line-height: 1.65; color: #333;
  }
  .methodology-note.open { display: block; }
  .methodology-note h3 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #1a1a1a; }
  .methodology-note p { margin-bottom: 10px; }
  .methodology-note table { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 13px; }
  .methodology-note td { padding: 6px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  .methodology-note td:first-child { width: 130px; white-space: nowrap; }
  .methodology-note ol { padding-left: 20px; margin: 6px 0 12px; }
  .methodology-note li { margin-bottom: 4px; }
</style>
</head>
<body>
<div class="summary-bar">
  <span class="title-text">Synthesis Review</span>
  <span class="stat" id="stat-reviewed"><b>0</b>/0 reviewed</span>
  <span class="stat" id="stat-avg-faith">Faith: <b>-</b></span>
  <span class="stat" id="stat-avg-compl">Compl: <b>-</b></span>
  <span class="stat" id="stat-avg-conci">Conci: <b>-</b></span>
  <span class="stat" id="stat-avg-coher">Coher: <b>-</b></span>
  <span class="stat" id="stat-avg-cite">Cite: <b>-</b></span>
</div>
<div class="methodology-toggle" id="methodology-toggle">
  <span class="chevron" id="methodology-chevron">&#9654;</span> Methodology &amp; Review Guide
</div>
<div class="methodology-note" id="methodology-note">
<h3>Methodology</h3>

<p><strong>How it works.</strong> For each question, the system retrieves source passages from WRI's document corpus through hybrid search (dense and sparse retrieval with cross-encoder reranking). Passages that score above a relevance threshold go to GPT-5.2, which synthesizes a two- to three-sentence answer. A separate GPT-5.2 instance then scores the answer on five dimensions, seeing only the passages the synthesis model received.</p>

<p><strong>What the scores mean.</strong></p>
<table>
<tr><td><strong>Faithfulness</strong></td><td>Every claim traces to a source passage. Penalizes hallucinated facts and unsupported causal claims.</td></tr>
<tr><td><strong>Completeness</strong></td><td>The answer covers key findings from its passages, given the two- to three-sentence limit. Does not penalize for information the model never saw.</td></tr>
<tr><td><strong>Conciseness</strong></td><td>Every word earns its place. No filler, no repetition, no hedging.</td></tr>
<tr><td><strong>Coherence</strong></td><td>The answer reads as a unified narrative, not a list of disconnected facts.</td></tr>
<tr><td><strong>Citation accuracy</strong></td><td>Each claim maps to a specific source passage. A reviewer can point to exactly which passage supports each statement.</td></tr>
</table>

<p>Scores range from 0.0 to 1.0. Above 0.7 is good; below 0.4 needs attention.</p>

<p><strong>How to review.</strong></p>
<ol>
<li>Read the synthesis (blue box) and the source passages.</li>
<li>Check the LLM scores and flagged issues. Do you agree?</li>
<li>Adjust sliders to reflect your judgment. LLM scores pre-populate as a starting point.</li>
<li>Confirm which key facts the synthesis captures. Add any it missed.</li>
<li>Write brief qualitative feedback if scores alone fail to capture what matters.</li>
<li>Click "Mark as Reviewed."</li>
</ol>

<p><strong>What to watch for.</strong> The LLM judge scores faithfulness generously; it rarely catches subtle overclaiming. If a synthesis asserts a causal relationship ("X leads to Y") but the source shows only correlation, flag it. Watch also for optimism bias: answers that omit caveats or risks present in the sources.</p>
</div>
<div class="container">
  <div class="error-banner" id="error-banner"></div>
  <div id="app"><div class="empty-state">Loading...</div></div>
</div>
<script>
(function() {
  // Methodology toggle
  document.getElementById('methodology-toggle').addEventListener('click', function() {
    var note = document.getElementById('methodology-note');
    var chev = document.getElementById('methodology-chevron');
    var open = note.classList.toggle('open');
    if (open) { chev.classList.add('open'); } else { chev.classList.remove('open'); }
  });

  var evalData = null;
  var rawData = null;
  var saveTimers = {};
  var renderedBodies = {};

  function esc(str) {
    var d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
  }

  function scoreColor(v) { return v > 0.7 ? 'green' : v > 0.4 ? 'yellow' : 'red'; }

  function updateSummary() {
    if (!evalData) return;
    var tcs = evalData.test_cases;
    var total = tcs.length;
    var reviewed = tcs.filter(function(t) { return t.human_eval.reviewed; }).length;
    document.getElementById('stat-reviewed').innerHTML = '<b>' + reviewed + '</b>/' + total + ' reviewed';

    var dims = ['faithfulness','completeness','conciseness','coherence','citation_accuracy'];
    var ids = ['stat-avg-faith','stat-avg-compl','stat-avg-conci','stat-avg-coher','stat-avg-cite'];
    var labels = ['Faith','Compl','Conci','Coher','Cite'];
    for (var i = 0; i < dims.length; i++) {
      var vals = tcs.filter(function(t) { return t.human_eval.reviewed; }).map(function(t) { return t.human_eval.scores[dims[i]] || 0; });
      var avg = vals.length ? vals.reduce(function(a,b){return a+b;},0) / vals.length : 0;
      document.getElementById(ids[i]).innerHTML = labels[i] + ': <b>' + (vals.length ? avg.toFixed(2) : '-') + '</b>';
    }
  }

  function getHumanEval(tcId) {
    var tc = evalData.test_cases.find(function(t) { return t.test_case_id === tcId; });
    return tc ? tc.human_eval : null;
  }

  function saveHumanEval(tcId) {
    var tc = evalData.test_cases.find(function(t) { return t.test_case_id === tcId; });
    if (!tc) return;
    fetch('/api/synthesis-eval/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_case_id: tcId, human_eval: tc.human_eval })
    }).then(function(r) {
      if (!r.ok) throw new Error('Save failed: ' + r.status);
      showFlash(tcId);
      updateSummary();
      updateBadge(tcId);
    }).catch(function(e) { showError(e.message); });
  }

  function debounceSave(tcId) {
    if (saveTimers[tcId]) clearTimeout(saveTimers[tcId]);
    saveTimers[tcId] = setTimeout(function() { saveHumanEval(tcId); }, 300);
  }

  function showFlash(tcId) {
    var el = document.getElementById('flash-' + tcId);
    if (!el) return;
    el.classList.add('show');
    setTimeout(function() { el.classList.remove('show'); }, 1200);
  }

  function showError(msg) {
    var b = document.getElementById('error-banner');
    b.textContent = msg; b.style.display = 'block';
    setTimeout(function() { b.style.display = 'none'; }, 5000);
  }

  function updateBadge(tcId) {
    var tc = evalData.test_cases.find(function(t) { return t.test_case_id === tcId; });
    var idx = evalData.test_cases.indexOf(tc);
    var badge = document.getElementById('badge-' + idx);
    if (badge && tc) {
      badge.className = 'badge ' + (tc.human_eval.reviewed ? 'badge-done' : 'badge-pending');
      badge.textContent = tc.human_eval.reviewed ? 'Reviewed' : 'Pending';
    }
  }

  function renderPassages(tcId) {
    var raw = rawData ? rawData.test_cases.find(function(t) { return t.test_case_id === tcId; }) : null;
    if (!raw || !raw.retrieved_passages.length) return '<div class="empty-state">No passage data</div>';
    var h = '';
    raw.retrieved_passages.forEach(function(p, i) {
      var sc = scoreColor(p.score);
      var snip = p.snippet || '';
      var truncated = snip.length > 200;
      var preview = truncated ? snip.slice(0, 200) + '...' : snip;
      var pid = 'p-' + tcId + '-' + i;
      h += '<div class="passage-card">';
      h += '<div class="passage-header">';
      h += '<span class="passage-title">' + esc(p.title) + '</span>';
      h += '<span class="passage-meta">' + esc(p.doc_id) + '</span>';
      h += '<span class="score-badge score-' + sc + '">' + p.score.toFixed(3) + '</span>';
      h += '<span class="passage-meta">p.' + (p.page || '?') + '</span>';
      h += '</div>';
      h += '<div class="passage-snippet" id="' + pid + '">' + esc(snip) + '</div>';
      h += '</div>';
    });
    return h;
  }

  function renderLLMEval(llm) {
    var dims = ['faithfulness','completeness','conciseness','coherence','citation_accuracy'];
    var h = '<div class="scores-row">';
    dims.forEach(function(d) {
      var v = llm.scores[d] || 0;
      var c = scoreColor(v);
      h += '<div class="score-item"><span class="score-label">' + d.replace('_',' ') + '</span><span class="score-value sv-' + c + '">' + v.toFixed(1) + '</span></div>';
    });
    h += '</div>';
    if (llm.qualitative_feedback) {
      h += '<div class="feedback-block">' + esc(llm.qualitative_feedback) + '</div>';
    }
    if (llm.flagged_issues && llm.flagged_issues.length) {
      llm.flagged_issues.forEach(function(issue) {
        h += '<div class="issue-card"><span class="issue-type">' + esc(issue.type) + '</span> ' + esc(issue.text) + '<br><small>' + esc(issue.detail) + '</small></div>';
      });
    }
    if (llm.key_facts_extracted && llm.key_facts_extracted.length) {
      h += '<div class="section-label">Key Facts Extracted</div><ul class="key-fact-list">';
      llm.key_facts_extracted.forEach(function(f) { h += '<li>' + esc(f) + '</li>'; });
      h += '</ul>';
    }
    return h;
  }

  function renderHumanPanel(tc, idx) {
    var he = tc.human_eval;
    var llm = tc.llm_eval;
    var tcId = tc.test_case_id;
    var dims = ['faithfulness','completeness','conciseness','coherence','citation_accuracy'];

    var h = '<div class="human-panel">';
    h += '<div class="section-label">Your Scores</div>';
    dims.forEach(function(d) {
      var val = he.reviewed ? he.scores[d] : llm.scores[d];
      h += '<div class="slider-row">';
      h += '<span class="slider-label">' + d.replace('_',' ') + '</span>';
      h += '<input type="range" min="0" max="1" step="0.1" value="' + val + '" data-tc="' + tcId + '" data-dim="' + d + '" class="human-slider">';
      h += '<span class="slider-val" id="sv-' + tcId + '-' + d + '">' + val.toFixed(1) + '</span>';
      h += '</div>';
    });

    h += '<div class="section-label" style="margin-top:12px">Qualitative Feedback</div>';
    h += '<textarea class="feedback-textarea" data-tc="' + tcId + '" placeholder="What is good, what needs improvement...">' + esc(he.qualitative_feedback) + '</textarea>';

    // Key facts checkboxes
    if (llm.key_facts_extracted && llm.key_facts_extracted.length) {
      h += '<div class="section-label" style="margin-top:12px">Confirm Key Facts</div>';
      llm.key_facts_extracted.forEach(function(f, fi) {
        var checked = he.key_facts_confirmed.indexOf(f) >= 0 ? ' checked' : '';
        h += '<div class="kf-check"><input type="checkbox" id="kf-' + tcId + '-' + fi + '" data-tc="' + tcId + '" data-fact="' + esc(f).replace(/"/g, '&quot;') + '" class="kf-checkbox"' + checked + '><label for="kf-' + tcId + '-' + fi + '">' + esc(f) + '</label></div>';
      });
    }

    // Add fact
    h += '<div class="section-label" style="margin-top:12px">Add Key Facts</div>';
    if (he.key_facts_added.length) {
      he.key_facts_added.forEach(function(f, fi) {
        h += '<div class="kf-check"><span style="color:#22c55e;font-size:12px">+</span> <span style="font-size:13px">' + esc(f) + '</span></div>';
      });
    }
    h += '<div class="add-fact-row"><input type="text" class="add-fact-input" id="addfact-' + tcId + '" placeholder="Type a key fact..."><button class="add-fact-btn" data-tc="' + tcId + '">Add</button></div>';

    h += '<button class="reviewed-btn' + (he.reviewed ? ' active' : '') + '" data-tc="' + tcId + '" id="revbtn-' + tcId + '">' + (he.reviewed ? 'Reviewed' : 'Mark as Reviewed') + '</button>';
    h += '<span class="save-flash" id="flash-' + tcId + '">Saved &#10003;</span>';
    h += '</div>';
    return h;
  }

  function renderTcBody(idx) {
    if (renderedBodies[idx]) return;
    renderedBodies[idx] = true;
    var tc = evalData.test_cases[idx];
    var tcId = tc.test_case_id;
    var body = document.getElementById('body-' + idx);

    var h = '';
    // Synthesis
    h += '<div class="synthesis-box">' + esc(tc.synthesis_text) + '</div>';

    // Passages (collapsible)
    h += '<div class="panel"><div class="panel-title" data-target="passages-' + idx + '"><span class="chevron" id="chev-passages-' + idx + '">&#9654;</span> Source Passages (' + tc.passage_count + ')</div>';
    h += '<div id="passages-' + idx + '" style="display:none">' + renderPassages(tcId) + '</div></div>';

    // LLM eval
    h += '<div class="panel"><div class="section-label">LLM Evaluation (' + esc(tc.llm_eval.model) + ')</div>';
    h += renderLLMEval(tc.llm_eval) + '</div>';

    // Human eval
    h += '<div class="panel"><div class="section-label">Human Evaluation</div>';
    h += renderHumanPanel(tc, idx) + '</div>';

    body.innerHTML = h;
    bindBodyEvents(body, idx);
  }

  function bindBodyEvents(container, idx) {
    var tc = evalData.test_cases[idx];
    var tcId = tc.test_case_id;

    // Panel toggles
    container.querySelectorAll('.panel-title').forEach(function(el) {
      el.addEventListener('click', function() {
        var targetId = this.getAttribute('data-target');
        var target = document.getElementById(targetId);
        var chev = this.querySelector('.chevron');
        if (target.style.display === 'none') {
          target.style.display = 'block';
          if (chev) chev.classList.add('open');
        } else {
          target.style.display = 'none';
          if (chev) chev.classList.remove('open');
        }
      });
    });

    // Snippet toggles
    container.querySelectorAll('.snippet-toggle').forEach(function(el) {
      el.addEventListener('click', function() {
        var pid = this.getAttribute('data-pid');
        var snipEl = document.getElementById(pid);
        var expanded = this.getAttribute('data-expanded') === 'true';
        if (expanded) {
          snipEl.textContent = this.getAttribute('data-preview');
          snipEl.classList.remove('expanded');
          this.textContent = 'Show full text';
          this.setAttribute('data-expanded', 'false');
        } else {
          snipEl.textContent = this.getAttribute('data-full');
          snipEl.classList.add('expanded');
          this.textContent = 'Hide';
          this.setAttribute('data-expanded', 'true');
        }
      });
    });

    // Sliders
    container.querySelectorAll('.human-slider').forEach(function(el) {
      el.addEventListener('input', function() {
        var dim = this.getAttribute('data-dim');
        var val = parseFloat(this.value);
        document.getElementById('sv-' + tcId + '-' + dim).textContent = val.toFixed(1);
        tc.human_eval.scores[dim] = val;
        debounceSave(tcId);
      });
    });

    // Feedback textarea
    container.querySelectorAll('.feedback-textarea').forEach(function(el) {
      el.addEventListener('blur', function() {
        tc.human_eval.qualitative_feedback = this.value;
        saveHumanEval(tcId);
      });
    });

    // Key fact checkboxes
    container.querySelectorAll('.kf-checkbox').forEach(function(el) {
      el.addEventListener('change', function() {
        var fact = this.getAttribute('data-fact');
        var confirmed = tc.human_eval.key_facts_confirmed;
        var idx = confirmed.indexOf(fact);
        if (this.checked && idx < 0) confirmed.push(fact);
        if (!this.checked && idx >= 0) confirmed.splice(idx, 1);
        saveHumanEval(tcId);
      });
    });

    // Add fact button
    container.querySelectorAll('.add-fact-btn').forEach(function(el) {
      el.addEventListener('click', function() {
        var input = document.getElementById('addfact-' + tcId);
        var val = input.value.trim();
        if (!val) return;
        tc.human_eval.key_facts_added.push(val);
        input.value = '';
        saveHumanEval(tcId);
        // Re-render body to show new fact
        renderedBodies[evalData.test_cases.indexOf(tc)] = false;
        renderTcBody(evalData.test_cases.indexOf(tc));
      });
    });

    // Reviewed button
    container.querySelectorAll('.reviewed-btn').forEach(function(el) {
      el.addEventListener('click', function() {
        if (tc.human_eval.reviewed) return;
        // Copy LLM scores to human scores if reviewer hasn't moved the sliders
        var dims = ['faithfulness','completeness','conciseness','coherence','citation_accuracy'];
        dims.forEach(function(d) {
          if (tc.human_eval.scores[d] === 0 && tc.llm_eval.scores[d] > 0) {
            tc.human_eval.scores[d] = tc.llm_eval.scores[d];
          }
        });
        tc.human_eval.reviewed = true;
        this.classList.add('active');
        this.textContent = 'Reviewed';
        saveHumanEval(tcId);
      });
    });
  }

  function render() {
    if (!evalData || !evalData.test_cases.length) {
      document.getElementById('app').innerHTML = '<div class="empty-state">No synthesis eval data loaded. Run stages 1-2 first.</div>';
      return;
    }
    var h = '';
    evalData.test_cases.forEach(function(tc, idx) {
      var reviewed = tc.human_eval.reviewed;
      h += '<div class="tc-section">';
      h += '<div class="tc-header" data-idx="' + idx + '">';
      h += '<span class="chevron" id="chev-' + idx + '">&#9654;</span>';
      h += '<span class="tc-id">' + esc(tc.test_case_id) + '</span>';
      h += '<span class="tc-question">' + esc(tc.question) + '</span>';
      h += '<span class="badge ' + (reviewed ? 'badge-done' : 'badge-pending') + '" id="badge-' + idx + '">' + (reviewed ? 'Reviewed' : 'Pending') + '</span>';
      h += '</div>';
      h += '<div class="tc-body" id="body-' + idx + '"><div class="empty-state">Click to load...</div></div>';
      h += '</div>';
    });
    document.getElementById('app').innerHTML = h;
    updateSummary();

    // Bind header clicks
    document.querySelectorAll('.tc-header').forEach(function(el) {
      el.addEventListener('click', function() {
        var idx = parseInt(this.getAttribute('data-idx'));
        var body = document.getElementById('body-' + idx);
        var chev = document.getElementById('chev-' + idx);
        if (body.classList.contains('open')) {
          body.classList.remove('open');
          chev.classList.remove('open');
        } else {
          renderTcBody(idx);
          body.classList.add('open');
          chev.classList.add('open');
        }
      });
    });
  }

  // Load both data sources
  Promise.all([
    fetch('/api/synthesis-eval').then(function(r) { return r.ok ? r.json() : Promise.reject('No eval data'); }),
    fetch('/api/synthesis-raw').then(function(r) { return r.ok ? r.json() : null; })
  ]).then(function(results) {
    evalData = results[0];
    rawData = results[1];
    render();
  }).catch(function(err) {
    document.getElementById('app').innerHTML = '<div class="empty-state">Error: ' + esc(String(err)) + '</div>';
  });
})();
</script>
</body>
</html>`

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function readLabels(): unknown {
  const raw = fs.readFileSync(LABELS_PATH, 'utf-8')
  return JSON.parse(raw)
}

function writeLabels(data: unknown): void {
  fs.writeFileSync(LABELS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

const MAX_BODY_BYTES = 1_048_576 // 1 MB

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function html(res: http.ServerResponse, content: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
  })
  res.end(content)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const pathname = url.pathname

  try {
    // GET /eval/review-labels → serve HTML page
    if (req.method === 'GET' && pathname === '/eval/review-labels') {
      html(res, REVIEW_HTML)
      return
    }

    // GET /api/labels → return labels JSON
    if (req.method === 'GET' && pathname === '/api/labels') {
      const data = readLabels()
      json(res, 200, data)
      return
    }

    // POST /api/labels/override → update human_override
    if (req.method === 'POST' && pathname === '/api/labels/override') {
      const body = await collectBody(req)
      let parsed: {
        question_id: string
        chunk_id: string
        override: string | null
      }
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { error: 'Invalid JSON' })
        return
      }

      const { question_id, chunk_id, override: overrideVal } = parsed
      if (!question_id || !chunk_id) {
        json(res, 400, { error: 'Missing question_id or chunk_id' })
        return
      }

      const validOverrides = [
        'relevant',
        'partially_relevant',
        'not_relevant',
        null,
      ]
      if (!validOverrides.includes(overrideVal)) {
        json(res, 400, { error: 'Invalid override value' })
        return
      }

      const data = readLabels() as {
        questions: Array<{
          id: string
          chunks: Array<{ chunk_id: string; human_override: string | null }>
        }>
      }

      let found = false
      for (const q of data.questions) {
        if (q.id === question_id) {
          for (const c of q.chunks) {
            if (c.chunk_id === chunk_id) {
              c.human_override = overrideVal
              found = true
              break
            }
          }
          break
        }
      }

      if (!found) {
        json(res, 404, { error: 'Chunk not found' })
        return
      }

      writeLabels(data)
      json(res, 200, { ok: true })
      return
    }

    // --- Synthesis Review Routes ---

    // GET /eval/review-synthesis → serve synthesis review HTML page
    if (req.method === 'GET' && pathname === '/eval/review-synthesis') {
      html(res, SYNTHESIS_REVIEW_HTML)
      return
    }

    // GET /api/synthesis-eval → return synthesis eval JSON
    if (req.method === 'GET' && pathname === '/api/synthesis-eval') {
      if (!fs.existsSync(SYNTHESIS_EVAL_PATH)) {
        json(res, 404, {
          error:
            'answer-synthesis-eval-final.json not found. Run stages 1-2 first.',
        })
        return
      }
      const synthData = JSON.parse(
        fs.readFileSync(SYNTHESIS_EVAL_PATH, 'utf-8'),
      )
      json(res, 200, synthData)
      return
    }

    // GET /api/synthesis-raw → return captured passages (optionally filtered by ?id=)
    if (req.method === 'GET' && pathname === '/api/synthesis-raw') {
      if (!fs.existsSync(SYNTHESIS_RAW_PATH)) {
        json(res, 404, {
          error: 'answer-synthesis-raw.json not found. Run stage 1 first.',
        })
        return
      }
      const rawData = JSON.parse(fs.readFileSync(SYNTHESIS_RAW_PATH, 'utf-8'))
      const testCaseId = url.searchParams.get('id')
      if (testCaseId) {
        const tc = rawData.test_cases.find(
          (t: any) => t.test_case_id === testCaseId,
        )
        json(res, tc ? 200 : 404, tc || { error: 'Test case not found' })
      } else {
        json(res, 200, rawData)
      }
      return
    }

    // POST /api/synthesis-eval/review → update human eval for a test case
    if (req.method === 'POST' && pathname === '/api/synthesis-eval/review') {
      const postBody = await collectBody(req)
      let parsedReview: {
        test_case_id: string
        human_eval: {
          scores: Record<string, number>
          qualitative_feedback: string
          key_facts_confirmed: string[]
          key_facts_added: string[]
          reviewed: boolean
        }
      }
      try {
        parsedReview = JSON.parse(postBody)
      } catch {
        json(res, 400, { error: 'Invalid JSON' })
        return
      }

      if (!parsedReview.test_case_id || !parsedReview.human_eval) {
        json(res, 400, { error: 'Missing test_case_id or human_eval' })
        return
      }

      const he = parsedReview.human_eval
      const validDims = [
        'faithfulness',
        'completeness',
        'conciseness',
        'coherence',
        'citation_accuracy',
      ]
      if (he.scores) {
        for (const [key, val] of Object.entries(he.scores)) {
          if (
            !validDims.includes(key) ||
            typeof val !== 'number' ||
            val < 0 ||
            val > 1
          ) {
            json(res, 400, { error: `Invalid score: ${key}=${val}` })
            return
          }
        }
      }
      if (typeof he.reviewed !== 'boolean') {
        json(res, 400, { error: 'reviewed must be a boolean' })
        return
      }

      const synthEvalData = JSON.parse(
        fs.readFileSync(SYNTHESIS_EVAL_PATH, 'utf-8'),
      )
      const synthTc = synthEvalData.test_cases.find(
        (t: any) => t.test_case_id === parsedReview.test_case_id,
      )
      if (!synthTc) {
        json(res, 404, { error: 'Test case not found' })
        return
      }

      synthTc.human_eval = parsedReview.human_eval
      fs.writeFileSync(
        SYNTHESIS_EVAL_PATH,
        JSON.stringify(synthEvalData, null, 2) + '\n',
        'utf-8',
      )
      json(res, 200, { ok: true })
      return
    }

    // 404
    json(res, 404, { error: 'Not found' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Server error:', message)
    json(res, 500, { error: message })
  }
})

server.listen(PORT, () => {
  console.log(`Review server running on :${PORT}`)
  console.log(`  Labels:    http://localhost:${PORT}/eval/review-labels`)
  console.log(`  Synthesis: http://localhost:${PORT}/eval/review-synthesis`)
})
