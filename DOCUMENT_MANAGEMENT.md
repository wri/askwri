# Document Management System - Quick Reference

## Overview

The AskWRI document management system provides a unified, web-based interface for uploading, processing, and managing research documents. All document metadata is stored in a single CSV database (`data/documents.csv`) with import batch tracking.

## Quick Start

1. **Access the Admin Interface:**
   ```
   http://localhost:3000/admin/documents
   ```

2. **Choose Upload Mode:**
   - **Single Document** - Upload one PDF with metadata
   - **Batch Upload** - Upload multiple PDFs (10+ recommended max)
   - **Zotero Import** - Bulk import from Zotero CSV export with intelligent matching

3. **Upload a Document:**
   - Select mode and file(s)
   - Fill in required metadata:
     - Article Title *
     - Authors *
     - Year *
     - Attribution URL (optional in Pure Local Mode)
     - Sub-tag (optional)
     - Summary (optional - for user-provided content)
   - Click "Upload & Process"

4. **Monitor Progress:**
   - Watch the "Processing Jobs" section
   - Wait for "completed" status
   - Documents appear in search after reindexing

5. **Zotero-Specific:**
   - For CSV-only import (no PDFs): Check "CSV-only mode"
   - System performs 3-tier matching:
     - **Exact match** - Same filename (case-insensitive)
     - **Fuzzy match** - 85%+ filename similarity (Levenshtein distance)
     - **Manual assignment** - User assigns unmatched PDFs to CSV entries
   - Review duplicates before upload (can override if needed)

## System Architecture

### Upload Flow

**Standard PDF + Metadata Upload:**
```
User uploads PDF + metadata
    ↓
API: POST /api/admin/documents
    ↓
Duplicate Check: /api/admin/documents/check-duplicates
    ├── If duplicates found: User can review/override
    └── If no conflicts: Proceed
    ↓
Job Queue: process_document
    ├── Extract text (pdfjs-dist)
    ├── Generate/store summary
    ├── Update unified CSV
    ├── Cache text
    └── Update metadata tracking
    ↓
Job Queue: reindex
    ↓
Hybrid Service rebuilds indexes (dense + sparse)
    ↓
Documents live in search with enriched metadata
```

**Zotero CSV Import Flow:**
```
User uploads Zotero CSV + PDFs (optional)
    ↓
API: POST /api/admin/documents
    ↓
Zotero Parser: /src/lib/zotero-parser.ts
    ├── Parse CSV with intelligent field extraction
    ├── Tier 1: Exact filename matching (case-insensitive)
    ├── Tier 2: Fuzzy matching (Levenshtein distance ≥ 85%)
    └── Tier 3: Manual assignment (user assigns unmatched PDFs)
    ↓
Duplicate Check: /api/admin/documents/check-duplicates
    ├── Exact match: title + authors + year
    ├── Fuzzy match: title + year (authors may vary)
    └── Title collision: same title exists
    ↓
Upload Confirmed (auto or user override)
    ↓
For each matched/assigned document:
    ├── Extract PDF text (if PDF exists)
    ├── Store enriched metadata (DOI, Publisher, Notes, etc.)
    ├── Update unified CSV with batch tracking
    └── Cache content
    ↓
Reindex triggered once for all documents
```

### File Structure
```
askwri/
├── src/
│   ├── app/
│   │   ├── admin/
│   │   │   └── documents/
│   │   │       └── page.tsx                    # Admin UI
│   │   └── api/
│   │       ├── catalog/
│   │       │   └── route.ts                    # Loads data/documents.csv
│   │       └── admin/
│   │           ├── documents/
│   │           │   ├── route.ts                # Upload/list documents
│   │           │   ├── [id]/route.ts           # Update/delete document
│   │           │   ├── check-duplicates/
│   │           │   │   └── route.ts            # Duplicate detection API
│   │           │   ├── csv/route.ts            # CSV utilities
│   │           │   └── cache/route.ts          # Text cache operations
│   │           ├── summary/route.ts            # AI summary generation
│   │           └── jobs/
│   │               ├── route.ts                # List jobs
│   │               └── [jobId]/route.ts        # Job status
│   ├── components/
│   │   ├── ZoteroBulkUpload.tsx               # Zotero CSV import UI
│   │   └── (other components)
│   └── lib/
│       ├── pdf-utils.ts                        # PDF text extraction
│       ├── csv-utils.ts                        # Unified CSV + duplicate detection
│       ├── zotero-parser.ts                    # Zotero CSV parsing & 3-tier matching
│       ├── job-queue.ts                        # Background processing
│       └── query-expansion.ts                  # Summary loading from unified CSV
├── data/
│   ├── documents.csv                           # Unified database (replaces legacy)
│   └── documents/                              # PDF files uploaded
│       ├── doc_000001.pdf
│       ├── doc_000002.pdf
│       └── ...
├── scripts/
│   └── migrate-catalog.ts                      # Migration script (old → unified CSV)
├── public/
│   └── TransportDecarb_llamacloud_metadata*.csv # Legacy (used as fallback only)
└── hybrid-service/
    ├── main.py
    └── cache/
        └── pdf_texts/                          # Cached document text
            ├── doc_000001.pdf.json
            └── ...
```

### Key Design Decisions

1. **Unified CSV Database**: Single source of truth at `data/documents.csv`
   - Backward compatible with legacy fallback paths
   - Includes import batch tracking for auditing
   - JSON-stringified metadata allows enriched fields

2. **Duplicate Detection**: Multi-tier matching before upload
   - Prevents accidental re-imports
   - User can override if intentional
   - Logs conflicts with reasons

3. **Zotero 3-Tier Matching**: Resilient to filename variations
   - Handles version markers (_v1, _v2), duplicates ((1), (2))
   - Provides fallback paths when files don't match exactly
   - Manual override for edge cases

4. **Pure Local Mode**: No external URL dependencies
   - PDFs served from local `data/documents/` directory
   - Metadata stored locally in `data/documents.csv`
   - Supports CSV-only imports without PDFs

## API Reference

### Document CRUD

**List Documents**
```bash
GET /api/admin/documents
Response: { documents: [...] }
```

**Upload Documents**
```bash
POST /api/admin/documents
Content-Type: multipart/form-data
Body:
  - files: File[]
  - metadata: JSON string
Response: { success: true, jobIds: [...] }
```

**Update Document**
```bash
PATCH /api/admin/documents/[id]
Body: { metadata: {...} }
Response: { success: true, jobId: "..." }
```

**Delete Document**
```bash
DELETE /api/admin/documents/[id]
Response: { success: true, jobId: "..." }
```

### Job Monitoring

**List All Jobs**
```bash
GET /api/admin/jobs
Response: { jobs: [...] }
```

**Get Job Status**
```bash
GET /api/admin/jobs/[jobId]
Response: {
  id: string
  type: "process_document" | "reindex"
  status: "queued" | "processing" | "completed" | "failed"
  progress: number (0-100)
  error?: string
  result?: any
}
```

### Utility Endpoints

**Check for Duplicate Documents**
```bash
POST /api/admin/documents/check-duplicates
Content-Type: application/json
Body: {
  documents: [
    { metadata: { "Article Title": "...", "All authors": "...", "YEAR accepted": 2024 } },
    ...
  ]
}
Response: {
  ok: true,
  conflicts: [
    {
      index: 0,
      title: "Document title",
      existingDocumentId: "doc_000001.pdf",
      conflictReason: "Exact match: same title, authors, and year"
    }
  ],
  hasConflicts: boolean,
  conflictCount: number
}
```

**Generate Summary**
```bash
POST /api/admin/summary
Body: { text: string, title?: string }
Response: { summary: string, tokens: number }
```

**Trigger Reindex**
```bash
POST http://localhost:8002/reindex
Response: { status: "success", documents_indexed: number }
```

## Data Formats

### Unified CSV Schema (data/documents.csv)

**Columns:**
- `file_path` - Unique document ID (e.g., `doc_000001.pdf`)
- `metadata` - JSON-stringified metadata object
- `summary` - Document summary (user-provided or AI-generated)
- `source_type` - Origin: `"imported"`, `"user-uploaded"`, or `"zotero"`
- `imported_at` - ISO 8601 timestamp when added
- `import_batch_id` - Batch identifier for tracking (e.g., `"initial_migration"`, `"zotero_batch_2025_01"`)

**CSV Row Example:**
```csv
file_path,metadata,summary,source_type,imported_at,import_batch_id
doc_000001.pdf,"{""Article Title"":""Access to Climate Finance"",""All authors"":""Laxton, V.; Caldwell, M."",""YEAR accepted"":2024,""Source URL"":""https://example.com/doc.pdf"",""DOI"":""https://doi.org/10.46830/wriwp.23.00145"",""Publisher"":""WRI""}","Key finding about climate finance mechanisms","imported","2025-11-14T00:38:51.529Z","initial_migration"
```

### Metadata Object Structure

**Required Fields:**
- `"Article Title"` - Document title (string)
- `"All authors"` - Authors formatted as "Last, First; Last, First" (string)
- `"YEAR accepted"` - Publication year (integer)
- `"Sub-tag"` - Category/topic (string, default: "Transport decarbonization")

**Optional Fields (populated from Zotero when available):**
- `"Source URL"` or `"Attribution URL"` - External document link (string)
- `"DOI"` - Digital Object Identifier (string)
- `"Publisher"` - Publishing organization (string)
- `"Article Type"` - Document type, e.g., "Working Paper", "Report" (string)
- `"Notes"` - Additional notes from Zotero (string)
- `"Abstract Note"` - Abstract from Zotero (string)
- `"Manuscript Number"` - Internal manuscript ID (string)

**Example Metadata Object:**
```json
{
  "Article Title": "Enabling Vehicle Grid Integration in China",
  "All authors": "Xue, Lulu",
  "YEAR accepted": 2020,
  "Sub-tag": "Transport decarbonization",
  "Source URL": "https://www.wri.org/research/...",
  "DOI": "https://doi.org/10.46830/writn.21.00134",
  "Publisher": "WRI",
  "Article Type": "Technical Note",
  "Manuscript Number": "WRI-D-19-00101"
}
```

### Cached Text Format
```json
{
  "text": "Full extracted text...",
  "metadata": {
    "title": "PDF Title",
    "author": "PDF Author",
    "pageCount": 25
  },
  "cachedAt": "2025-01-15T10:30:00.000Z"
}
```

## Job Processing

### Job Types

**process_document**
- Duration: ~30-60 seconds (estimated, not measured in production)
- Steps (progress percentages are UI estimates, not based on actual timing):
  1. Extract text (10% shown in UI)
  2. Generate summary (40% shown in UI)
  3. Update CSV (20% shown in UI)
  4. Cache text (20% shown in UI)
  5. Complete (10% shown in UI)

**Note:** Actual step timing varies significantly by document size. Progress bar is cosmetic.

**reindex**
- Duration: ~30-60 seconds
- Triggers full rebuild of hybrid service indexes
- Runs after document uploads/updates/deletes

### Job States

- `queued` - Waiting to be processed
- `processing` - Currently running
- `completed` - Successfully finished
- `failed` - Error occurred (see error field)

### Progress Tracking

Jobs automatically update every 2 seconds when status is `queued` or `processing`. The UI shows:
- Status icon (clock/checkmark/error)
- Progress percentage
- Progress bar
- Error message (if failed)

## Common Operations

### Add Single Document

1. Navigate to `/admin/documents`
2. Select "Single Document" mode
3. Click "Choose File" and select PDF
4. Fill in metadata form:
   - Title: "Electric Bus Deployment Guide"
   - Authors: "Smith, J.; Johnson, A."
   - Year: 2024
   - URL: "https://example.com/doc.pdf"
   - Sub-tag: "Transport decarbonization"
5. Click "Upload & Process"
6. Monitor job progress
7. Wait for reindex to complete
8. Document is now searchable

### Batch Upload Multiple Documents

1. Navigate to `/admin/documents`
2. Select "Batch Upload" mode
3. Click "Choose Files" and select multiple PDFs
4. Fill in metadata for each document (forms auto-generate)
5. Click "Upload & Process"
6. All documents process in sequence
7. Single reindex runs after all are cached
8. All documents searchable after reindex

### Delete Document

1. Find document in "Existing Documents" list
2. Click trash icon
3. Confirm deletion
4. Document removed from CSV and cache
5. Reindex triggered automatically
6. Document no longer appears in search

### Update Document Metadata

Currently requires manual CSV editing:
1. Open `public/TransportDecarb_llamacloud_metadata_with_summaries.csv`
2. Find row with matching `file_path`
3. Update JSON in `metadata` column
4. Save file
5. Call `POST http://localhost:8002/reindex`

## Troubleshooting

### Upload Fails

**Check:**
- PDF is valid (not corrupted/password-protected)
- All required fields filled
- Hybrid service running on port 8002
- OPENAI_API_KEY is set

**Common Errors:**
- "No files provided" - Select at least one PDF
- "Metadata is required" - Fill all required fields
- "Failed to extract text" - PDF may be scanned without OCR

### Jobs Stuck

**Check:**
- Hybrid service is running
- LLAMAINDEX_SERVICE_URL is correct
- Check job error message
- Browser console for errors

**Fix:**
- Restart hybrid service
- Refresh `/admin/documents` page
- Check network tab for failed requests

### Document Not Searchable

**Check:**
- Reindex job completed successfully
- CSV contains document row
- Cache file exists: `hybrid-service/cache/pdf_texts/doc_N.json`
- Hybrid service logs show document loaded

**Fix:**
- Manually trigger reindex: `POST http://localhost:8002/reindex`
- Check hybrid service health: `GET http://localhost:8002/health`
- Verify CSV format is valid

## Best Practices

### Document Naming
- Use sequential IDs: `doc_0`, `doc_1`, etc.
- System auto-assigns next available ID
- Don't manually create gaps in sequence

### Metadata Quality
- Use full author names with semicolon separators
- Include accurate publication year
- Provide stable URLs (not temporary links)
- Add descriptive sub-tags for filtering

### Summary Guidelines
- Let AI generate summaries (more consistent)
- 2-3 sentences captures essence
- Focuses on methods and findings
- Used for embeddings, so quality matters

### Batch Operations
- Upload related documents together
- Single reindex is more efficient
- Monitor job queue to avoid overload
- Max ~10 documents per batch recommended

### Cache Management
- Caches persist across restarts
- Clear cache if text extraction changes
- Cache files are ~10KB per page
- Monitor disk space for large corpora

## Production Deployment

### Environment Variables
```bash
# Required
OPENAI_API_KEY=sk-your-key
LLAMAINDEX_SERVICE_URL=https://your-service.up.railway.app

# Optional
OPENAI_MODEL_SUMMARY=gpt-4o-mini
```

### Security Considerations
- No authentication on `/admin` routes (add if needed)
- File uploads limited to PDFs only
- Validate metadata before processing
- Sanitize user inputs in metadata fields

### Scaling Considerations
- Job queue is in-memory (lost on restart)
- For production, consider Redis-backed queue
- Multiple instances need shared storage
- Coordinate reindex across instances

### Monitoring
- Check `/api/admin/jobs` for stuck jobs
- Monitor hybrid service health endpoint
- Track OpenAI API usage for costs
- Log all uploads for audit trail

## Cost Estimates

### Per Document Cost Estimate (10-page assumption)
**Calculation:**
- Summary generation: 500 input + 100 output tokens at $0.15/$0.60 per 1M = $0.000135
- Embedding generation: 5000 tokens at $0.02/1M = $0.0001
- Text extraction: Free (pdfjs-dist, client-side)
- **Total: ~$0.0002 per 10-page document**

**Limitations:**
- No actual cost tracking/logging implemented
- Assumes 500 tokens per page (varies by document)
- Does not include query costs from retrieval phase
- Pricing may change (check OpenAI dashboard)

### At Scale
- 100 documents: ~$0.02
- 1,000 documents: ~$0.20
- Ongoing queries: Use cached embeddings (free)

## Testing

The document management system has test coverage for core utilities:

**Test Coverage:**
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

**What's Tested:**
- PDF text extraction: 13 tests passing
- PDF validation: Included in extraction tests
- CSV metadata interfaces: 3 tests passing

**What's NOT Tested:**
- Job queue: 24 tests written but skipped (async timing prevents reliable execution)
- API routes: No tests (edge-runtime mocking limitations)
- Zotero parser: No tests (matching algorithm untested)
- Duplicate detection: No tests (conflict logic untested)

**Test Results:**
- 16 tests passing (40% pass rate)
- 24 tests skipped (60% skipped)
- Coverage: 70% threshold configured (actual coverage % unknown)
- See [TESTING.md](./TESTING.md) for detailed documentation

**Test Files:**
- `src/lib/__tests__/pdf-utils.test.ts` - PDF extraction utilities
- `src/lib/__tests__/csv-utils.test.ts` - CSV metadata management
- `src/lib/__tests__/job-queue.test.ts` - Job queue system (skipped)
- `src/__tests__/helpers/test-utils.tsx` - Test utilities and mocks

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review logs in browser console and terminal
3. Test API endpoints with curl
4. Run test suite: `npm test`
5. Open GitHub issue with error details