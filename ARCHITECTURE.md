# Architecture

## System Overview

**Two-service architecture:**
- **Frontend**: Next.js on port 3000 (UI + API routes)
- **Backend**: Python FastAPI hybrid service on port 8002 (retrieval + indexing)
- **Data**: Unified CSV (`data/documents.csv`) + PDFs (`data/documents/`)

## Query Flow

```
User Query
    ↓
Next.js API (/api/llamaindex)
    ↓
Hybrid Service (localhost:8002/query)
    ├─ Vector Search (OpenAI embeddings)
    ├─ BM25 Sparse Search
    ├─ RRF Fusion
    └─ Cross-encoder Reranking
    ↓
CSV Metadata Hydration
    ↓
OpenAI Synthesis (/api/answer or /api/relates)
    ↓
UI Rendering
```

## Document Upload Flow

```
User Uploads PDFs + Metadata
    ↓
Pre-Upload Duplicate Check (3-tier)
    ├─ Exact: title + authors + year match
    ├─ Fuzzy: title + year match
    └─ Title: same title (>20 chars)
    ↓
User Confirms (Cancel or Upload Anyway)
    ↓
Save PDFs to data/documents/
    ↓
Append to data/documents.csv
    ↓
Queue Reindex Job
    ↓
Hybrid Service Rebuilds Indexes (30-60s)
    ↓
Documents Searchable
```

## Data Schema

**CSV Structure** (`data/documents.csv`):
```
file_path,metadata,summary
doc_000001.pdf,"{JSON metadata}","Summary text"
```

**Required Metadata Fields:**
- `Article Title` - Document title
- `All authors` - Author names (format: "Last, First; Last, First")
- `YEAR accepted` - Publication year
- `Sub-tag` - Category (default: "Transport decarbonization")

**Optional Fields:**
- `URL` / `Attribution URL` - Source URL
- `DOI` - Digital Object Identifier
- `Publisher` - Publishing organization
- `summary` - Abstract/summary for enrichment

## Key Components

### Frontend
- `src/components/AskWriApp.tsx` - Main research UI
- `src/app/admin/documents/page.tsx` - Admin interface
- `src/components/ZoteroBulkUpload.tsx` - Zotero import UI
- `src/app/api/` - API routes (synthesis, admin operations)

### Backend
- `hybrid-service/main.py` - FastAPI hybrid retrieval service
- `hybrid-service/cache/` - Persistent cache (parsed PDFs, embeddings, chunks)

### Libraries
- `src/lib/csv-utils.ts` - CSV operations + duplicate detection
- `src/lib/zotero-parser.ts` - Zotero CSV parsing + file matching
- `src/lib/job-queue.ts` - Background job processing (in-memory)
- `src/lib/pdf-utils.ts` - PDF text extraction

## Retrieval Configuration

**Answer Mode** (`src/config/retrieval.ts`):
- denseTopK: 150, sparseTopK: 150
- Rerank to top 20 passages (~10-15 unique docs)
- Optimized for precision

**Cite Mode**:
- denseTopK: 500, sparseTopK: 500
- Rerank to top 40 passages (~37 docs avg, 83% recall)
- Optimized for comprehensive coverage

## Job Queue

**In-memory queue** (lost on restart):
- Document processing: Text extraction → Summary generation
- Reindexing: Trigger hybrid service rebuild
- Status tracking: `/api/admin/jobs`

**Production note:** Consider Bull/BullMQ or SQS for persistence

## Performance

**Current Capacity (218 documents):**
- CSV duplicate check: <100ms
- Document upload: ~5s per PDF
- Full reindex: 10min or more with 200 pdfs
- Vector search: <1s per query

**Scalability:**
- CSV parsing: O(n)
- Duplicate detection: O(n*m)
- No issues expected until 10k+ documents

## Caching Strategy

**Hybrid Service Cache** (`hybrid-service/cache/`):
- Parsed PDF text
- OpenAI embeddings (per chunk)
- Document nodes
- Survives restarts, Python version-dependent

**Why cached?**
- Embeddings: Expensive to compute, reused across queries
- PDF parsing: Slow, only needed once per document
- Speedup: ~10x faster startup after first run

## Design Decisions

**Why CSV as database?**
- Simple: Human-readable, easy to inspect/edit
- Portable: Easy backup, version control, migration
- Resilient: No connection failures
- Sufficient: Handles 1000s of documents efficiently

**Why pre-upload duplicate check?**
- Immediate feedback before committing
- User control over conflict resolution
- Non-destructive cancellation
- Client-side performance

**Why "Upload Anyway" option?**
- User may intentionally update metadata
- Different versions/sources of same paper
- Explicit control prevents silent data loss

## API Endpoints

**Research:**
- `POST /api/llamaindex` - Hybrid retrieval proxy
- `POST /api/answer` - Answer synthesis
- `POST /api/summary`, `/api/why`, `/api/relates` - Enrichment

**Admin:**
- `GET/POST /api/admin/documents` - List/upload
- `PATCH/DELETE /api/admin/documents/[id]` - Update/delete
- `POST /api/admin/documents/check-duplicates` - Duplicate detection
- `GET /api/admin/jobs` - Job queue status

**Hybrid Service:**
- `POST /query` - Hybrid search
- `POST /reindex` - Rebuild indexes
- `GET /health`, `/stats` - Service monitoring

## Troubleshooting

**Documents not appearing in search:**
1. Check `/api/admin/jobs` for reindex status
2. Verify CSV has document row with valid JSON
3. Check `hybrid-service/cache/pdf_texts/` for cached text
4. Manual reindex: `POST http://localhost:8002/reindex`

**Duplicate detection false positives:**
- Title collision triggers on >20 char titles
- Use "Upload Anyway" if legitimate duplicate
- Common short titles may trigger incorrectly

**Slow reindexing:**
- First run: Parses all PDFs + generates embeddings
- Subsequent runs: Uses cache (~10x faster)
- Clear cache to force full rebuild: `rm -rf hybrid-service/cache/`
