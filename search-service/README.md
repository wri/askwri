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
| Dense (vector) top_k | 500 | 150 |
| Sparse (BM25) top_k | 500 | 150 |
| Fusion top_k | 200 | 100 |
| Dense weight | 0.5 | 0.65 |
| Sparse weight | 0.5 | 0.35 |
| RRF k | 60 | 60 |

All parameters flow through from request — values above are defaults from `src/config/retrieval.ts` (`CITE_PRESET` / `ANSWER_PRESET`).

BM25 queries receive **conservative query expansion** via domain-specific synonym mapping (e.g., "micromobility" → ["bike sharing", "e-bikes", "scooters"]). See `app/query_expansion.py`.

### 3. Voyage Reranking

After fusion, results are reranked using **Voyage rerank-2.5** (API-based). This replaced local cross-encoder models (MiniLM-L-6/L-12) which took 28s on Fargate — Voyage completes in <1s.

Requires `VOYAGE_API_KEY` in environment. If the key is missing, reranking is skipped and fusion results are returned as-is.

### 4. Cite Mode: Score Floor & Relevance Tiers

In cite mode, results are grouped by document (best chunk per doc), then filtered and tiered based on Voyage scores (0-1 range):

| Tier | Score threshold | Meaning |
|------|----------------|---------|
| **Strong** | ≥ 0.80 | High confidence match |
| **Partial** | ≥ 0.60 | Moderate relevance |
| **Weak** | ≥ 0.50 | Low but above floor |
| Dropped | < 0.50 | Below floor, not returned |

Calibrated against 11-query golden dataset (2026-03-22): P=33.2%, R=77%, F1=45%, 8/11 passed.

Thresholds are configured in `app/config.py`:
```python
cite_score_floor: float = 0.50
cite_strong_threshold: float = 0.80
cite_partial_threshold: float = 0.60
```

### 5. Answer Mode Relevance

Answer mode does **not** use a score floor. Calibration showed Voyage scores (like the previous cross-encoder logits) cannot separate relevant from irrelevant chunks — the score distributions overlap completely (both span 0.0–1.0). The reranker is a ranking tool, not a classifier.

Answer mode returns the top `max_results` (default 15) chunks by Voyage score. Relevance filtering happens downstream in the Next.js answer route via the synthesis LLM.

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
  "rerank_top_n": 500,
  "vector_top_k": 500,
  "bm25_top_k": 500,
  "fusion_top_k": 200,
  "dense_weight": 0.5,
  "sparse_weight": 0.5
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
#   VOYAGE_API_KEY=pa-...
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
| `VOYAGE_API_KEY` | — | Required for reranking (Voyage rerank-2.5) |
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
  -e VOYAGE_API_KEY=pa-... \
  -e DOCUMENTS_LOCAL_DIR=/data \
  askwri-search-service
```

## Deployment

Deployed via Terraform to AWS ECS Fargate. See `/terraform/infrastructure/`.

`VOYAGE_API_KEY` must be added to the `SEARCH_SERVICE_ENV` GitHub secret.

## Project Structure

```
search-service/
├── app/
│   ├── main.py              # FastAPI app, retrieval pipeline, Voyage reranking
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
