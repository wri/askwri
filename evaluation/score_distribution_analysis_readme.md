# Score Distribution Analysis

Collects raw cross-encoder logit scores and normalized scores for golden-set
queries, then visualizes the distributions to help calibrate relevance thresholds.

Two variants — one for each retrieval mode:

| Mode       | Unit                               | Data collection script                  | Notebook                                |
| ---------- | ---------------------------------- | --------------------------------------- | --------------------------------------- |
| **Cite**   | Documents (one per `doc_id`)       | `score_distribution_analysis_cite.ts`   | `score_distribution_analysis_cite.py`   |
| **Answer** | Passages/chunks (multiple per doc) | `score_distribution_analysis_answer.ts` | `score_distribution_analysis_answer.py` |

---

## Prerequisites — start the search service

The search service is located in `askwri/search-service`.

```bash
cd search-service && uv run python -m app.main
```

Wait until the index has fully loaded before running either script.

---

## Cite mode

### Step 1 — Collect data

```bash
npx tsx --env-file-if-exists=.env evaluation/score_distribution_analysis_cite.ts
```

Output written to `evaluation/results/score-distribution-<timestamp>.json`.

Retrieval params: `vector_top_k=800, bm25_top_k=800, rerank_top_n=200, max_results=200`.
Relevance labeling: URL slug match against `golden-dataset.json`.

### Step 2 — Explore in the notebook

```bash
uvx marimo edit --sandbox evaluation/score_distribution_analysis_cite.py
```

The notebook auto-discovers files in `evaluation/results/` and lets you select
which run to load via a dropdown. Use the threshold slider to explore precision/
recall tradeoffs and see recommended values for `CITE_LOGIT_FLOOR`.

---

## Answer mode

### Step 1 — Collect data

```bash
npx tsx --env-file-if-exists=.env evaluation/score_distribution_analysis_answer.ts
```

Output written to `evaluation/results/answer-score-distribution-<timestamp>.json`.

Retrieval params: `vector_top_k=500, bm25_top_k=500, rerank_top_n=100, max_results=100`
(wider than the production preset of 20 to expose the full score distribution).
Relevance labeling: `chunk_id` match against `answer-golden-dataset.json`, with
exact and adjacent (±1) tolerance tracked separately.

### Step 2 — Explore in the notebook

```bash
uvx marimo edit --sandbox evaluation/score_distribution_analysis_answer.py
```

The notebook auto-discovers `answer-score-distribution-*.json` files in
`evaluation/results/`. Features:

- Histogram and KDE of raw logits and normalized scores, split by relevance label
  (exact / adjacent / not-relevant)
- Per-query breakdown table
- Interactive threshold slider showing precision and recall (exact + adjacent)
  at the selected logit floor, for a single query and across all queries
- PR and ROC curves with AUC
- Threshold recommendations table:
  - **Synthesis floor** — most aggressive threshold keeping exact recall ≥ 80%
  - **High-precision floor** — highest precision with exact recall ≥ 50%
  - **F1-optimal** — shown for reference

Use the recommendations to calibrate `ANSWER_LOGIT_FLOOR` if you want to filter
passages before synthesis in `src/app/api/answer/route.ts`.
