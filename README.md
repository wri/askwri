# AskWRI

Research interface for transport decarbonization documents. Two query modes: **Answer** (synthesized responses) and **Cite** (comprehensive bibliography).

## Quick Start

```bash
# 1. Setup
cp .env.example .env
# Add your OPENAI_API_KEY to .env

# 2. Start
./start.sh

# 3. Use
# Research: http://localhost:3000
# Admin: http://localhost:3000/admin/documents
```

## System Overview

### Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Research UI | `src/components/AskWriApp.tsx` | Main interface (Answer/Cite modes) |
| Admin UI | `src/app/admin/documents/page.tsx` | Document upload, management |
| Hybrid Service | `hybrid-service/main.py` | Vector + BM25 search, reranking |
| Document Catalog | `data/documents.csv` | Metadata, summaries (single source of truth) |
| PDF Storage | `data/documents/` | Uploaded documents |
| Cache | `hybrid-service/cache/` | Parsed PDFs, embeddings, indexes |

### API Routes (`src/app/api/`)

| Route | Purpose |
|-------|---------|
| `llamaindex/` | Proxy queries to hybrid service |
| `answer/` | Synthesize 2-3 sentence answers from passages |
| `why/`, `batch-why/` | Explain why passages answer the query |
| `relates/` | Explain document-query relationship (Cite mode) |
| `alignment/` | Self-critique: coverage, caveats, risks |
| `admin/documents/` | CRUD, duplicate detection, reindex triggers |
| `admin/extract-title/` | LLM title extraction from PDF |
| `admin/jobs/` | Background job status |

### Libraries (`src/lib/`)

| Library | Purpose |
|---------|---------|
| `csv-utils.ts` | Read/write catalog, duplicate detection |
| `zotero-parser.ts` | Parse Zotero CSV, match filenames |
| `job-queue.ts` | In-memory background job processing |
| `llamaindex-client.ts` | Client for hybrid service |
| `summary-generator.ts` | LLM summary generation |
| `title-extractor.ts` | LLM title extraction |

### Configuration (`src/config/`)

| File | Controls |
|------|----------|
| `retrieval.ts` | Answer/Cite mode presets (topK, reranking) |
| `alignment.ts` | Self-critique model, prompts |
| `costs.ts` | Token cost estimation |
| `energy.ts` | Carbon footprint (gCO2e) |

### Evaluation (`evaluation/`)

| File | Purpose |
|------|---------|
| `golden-dataset.json` | 11 test queries with expected docs |
| `run-cite-eval.ts` | Full evaluation (11 queries) |
| `run-cite-eval-quick.ts` | Quick evaluation (3 queries) |
| `generate-report.ts` | Generate eval reports |

### Scripts (`scripts/`)

Data quality and maintenance utilities:
- `cleanup-summaries.ts`, `cleanup-titles.ts` - Fix data quality issues
- `generate-missing-summaries.ts` - Generate summaries via LLM
- `sync-summaries.ts` - Sync CSV column with metadata field

## Requirements

- Node.js 20+
- Python 3.11+
- OpenAI API key

## Configuration

**Required** (`.env`):
```bash
OPENAI_API_KEY=sk-...
LLAMAINDEX_SERVICE_URL=http://127.0.0.1:8002
```

**Optional overrides**:
```bash
OPENAI_MODEL=gpt-4o-mini
OPENAI_MODEL_WHY=gpt-4o-mini
OPENAI_MODEL_RELATES=gpt-4o-mini
OPENAI_MODEL_ALIGNMENT=gpt-4o-mini
OPENAI_MODEL_RELEVANCE=gpt-4o-mini
```

## Commands

```bash
./start.sh              # Start all services
./stop.sh               # Stop all services
npm run start:all       # Start with monitor and status scripts
npm run dev             # Frontend only
npm run build           # Production build
npm test                # Run tests
npm run lint            # Lint code
npm run eval:cite       # Run full evaluation (11 queries)
npm run eval:quick      # Run quick evaluation (3 queries)
```

**Note:** First startup takes ~10 minutes (~200 docs) for parsing, chunking, embedding, and indexing. Subsequent starts use cache.

## Deployment

See [VPS_SETUP.md](./VPS_SETUP.md) for VPS deployment guide.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design, query flow, data schema
- [VPS_SETUP.md](./VPS_SETUP.md) - VPS deployment guide
- [TESTING.md](./TESTING.md) - Test documentation
- [CLAUDE.md](./CLAUDE.md) - Development guide for Claude Code
- [evaluation/README.md](./evaluation/README.md) - Evaluation system details
- [hybrid-service/README.md](./hybrid-service/README.md) - Retrieval service details

## Troubleshooting

**Service not initialized**:
- Check `OPENAI_API_KEY` is set
- Verify hybrid service running on port 8002

**Documents not in search**:
- Wait for reindex job to complete (it can take 10-15 if you're doing this from scratch for ~200 docs currently...)
- Check job status at `/admin/documents`

**Upload fails**:
- Ensure PDF is valid (not password-protected)
- Fill all required metadata fields

**Debug endpoints**:
```bash
curl http://localhost:8002/health        # Service health
curl http://localhost:3000/api/admin/jobs # Job status
```

## License

MIT
