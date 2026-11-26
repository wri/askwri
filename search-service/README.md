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

With the `legacy` retrieval backend, on startup the service:
1. Parses PDFs from the documents directory (400-char chunks, 80-char overlap)
2. Generates **summary nodes** from `documents.csv` metadata (one per document)
3. Builds an in-memory index over all nodes, embedding chunks with Cohere Embed v4
   via Bedrock (`cohere-embed-v4`; `text-embedding-3-small` is the OpenAI rollback)
4. Caches parsed nodes and embeddings to avoid reprocessing on restart

With the `postgres` backend (see *Postgres-backed retrieval* below) there is no
boot-time parsing or embedding: chunks, sparse vectors and embeddings are read
from Postgres. Ingestion and embedding are the worker's job, not the service's.

### 2. Hybrid Retrieval

Queries use **Reciprocal Rank Fusion (RRF)** to combine two retrieval strategies:

| Parameter | Cite mode | Answer mode |
|-----------|-----------|-------------|
| Dense (vector) top_k | 500 | 150 |
| Sparse (BM25) top_k | 500 | 150 |
| Fusion top_k | 500 | 100 |
| Dense weight | 0.5 | 0.65 |
| Sparse weight | 0.5 | 0.35 |
| RRF k | 60 | 60 |

These are the app's presets (`CITE_PRESET` / `ANSWER_PRESET` in
`src/config/retrieval.ts`), sent with every request. The service's own
`QueryRequest` defaults (500 / 500 / 200) apply only when a caller omits them.

BM25 runs on the Postgres-resident sparse impact vectors by default
(`KEYWORD_BACKEND=sparse`), not an in-memory index. Queries may additionally
receive **query expansion**: semantic tag lanes and LLM-generated variants, both
gated per environment by `QUERY_UNDERSTANDING_ENABLED` /
`QUERY_EXPANSION_LANES_ENABLED` / `QUERY_UNDERSTANDING_LLM_ENABLED`. Where those
lanes are off, the legacy conservative synonym mapping still applies (e.g.
"micromobility" → ["bike sharing", "e-bikes", "scooters"]); see
`app/query_expansion.py`. Expansion never changes the `/query` contract.

### 3. Cross-Encoder Reranking

After fusion, results are reranked using **Cohere Rerank 3.5 via AWS Bedrock**
(`app/bedrock_rerank.py`; region from `BEDROCK_RERANK_REGION`).

| Parameter | Cite mode | Answer mode |
|-----------|-----------|-------------|
| rerank_top_n | 500 | 20 |
| max_results returned | 25 | 15 |

Cite mode sets `rerank_top_n == fusion_top_k`, so nothing is dropped between
fusion and rerank and the relevance floor is the sole quality gate. Its 25-doc
cap — not the floor — bounds list length, because the UI renders every returned
doc.

Only the top `RERANK_CANDIDATES` fused candidates are sent to Bedrock; the
un-reranked tail is dropped rather than passed through. The reranker returns
**0–1 relevance scores** (not logits). Higher = more relevant.

### 4. Cite Mode: Relevance Floor & Tiers

In cite mode, results are filtered and tiered on the 0–1 rerank scale:

| Tier | Score | Meaning |
|------|-------|---------|
| **Strong** | ≥ 0.70 | Top of the relevant score distribution |
| **Partial** | ≥ 0.30 | Middle of the relevant score distribution |
| **Weak** | ≥ 0.09 | Low relevance, still above the floor |
| Dropped | < 0.09 | Below floor, not returned |

These are **universal fixed cutpoints** derived from calibration against a golden evaluation dataset, and re-derived whenever the corpus, chunk text or embedding model changes. They reflect absolute reranker confidence, not position within a given query's results. A query with easy matches may return all "Strong"; a hard query may return mostly "Weak."

Thresholds are configured in `app/config.py`:
```python
cite_logit_floor: float = 0.09        # Drop docs below this relevance score
cite_strong_threshold: float = 0.70
cite_partial_threshold: float = 0.30
```

The response includes `raw_score` and `relevance_tier` ("strong"/"partial"/"weak") per document.

`TODO(golden-set)`: the floor and tiers were derived on English-dominant sets and
are pending per-language recalibration (issue #498 item 20).

### 5. Answer Mode Relevance

Answer mode does **not** use reranker logit thresholds to assign relevance tiers.

Calibration showed that cross-encoder scores cannot separate relevant from irrelevant chunks for answer-mode queries: the relevant and irrelevant score distributions overlap almost completely (relevant median 2.25, irrelevant median 2.07). The reranker is a ranking tool, not a classifier — it coarsely selects the top candidates but cannot discriminate within them.

**Relevance filtering for answer mode happens in the Next.js answer route**, not the search service. After the search service returns up to 15 chunks, the answer route can score each chunk for relevance before synthesis. That prefilter is **off by default** (`USE_NANO_FILTER=false`); its model comes from the `MODEL_PREFILTER` lever (see `src/config/models.ts`). With it off, synthesis assigns source relevance itself.

**The answer-mode logit floor experiment has been removed.** Calibration showed cross-encoder scores cannot separate relevant from irrelevant chunks for answer-mode queries (relevant median 2.25, irrelevant median 2.07). The logit floor config (`answer_use_logit_floor`, `answer_logit_floor`, etc.) has been removed from `app/config.py`.

**The query-level overview** is produced by the Next.js `/api/alignment` route, not the search service. It rates how well the retrieved set answers the query and reports `provenance.produced`; when no model authored the rating the UI shows an explicit unavailable state rather than a rating.

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

# Install dependencies. requirements.txt is PINNED pip-compile output —
# every direct and transitive version is fixed, so this matches the deploy
# image exactly. Edit requirements.in (never the .txt), then regenerate:
#   ./scripts/compile-requirements.sh
pip install -r requirements.txt

# To make the venv match the lock exactly (removes anything not in it):
#   pip install pip-tools && pip-sync requirements.txt requirements-dev.txt

# Create .env with:
#   OPENAI_API_KEY=sk-...
#   DOCUMENTS_LOCAL_DIR=./data

# Place documents.csv and PDF files in ./data/

# Start the service
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000

# The legacy backend builds the index on first start (slow at corpus scale, cached after that).
# The postgres backend skips this entirely — see "Postgres-backed retrieval" below.
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
| `RETRIEVAL_BACKEND` | `legacy` | `legacy` (CSV + boot-time index build) or `postgres` (read chunks/embeddings from Postgres) |
| `DATABASE_URL` | — | Postgres connection URL; required for `postgres` backend and the migration script (append `?sslmode=require` for RDS) |
| `EMBEDDING_MODEL` | `cohere-embed-v4` | Dense model for chunk writes + query encode: `cohere-embed-v4` (Bedrock) or `text-embedding-3-small` (OpenAI rollback) |
| `BEDROCK_EMBED_REGION` | `us-east-1` | Bedrock region hosting Cohere embed-v4 (infra runs in us-east-2; cross-region call) |
| `BEDROCK_RERANK_REGION` | `us-west-2` | Bedrock region hosting Cohere Rerank 3.5 |
| `RERANK_CANDIDATES` | `100` | Fused candidates sent to the Bedrock Rerank API (cost/latency scale with count) |
| `CITE_RERANK_PER_DOC_CAP` | `2` | Max chunks per doc in the cite-mode rerank candidate set (doc-coverage lever; answer mode uncapped) |
| `CITE_LOGIT_FLOOR` | `0.09` | Cite-mode relevance floor on the 0–1 rerank scale (re-derived after each corpus or embedding change, most recently post-Mistral-re-parse; re-derive with `scripts/capture_cite_scores.py` + `analyze_cite_scores.py` after candidate-pool changes) |
| `CITE_SUBSTITUTE_SUMMARY_PASSAGE` | `false` | Cite mode: show a real passage for documents whose best chunk is the synthetic summary node, carrying its score and tier over (issue #233). Ranking is unchanged by construction; only `content`/`page`/`chunk_id` move, for ~1% of golden-set and ~3% of cross-lingual result rows |
| `PARSE_BACKEND` | `pypdf` | Worker parse stage: `pypdf` (text layer, validation oracle) or `mistral` (Mistral OCR markdown, per-page; ratified for Phase C, default flips after the Phase 1 gate) |
| `MISTRAL_API_KEY` | — | Required when `PARSE_BACKEND=mistral` |
| `MISTRAL_OCR_MODEL` | `mistral-ocr-latest` | Mistral OCR model id |
| `BEDROCK_EMBED_MODEL_ID` | `cohere.embed-v4:0` | Bedrock invoke target for embed; set `us.cohere.embed-v4:0` (cross-region profile, 2× quota) for bulk re-embeds/re-ingests |

## Docs

- [docs/document-management.md](../docs/document-management.md) — Phase 0 as-built reference (schema, lifecycle, retrieval backends, parity status)
- [docs/runbooks/phase0-cutover.md](../docs/runbooks/phase0-cutover.md) — local dev setup, production cutover steps, rollback

## Postgres-backed retrieval (Phase 0)

Two boot modes, switched by `RETRIEVAL_BACKEND`:

- **`legacy`** (default): parses `documents.csv` + PDFs, builds in-memory indexes at boot (cached; slow cold start).
- **`postgres`**: reads `document_chunks` (text + embeddings + node metadata) from Postgres at boot — no CSV, no PDF parsing, no OpenAI calls at startup. Dense retrieval runs per-query against pgvector; BM25 is hydrated from the chunk rows in `corpus_order` (which must match the legacy node build order — BM25 breaks score ties by corpus position).

One-time corpus migration (schema first via `npm run migration:run` at the repo root):

```bash
./venv/bin/python -m scripts.migrate_csv_to_postgres [--reset]
```

The `/query` request/response contract (`QueryRequest`/`QueryResponse` in `app/main.py`) is frozen — both backends serve it identically. Parity vs the golden sets is recorded in `docs/plans/2026-06-09-phase0-store-and-migration-plan.md` (Task 10).

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
│   ├── bedrock_embed.py     # Cohere Embed v4 via Bedrock
│   ├── bedrock_rerank.py    # Cohere Rerank 3.5 via Bedrock
│   ├── pg_store.py          # Postgres reads: chunks, embeddings, sparse vectors
│   ├── sparse_keyword.py    # Postgres-resident BM25 impact vectors
│   ├── understanding.py     # Deterministic query understanding (tags, facets)
│   ├── understanding_llm.py # LLM sidecar: core topic, variants, off-topic check
│   ├── query_expansion.py   # Legacy synonym expansion (lanes-off path)
│   ├── query_translate.py   # Cross-language query translation
│   ├── indexing.py          # Legacy CSV + PDF index build
│   └── routers/
│       └── api.py           # API routes
├── data/                    # Local documents (not in git)
│   ├── documents.csv        # Document metadata catalog
│   └── *.pdf                # PDF corpus
├── Dockerfile
├── requirements.in         # SOURCE — edit this
├── requirements.txt        # GENERATED — pinned, do not hand-edit
├── requirements-dev.in     # SOURCE
├── requirements-dev.txt    # GENERATED
├── scripts/
│   └── compile-requirements.sh  # regenerate the two .txt files
└── README.md
```
