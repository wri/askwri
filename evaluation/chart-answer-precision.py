#!/usr/bin/env python3
"""
Generate charts showing answer mode retrieval precision improvements.

Usage: python3 evaluation/chart-answer-precision.py
Output: evaluation/results/answer-precision-charts.png
"""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# ── Data ──────────────────────────────────────────────────────────────

queries = [
    ("ans_001", "Land value\ncapture"),
    ("ans_002", "Denser cities\nsustainable?"),
    ("ans_003", "NDC\nintegration"),
    ("ans_004", "Motorcycle\nsafety"),
    ("ans_005", "Electric\nbuses"),
    ("ans_006", "Nature-based\nsolutions"),
    ("ans_007", "Slums &\nresilience"),
    ("ans_008", "Public\ntransport NDC"),
    ("ans_009", "Housing\naffordability"),
]

# Retrieval precision before (alpha=0.5) and after (alpha=0.65)
baseline_p8 =    [0.625, 0.125, 1.00, 0.875, 0.875, 0.25, 0.625, 0.875, 0.25]
phase1_p8 =      [0.625, 0.25,  1.00, 0.875, 0.875, 0.25, 0.625, 0.875, 0.375]

# Nano filter results: precision at synthesis input (100% for all)
nano_precision = [1.0] * 9

# Coverage ratings from nano filter
coverage = ["good", "limited", "good", "good", "good", "good", "limited", "good", "good"]

# Alpha sweep data
alphas = [0.5, 0.6, 0.65, 0.7]
p8_by_alpha = [0.611, 0.625, 0.639, 0.639]

# ── Chart Setup ───────────────────────────────────────────────────────

fig = plt.figure(figsize=(18, 14), facecolor='white')
fig.suptitle('Answer Mode Retrieval Precision Improvements', fontsize=20, fontweight='bold', y=0.98)
fig.text(0.5, 0.955, 'askWRI — March 2026', ha='center', fontsize=12, color='#666')

# Color palette
C_BASELINE = '#8B9DC3'    # muted blue
C_PHASE1 = '#5B7FD5'      # medium blue
C_NANO = '#2ECC71'         # green
C_WARN = '#E74C3C'         # red
C_GRID = '#E8E8E8'

# ── Chart 1: Per-Query Precision (Before → Phase 1 → Nano Filter) ────

ax1 = fig.add_subplot(2, 2, (1, 2))

x = np.arange(len(queries))
width = 0.25

bars1 = ax1.bar(x - width, baseline_p8, width, label='Baseline (α=0.5)', color=C_BASELINE, edgecolor='white', linewidth=0.5)
bars2 = ax1.bar(x, phase1_p8, width, label='Phase 1 (α=0.65)', color=C_PHASE1, edgecolor='white', linewidth=0.5)
bars3 = ax1.bar(x + width, nano_precision, width, label='+ Nano Filter', color=C_NANO, edgecolor='white', linewidth=0.5)

# Coverage warning markers
for i, cov in enumerate(coverage):
    if cov in ("limited", "poor"):
        ax1.annotate('⚠ limited', (x[i] + width, 1.02), ha='center', fontsize=7,
                     color=C_WARN, fontweight='bold')

ax1.set_ylabel('Precision @ 8', fontsize=12)
ax1.set_title('Per-Query Precision at Synthesis Input', fontsize=14, fontweight='bold', pad=12)
ax1.set_xticks(x)
ax1.set_xticklabels([q[1] for q in queries], fontsize=9)
ax1.set_ylim(0, 1.15)
ax1.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:.0%}'))
ax1.legend(loc='upper left', fontsize=10, framealpha=0.9)
ax1.grid(axis='y', color=C_GRID, linewidth=0.5)
ax1.set_axisbelow(True)
ax1.spines['top'].set_visible(False)
ax1.spines['right'].set_visible(False)

# Add 80% target line
ax1.axhline(y=0.80, color=C_WARN, linestyle='--', linewidth=1, alpha=0.6)
ax1.text(8.5, 0.81, '80% target', ha='right', fontsize=8, color=C_WARN, alpha=0.8)

# ── Chart 2: Alpha Sweep ─────────────────────────────────────────────

ax2 = fig.add_subplot(2, 2, 3)

ax2.plot(alphas, p8_by_alpha, 'o-', color=C_PHASE1, linewidth=2.5, markersize=10, markerfacecolor='white', markeredgewidth=2.5)
ax2.fill_between(alphas, p8_by_alpha, alpha=0.1, color=C_PHASE1)

# Highlight chosen value
chosen_idx = alphas.index(0.65)
ax2.plot(alphas[chosen_idx], p8_by_alpha[chosen_idx], 'o', color=C_NANO, markersize=14, markeredgewidth=2.5, markerfacecolor=C_NANO, zorder=5)
ax2.annotate(f'α=0.65\nP@8={p8_by_alpha[chosen_idx]:.1%}',
             (0.65, p8_by_alpha[chosen_idx]),
             xytext=(0.65, p8_by_alpha[chosen_idx] + 0.015),
             ha='center', fontsize=10, fontweight='bold', color=C_NANO)

ax2.set_xlabel('Alpha (dense weight)', fontsize=12)
ax2.set_ylabel('Mean P@8', fontsize=12)
ax2.set_title('Alpha Sweep: Semantic vs Keyword Balance', fontsize=14, fontweight='bold', pad=12)
ax2.set_xticks(alphas)
ax2.set_xticklabels([f'{a:.2f}\n({a:.0%} semantic)' for a in alphas], fontsize=9)
ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:.1%}'))
ax2.set_ylim(0.59, 0.67)
ax2.grid(color=C_GRID, linewidth=0.5)
ax2.set_axisbelow(True)
ax2.spines['top'].set_visible(False)
ax2.spines['right'].set_visible(False)

# ── Chart 3: Pipeline Improvement Summary ─────────────────────────────

ax3 = fig.add_subplot(2, 2, 4)

stages = ['Baseline\n(α=0.5, no filter)', 'Phase 1\n(α=0.65)', 'Phase 1 + 2\n(+ Nano Filter)']
mean_precision = [np.mean(baseline_p8), np.mean(phase1_p8), np.mean(nano_precision)]
colors = [C_BASELINE, C_PHASE1, C_NANO]

bars = ax3.bar(stages, mean_precision, color=colors, edgecolor='white', linewidth=1, width=0.6)

# Value labels on bars
for bar, val in zip(bars, mean_precision):
    ax3.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02,
             f'{val:.1%}', ha='center', fontsize=14, fontweight='bold')

# Improvement arrows
ax3.annotate('', xy=(1, mean_precision[1]), xytext=(0, mean_precision[0]),
             arrowprops=dict(arrowstyle='->', color='#333', lw=1.5))
ax3.text(0.5, (mean_precision[0] + mean_precision[1])/2 + 0.02,
         f'+{(mean_precision[1]-mean_precision[0]):.1%}', ha='center', fontsize=9, color='#333')

ax3.annotate('', xy=(2, mean_precision[2]), xytext=(1, mean_precision[1]),
             arrowprops=dict(arrowstyle='->', color='#333', lw=1.5))
ax3.text(1.5, (mean_precision[1] + mean_precision[2])/2 + 0.02,
         f'+{(mean_precision[2]-mean_precision[1]):.1%}', ha='center', fontsize=9, color='#333')

ax3.set_ylabel('Mean Precision @ Synthesis Input', fontsize=12)
ax3.set_title('Overall Pipeline Improvement', fontsize=14, fontweight='bold', pad=12)
ax3.set_ylim(0, 1.2)
ax3.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:.0%}'))
ax3.grid(axis='y', color=C_GRID, linewidth=0.5)
ax3.set_axisbelow(True)
ax3.spines['top'].set_visible(False)
ax3.spines['right'].set_visible(False)

# 80% target line
ax3.axhline(y=0.80, color=C_WARN, linestyle='--', linewidth=1, alpha=0.6)
ax3.text(2.35, 0.81, '80% target', ha='right', fontsize=8, color=C_WARN, alpha=0.8)

plt.tight_layout(rect=[0, 0, 1, 0.94])

outpath = 'evaluation/results/answer-precision-charts.png'
plt.savefig(outpath, dpi=150, bbox_inches='tight', facecolor='white')
print(f'Saved to {outpath}')
