# AskWRI Code Review Walkthrough - Quick version!


## 1. Context & Architecture

### What problem does this solve?
Experimental research interface for WRI Cities documents - enables researchers to query ~162 PDF documents using semantic + keyword search.

### Two Query Modes (from `src/config/retrieval.ts:12-28`)
```typescript
ANSWER_PRESET: denseTopK:150, sparseTopK:150, rerankTopN:20  // Precision
CITE_PRESET:   denseTopK:500, sparseTopK:500, rerankTopN:40  // Recall (83%)
```

### Architecture
```
User → Next.js (:3000) → /api/llamaindex → Python hybrid-service (:8002)
                                            ├─ FAISS vector index
                                            ├─ BM25 sparse index
                                            └─ Cross-encoder reranking
```

### Why CSV instead of a database? (from `src/lib/csv-utils.ts:22-24`)
```typescript
// CSV format: file_path,metadata,summary
// Where metadata is JSON stringified
const CSV_HEADER = 'file_path,metadata,summary\n';
```
Simple, human-readable, portable. No ACID guarantees but sufficient for ~200 docs.

---

## 2. Live Demo 

### Prerequisites
Run `bash start.sh` which does (from `start.sh:52-109`):
1. Checks `.env` for `OPENAI_API_KEY`
2. Creates Python venv and installs deps
3. Starts hybrid service, waits up to 5 min for `/health`
4. Starts Next.js frontend
5. TBD: HF reranker models

### Demo Script
1. **Answer mode**: Query "What are barriers to EV adoption?"
   - Shows synthesized 2-3 sentence answer with inline citations
   - "Why it answers" explanations per passage

2. **Cite mode**: Same query
   - Returns ~37 documents (no synthesis)
   - Document-level "How it relates" explanations

3. **Admin panel**: `/admin/documents`
   - Upload, Zotero import, duplicate detection

---

## 3. Frontend Deep-Dive

### State Management (`AskWriApp.tsx:163-217`)
```typescript
const [mode, setMode] = useState<Mode>("answer");
const [query, setQuery] = useState("");
const [page, setPage] = useState(1);
const [docWhy, setDocWhy] = useState<Record<string, WhyMeta>>({});
const [passageWhy, setPassageWhy] = useState<Record<string, WhyMeta>>({});
```
- Separate caches for document-level and passage-level explanations
- Page-based caching prevents redundant API calls

### Catalog Hydration (`AskWriApp.tsx:104-121`)
```typescript
function matchCatalogRow(doc: DocMeta, index: ReturnType<typeof buildCatalogIndex> | null): any | undefined {
  // Match by: _url, chunk.file_path, chunk.file_name, chunk.external_file_id, title
  const candidates = [doc._url, chunk.file_path, chunk.file_name, ...];
  // Try basename, full path, then title slug
  if (index.byBase.has(base)) return index.byBase.get(base);
  if (index.bySlug.has(s)) return index.bySlug.get(s);
}
```
Hybrid service returns minimal metadata → UI enriches from CSV catalog.

### Pagination Logic (`AskWriApp.tsx:284-323`)
```typescript
// Answer mode: paginate by PASSAGES
const allPassages: Array<{doc: DocMeta, kp: KP}> = [];
filteredDocs.forEach(d => {
  (d.kps || []).forEach(kp => allPassages.push({doc: d, kp}));
});

// Cite mode: paginate by DOCUMENTS
const start = (page - 1) * actualSize;
const docs = filteredDocs.slice(start, start + actualSize);
```

### Batch "Why" Processing (`AskWriApp.tsx:327-472`)
```typescript
// Only process current page's passages (not all results)
fetch("/api/batch-why", {
  body: JSON.stringify({
    query,
    mode,
    passages: passagesToProcess.map(p => ({
      docTitle: p.docTitle,
      snippet: p.snippet
    }))
  })
})
```
- Answer mode: single batch call to `/api/batch-why`
- Cite mode: individual `/api/relates` calls per document

### Token Calculation (`src/app/api/batch-why/route.ts:10-25`)
```typescript
function calculateOptimalTokens(passages: any[], model: string): number {
  const isGPT5 = model.includes('gpt-5') || model === 'gpt-5-mini';
  // Simplified: 200 base + 80 per passage
  const calculatedTokens = 200 + (passages.length * 80);
  const maxTokens = isGPT5 ? 3000 : 2500;
  return Math.min(calculatedTokens, maxTokens);
}
```
Previous bug: 1500 token cap caused JSON truncation for 20+ passages.

### Model-Specific Parameters (`batch-why/route.ts:28-57`)
```typescript
function getModelParams(model: string, tokenCount: number) {
  if (isGPT5) return { max_completion_tokens: tokenCount };
  if (isO1) return { max_completion_tokens: tokenCount };  // no temperature
  if (isGPT4o) return { max_completion_tokens: tokenCount, temperature: 0.3 };
  else return { max_tokens: tokenCount, temperature: 0.3 };  // older models
}
```

---

## 4. Backend Deep-Dive

### Startup Sequence (`hybrid-service/main.py:349-875`)

**Step 1: Load CSV** (lines 359-424)
```python
possible_paths = [
    Path("/data/documents.csv"),              # Railway volume
    Path.home() / "askwri" / "data" / "documents.csv",  # VPS
    Path("../data/documents.csv"),            # Local dev
]
df = pd.read_csv(csv_path)
```

**Step 2: Parse PDFs** (lines 439-654)
```python
# Check cache first
cached_text = cache.get_cached_text(doc_id, cache_key)
if cached_text:
    # Use cached parsed text
    continue

# Parse with LlamaIndex's local PDF reader
from llama_index.readers.file import PDFReader
reader = PDFReader()
parsed_docs = reader.load_data(str(local_file))
```

**Step 3: Create Chunks** (lines 663-749)
```python
node_parser = SimpleNodeParser.from_defaults(
    chunk_size=400,  # Characters
    chunk_overlap=80
)
```

**Step 4: Build Vector Index** (lines 762-837)
```python
# Try cached index first
if index_cache_path.exists():
    vector_index = load_index_from_storage(storage_context, embed_model=embed_model)
else:
    # Build fresh (calls OpenAI for embeddings)
    vector_index = VectorStoreIndex(nodes=nodes, embed_model=embed_model)
```

**Step 5: Build BM25 Index** (lines 838-845)
```python
bm25_retriever = BM25Retriever.from_defaults(
    nodes=nodes,
    similarity_top_k=1000  # High limit for recall
)
```

**Step 6: Load Rerankers** (lines 848-866)
```python
reranker_answer = SentenceTransformerRerank(
    model="cross-encoder/ms-marco-MiniLM-L-12-v2",  # High precision
    top_n=20
)
reranker_cite = SentenceTransformerRerank(
    model="cross-encoder/ms-marco-MiniLM-L-6-v2",   # Faster
    top_n=200
)
```

### Hybrid Fusion (RRF Algorithm) (`main.py:131-209`)
```python
class HybridFusionRetriever(BaseRetriever):
    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        # Vector search: original query
        dense_results = self.vector_retriever.retrieve(query_bundle)

        # BM25: expanded query (domain synonyms)
        expanded_query = expand_query_conservative(query_bundle.query_str, max_expansions=3)
        sparse_results = self.bm25_retriever.retrieve(expanded_bundle)

        # RRF fusion: 1/(k + rank)
        for i, node_with_score in enumerate(dense_results):
            rrf_score = self.dense_weight * (1.0 / (60 + i + 1))  # k=60
            fused_scores[node_id] = fused_scores.get(node_id, 0) + rrf_score
```

### Query Processing (`main.py:950-1183`)
```python
@app.post("/query", response_model=QueryResponse)
async def hybrid_query(request: QueryRequest):
    # Stage 1: Hybrid fusion
    stage1_results = hybrid_retriever.retrieve(query_bundle)

    # Stage 2: Reranking
    stage2_results = reranker.postprocess_nodes(stage1_results, query_bundle)

    # Stage 2.5: Metadata filters (year, program, keywords)
    stage2_results = apply_metadata_filters(stage2_results, min_year=request.min_year, ...)

    # Cite mode: dedupe by doc_id
    if request.mode == "cite":
        doc_groups = {}
        for node in stage2_results:
            doc_id = node.node.metadata.get("doc_id")
            if doc_id not in doc_groups or node.score > doc_groups[doc_id].score:
                doc_groups[doc_id] = node
```

---

## 5. Document Import Pipeline

### Zotero Parser 3-Tier Matching (`src/lib/zotero-parser.ts:86-149`)

**Filename Normalization:**
```typescript
function normalizeFilename(filename: string): string {
  // Remove version markers: _v1, _v2, _0
  normalized = normalized.replace(/_v\d+/gi, "");
  // Remove duplicate markers: (1), (2)
  normalized = normalized.replace(/\s*[\(\[]?\d+[\)\]]?$/g, "");
  // Normalize whitespace
  normalized = normalized.replace(/[_\-\s]+/g, " ");
}
```

**Similarity Calculation:**
```typescript
function calculateSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  const distance = editDistance(a, b);  // Levenshtein
  return 1 - distance / maxLen;  // 85%+ threshold for fuzzy
}
```

### Duplicate Detection (`src/lib/csv-utils.ts:242-291`)
```typescript
export async function findDuplicateDocument(newMetadata: any) {
  // Exact match: same title, authors, and year
  if (newTitle && existingTitle === newTitle &&
      newAuthors && existingAuthors === newAuthors &&
      newYear === existingYear) {
    return { exists: true, conflictReason: "Exact match" };
  }

  // Fuzzy match: same title and year (authors may vary)
  if (newTitle && existingTitle === newTitle &&
      newYear === existingYear && newTitle.length > 10) {
    return { exists: true, conflictReason: "Likely duplicate" };
  }

  // Title collision (>20 chars)
  if (newTitle && existingTitle === newTitle && newTitle.length > 20) {
    return { exists: true, conflictReason: "Title already exists" };
  }
}
```

---

## 6. Key Architectural Decisions

| Decision | Code Location | Trade-off |
|----------|---------------|-----------|
| CSV as database | `csv-utils.ts:22-24` | Simple but no ACID |
| In-memory job queue | `job-queue.ts` | Lost on restart |
| Local PDF parsing | `main.py:467-472` | No cloud dep but CPU-bound |
| RRF fusion k=60 | `main.py:181` | Standard default |
| 400-char chunks | `main.py:665-667` | Balance context/precision |
| Pagination caching | `AskWriApp.tsx:204-209` | Fast UX, page-specific calls |

---

## 7. Discussion Questions (With Answers)

**Q: Why was the LLM filter removed?**
From CLAUDE.md: Pre-filter recall was 82%, post-filter dropped to 52.5%. LLM filter removed 30% of good docs. Simpler retrieval+reranking performs better.

**Q: How does cold start work?**
From `main.py:762-837`: Checks for cached index at `cache/indexes/{hash}_vector_index`. If missing, calls OpenAI for embeddings (~2-5 min). Subsequent starts use cache (<30s).

**Q: What's the cost structure?**
- Embeddings: One-time at index build (~$0.001/doc)
- Queries: ~$0.001 for retrieval (no LLM), ~$0.0015/page for "Why" explanations
- Synthesis (Answer mode): ~$0.003 per answer

**Q: Production readiness gaps?**
1. In-memory job queue (`job-queue.ts`) - use Bull/Redis
2. No auth on admin routes
3. CSV file locking for concurrent writes
4. No horizontal scaling (single Python process)

---

## 8. File Quick Reference

| File | Lines | Purpose |
|------|-------|---------|
| `src/components/AskWriApp.tsx` | 1832 | Main UI, state, pagination |
| `hybrid-service/main.py` | 1354 | Retrieval engine |
| `src/app/api/batch-why/route.ts` | 228 | Token management |
| `src/lib/zotero-parser.ts` | 589 | Import matching |
| `src/lib/csv-utils.ts` | 326 | Data persistence |
| `start.sh` | 156 | Service orchestration |

---

## Appendix: Directory Structure

```
askwri/
├── src/                      # Next.js frontend (TypeScript)
│   ├── components/           # React components
│   │   └── AskWriApp.tsx     # Main research interface
│   ├── app/api/              # API routes
│   │   ├── llamaindex/       # Proxy to hybrid service
│   │   ├── batch-why/        # Batch explanations
│   │   └── admin/            # Document management
│   ├── lib/                  # Shared utilities
│   │   ├── zotero-parser.ts  # Import matching
│   │   └── csv-utils.ts      # Data persistence
│   └── config/               # Configuration
│       └── retrieval.ts      # Query presets
├── hybrid-service/           # Python backend
│   ├── main.py               # FastAPI retrieval engine
│   ├── cache_system.py       # Caching
│   └── query_expansion.py    # Domain synonyms
├── data/                     # Runtime data
│   ├── documents.csv         # Metadata catalog
│   └── documents/            # PDF files
└── start.sh                  # Service orchestration
```
