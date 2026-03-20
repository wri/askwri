"""
Generate calibration charts from cite threshold sweep results.
Usage: python3 evaluation/chart-calibration.py evaluation/results/cite-threshold-calibration-*.json
"""

import json
import sys
import os
import numpy as np

# Find the most recent calibration file if no arg given
if len(sys.argv) > 1:
    report_path = sys.argv[1]
else:
    results_dir = os.path.join(os.path.dirname(__file__), 'results')
    files = sorted([f for f in os.listdir(results_dir) if f.startswith('cite-threshold-calibration')])
    if not files:
        print("No calibration files found")
        sys.exit(1)
    report_path = os.path.join(results_dir, files[-1])

print(f"Loading: {report_path}")
with open(report_path) as f:
    report = json.load(f)

sweep = report['sweep_data']
raw_docs = report.get('raw_docs', [])
rec = report['recommended']
f1opt = report['f1_optimal']

# --- Chart 1 & 2 & 3: Combined figure ---
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.patches import FancyBboxPatch
    import matplotlib.patheffects as pe
except ImportError:
    print("matplotlib not installed. Install with: pip install matplotlib")
    sys.exit(1)

# Style
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
fig.suptitle('Cite Mode Logit Threshold Calibration', fontsize=18, fontweight='bold', y=0.98)

# --- Panel 1: Precision-Recall curve ---
ax1 = axes[0, 0]
recalls = [p['recall'] * 100 for p in sweep]
precisions = [p['precision'] * 100 for p in sweep]
thresholds = [p['threshold'] for p in sweep]

ax1.plot(recalls, precisions, 'b-', linewidth=2, alpha=0.8, zorder=2)

# Mark F1-optimal
ax1.scatter([f1opt['recall'] * 100], [f1opt['precision'] * 100],
           color='#ef4444', s=120, zorder=5, edgecolors='white', linewidth=2)
ax1.annotate(f"F1-optimal ({f1opt['floor']:.1f})",
            xy=(f1opt['recall'] * 100, f1opt['precision'] * 100),
            xytext=(15, 10), textcoords='offset points',
            fontsize=10, fontweight='bold', color='#ef4444',
            arrowprops=dict(arrowstyle='->', color='#ef4444', lw=1.5))

# Mark 75% recall line
ax1.axvline(x=75, color='#22c55e', linestyle=':', linewidth=2, alpha=0.7)
ax1.text(76, ax1.get_ylim()[0] + 2, 'Recall target\n(75%)', color='#22c55e',
        fontsize=9, fontweight='bold', va='bottom')

# Mark floor point
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
ax1.set_title('Precision–Recall Tradeoff')
ax1.set_xlim(0, 100)
ax1.set_ylim(0, 105)

# --- Panel 2: Score distributions (histogram) ---
ax2 = axes[0, 1]
relevant_scores = [d['raw_score'] for d in raw_docs if d['is_expected']]
not_relevant_scores = [d['raw_score'] for d in raw_docs if not d['is_expected']]

bins = np.arange(-12, 6, 0.5)
ax2.hist(not_relevant_scores, bins=bins, alpha=0.5, color='#94a3b8', label=f'Not relevant (n={len(not_relevant_scores)})', edgecolor='white')
ax2.hist(relevant_scores, bins=bins, alpha=0.7, color='#22c55e', label=f'Relevant (n={len(relevant_scores)})', edgecolor='white')

# Mark F1-optimal floor
ax2.axvline(x=f1opt['floor'], color='#ef4444', linestyle='--', linewidth=2, label=f"F1-optimal floor ({f1opt['floor']:.1f})")

# Mark tier boundaries
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
ax3.axvline(x=f1opt['floor'], color='#ef4444', linestyle='--', linewidth=1.5, alpha=0.7,
           label=f"F1-optimal ({f1opt['floor']:.1f})")

ax3.set_xlabel('Logit Floor Threshold')
ax3.set_ylabel('Metric (%)')
ax3.set_title('Recall, Precision & F1 vs Floor Threshold')
ax3.legend(fontsize=9)
ax3.invert_xaxis()

# --- Panel 4: Per-query retrieval coverage ---
ax4 = axes[1, 1]

# Compute per-query stats
query_stats = {}
for d in raw_docs:
    qid = d['query_id']
    if qid not in query_stats:
        query_stats[qid] = {'found': 0, 'total_retrieved': 0}
    query_stats[qid]['total_retrieved'] += 1
    if d['is_expected']:
        query_stats[qid]['found'] += 1

# Get expected counts from the golden set
golden_path = os.path.join(os.path.dirname(__file__), 'golden-dataset.json')
with open(golden_path) as f:
    golden = json.load(f)
for tc in golden['test_cases']:
    qid = tc['id']
    if qid in query_stats:
        query_stats[qid]['expected'] = len(tc['expected_urls'])
    else:
        query_stats[qid] = {'found': 0, 'total_retrieved': 0, 'expected': len(tc['expected_urls'])}

# Sort by recall (ascending for visual impact)
sorted_queries = sorted(query_stats.items(), key=lambda x: x[1]['found'] / max(x[1].get('expected', 1), 1))

labels = [q[0].replace('_', '\n', 1) for q in sorted_queries]
found = [q[1]['found'] for q in sorted_queries]
expected = [q[1].get('expected', 0) for q in sorted_queries]
missing = [e - f for e, f in zip(expected, found)]

x = np.arange(len(labels))
width = 0.6

bars1 = ax4.bar(x, found, width, color='#22c55e', label='Found', edgecolor='white')
bars2 = ax4.bar(x, missing, width, bottom=found, color='#fecaca', label='Missing', edgecolor='white')

# Add recall % labels on bars
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

out_path = report_path.replace('.json', '.png')
plt.savefig(out_path, dpi=150, bbox_inches='tight')
print(f"Chart saved: {out_path}")
