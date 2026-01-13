# Hybrid Retrieval Service

FastAPI service combining dense vector search with sparse BM25 retrieval for document discovery.

## How Hybrid Retrieval Works

This section explains how the retrieval system finds relevant documents. If you're new to information retrieval (IR), read on—we'll build up from basics.

### The Problem: Why Hybrid?

Finding relevant documents is harder than it looks. Consider searching for "electric bus deployment":

- **Keyword search** finds documents containing those exact words, but misses a paper titled "Battery Transit Vehicle Implementation" that's highly relevant
- **Semantic search** understands that "battery transit vehicle" means the same thing, but might miss a document that uses "electric bus" in a crucial table without much surrounding context

Neither approach alone is sufficient. Hybrid retrieval combines both to get the best of each.

### Component 1: BM25 (Keyword Matching)

BM25 is a ranking function that scores documents based on query term frequency. It's the algorithm behind most traditional search engines.

**How it works:**
1. Count how often each query term appears in a document
2. Reward documents where query terms are frequent
3. Penalize very long documents (they naturally contain more words)
4. Penalize common terms like "the" (they don't indicate relevance)

**Strengths:** Precise keyword matching, fast, no ML required
**Weaknesses:** Misses synonyms, no semantic understanding

**Configuration:** `BM25_K1=1.2` (term frequency saturation), `BM25_B=0.75` (length normalization)

### Component 2: Vector Search (Semantic Matching)

Vector search converts text into numerical representations (embeddings) that capture meaning. Similar concepts have similar vectors.

**How it works:**
1. Convert the query into a 1536-dimensional vector using OpenAI's `text-embedding-3-small`
2. Compare against pre-computed document chunk vectors
3. Return chunks with the highest cosine similarity

**Strengths:** Understands synonyms, concepts, paraphrasing
**Weaknesses:** Can miss exact keyword matches, requires ML model

### Component 3: RRF Fusion (Combining Rankings)

Reciprocal Rank Fusion (RRF) combines the two ranked lists without requiring score calibration.

**How it works:**
```
RRF_score(doc) = Σ (weight / (k + rank))
```

For each document, sum its contribution from each retriever:
- A document ranked #1 in vector search contributes: `0.5 / (60 + 1) = 0.0082`
- The same document ranked #5 in BM25 contributes: `0.5 / (60 + 5) = 0.0077`
- Total RRF score: `0.0159`

**Why k=60?** This constant prevents top-ranked documents from dominating. With k=60, rank #1 vs #2 is a 1.6% difference, not 50%.

**Configuration:** Equal weights (0.5/0.5) for balanced keyword + semantic matching

### Component 4: Cross-Encoder Reranking

The final stage uses a cross-encoder model to re-score the top candidates. Unlike bi-encoders (used in vector search), cross-encoders read query and passage together.

**How it works:**
1. Take top ~150-500 results from RRF fusion
2. For each result, feed `[query, passage]` pair through the model
3. Model outputs a relevance score (0-1)
4. Re-sort by this score, keep top 20-40

**Why is this more accurate?** Bi-encoders encode query and document separately, then compare. Cross-encoders see both together, catching subtle relevance signals.

**Trade-off:** Cross-encoders are slow (~10ms per pair), so we only apply them to pre-filtered candidates.

**Models used:**
- Answer mode: `ms-marco-MiniLM-L-12-v2` (higher accuracy, top 20)
- Cite mode: `ms-marco-MiniLM-L-6-v2` (faster, top 40)

### The Full Pipeline

```
User Query: "electric bus deployment barriers"
                    │
    ┌───────────────┴───────────────┐
    ▼                               ▼
┌─────────────┐             ┌─────────────┐
│   Vector    │             │    BM25     │
│   Search    │             │   Search    │
│ (semantic)  │             │ (keywords)  │
└──────┬──────┘             └──────┬──────┘
       │ top 500                   │ top 500
       └───────────┬───────────────┘
                   ▼
           ┌─────────────┐
           │ RRF Fusion  │
           │   (k=60)    │
           └──────┬──────┘
                  │ top 150-500
                  ▼
           ┌─────────────┐
           │Cross-Encoder│
           │  Reranking  │
           └──────┬──────┘
                  │ top 20-40
                  ▼
            Final Results
```

### Answer vs. Cite Mode

The system has two retrieval modes with different tuning:

| Parameter | Answer Mode | Cite Mode |
|-----------|-------------|-----------|
| **Goal** | Precision (best passages) | Recall (comprehensive coverage) |
| **Vector top-k** | 150 | 500 |
| **BM25 top-k** | 150 | 500 |
| **Fusion top-k** | 100 | 500 |
| **Rerank top-n** | 20 | 40 |
| **Cross-encoder** | L-12 (accurate) | L-6 (fast) |
| **Typical results** | ~10-15 docs | ~37 docs |

## Quick Start

```bash
# Setup
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Configure
export OPENAI_API_KEY=sk-your-key

# Run
python main.py
# Service at http://127.0.0.1:8002
```

First startup takes ~10 minutes for 200+ docs (parsing, embedding, indexing). Subsequent starts use cache.

## API Reference

### POST /query

Main retrieval endpoint.

**Request:**
```json
{
  "query": "electric bus deployment",
  "mode": "cite",
  "max_results": 40,
  "rerank": true,
  "vector_top_k": 500,
  "bm25_top_k": 500,
  "rerank_top_n": 200
}
```

**Response:**
```json
{
  "docs": [
    {
      "doc_id": "doc_000016",
      "title": "Electric Bus Deployment Guide",
      "content": "**[Electric buses offer significant benefits]** by reducing emissions...",
      "score": 0.85,
      "page": 12,
      "metadata": { "authors": "Smith, J.", "year": 2023 }
    }
  ],
  "total_results": 37,
  "query": "electric bus deployment",
  "mode": "cite",
  "debug": {
    "stage1_results": 500,
    "stage2_results": 40,
    "reranking_applied": true
  }
}
```

### GET /health

Service health and statistics.

### POST /reindex

Trigger full re-indexing (rebuilds all caches and indexes).

## Configuration

### Environment Variables

```bash
# Required
OPENAI_API_KEY=sk-your-key

# Optional (defaults shown)
PORT=8002
CHUNK_SIZE=400           # Characters per chunk
CHUNK_OVERLAP=80         # Overlap between chunks
BM25_K1=1.2              # Term frequency saturation
BM25_B=0.75              # Length normalization
RRF_K=60                 # Fusion constant
```

### Cache Structure

```
cache/
├── pdf_texts/           # Parsed PDF text (per document)
├── embeddings.pkl       # OpenAI embeddings (expensive to regenerate)
├── nodes_cache.pkl      # Chunked nodes
└── {hash}_vector_index/ # FAISS vector index
```

Cache survives restarts. Delete `cache/` to force full rebuild.

## File Structure

```
hybrid-service/
├── main.py              # FastAPI service, retrieval logic
├── cache_system.py      # Multi-layer caching
├── query_expansion.py   # Domain-specific term expansion
├── requirements.txt     # Python dependencies
├── cache/               # Runtime cache (gitignored)
└── README.md            # This file
```

## Performance Tuning

### Memory Optimization

For memory-constrained environments:
```bash
CHUNK_SIZE=200      # Smaller chunks = less memory
CHUNK_OVERLAP=40
```

### Latency Optimization

For faster queries:
```bash
# In request parameters:
"vector_top_k": 100,    # Reduce candidate pool
"bm25_top_k": 100,
"rerank_top_n": 20      # Fewer reranking passes
```

### Recall Optimization

For comprehensive results:
```bash
# In request parameters:
"vector_top_k": 1000,   # Larger candidate pool
"bm25_top_k": 1000,
"rerank_top_n": 200
```

## See Also

- [../README.md](../README.md) - Project overview and commands
- [../ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture and query flow
- [../VPS_SETUP.md](../VPS_SETUP.md) - VPS deployment guide
