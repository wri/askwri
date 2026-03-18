# Score Distribution Analysis

## Overview

Collects raw cross-encoder logit scores and normalized scores for all golden-set
queries against the live search service, then visualizes the score distributions
to help calibrate relevance thresholds.


## Step 0 - start the search service 

The search service is locatred in askwri/search-service
$ uv run python -m app.main

Make sure the index has loaded up completely 

## Step 1 — Run the data collection script

Requires the search service running on `http://localhost:8000`.

```bash
npx tsx --env-file-if-exists=.env evaluation/score-distribution-analysis.ts
```

Output is written to:

```
evaluation/results/score-distribution-<timestamp>.json
```

## Step 2 — Explore results in the notebook

```bash
uvx marimo edit --sandbox evaluation/score_distribution_notebook.py
```

The notebook auto-discovers files in `evaluation/results/` and lets you select
which run to load via a dropdown. Use the threshold slider to explore precision/
recall tradeoffs and see recommended values for `CITE_LOGIT_FLOOR` and
`ANSWER_LOGIT_FLOOR`.
