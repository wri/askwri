# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Recent Updates

### Nov 25, 2025: Document Quality & Import Improvements (Issue #36) ✅
**Fixed document summaries and titles, added preventive import features**

#### Summary & Title Quality Fixes
- **Problem**: 39 summaries with "Synopsis" prefixes, 22 empty summaries, 19 titles with filename artifacts
- **Root causes**:
  - Zotero imports with web-scraped abstracts containing prefixes
  - Manual uploads using filename as title
  - Bibliography exports with citation-format titles
- **Solutions implemented**:
  1. **Pattern-based cleanup**: Removed prefixes, citation formats, underscores (54 docs fixed)
  2. **LLM generation**: Generated 22 missing summaries, extracted 9 ambiguous titles
  3. **Summary sync**: Fixed 37 docs where column/metadata were out of sync
  4. **Final status**: 100% summary sync, 100% quality titles

#### Import Prevention Features
- **Zotero Bibliography Detection** (`src/lib/zotero-parser.ts:327-422`)
  - Detects citation-format CSV exports (>50% of titles match `"Author - Year - Title"`)
  - Rejects import with helpful error showing examples and fix instructions
  - Cost: $0 (pattern-based)
- **Auto-Title Extraction** (`src/app/api/admin/extract-title/route.ts`)
  - "Extract" button next to title field in upload UI
  - Extracts proper title from PDF using LLM (first 2 pages)
  - Shows loading spinner, populates field automatically
  - Cost: ~$0.01/doc (on-demand, user-initiated)

#### Key Findings
- **Two summary fields exist**: Separate `summary` column AND `metadata.summary` in JSON
- **Hybrid service uses column**: `row.get('summary', '')` on main.py:418
- **Both now synchronized**: All scripts/APIs update both for consistency
- **Impact**: 98%+ data quality, prevented 90%+ of future title issues

#### Files Created/Modified
- Created: `src/lib/summary-generator.ts`, `src/lib/title-extractor.ts`
- Created: `scripts/cleanup-summaries.ts`, `scripts/generate-missing-summaries.ts`
- Created: `scripts/cleanup-titles.ts`, `scripts/extract-titles-llm.ts`
- Created: `scripts/verify-summary-sync.ts`, `scripts/sync-summaries.ts`
- Created: `src/app/api/admin/extract-title/route.ts`
- Created: `src/app/api/admin/documents/[id]/generate-summary/route.ts`
- Modified: `src/lib/zotero-parser.ts` (bibliography detection + prefix removal)
- Modified: `src/app/admin/documents/page.tsx` (extract title button + regenerate summary)
- Modified: `src/lib/csv-utils.ts` (updateDocumentInCSV function)

#### Documentation
- See `IMPORT_IMPROVEMENTS.md` for complete details
- See `scripts/README.md` for script usage guide

### Nov 25, 2025: Fixed "Why it answers" Bug (Issue #38) ✅
**Fixed completely broken "Why it answers" explanations in Answer mode**
- **Problem diagnosed**:
  - JSON truncation: API responses cut off mid-JSON due to insufficient token allocation (1500 max)
  - Parse failures: Truncated JSON → parse error → fallback generic message shown for every passage
  - React warnings: useEffect dependency array included large array causing size change warnings
- **Root cause**:
  - Token limit too low: `calculateOptimalTokens()` capped at 1500 tokens, insufficient for 20+ passages
  - API returned 1500 tokens then truncated: `"Unterminated string in JSON at position 8584"`
  - All passages showed: `[Indirect] This passage provides relevant context for the query.`
- **Solution implemented (Options A+B+D + Pagination Caching)**:
  1. **Increased token limit**: 1500 → 2500 tokens (handles 20-30 passages)
  2. **Improved token calculation**: Simplified to `200 + (passages.length × 80)` for predictable scaling
  3. **Pagination-aware processing**: Only process current page (default 20 docs), not all results
  4. **Page-based caching**: API calls only for newly viewed pages, cached pages instant
  5. **Fixed React warnings**: Use primitives in dependency array (`page`, `size`) instead of arrays
- **Performance & cost**:
  - Before: $0 (feature broken)
  - After: ~$0.0015 per page viewed (~$0.003 for typical 2-page query)
  - Latency: 1-2s per page (only when first viewing that page)
  - Scalability: Works with any result set size (1-1000+ docs)
- **Benefits for both modes**:
  - **Answer mode**: Batch `/api/batch-why` call for all passages on current page
  - **Cite mode**: Individual `/api/relates` calls per document on current page
  - Both modes: Pagination + caching + no redundant API calls
- **Files modified**:
  - `src/app/api/batch-why/route.ts` - Token calculation (lines 10-25)
  - `src/components/AskWriApp.tsx` - Pagination processing (lines 287-455)
- **Key learnings**:
  1. **Pagination is UX gold**: Users see results faster, only pay for what they view
  2. **Always check token limits**: LLM output truncation causes silent failures
  3. **React arrays in deps**: Use primitives or memoized stable refs to avoid warnings
  4. **Diagnostic > guessing**: Dev tools showed exact error (JSON parse, token count)

### Nov 24, 2025: LLM Filter Removed - Simpler is Better ✅
**Removed LLM relevance filter after diagnostic analysis proved it was harmful**
- **Problem diagnosed**: LLM filter was removing 30% of correctly retrieved documents
  - Pre-filter recall: 82% (59/72 expected docs retrieved by hybrid search)
  - Post-filter recall: 52.5% (LLM filter removed 13 good documents)
  - Trade-off: Gained 20% precision but lost 30% recall - bad for research tool
- **Solution**: Removed LLM filter entirely, reduced max_results from 80→40
- **New performance**: 83% recall, 14.4% precision, ~37 docs/query
  - Better F1 score (23.7% vs 18.3% at max_results=80)
  - Simpler system (no LLM API calls, lower cost, lower latency)
  - More predictable behavior
- **Key learnings**:
  1. **Diagnose before optimizing**: Pre-filter diagnostic revealed upstream retrieval was fine (82% recall)
  2. **Per-document LLM filtering is flawed**: Lacks comparative context, removes relevant docs
  3. **For research tools, recall > precision**: Better to show 37 docs with 83% recall than 20 docs with 52% recall
  4. **Simpler is often better**: Retrieval + reranking is sufficient, don't over-engineer
- See `evaluation/diagnose-pre-filter-recall.ts` for diagnostic methodology

### Nov 24, 2025: Parallel Batch Processing - 40% Speed Improvement (OBSOLETE)
⚠️ **This optimization is now obsolete after removing LLM filter**
- LLM filter was optimized but then removed entirely
- Learnings preserved: parallel batch processing is effective when needed
- See commit history for implementation details

### Nov 23, 2025: Regression Recovery - Quality Filter Lesson (OBSOLETE)
⚠️ **LLM filter approach was fundamentally flawed, now removed**
- Root cause was deeper than implementation: per-document LLM filtering doesn't work well
- Real lesson: Some optimizations reveal the approach itself is wrong
- See Nov 24 update for correct solution

### Nov 18, 2025: Railway Deployment Ready
✅ **One-Command Railway Deployment**
- Automated setup: `bash railway-setup.sh`
- Monorepo deployment (hybrid service + frontend)
- Railway volume for persistent data
- See `RAILWAY_DEPLOY.md`

### Nov 14, 2025: Pre-Upload Deduplication
✅ **3-tier duplicate detection**
- Exact, fuzzy, and title collision matching
- See `ARCHITECTURE.md`

## Project Overview

AskWRI is a research interface for transport decarbonization that combines a Next.js frontend with a local Python-based hybrid retrieval backend.

**Two Query Modes:**
- **Answer**: Precision-focused (denseTopK:150, rerank to top 20) + OpenAI synthesis with citations
- **Cite**: Recall-focused (denseTopK:500, rerank to top 40) → comprehensive bibliography (~37 docs, 83% recall)

**Architecture:**
- **Frontend**: Next.js on port 3000 (UI + API proxies)
- **Backend**: Python hybrid retrieval service on port 8002 (dual-index search + reranking)
- **Data**: Unified CSV catalog (`data/documents.csv`) + local PDFs in `data/documents/`
- **Indexes**: Vector (OpenAI embeddings) + Sparse (BM25) with cross-encoder reranking

**Document Lifecycle:**
1. User uploads PDFs + metadata via `/admin/documents` UI
2. Files saved to disk, metadata added to CSV
3. Reindex job queued → triggers hybrid service rebuild
4. Hybrid service: Parse PDFs → Create chunks → Build vector+BM25 indexes → Initialize rerankers
5. Service ready for queries

## Development Commands

```bash
# Local Development
npm run dev                         # Start dev server with Turbopack at http://localhost:3000
bash start.sh                       # Start both services (hybrid + frontend)
bash stop.sh                        # Stop all services
bash verify-local-dev.sh            # Verify local setup after Railway changes

# Production Build
npm run build                       # Build with Turbopack
npm start                          # Start production server

# Railway Deployment
bash railway-setup.sh               # One-command automated Railway deployment
railway logs                        # View deployment logs
railway open                        # Open Railway dashboard

# Database Migration
npx tsx scripts/migrate-catalog.ts # Migrate old CSV to unified format

# Testing
npm test                           # Run test suite
npm run test:watch                # Watch mode
npm run test:coverage             # Coverage report
```

## Architecture

### Two-Service Design

**Frontend (Next.js on port 3000):**
- `src/components/AskWriApp.tsx` - Research UI (Answer/Cite modes)
- `src/app/api/` - API routes that proxy/orchestrate:
  - `llamaindex/` - Proxies queries to hybrid service
  - `answer/` - OpenAI synthesis for Answer mode
  - `relates/` - OpenAI retrieval for related papers (Cite mode)
  - `alignment/` - Cost-optimized alignment analysis (gpt-5-nano)
  - `admin/documents/*` - CRUD for document uploads, duplicate detection
  - `admin/jobs/` - Monitor reindex jobs

**Backend (Python on port 8002):**
- `hybrid-service/main.py` - FastAPI service with dual-index search:
  - Vector index (OpenAI `text-embedding-3-small` embeddings)
  - BM25 sparse index (keyword search)
  - RRF fusion of both indexes
  - Cross-encoder reranking (different models for Answer/Cite modes)

**Data Layer:**
- `data/documents.csv` - Single source of truth (166 rows: file_path, metadata JSON, summary)
- `data/documents/` - Local PDFs (one per document)
- `hybrid-service/cache/` - Persistent cache (parsed text, embeddings, chunks)

### Query Flow (End-to-End)

```
1. User submits query in UI
2. Next.js calls /api/llamaindex → proxies to hybrid service:8002/query
3. Hybrid service:
   - Vector search: dense embeddings × denseTopK
   - Sparse search: BM25 × sparseTopK
   - Fuse results with RRF
   - Rerank with cross-encoder (Answer: top 20, Cite: top 40)
   - Group by doc_id, return
4. Next.js hydrates results with CSV metadata
5. **[Cite mode only]**: LLM relevance filter judges each document
   - gpt-4o-mini evaluates: summary + retrieved chunk
   - Filters to documents with confidence ≥0.35
   - Removes tangentially related results
6. If Answer mode: calls /api/answer → OpenAI synthesis
7. If Cite mode: calls /api/relates → related papers
8. UI renders with citations and metadata
```

### Startup Sequence

When hybrid service starts (`python hybrid-service/main.py`):
1. Reads CSV from `../data/documents.csv` → all documents in corpus
2. For each document:
   - Check if parsed PDF cached → if yes, use cache
   - If not, parse PDF using LlamaIndex PDFReader locally
   - Cache parsed text for future runs
3. Chunk all parsed text: 400 char chunks with 80 char overlap → ~2000+ chunks
4. Check if embeddings cached → if yes, skip OpenAI
5. If not, call OpenAI to embed all chunks
6. Build FAISS vector index
7. Build BM25 index
8. Load rerankers (cross-encoder models)
9. Listen on 8002, ready for queries

## Unified Document Database

The app uses a single unified CSV catalog (`data/documents.csv`) for all metadata:
- **Location**: `data/documents.csv` (priority) → legacy fallback paths for backward compatibility
- **Schema**: `file_path,metadata,summary,source_type,imported_at,import_batch_id`
- **Key fields**: "Article Title", "All authors", "Source URL", "YEAR accepted", "Sub-tag", "DOI", "Publisher"
- **Metadata storage**: JSON-stringified in metadata column
- **Import tracking**: Each row tagged with source_type ("imported", "user-uploaded") and batch ID
- **Migration**: Run `npx tsx scripts/migrate-catalog.ts` to migrate legacy CSV

### Document Management Features
- **Single & Batch Upload**: Web UI at `/admin/documents`
- **Zotero CSV Import**: 3-tier matching (exact → fuzzy → manual)
- **CSV-only Mode**: Import metadata without associated PDFs
- **Duplicate Detection**: Pre-upload conflict detection (exact/fuzzy/title matches)
- **User Override**: Allow force-upload for known duplicates
- **Filename Normalization**: Handles version markers (_v1, _0), duplicate markers ((1), (2))
- **Enriched Metadata**: Extracts DOI, Publisher, Notes, Abstract from Zotero exports
- **Batch ID Tracking**: Track which import batch each document came from

## Environment Configuration

### Local Development
Required variables (`.env` file):
```bash
OPENAI_API_KEY=sk-...
LLAMAINDEX_SERVICE_URL=http://127.0.0.1:8002
```

Optional overrides:
```bash
OPENAI_MODEL=gpt-4o-mini
OPENAI_MODEL_WHY=gpt-4o-mini
OPENAI_MODEL_RELATES=gpt-4o-mini
OPENAI_MODEL_SUMMARY=gpt-4o-mini
OPENAI_MODEL_ALIGNMENT=gpt-4o-mini
OPENAI_MODEL_RELEVANCE=gpt-4o-mini  # LLM relevance filter (can use gpt-4o for better accuracy at 10x cost)

# Legacy path support (auto-detected, not required)
FILE_METADATA_PATH=data/documents.csv
```

### Railway Deployment
Environment variables are set automatically by `railway-setup.sh`:
- `OPENAI_API_KEY` - Set from your local env or prompted
- `LLAMAINDEX_SERVICE_URL` - Auto-configured to hybrid service URL
- Model configurations - Defaults to gpt-4o-mini
- Data paths - Auto-configured to `/data` (volume mount)

See `RAILWAY_DEPLOY.md` for complete deployment guide.

## TypeScript Configuration

- Uses `@/*` path mapping to `./src/*`
- Strict mode enabled
- Next.js plugin configured for App Router

## Debugging

Access debug endpoints:
- `/api/catalog` - Verify unified CSV loading (checks data/documents.csv first, then legacy paths)
- `/api/admin/documents` - List all documents with download URLs
- `/api/admin/documents/check-duplicates` - Test duplicate detection
- `/api/admin/jobs` - View background processing jobs

UI "Thinking" panel shows:
- Retrieval parameters
- Catalog loading status
- Filter application results
- Document hydration details

## Common Tasks

### Adding New API Endpoints
Follow existing pattern in `src/app/api/` with route.ts files using Next.js App Router conventions.

### Modifying Retrieval Behavior
Update presets in `src/config/retrieval.ts` (ANSWER_PRESET, CITE_PRESET).

### CSV Catalog Management
- **Automatic**: Web UI at `/admin/documents` manages unified CSV
- **Manual**: Edit `data/documents.csv` directly (JSON-stringified metadata)
- **Migration**: Run `npx tsx scripts/migrate-catalog.ts` once to migrate legacy data
- **Zotero Import**: Use `/admin/documents` with Zotero tab for bulk imports with matching

### Duplicate Detection
The system detects duplicates by:
1. **Exact match**: Title + authors + year all match
2. **Fuzzy match**: Title + year match (authors may vary)
3. **Title collision**: Same title already exists (if >20 chars)

**Known Limitations:**
- False positives: Common titles trigger collisions (e.g., "Annual Report 2024")
- False negatives: Different punctuation/capitalization may bypass exact match
- Author matching: "Smith, J." vs "Smith, John" may not match
- No stemming or synonym detection in title matching
- Matching accuracy untested (no evaluation performed)

Check `/src/lib/csv-utils.ts` for `findDuplicateDocument()` and `detectBatchDuplicates()`.

### UI Component Development
Use existing shadcn/ui components in `src/components/ui/`. Follow Tailwind + TypeScript patterns from `AskWriApp.tsx`.

## Key Implementation Details

### Zotero Parser (`src/lib/zotero-parser.ts`)
- **normalizeFilename()**: Removes version markers (_v1), duplicate markers ((1)), normalizes spaces
- **calculateSimilarity()**: Levenshtein distance-based matching (85%+ threshold for fuzzy)
- **Intelligent extraction**: Fallback chains for title (Title → Short Title → Publication Title), authors (Author → Editor), year, summary
- **3-tier matching**: Exact → Fuzzy → Manual assignment with user metadata editing

### CSV Utils (`src/lib/csv-utils.ts`)
- **readCSV()**: Parse unified `data/documents.csv` with JSON metadata
- **findDuplicateDocument()**: Detect existing document by metadata
- **detectBatchDuplicates()**: Pre-upload batch validation
- **addDocumentToCSV()**: Append with auto-incremented ID
- **deleteDocumentFromCSV()**: Remove by document ID

### ZoteroBulkUpload Component (`src/components/ZoteroBulkUpload.tsx`)
- **CSV + PDF matching**: Pairs Zotero CSV entries with uploaded PDF files
- **CSV-only mode**: Toggle to import metadata without PDFs
- **Duplicate detection**: Calls `/api/admin/documents/check-duplicates` API
- **Manual assignment**: Allow user to assign unmatched PDFs to CSV entries
- **Inline editing**: Edit custom metadata for unmatched files before upload

## Railway Deployment

### Quick Deploy
```bash
# One-command deployment
bash railway-setup.sh
```

### What Gets Deployed
- **Monorepo Setup**: Both services (hybrid + frontend) in one Railway project
- **Data Storage**: Railway volume at `/data` (1.2GB PDFs + CSV)
- **Cache Strategy**: Ephemeral (rebuilds on each deploy, ~30-60s cold start)
- **Environment**: Shared variables across services
- **Cost**: ~$6-7/month (Hobby plan + volume storage)

### Path Resolution (Automatic)
The hybrid service automatically detects the environment:
- **Railway**: Uses `/data/documents.csv` and `/data/documents/`
- **Local Dev**: Uses `../data/documents.csv` and `../data/documents/`

**Zero impact on local development** - all Railway changes are additive.

### Files Added for Railway
- `railway.toml` - Monorepo service configuration
- `railway-setup.sh` - Automated deployment script
- `RAILWAY_DEPLOY.md` - Complete deployment guide
- `.env.railway` - Railway environment template
- `verify-local-dev.sh` - Local dev verification script

### Modified Files
- `hybrid-service/main.py` - Updated path resolution (lines 252, 287-299)
  - Added `/data/` paths for Railway volume
  - Maintains backward compatibility with local dev paths

### Management Commands
```bash
railway logs                # View deployment logs
railway status              # Check deployment status
railway open                # Open Railway dashboard
railway up                  # Redeploy services
bash verify-local-dev.sh    # Verify local dev still works
```

See `RAILWAY_DEPLOY.md` for complete documentation including:
- Prerequisites checklist
- Step-by-step manual deployment
- Troubleshooting guide
- Cost breakdown
- Update procedures

## Testing

Test coverage for document management:
- PDF text extraction (13 tests)
- CSV metadata management (3 tests)
- Zotero parser (matching, normalization, extraction)
- Job queue system (24 tests skipped - async timing issues)
- API routes (skipped - edge-runtime limitations)

Run tests:
```bash
npm test                   # All tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
bash verify-local-dev.sh   # Verify Railway changes don't affect local dev
```