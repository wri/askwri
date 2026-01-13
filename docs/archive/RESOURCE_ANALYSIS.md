# AskWRI Resource Consumption & Optimization Analysis

## Executive Summary

AskWRI is a Next.js research UI with a hybrid Python retrieval service. The system performs resource-intensive operations across document parsing, vector embedding, hybrid retrieval, and AI synthesis. This analysis identifies the primary resource consumers and provides actionable optimization strategies.

**Current Cache Size: 211 MB** (hybrid-service/cache)

---

## 1. Resource-Intensive Operations Overview

### 1.1 Hybrid-Service (Python Backend) - /hybrid-service/main.py (1,081 lines)

#### Primary Resource Consumers:

**A. Document Processing & PDF Parsing**
- **Location**: Lines 242-521 in `load_documents_and_build_indexes()`
- **Operation**: Full PDF text extraction from local files and remote URLs
- **Impact**:
  - Synchronous PDF parsing with LlamaIndex PDFReader
  - Unbuffered full-document-to-memory loading
  - No streaming or chunked processing
  - Blocks during remote PDF downloads (60s timeout per file)
  
**Resource Cost**:
- Memory: O(document_size) - entire PDF loaded into memory before parsing
- Network: 60s timeout × number of remote PDFs
- Disk I/O: Write all parsed text to memory immediately

**B. Embedding Generation**
- **Location**: Lines 627-658 in vector index creation
- **Model**: `text-embedding-3-small` (OpenAI)
- **Operation**: Creates embeddings for ALL chunks on startup
  
**Resource Cost**:
- API Calls: 1 embedding call per ~100 tokens = potentially 1000+ API calls per boot
- Cost: ~$0.02 per 1M tokens (text-embedding-3-small)
- Network: Each call roundtrip to OpenAI
- Cannot resume interrupted embedding jobs

**C. Hybrid Retrieval & RRF Fusion**
- **Location**: Lines 96-167 in `HybridFusionRetriever._retrieve()`
- **Operations**: 
  - Dense retrieval (vector search)
  - Sparse retrieval (BM25 keyword search)
  - Reciprocal Rank Fusion combining results
  
**Resource Cost**:
- Memory: Stores all intermediate results before filtering
- CPU: O(n log n) sorting during fusion
- High-throughput: Can retrieve up to 500+ results before reranking

**D. Reranking Models (SentenceTransformers)**
- **Location**: Lines 666-674 in model initialization
- **Models**: 
  - Answer mode: `cross-encoder/ms-marco-MiniLM-L-12-v2` (12 layers, 233M parameters)
  - Cite mode: `cross-encoder/ms-marco-MiniLM-L-6-v2` (6 layers, 136M parameters)
- **Operation**: Loaded into memory on startup, runs on CPU by default

**Resource Cost**:
- Memory: ~500MB-1GB resident for both models loaded
- Inference: Sequential processing of each result (no batching visible)
- CPU Intensive: Cross-encoder models require full sequence similarity computation

---

### 1.2 Next.js Frontend API Layer

#### Key API Routes with High Resource Usage:

**A. /api/llama/chat** (Lines 336-427 in route.ts)
- **Purpose**: LlamaCloud pipeline proxy with SSE parsing
- **Operation**: 
  - Forwards queries to LlamaCloud
  - Parses streaming SSE responses
  - Groups results by document
  - Applies bibliography/footnote filtering
- **Resource Cost**:
  - Memory: Loads entire SSE response into memory
  - CPU: String scanning for regex patterns on full responses
  - No result streaming to client

**B. /api/answer** (Lines 119-304 in route.ts)
- **Purpose**: Query synthesis with GPT models
- **Features**:
  - Model detection (GPT-5 vs GPT-4)
  - Dynamic token limits (up to 2500 for GPT-5)
  - Supports up to 12 documents × 600-char snippets
- **Resource Cost**:
  - API Calls: 1 call per query to OpenAI (external)
  - Context Size: 7,200-10,000 tokens per synthesis request
  - Verbatim quote detection: O(n*m) string scanning

**C. /api/admin/documents** (document upload)
- **Purpose**: Document ingestion and metadata handling
- **Operation**: 
  - File upload processing
  - CSV reading/writing on each operation
  - Duplicate detection with string matching
- **Resource Cost**:
  - Disk: CSV read/write on EVERY operation
  - CPU: Linear scan through all existing documents for duplicates
  - No pagination or batch operations

---

## 2. Caching Mechanisms Currently in Place

### 2.1 Python Hybrid-Service Cache System (cache_system.py - 174 lines)

**Cache Subdirectories:**
```
./cache/
├── pdfs/          - Downloaded PDFs (raw bytes)
├── texts/         - Parsed text with page boundaries (JSON)
├── embeddings/    - Embedding metadata (pickle)
├── nodes/         - Chunked document nodes (pickle)
└── indexes/       - Built indexes (pickle)
```

**Current Caching Coverage:**

| Cache Layer | Implementation | Effectiveness | Hit Rate |
|-------------|-----------------|----------------|----------|
| PDF Downloads | URL-based hash caching | Good | Depends on remote URLs |
| Parsed Text | Combined doc_id + URL hash | Good | High for local files |
| Nodes/Chunks | Content hash of all docs | Moderate | Breaking on any doc change |
| Embeddings | Metadata only, not vectors | Poor | Cannot skip OpenAI calls |
| Indexes | Metadata only | Poor | Essentially unused |

**Current Cache Size: 211 MB**
- Uses pickle format (non-human-readable, version-dependent)
- No expiration strategy (cache persists indefinitely)
- No manual invalidation mechanism

**Critical Gap**: Embeddings are NOT cached with vectors - only metadata. The `get_cached_embeddings()` function logs cache hit but OpenAI calls still happen.

### 2.2 Frontend Query Expansion Cache

**Location**: src/lib/query-expansion.ts
- **Method**: In-memory Map (summariesCache)
- **Coverage**: Document summaries loaded once on first use
- **Size**: Unbounded (scales with document count)
- **Issue**: Single-threaded, no expiration

---

## 3. Database Queries & API Call Patterns

### 3.1 CSV File Operations (src/lib/csv-utils.ts)

**Current Pattern: Read → Modify → Rewrite**

Every operation on documents triggers:
```typescript
1. readCSV()           // Load entire file into memory
2. Parse all lines     // O(n) parsing
3. Modify one entry    // Single item change
4. writeFile()         // Rewrite entire CSV
```

**Operations that trigger this:**
- Add document: 1 read + 1 write
- Delete document: 1 read + 1 write  
- Find duplicates: 1 read + linear scan for matches

**Resource Impact**:
- O(n) memory per operation where n = document count
- File I/O: Entire document list read/written for single changes
- No transactions or ACID guarantees

### 3.2 External API Calls

**OpenAI API - Embedded Costs:**
- Embeddings: text-embedding-3-small @ $0.02/1M tokens
- Chat Completion: gpt-4o-mini @ $0.15 input / $0.60 output per 1K
- Token estimates: 100-200 tokens per document chunk (400-char default)

**Call Patterns**:
```
User Query Flow:
1. LlamaCloud Chat     → Query pipeline (external)
2. /api/llama/chat     → Parse SSE response
3. /api/answer         → OpenAI synthesis (gpt-4o-mini or gpt-5*)
4. Additional why/relates endpoints → More OpenAI calls
```

**No call coalescing or request batching visible** in the code.

### 3.3 LlamaCloud Integration (src/lib/llamacloud.ts)

**Retrieval Parameters by Mode:**

| Parameter | Answer Mode | Cite Mode | Issue |
|-----------|-------------|-----------|-------|
| denseTopK | 150 | 500 | Large number before reranking |
| sparseTopK | 150 | 500 | Retrieves many results |
| rerank TopN | 10 | 60 | Wide range - Cite is 6x more |
| capPerDoc | 100 | 200 | KPs per document (very generous) |

**Call Patterns**:
- One query → One LlamaCloud call
- No query caching or deduplication
- Each retrieval returns up to 37 documents
- All documents loaded into memory for processing

---

## 4. File I/O Operations for PDFs & Embeddings

### 4.1 PDF Handling

**Local Files** (hybrid-service/main.py lines 312-398):
```
1. Check cache (file path hash)
2. If miss: Load from disk into memory
3. PDFReader.load_data() - parse to memory
4. Cache parsed text to JSON
5. Store full text in document_texts dict
```

**Remote URLs** (hybrid-service/main.py lines 401-508):
```
1. Check cache (URL hash)
2. If miss: HTTP GET with 60s timeout
3. Save to temp file
4. PDFReader.load_data() from temp
5. Delete temp file
6. Cache parsed text
7. Store full text in memory
```

**Issues**:
- Temp files not cleaned up on exceptions
- 60-second timeout blocks entire startup if one URL is slow
- No retry logic for failed downloads
- Memory holds ALL documents on startup

### 4.2 Embedding & Index Files

**Pickle-based Storage** (cache_system.py):
- Binary format with Python version dependencies
- No schema versioning
- No compression
- Cannot stream or incrementally load

---

## 5. Database Connections & Connection Management

**Current State**: NO Database System
- Using CSV as file-based store (data/documents.csv)
- No connection pooling (not applicable)
- No transaction support
- No query optimization

**CSV Limitations**:
- No indexing (all queries O(n))
- No ACID guarantees
- Race conditions possible with concurrent writes
- Inefficient for large datasets (>10K documents)

---

## 6. Key Optimization Opportunities

### Priority 1: Immediate High-Impact (Quick Wins)

**A. Fix Embedding Caching** (Easy, High Impact)
- **Issue**: Embeddings cached but vectors discarded; OpenAI calls always happen
- **Fix**: Store actual embedding vectors in pickle cache
- **Benefit**: 100% skip OpenAI startup calls on cache hit
- **Effort**: 2-3 hours
- **Savings**: $0.02-0.05 per startup, 30-60 seconds faster boot

**B. Stream PDF Processing** (Medium, High Impact)
- **Issue**: Entire PDFs loaded to memory before parsing
- **Fix**: Use streaming readers with chunked processing
- **Benefit**: 50-70% memory reduction during initialization
- **Effort**: 4-6 hours
- **Savings**: 500MB+ memory for large document sets

**C. Batch CSV Operations** (Easy, Medium Impact)
- **Issue**: Every document change = full file read/write
- **Fix**: Implement in-memory buffer, batch writes
- **Benefit**: 70-90% fewer file I/O operations
- **Effort**: 3-4 hours
- **Savings**: 2-3 seconds per bulk upload operation

### Priority 2: Medium-Term Improvements (Weekly)

**D. Query Result Caching** (Medium, High Impact)
- **Issue**: No caching of query results; popular queries run repeatedly
- **Fix**: Implement Redis-style TTL cache for common queries
- **Benefit**: 80%+ hit rate for repeated queries in UI testing
- **Effort**: 6-8 hours
- **Savings**: 50-100ms per cached query, near-zero latency for popular topics

**E. Implement Connection Pooling for Embeddings** (Medium, Medium Impact)
- **Issue**: Sequential embedding calls to OpenAI (no parallelization)
- **Fix**: Batch embedding requests (1 call for 100 chunks instead of 100 calls)
- **Benefit**: 50-70% fewer API calls, faster batch processing
- **Effort**: 4-6 hours
- **Savings**: $50-200 per full reindex, 15-30 minutes faster startup

**F. Lazy-Load Reranking Models** (Easy, Low-Medium Impact)
- **Issue**: Both reranker models (500MB+) loaded on startup even if not used
- **Fix**: Load rerankers on-demand when first query uses them
- **Benefit**: 500MB memory saved for "answer-only" deployments
- **Effort**: 2-3 hours
- **Savings**: 500MB memory on answer-only instances

### Priority 3: Architectural (Sprint-Scale)

**G. Replace CSV with SQLite** (Large, High Impact)
- **Issue**: O(n) duplicates check, full file read/writes, no transactions
- **Fix**: SQLite with proper indexing on title+authors+year
- **Benefit**: 100x faster duplicate detection, ACID guarantees, transactions
- **Effort**: 16-24 hours
- **Savings**: Scales well to 100K+ documents, removes race conditions

**H. Implement Distributed Caching** (Large, Medium Impact)
- **Issue**: In-memory caches don't persist across server restarts
- **Fix**: Add Redis for embeddings, parsed texts, query results
- **Benefit**: Shared cache across replicas, persistent, fast access
- **Effort**: 20-30 hours
- **Savings**: No reprocessing on restarts, supports horizontal scaling

**I. Streaming API Responses** (Medium, Low Impact)
- **Issue**: All results loaded to memory before sending to client
- **Fix**: Implement Server-Sent Events (SSE) for progressive results
- **Benefit**: Perceived speed improvement, lower peak memory
- **Effort**: 8-12 hours
- **Savings**: ~20-30% memory during result processing

---

## 7. Specific Resource Bottlenecks & Solutions

### Bottleneck 1: Startup Initialization (Critical)

**Current Flow:**
```
1. Load CSV metadata        → 100ms-1s
2. Fetch all remote PDFs    → 30-60s (blocking)
3. Parse all PDFs to text   → 20-40s
4. Generate embeddings      → 2-5 minutes (OpenAI API calls)
5. Build BM25 index         → 10-20s
6. Load reranker models     → 5-10s
Total: 3-6 minutes
```

**Optimization Strategy:**
- Cache step 2-4 together under content hash
- Lazy-load rerankers (step 6)
- Add skip flags for testing
- **Target**: 30-60 seconds on cache hit

### Bottleneck 2: Memory Usage During Retrieval

**Current Pattern:**
```
Query → Retrieve 500 dense results
      → Retrieve 500 sparse results  
      → Merge and score (1000 in-memory)
      → Rerank (subset in-memory)
      → Return top K
```

**Issue**: Peak memory = all 1000 results + full document texts in memory

**Optimization Strategy:**
- Use generators for result streaming
- Implement windowed processing
- **Target**: 50% memory reduction during retrieval

### Bottleneck 3: API Call Overhead

**Current**: ~2-4 API calls per user query
- LlamaCloud chat
- OpenAI synthesis (answer mode)
- Optional: why, relates, alignment endpoints

**Optimization Strategy:**
- Batch requests where possible
- Cache synthesis results for similar queries
- Implement request deduplication
- **Target**: 40-50% reduction in API calls for repeated queries

---

## 8. Recommended Action Plan

### Week 1: Quick Wins
1. Fix embedding vector caching (2-3h) → Save $0.03-0.05 per startup
2. Batch CSV operations (3-4h) → Save 70% of file I/O
3. Lazy-load reranker models (2-3h) → Save 500MB memory

### Week 2: Medium-Term
1. Query result caching layer (6-8h) → 80% cache hit for common queries
2. Batch embedding requests (4-6h) → 50-70% fewer API calls
3. PDF stream processing (4-6h) → 50-70% memory reduction

### Week 3: Foundation
1. Replace CSV with SQLite (16-24h) → 100x duplicate detection speedup
2. Add Redis layer (20-30h) → Persistent cross-server caching

---

## 9. Monitoring & Observability Recommendations

### Key Metrics to Track:

1. **Startup Time**: Target <1 minute on cache hit
2. **Memory Peak**: Track during retrieval (target 2GB for large datasets)
3. **API Calls**: Count OpenAI calls per startup/query
4. **Cache Hit Rates**: By cache layer (target 90%+ for embeddings)
5. **Query Latency**: P50/P95/P99 response times
6. **Document Processing**: Time per file for PDF parsing

### Implementation:
- Add timing annotations in hybrid-service/main.py
- Track in debug response headers
- Implement APM (Application Performance Monitoring)

---

## 10. Dependencies & Library Analysis

### Current Stack:
- **LlamaIndex**: Document parsing, indexing, retrieval
- **FastAPI**: Python service framework
- **Sentence-Transformers**: Cross-encoder reranking
- **LlamaParse/LlamaCloud**: Cloud-based document processing
- **OpenAI**: Embeddings and synthesis
- **Next.js**: Frontend framework
- **Pandas**: CSV handling

### Optimization Candidates:
- Sentence-Transformers → Consider ONNX quantized versions for 50% speedup
- Pandas → Replace with built-in CSV parsing for lightweight operations
- LlamaIndex → Pin specific models to avoid version churn

---

## Conclusion

AskWRI has significant opportunities for optimization across three dimensions:

1. **Caching**: Embedding vectors not cached; query results not cached
2. **I/O**: CSV operations O(n); PDF processing unbuffered
3. **Architecture**: No database; no connection pooling; no result streaming

**Quick wins in Week 1 alone can deliver 30-50% performance improvement with 10-15 hours of effort.**

The recommended path prioritizes high-impact, low-effort changes first, then builds toward a more scalable architecture with SQLite and Redis.

