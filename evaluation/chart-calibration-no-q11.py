"""
Generate calibration chart excluding q11 (urban finance exclude e-buses).
Recomputes sweep from raw_docs after filtering.
Usage: python3 evaluation/chart-calibration-no-q11.py [calibration-report.json]
"""

import json
import sys
import os
import numpy as np

EXCLUDE_QUERY = 'q11_urban_finance_exclude_ebuses'

# Find the most recent calibration file if no arg given
if len(sys.argv) > 1:
    report_path = sys.argv[1]
else:
    results_dir = os.path.join(os.path.dirname(__file__), 'results')
    files = sorted([f for f in os.listdir(results_dir) if f.startswith('cite-threshold-calibration') and f.endswith('.json')])
    if not files:
        print("No calibration files found")
        sys.exit(1)
    report_path = os.path.join(results_dir, files[-1])

print(f"Loading: {report_path}")
with open(report_path) as f:
    report = json.load(f)

raw_docs = [d for d in report.get('raw_docs', []) if d['query_id'] != EXCLUDE_QUERY]

# Get expected count without q11
golden_path = os.path.join(os.path.dirname(__file__), 'golden-dataset.json')
with open(golden_path) as f:
    golden = json.load(f)
total_expected = sum(len(tc['expected_urls']) for tc in golden['test_cases'] if tc['id'] != EXCLUDE_QUERY)

# Recompute sweep
all_scores = sorted([d['raw_score'] for d in raw_docs])
candidates = sorted(set(
    [round(t, 2) for t in np.arange(min(all_scores) - 0.5, max(all_scores) + 0.5, 0.25).tolist()] +
    [round(t, 2) for t in np.arange(-10, -3, 0.1).tolist()]
))

sweep = []
for t in candidates:
    tp = sum(1 for d in raw_docs if d['raw_score'] >= t and d['is_expected'])
    retained = sum(1 for d in raw_docs if d['raw_score'] >= t)
    dropped = len(raw_docs) - retained
    fn = sum(1 for d in raw_docs if d['raw_score'] < t and d['is_expected'])
    recall = tp / total_expected if total_expected > 0 else 0
    precision = tp / retained if retained > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0
    sweep.append({
        'threshold': t, 'recall': recall, 'precision': precision, 'f1': f1,
        'docs_retained': retained, 'docs_dropped': dropped,
        'true_positives': tp, 'false_negatives': fn
    })

# Find recommended floor and F1-optimal
passing = [p for p in sweep if p['recall'] >= 0.75]
rec_floor = max(passing, key=lambda p: p['threshold']) if passing else sweep[0]
f1opt = max(sweep, key=lambda p: p['f1'])

# Relevant score stats for tier thresholds
rel_scores = sorted([d['raw_score'] for d in raw_docs if d['is_expected']])
def percentile(s, p):
    if not s: return 0
    idx = (p / 100) * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)

strong_threshold = percentile(rel_scores, 70)
partial_threshold = percentile(rel_scores, 25)

rec = {
    'floor': rec_floor['threshold'],
    'floor_recall': rec_floor['recall'],
    'floor_precision': rec_floor['precision'],
    'strong_threshold': strong_threshold,
    'partial_threshold': partial_threshold,
}

# --- Chart ---
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.size': 11,
    'axes.titlesize': 14,
    'axes.titleweight': 'bold',
    'axes.labelsize': 12,
    'figure.facecolor': '#fafafa',
    'axes.facecolor': '#ffffff',
    'axes.grid': True,
    'grid.alpha': 0.3,
    'grid.linestyle': '--',
})

fig, axes = plt.subplots(2, 2, figsize=(16, 12))
fig.suptitle('Cite Mode Logit Threshold Calibration (excluding q11)', fontsize=18, fontweight='bold', y=0.98)

# --- Panel 1: Precision-Recall curve ---
ax1 = axes[0, 0]
recalls = [p['recall'] * 100 for p in sweep]
precisions = [p['precision'] * 100 for p in sweep]
thresholds = [p['threshold'] for p in sweep]

ax1.plot(recalls, precisions, 'b-', linewidth=2, alpha=0.8, zorder=2)
ax1.scatter([f1opt['recall'] * 100], [f1opt['precision'] * 100],
           color='#ef4444', s=120, zorder=5, edgecolors='white', linewidth=2)
ax1.annotate(f"F1-optimal ({f1opt['threshold']:.1f})",
            xy=(f1opt['recall'] * 100, f1opt['precision'] * 100),
            xytext=(15, 10), textcoords='offset points',
            fontsize=10, fontweight='bold', color='#ef4444',
            arrowprops=dict(arrowstyle='->', color='#ef4444', lw=1.5))

ax1.axvline(x=75, color='#22c55e', linestyle=':', linewidth=2, alpha=0.7)
ax1.text(76, ax1.get_ylim()[0] + 2, 'Recall target\n(75%)', color='#22c55e',
        fontsize=9, fontweight='bold', va='bottom')

floor_recall = rec['floor_recall'] * 100
floor_precision = rec['floor_precision'] * 100
ax1.scatter([floor_recall], [floor_precision],
           color='#16a34a', s=120, zorder=5, edgecolors='white', linewidth=2, marker='s')
ax1.annotate(f"Floor ({rec['floor']:.1f})\nR={floor_recall:.0f}% P={floor_precision:.0f}%",
            xy=(floor_recall, floor_precision),
            xytext=(-15, -25), textcoords='offset points',
            fontsize=9, fontweight='bold', color='#16a34a',
            arrowprops=dict(arrowstyle='->', color='#16a34a', lw=1.5))

ax1.set_xlabel('Recall (%)')
ax1.set_ylabel('Precision (%)')
ax1.set_title('Precision\u2013Recall Tradeoff')
ax1.set_xlim(0, 100)
ax1.set_ylim(0, 105)

# --- Panel 2: Score distributions ---
ax2 = axes[0, 1]
relevant_scores = [d['raw_score'] for d in raw_docs if d['is_expected']]
not_relevant_scores = [d['raw_score'] for d in raw_docs if not d['is_expected']]

bins = np.arange(-12, 6, 0.5)
ax2.hist(not_relevant_scores, bins=bins, alpha=0.5, color='#94a3b8', label=f'Not relevant (n={len(not_relevant_scores)})', edgecolor='white')
ax2.hist(relevant_scores, bins=bins, alpha=0.7, color='#22c55e', label=f'Relevant (n={len(relevant_scores)})', edgecolor='white')
ax2.axvline(x=f1opt['threshold'], color='#ef4444', linestyle='--', linewidth=2, label=f"F1-optimal floor ({f1opt['threshold']:.1f})")
ax2.axvline(x=rec['strong_threshold'], color='#16a34a', linestyle=':', linewidth=1.5, label=f"Strong threshold ({rec['strong_threshold']:.1f})")
ax2.axvline(x=rec['partial_threshold'], color='#f59e0b', linestyle=':', linewidth=1.5, label=f"Partial threshold ({rec['partial_threshold']:.1f})")

ax2.set_xlabel('Raw Reranker Logit')
ax2.set_ylabel('Count')
ax2.set_title('Score Distribution: Relevant vs Not Relevant')
ax2.legend(fontsize=9, loc='upper left')

# --- Panel 3: Recall & Precision vs Threshold ---
ax3 = axes[1, 0]
ax3.plot(thresholds, recalls, 'b-', linewidth=2, label='Recall', alpha=0.8)
ax3.plot(thresholds, precisions, 'r-', linewidth=2, label='Precision', alpha=0.8)
f1s = [p['f1'] * 100 for p in sweep]
ax3.plot(thresholds, f1s, 'g--', linewidth=1.5, label='F1', alpha=0.6)
ax3.axhline(y=75, color='#22c55e', linestyle=':', linewidth=1.5, alpha=0.5)
ax3.axvline(x=f1opt['threshold'], color='#ef4444', linestyle='--', linewidth=1.5, alpha=0.7,
           label=f"F1-optimal ({f1opt['threshold']:.1f})")
ax3.set_xlabel('Logit Floor Threshold')
ax3.set_ylabel('Metric (%)')
ax3.set_title('Recall, Precision & F1 vs Floor Threshold')
ax3.legend(fontsize=9)
ax3.invert_xaxis()

# --- Panel 4: Per-query retrieval coverage ---
ax4 = axes[1, 1]
query_stats = {}
for d in raw_docs:
    qid = d['query_id']
    if qid not in query_stats:
        query_stats[qid] = {'found': 0, 'total_retrieved': 0}
    query_stats[qid]['total_retrieved'] += 1
    if d['is_expected']:
        query_stats[qid]['found'] += 1

for tc in golden['test_cases']:
    qid = tc['id']
    if qid == EXCLUDE_QUERY:
        continue
    if qid in query_stats:
        query_stats[qid]['expected'] = len(tc['expected_urls'])
    else:
        query_stats[qid] = {'found': 0, 'total_retrieved': 0, 'expected': len(tc['expected_urls'])}

sorted_queries = sorted(query_stats.items(), key=lambda x: x[1]['found'] / max(x[1].get('expected', 1), 1))
labels = [q[0].replace('_', '\n', 1) for q in sorted_queries]
found = [q[1]['found'] for q in sorted_queries]
expected = [q[1].get('expected', 0) for q in sorted_queries]
missing = [e - f for e, f in zip(expected, found)]

x = np.arange(len(labels))
width = 0.6
ax4.bar(x, found, width, color='#22c55e', label='Found', edgecolor='white')
ax4.bar(x, missing, width, bottom=found, color='#fecaca', label='Missing', edgecolor='white')

for i, (f, e) in enumerate(zip(found, expected)):
    pct = f / e * 100 if e > 0 else 0
    ax4.text(i, e + 0.3, f'{pct:.0f}%', ha='center', va='bottom', fontsize=9, fontweight='bold',
            color='#16a34a' if pct >= 75 else '#dc2626')

ax4.set_xticks(x)
ax4.set_xticklabels(labels, fontsize=8)
ax4.set_ylabel('Documents')
ax4.set_title('Per-Query Retrieval Coverage (Before Any Floor)')
ax4.legend(fontsize=9)

plt.tight_layout(rect=[0, 0, 1, 0.95])

out_path = report_path.replace('.json', '-no-q11.png')
plt.savefig(out_path, dpi=150, bbox_inches='tight')
print(f"Chart saved: {out_path}")
