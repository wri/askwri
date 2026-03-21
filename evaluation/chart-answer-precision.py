#!/usr/bin/env python3
"""
Generate charts showing answer mode retrieval precision improvements.

Usage: python3 evaluation/chart-answer-precision.py
Output: evaluation/results/answer-precision-charts.png
"""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
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

# Alpha sweep data
alphas = [0.5, 0.6, 0.65, 0.7]
p8_by_alpha = [0.611, 0.625, 0.639, 0.639]

# Synthesis quality: baseline vs with nano filter (regressed)
synth_dimensions = ['Faithfulness', 'Completeness', 'Conciseness', 'Coherence', 'Citation\nAccuracy']
synth_baseline =   [0.811, 0.889, 0.944, 0.956, 0.811]
synth_nano =       [0.800, 0.867, 0.911, 0.911, 0.800]

# ── Chart Setup ───────────────────────────────────────────────────────

fig = plt.figure(figsize=(18, 14), facecolor='white')
fig.suptitle('Answer Mode Retrieval & Synthesis Analysis', fontsize=20, fontweight='bold', y=0.98)
fig.text(0.5, 0.955, 'askWRI — March 2026', ha='center', fontsize=12, color='#666')

# Color palette
C_BASELINE = '#8B9DC3'    # muted blue
C_PHASE1 = '#5B7FD5'      # medium blue
C_NANO = '#E8A838'         # amber (caution — unproven)
C_WARN = '#E74C3C'         # red
C_GOOD = '#2ECC71'         # green
C_GRID = '#E8E8E8'

# ── Chart 1: Per-Query Retrieval Precision (Before → After) ──────────

ax1 = fig.add_subplot(2, 2, (1, 2))

x = np.arange(len(queries))
width = 0.35

bars1 = ax1.bar(x - width/2, baseline_p8, width, label='Baseline (α=0.5)', color=C_BASELINE, edgecolor='white', linewidth=0.5)
bars2 = ax1.bar(x + width/2, phase1_p8, width, label='Phase 1 (α=0.65)', color=C_PHASE1, edgecolor='white', linewidth=0.5)

# Highlight improved queries
for i in range(len(queries)):
    if phase1_p8[i] > baseline_p8[i]:
        ax1.annotate(f'+{(phase1_p8[i]-baseline_p8[i]):.0%}',
                     (x[i] + width/2, phase1_p8[i] + 0.02),
                     ha='center', fontsize=9, fontweight='bold', color=C_GOOD)

# Mark worst queries
for i in range(len(queries)):
    if phase1_p8[i] < 0.5:
        ax1.annotate('⚠', (x[i], -0.06), ha='center', fontsize=14, color=C_WARN)

ax1.set_ylabel('Precision @ 8', fontsize=12)
ax1.set_title('Per-Query Retrieval Precision (What Reaches Synthesis)', fontsize=14, fontweight='bold', pad=12)
ax1.set_xticks(x)
ax1.set_xticklabels([q[1] for q in queries], fontsize=9)
ax1.set_ylim(-0.1, 1.15)
ax1.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:.0%}'))
ax1.legend(loc='upper left', fontsize=10, framealpha=0.9)
ax1.grid(axis='y', color=C_GRID, linewidth=0.5)
ax1.set_axisbelow(True)
ax1.spines['top'].set_visible(False)
ax1.spines['right'].set_visible(False)

# 80% target line
ax1.axhline(y=0.80, color=C_WARN, linestyle='--', linewidth=1, alpha=0.6)
ax1.text(8.5, 0.81, '80% target', ha='right', fontsize=8, color=C_WARN, alpha=0.8)

# Note about worst queries
ax1.text(0.02, 0.02, '⚠ = below 50% precision (needs LLM filter or better reranker)',
         transform=ax1.transAxes, fontsize=8, color=C_WARN, style='italic')

# ── Chart 2: Alpha Sweep ─────────────────────────────────────────────

ax2 = fig.add_subplot(2, 2, 3)

ax2.plot(alphas, p8_by_alpha, 'o-', color=C_PHASE1, linewidth=2.5, markersize=10, markerfacecolor='white', markeredgewidth=2.5)
ax2.fill_between(alphas, p8_by_alpha, alpha=0.1, color=C_PHASE1)

# Highlight chosen value
chosen_idx = alphas.index(0.65)
ax2.plot(alphas[chosen_idx], p8_by_alpha[chosen_idx], 'o', color=C_GOOD, markersize=14, markeredgewidth=2.5, markerfacecolor=C_GOOD, zorder=5)
ax2.annotate(f'α=0.65\nP@8={p8_by_alpha[chosen_idx]:.1%}',
             (0.65, p8_by_alpha[chosen_idx]),
             xytext=(0.65, p8_by_alpha[chosen_idx] + 0.015),
             ha='center', fontsize=10, fontweight='bold', color=C_GOOD)

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

# ── Chart 3: Synthesis Quality (Baseline vs Nano Filter) ─────────────

ax3 = fig.add_subplot(2, 2, 4)

x3 = np.arange(len(synth_dimensions))
width3 = 0.35

bars_base = ax3.bar(x3 - width3/2, synth_baseline, width3, label='Baseline', color=C_PHASE1, edgecolor='white', linewidth=0.5)
bars_nano = ax3.bar(x3 + width3/2, synth_nano, width3, label='+ Nano Filter', color=C_NANO, edgecolor='white', linewidth=0.5)

# Show deltas
for i in range(len(synth_dimensions)):
    delta = synth_nano[i] - synth_baseline[i]
    color = C_WARN if delta < 0 else C_GOOD
    ax3.text(x3[i] + width3/2, synth_nano[i] + 0.01,
             f'{delta:+.1%}', ha='center', fontsize=8, fontweight='bold', color=color)

ax3.set_ylabel('Score (0–1)', fontsize=12)
ax3.set_title('Synthesis Quality: Nano Filter Regressed All Dimensions', fontsize=14, fontweight='bold', pad=12, color=C_WARN)
ax3.set_xticks(x3)
ax3.set_xticklabels(synth_dimensions, fontsize=9)
ax3.set_ylim(0.7, 1.05)
ax3.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:.0%}'))
ax3.legend(loc='upper right', fontsize=10, framealpha=0.9)
ax3.grid(axis='y', color=C_GRID, linewidth=0.5)
ax3.set_axisbelow(True)
ax3.spines['top'].set_visible(False)
ax3.spines['right'].set_visible(False)

# Caveat
ax3.text(0.02, 0.02, 'Nano filter currently gated off (USE_NANO_FILTER=false)\nNeeds independent validation before enabling',
         transform=ax3.transAxes, fontsize=8, color='#666', style='italic')

plt.tight_layout(rect=[0, 0, 1, 0.94])

outpath = 'evaluation/results/answer-precision-charts.png'
plt.savefig(outpath, dpi=150, bbox_inches='tight', facecolor='white')
print(f'Saved to {outpath}')
