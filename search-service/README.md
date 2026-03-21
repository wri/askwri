# AskWRI Search Service

Search service for AskWRI application, deployed via AWS ECS Fargate.

## Overview

This service provides hybrid document retrieval and reranking for the AskWRI application. It supports two modes:
- **Cite mode**: Returns ranked documents with relevance tiers for citation-style search
- **Answer mode**: Returns documents for LLM-based answer generation

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   ALB           │────▶│  Next.js Backend │────▶│ Search Service  │
│                 │     │  (ECS Fargate)   │     │  (ECS Fargate)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

The search service is internal — the Next.js backend proxies all requests.

## Retrieval Pipeline

### 1. Indexing

On startup, the service:
1. Parses PDFs from the documents directory (400-char chunks, 80-char overlap)
2. Generates **summary nodes** from `documents.csv` metadata (one per document)
3. Builds a **vector index** (OpenAI embeddings) and a **BM25 index** over all nodes
4. Caches parsed nodes and embeddings to avoid reprocessing on restart

### 2. Hybrid Retrieval

Queries use **Reciprocal Rank Fusion (RRF)** to combine two retrieval strategies:

| Parameter | Cite mode | Answer mode |
|-----------|-----------|-------------|
| Dense (vector) top_k | 800 | 200 |
| Sparse (BM25) top_k | 800 | 200 |
| Fusion top_k | 500 | 200 |
| Dense weight | 0.5 | 0.5 |
| Sparse weight | 0.5 | 0.5 |
| RRF k | 60 | 60 |

BM25 queries receive **conservative query expansion** via domain-specific synonym mapping (e.g., "micromobility" → ["bike sharing", "e-bikes", "scooters"]). See `app/query_expansion.py`.

### 3. Cross-Encoder Reranking

After fusion, results are reranked using `cross-encoder/ms-marco-MiniLM-L-6-v2` (22M params).

| Parameter | Cite mode | Answer mode |
|-----------|-----------|-------------|
| rerank_top_n | 250 | 120 |

The reranker produces raw logit scores (not probabilities). Higher = more relevant.

### 4. Cite Mode: Logit Floor & Relevance Tiers

In cite mode, results are filtered and tiered based on calibrated logit thresholds:

| Tier | Logit threshold | Meaning |
|------|----------------|---------|
| **Strong** | ≥ -2.3 | Top ~30% of relevant scores (70th percentile) |
| **Partial** | ≥ -7.8 | Middle ~45% (25th–70th percentile) |
| **Weak** | ≥ -9.0 | Bottom ~25% of relevant scores |
| Dropped | < -9.0 | Below floor, not returned |

These are **universal fixed cutpoints** derived from calibration against a golden evaluation dataset. They reflect absolute reranker confidence, not position within a given query's results. A query with easy matches may return all "Strong"; a hard query may return mostly "Weak."

Thresholds are configured in `app/config.py`:
```python
cite_logit_floor: float = -9.0        # Drop docs below this raw logit
cite_strong_threshold: float = -2.3   # 70th percentile of relevant scores
cite_partial_threshold: float = -7.8  # 25th percentile of relevant scores
```

The response includes `raw_score` (logit) and `relevance_tier` ("strong"/"partial"/"weak") per document.

### 5. Answer Mode Relevance

Answer mode does **not** use reranker logit thresholds to assign relevance tiers.

Calibration (see `evaluation/calibrate-answer-thresholds.ts`) showed that cross-encoder scores cannot separate relevant from irrelevant chunks for answer-mode queries: the relevant and irrelevant score distributions overlap almost completely (relevant median 2.25, irrelevant median 2.07). The reranker is a ranking tool, not a classifier — it coarsely selects the top candidates but cannot discriminate within them.

**Relevance tiers for answer mode come from the synthesis LLM (GPT-5.4)**, not the reranker. The synthesis prompt instructs GPT-5.4 to classify each source as `strong` (used in synthesis), `partial` (on-topic but not used), or `weak` (not relevant). This costs zero extra LLM calls.

**Gated logit floor config** exists in `app/config.py` (`answer_use_logit_floor`, `answer_logit_floor`, `answer_strong_threshold`, `answer_partial_threshold`) but is inactive (`answer_use_logit_floor = False`). It is retained for future use if better calibration data produces clearer score separation.

**Coverage assessment** uses `gpt-5.4-nano` in the Next.js layer (`/api/answer-coverage`), not the search service. It provides an absolute query-level rating (good/limited/poor) before synthesis runs.

### 6. Document Deduplication

Cite mode deduplicates by document ID, keeping the best chunk score per document.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/query` | POST | Main query endpoint |

### POST /query

```json
{
  "query": "electric buses in Latin America",
  "mode": "cite",
  "max_results": 100,
  "rerank": true,
  "rerank_top_n": 250,
  "vector_top_k": 800,
  "bm25_top_k": 800
}
```

## Local Development

### Prerequisites

- Python 3.12+
- pip

### Setup

```bash
cd search-service

# Install dependencies
pip install -r requirements.txt

# Create .env with:
#   OPENAI_API_KEY=sk-...
#   DOCUMENTS_LOCAL_DIR=./data

# Place documents.csv and PDF files in ./data/

# Start the service
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# Index build takes 1-2 minutes on first start; cached after that
```

### API Documentation

Once running: http://localhost:8000/docs

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | — | Required for embeddings |
| `DOCUMENTS_LOCAL_DIR` | `/tmp/askWRI_docs` | Directory containing documents.csv and PDFs |
| `ENVIRONMENT` | `development` | Environment name |
| `PORT` | `8000` | Server port |
| `WORKERS` | `1` | Number of uvicorn workers |
| `LOG_LEVEL` | `info` | Logging level |

## Docker

```bash
docker build -t askwri-search-service .
docker run -p 8000:8000 \
  -e OPENAI_API_KEY=sk-... \
  -e DOCUMENTS_LOCAL_DIR=/data \
  askwri-search-service
```

## Deployment

Deployed via Terraform to AWS ECS Fargate. See `/terraform/infrastructure/`.

## Project Structure

```
search-service/
├── app/
│   ├── main.py              # FastAPI app, retrieval pipeline, reranking
│   ├── config.py            # Settings (thresholds, paths, ports)
│   ├── query_expansion.py   # Domain-specific BM25 synonym expansion
│   └── routers/
│       └── api.py           # API routes
├── data/                    # Local documents (not in git)
│   ├── documents.csv        # Document metadata catalog
│   └── *.pdf                # PDF corpus
├── Dockerfile
├── requirements.txt
└── README.md
```
