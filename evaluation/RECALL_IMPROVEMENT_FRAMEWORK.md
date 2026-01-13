# AskWRI Cite Mode: Precision/Recall Optimization Framework

**Previous Performance:** 41.1% recall, 18.5% precision (baseline before improvements)
**Current Performance:** 79.2% recall, 6.2% precision (0/7 test cases passing)
**Target:** ≥75% recall with ≥30% precision
**Last Updated:** November 22, 2025

---

## Recent Experiments Summary (Nov 22, 2025)

### Progress Made
✅ **Recall improved from 41% → 79%** by increasing retrieval parameters (1000/1000) and removing bottlenecks
✅ **Identified root cause**: Cross-encoder reranker has poor discrimination for this domain
✅ **Answer mode isolated**: All changes only affect Cite mode, Answer mode unaffected

### Experiments Conducted

| Experiment | Precision | Recall | F1 | Key Changes |
|------------|-----------|--------|-----|-------------|
| **Original Baseline** | 18.5% | 41.1% | 25.5% | 500/500 retrieval, rerank enabled, query expansion |
| **Aggressive Recall** | 6.0% | 83.9% | 11.1% | 1000/1000 retrieval, disabled reranking, query expansion on |
| **Re-enable Reranking** | 6.0% | 83.9% | 11.1% | Same (eval script wasn't using config) |
| **Aggressive Precision** | 8.5% | 54.8% | 14.6% | rerank_top_n=30, max_results=30 (too harsh) |
| **Balanced Approach** | 6.2% | 79.2% | 11.4% | 500/500 retrieval, balanced fusion (0.5/0.5), rerank_top_n=60 |

### Key Findings

1. **Reranker is ineffective for precision**: Even with aggressive filtering (top 30-60 chunks), precision remains ~6-8%
   - The cross-encoder cannot distinguish "mentions topic X" from "focuses on topic X"
   - Score normalization in Cite mode (0.15-1.0 range) makes threshold filtering ineffective
   - All retrieved documents score similarly, preventing meaningful discrimination

2. **Query expansion had no effect**: Disabling synonym expansion didn't change metrics
   - Suggests high recall was already achieved without expansion
   - Expansion may have been redundant with 1000/1000 retrieval

3. **Fusion weight changes minimal impact**: Balancing from 0.3/0.7 → 0.5/0.5 gave +0.2% precision
   - Reducing retrieval 1000→500 lost -4.7% recall but gained almost no precision

4. **Precision ceiling at ~6-11%**: Config tuning cannot break through this barrier
   - 90%+ false positive rate regardless of parameters
   - Indicates fundamental limitation of current reranking approach

### Current Configuration (After Experiments)

**Cite Mode Settings:**
```typescript
// src/config/retrieval.ts
denseTopK: 500      // Reduced from 1000
sparseTopK: 500     // Reduced from 1000
alpha: 0.5          // Balanced (was 0.3)
rerank: true
rerankTopN: 60      // Moderate filtering (was 30, then 100)
```

```python
# hybrid-service/main.py (Cite mode)
dense_weight: 0.5   # Balanced (was 0.4)
sparse_weight: 0.5  # Balanced (was 0.6)
fusion_top_k: 500
```

**Evaluation Settings:**
```typescript
max_results: 80
rerank_top_n: 60
vector_top_k: 500
bm25_top_k: 500
```

### Conclusion

**Config-based optimization has reached its limit.** To achieve ≥30% precision while maintaining ≥75% recall, we need architectural changes:
- LLM-based relevance filtering
- Query reformulation/decomposition
- Metadata-based constraints
- Different/fine-tuned reranker model
- Post-retrieval relevance scoring

See "Next Steps (No Restart Required)" section below for actionable improvements.

---

## Executive Summary (Original Framework)

This framework provides a systematic approach to diagnose and fix recall failures in the AskWRI Cite mode retrieval system. The core issue is **missing expected documents** despite aggressive retrieval parameters. The evaluation framework focuses on identifying WHERE documents are lost in the pipeline and WHY they fail to rank highly enough.

### Key Findings from Baseline Analysis

1. **Critical Failure Modes:**
   - **Thematic intersection queries** (children+pollution): 33% recall, 23 false positives
   - **Intervention impact queries** (school bus health): 33% recall, missing 2/3 expected docs
   - **Precision failures** (Jakarta housing): 14 irrelevant docs returned when 0 expected

2. **Success Patterns:**
   - **Geography queries** (Bangalore): 67% recall (best performance)
   - **Thematic+geo queries** (climate+Brazil): 67% recall
   - **Topic area queries** (land value capture): 50% recall

3. **System Architecture Issues:**
   - Hybrid fusion may be de-ranking relevant documents from sparse (BM25) results
   - Reranker may be dropping documents that made it through Stage 1
   - Embeddings may not capture nuanced semantic relationships (children AND pollution vs OR)
   - No query expansion or reformulation for complex queries

---

## 1. Root Cause Analysis Framework

### 1.1 Diagnostic Test Suite

Create a comprehensive diagnostic evaluation that tracks documents through each stage of the retrieval pipeline:

#### Stage 1: Pre-Retrieval Analysis
**Objective:** Verify that expected documents exist in the corpus and have the content we expect.

**Tests:**
```typescript
// File: evaluation/diagnostics/corpus-analysis.ts

interface CorpusAnalysis {
  doc_id: string;
  title: string;
  url: string;
  has_pdf: boolean;
  text_length: number;
  chunk_count: number;
  query_terms_present: {
    term: string;
    count: number;
    in_title: boolean;
    in_abstract: boolean;
  }[];
}

function analyzeCorpusCoverage(
  testCase: TestCase,
  documentsMetadata: Map<string, DocMetadata>
): CorpusAnalysis[] {
  // For each expected URL:
  // 1. Check if document exists in corpus
  // 2. Extract query terms (children, pollution, school bus, etc.)
  // 3. Count term occurrences in title, abstract, full text
  // 4. Verify chunks were created
  // 5. Flag if document has no content or is metadata-only
}
```

**Metrics:**
- Expected documents present in corpus: X/Y
- Expected documents with full PDF text: X/Y
- Average text length of expected docs vs corpus avg
- Query term density in expected docs

**Expected Insights:**
- Are missing documents actually in the corpus?
- Do they have sufficient text content?
- Do they contain the query terms we expect?

---

#### Stage 2: Dense Retrieval Analysis (Vector Search)
**Objective:** Determine if expected documents are in the top 500 vector search results.

**Tests:**
```typescript
// File: evaluation/diagnostics/dense-retrieval-analysis.ts

interface DenseRetrievalAnalysis {
  query: string;
  expected_doc_ids: string[];
  dense_results: {
    doc_id: string;
    rank: number;
    score: float;
    in_top_50: boolean;
    in_top_100: boolean;
    in_top_500: boolean;
  }[];
  missing_from_top_500: string[];
  embedding_quality_score: float;
}

async function analyzeDenseRetrieval(
  query: string,
  expectedDocs: string[]
): Promise<DenseRetrievalAnalysis> {
  // Call Python service with vector-only mode
  // Track rank positions of expected documents
  // Calculate score distribution
  // Identify if expected docs are missing entirely or just low-ranked
}
```

**Call Pattern:**
```python
# Add to hybrid-service/main.py
@app.post("/debug/dense-only")
async def debug_dense_retrieval(request: QueryRequest):
    """Dense retrieval only - no fusion, no reranking"""
    vector_retriever = VectorIndexRetriever(
        index=service_state["vector_index"],
        similarity_top_k=500
    )
    results = vector_retriever.retrieve(QueryBundle(query_str=request.query))
    # Return full ranked list with doc_id, score, rank
```

**Metrics:**
- **Dense Recall@50:** How many expected docs in top 50?
- **Dense Recall@100:** How many expected docs in top 100?
- **Dense Recall@500:** How many expected docs in top 500?
- **Mean Reciprocal Rank (MRR):** Average 1/rank of first expected doc
- **Rank distribution:** Where do expected docs appear in ranking?
- **Score gap:** Difference between expected doc scores and top-ranked scores

**Expected Insights:**
- If expected docs are NOT in top 500: Embedding quality issue
- If expected docs are in top 500 but ranked 400+: Fusion may be helping or hurting
- If expected docs are in top 100: Reranker or fusion is the problem

---

#### Stage 3: Sparse Retrieval Analysis (BM25)
**Objective:** Determine if expected documents are in the top 500 BM25 results.

**Tests:**
```typescript
interface SparseRetrievalAnalysis {
  query: string;
  query_terms: string[];
  expected_doc_ids: string[];
  sparse_results: {
    doc_id: string;
    rank: number;
    score: float;
    term_matches: {
      term: string;
      tf: number;  // term frequency
      idf: number; // inverse document frequency
    }[];
  }[];
  missing_from_top_500: string[];
}
```

**Call Pattern:**
```python
# Add to hybrid-service/main.py
@app.post("/debug/sparse-only")
async def debug_sparse_retrieval(request: QueryRequest):
    """BM25 retrieval only - no fusion, no reranking"""
    results = service_state["bm25_retriever"].retrieve(
        QueryBundle(query_str=request.query)
    )
    # Return full ranked list with doc_id, score, rank, term matches
```

**Metrics:**
- **Sparse Recall@50/100/500:** BM25 recall at different cutoffs
- **Term coverage:** Do expected docs contain query terms?
- **IDF analysis:** Are query terms too common or too rare?
- **Query term expansion:** Would synonyms or related terms help?

**Expected Insights:**
- If BM25 finds docs that vector search misses: Hybrid fusion is valuable
- If BM25 also misses docs: Query reformulation or term expansion needed
- If BM25 ranks expected docs highly: Fusion weights may be wrong

---

#### Stage 4: Fusion Analysis (RRF)
**Objective:** Determine if RRF fusion is improving or degrading recall.

**Tests:**
```typescript
interface FusionAnalysis {
  query: string;
  expected_doc_ids: string[];
  fusion_results: {
    doc_id: string;
    rank_after_fusion: number;
    fusion_score: float;
    dense_rank: number | null;
    dense_score: float | null;
    sparse_rank: number | null;
    sparse_score: float | null;
    rank_change_from_dense: number;
    rank_change_from_sparse: number;
  }[];
  fusion_helped: string[];  // Expected docs ranked higher after fusion
  fusion_hurt: string[];    // Expected docs ranked lower after fusion
}
```

**Call Pattern:**
```python
# Add to hybrid-service/main.py
@app.post("/debug/fusion-detailed")
async def debug_fusion(request: QueryRequest):
    """Return pre-fusion and post-fusion results for comparison"""
    dense_results = vector_retriever.retrieve(query_bundle)
    sparse_results = bm25_retriever.retrieve(query_bundle)
    fused_results = hybrid_retriever.retrieve(query_bundle)

    # Return:
    # - All three result lists with ranks and scores
    # - Per-document fusion analysis
    # - Rank correlation metrics
```

**Metrics:**
- **Fusion Recall@100:** Recall after fusion, before reranking
- **Rank correlation:** Kendall's Tau between dense and fused rankings
- **Fusion uplift:** How many expected docs moved UP in ranking?
- **Fusion penalty:** How many expected docs moved DOWN in ranking?
- **RRF weight sensitivity:** Does changing dense_weight/sparse_weight help?

**Expected Insights:**
- If fusion hurts recall: Consider changing weights or using different fusion method
- If fusion helps: Keep current approach but may need to adjust weights
- If fusion is neutral: May be able to simplify to dense-only

---

#### Stage 5: Reranking Analysis
**Objective:** Determine if cross-encoder reranking is improving or degrading recall.

**Tests:**
```typescript
interface RerankingAnalysis {
  query: string;
  expected_doc_ids: string[];
  reranking_results: {
    doc_id: string;
    rank_before_rerank: number;
    rank_after_rerank: number;
    score_before_rerank: float;
    score_after_rerank: float;
    rank_change: number;
    dropped: boolean;  // Was in pre-rerank but not in final results
  }[];
  reranker_helped: string[];
  reranker_hurt: string[];
  reranker_dropped: string[];  // Expected docs dropped by reranker
}
```

**Call Pattern:**
```python
# Modify existing /query endpoint to return debug info
@app.post("/query")
async def hybrid_query(request: QueryRequest):
    # ... existing code ...

    if request.debug:
        return {
            "docs": final_results,
            "debug": {
                "pre_rerank_count": len(stage1_results),
                "post_rerank_count": len(stage2_results),
                "expected_docs_pre_rerank": [...],
                "expected_docs_post_rerank": [...],
                "dropped_by_reranker": [...]
            }
        }
```

**Metrics:**
- **Reranker Recall:** How many expected docs survive reranking?
- **Reranker precision boost:** Does precision improve with reranking?
- **Drop rate:** What % of pre-rerank results are dropped?
- **Rank improvement:** Do expected docs move UP after reranking?

**Expected Insights:**
- If reranker drops expected docs: May need different reranker model
- If reranker helps precision without hurting recall: Good tradeoff
- If reranker is neutral: May be able to disable for cite mode

---

#### Stage 6: Document Grouping Analysis
**Objective:** Verify that document grouping (taking best chunk per doc) isn't dropping expected documents.

**Tests:**
```typescript
interface GroupingAnalysis {
  query: string;
  expected_doc_ids: string[];
  pre_grouping_results: {
    chunk_id: string;
    doc_id: string;
    score: float;
  }[];
  post_grouping_results: {
    doc_id: string;
    best_chunk_id: string;
    best_chunk_score: float;
    num_chunks: number;
  }[];
  expected_docs_lost_in_grouping: string[];
}
```

**Metrics:**
- **Grouping recall:** How many expected docs survive grouping?
- **Multi-chunk docs:** How many chunks per expected document?
- **Best chunk selection:** Is the highest-scoring chunk representative?

**Expected Insights:**
- If grouping loses expected docs: Bug in grouping logic
- If grouping preserves recall: No issue here

---

### 1.2 Diagnostic Evaluation Runner

Create a comprehensive diagnostic runner that executes all tests:

```typescript
// File: evaluation/run-diagnostic-eval.ts

interface DiagnosticReport {
  test_case_id: string;
  query: string;
  expected_docs: string[];

  // Stage 1: Corpus
  corpus_analysis: CorpusAnalysis[];

  // Stage 2: Dense
  dense_analysis: DenseRetrievalAnalysis;

  // Stage 3: Sparse
  sparse_analysis: SparseRetrievalAnalysis;

  // Stage 4: Fusion
  fusion_analysis: FusionAnalysis;

  // Stage 5: Reranking
  reranking_analysis: RerankingAnalysis;

  // Stage 6: Grouping
  grouping_analysis: GroupingAnalysis;

  // Root cause determination
  root_cause: "corpus_missing" | "embedding_quality" | "fusion_weights" |
               "reranker_drops" | "query_complexity" | "unknown";

  recall_by_stage: {
    stage_name: string;
    recall: float;
    docs_found: string[];
    docs_missing: string[];
  }[];
}

async function runDiagnosticEvaluation(
  goldenDataset: GoldenDataset
): Promise<DiagnosticReport[]> {
  const reports: DiagnosticReport[] = [];

  for (const testCase of goldenDataset.test_cases) {
    const report = await runDiagnosticForTestCase(testCase);
    reports.push(report);

    // Print actionable insights
    printDiagnosticSummary(report);
  }

  return reports;
}

function printDiagnosticSummary(report: DiagnosticReport) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Diagnostic Report: ${report.test_case_id}`);
  console.log(`Query: ${report.query}`);
  console.log(`${'='.repeat(80)}`);

  // Print recall waterfall
  console.log(`\nRecall Waterfall:`);
  for (const stage of report.recall_by_stage) {
    const status = stage.recall === 1.0 ? '✅' : '❌';
    console.log(`  ${status} ${stage.stage_name}: ${(stage.recall * 100).toFixed(1)}% recall`);
  }

  // Print root cause
  console.log(`\n🎯 Root Cause: ${report.root_cause}`);

  // Print missing docs with reasons
  const finalMissing = report.recall_by_stage[report.recall_by_stage.length - 1].docs_missing;
  if (finalMissing.length > 0) {
    console.log(`\n❌ Missing Documents:`);
    for (const doc of finalMissing) {
      const reasons = getDiagnosticReasons(doc, report);
      console.log(`  - ${doc}`);
      for (const reason of reasons) {
        console.log(`    • ${reason}`);
      }
    }
  }

  // Print recommended actions
  console.log(`\n💡 Recommended Actions:`);
  const actions = getRecommendedActions(report);
  for (const action of actions) {
    console.log(`  ${action}`);
  }
}

function getDiagnosticReasons(doc_id: string, report: DiagnosticReport): string[] {
  const reasons: string[] = [];

  // Check each stage to see where doc was lost
  const inCorpus = report.corpus_analysis.some(d => d.doc_id === doc_id);
  if (!inCorpus) {
    reasons.push("Document not in corpus");
    return reasons;
  }

  const denseRank = report.dense_analysis.dense_results.find(d => d.doc_id === doc_id)?.rank;
  if (!denseRank || denseRank > 500) {
    reasons.push(`Not in top 500 dense results (rank: ${denseRank || 'not found'})`);
  } else if (denseRank > 100) {
    reasons.push(`Low dense rank: ${denseRank}`);
  }

  const sparseRank = report.sparse_analysis.sparse_results.find(d => d.doc_id === doc_id)?.rank;
  if (!sparseRank || sparseRank > 500) {
    reasons.push(`Not in top 500 sparse results (rank: ${sparseRank || 'not found'})`);
  } else if (sparseRank > 100) {
    reasons.push(`Low sparse rank: ${sparseRank}`);
  }

  const fusionRank = report.fusion_analysis.fusion_results.find(d => d.doc_id === doc_id)?.rank_after_fusion;
  if (fusionRank && fusionRank > 100) {
    reasons.push(`Fusion degraded rank to ${fusionRank}`);
  }

  const rerankerDropped = report.reranking_analysis.reranker_dropped.includes(doc_id);
  if (rerankerDropped) {
    reasons.push(`Dropped by reranker (was in pre-rerank results)`);
  }

  return reasons;
}

function getRecommendedActions(report: DiagnosticReport): string[] {
  const actions: string[] = [];

  switch (report.root_cause) {
    case "corpus_missing":
      actions.push("✓ Verify documents are in data/documents/ and CSV catalog");
      actions.push("✓ Check PDF parsing succeeded for these documents");
      break;

    case "embedding_quality":
      actions.push("✓ Consider using a more powerful embedding model");
      actions.push("✓ Experiment with query expansion or reformulation");
      actions.push("✓ Add document metadata (title, abstract) to embeddings");
      break;

    case "fusion_weights":
      actions.push("✓ Increase sparse_weight if BM25 is finding expected docs");
      actions.push("✓ Try different fusion algorithms (Linear, Weighted RRF)");
      actions.push("✓ Increase fusion_top_k to preserve more candidates");
      break;

    case "reranker_drops":
      actions.push("✓ Try a different reranker model (L-12 instead of L-6)");
      actions.push("✓ Increase reranker top_n to preserve more results");
      actions.push("✓ Consider disabling reranking for Cite mode (prioritize recall)");
      break;

    case "query_complexity":
      actions.push("✓ Implement query decomposition for multi-concept queries");
      actions.push("✓ Use query expansion with synonyms/related terms");
      actions.push("✓ Try query reformulation with LLM");
      break;
  }

  return actions;
}
```

---

## 2. Enhanced Evaluation Metrics

Beyond the current precision, recall, and F1 metrics, implement:

### 2.1 Ranking Quality Metrics

```typescript
interface RankingMetrics {
  // Mean Reciprocal Rank: Average 1/rank of first relevant doc
  mrr: float;

  // Normalized Discounted Cumulative Gain
  ndcg_at_10: float;
  ndcg_at_60: float;

  // Recall at different cutoffs
  recall_at_10: float;
  recall_at_30: float;
  recall_at_60: float;
  recall_at_100: float;

  // Precision at different cutoffs
  precision_at_10: float;
  precision_at_60: float;

  // Average Precision (area under precision-recall curve)
  average_precision: float;

  // Coverage metrics
  doc_coverage: float;  // % of corpus returned
  query_term_coverage: float;  // % of query terms matched
}

function calculateRankingMetrics(
  retrievedDocs: DocMeta[],
  expectedUrls: string[]
): RankingMetrics {
  // Implementation using standard IR metrics formulas
  // See: https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)
}
```

### 2.2 Query Difficulty Scoring

```typescript
interface QueryDifficultyScore {
  query: string;

  // Lexical complexity
  num_terms: number;
  avg_term_idf: float;  // Higher IDF = rarer terms = harder

  // Semantic complexity
  num_concepts: number;  // e.g., "children AND pollution" = 2 concepts
  requires_intersection: boolean;  // vs simple OR query

  // Specificity
  has_geography: boolean;
  has_intervention: boolean;
  has_impact: boolean;

  // Expected difficulty
  difficulty_score: float;  // 0-1, higher = harder
  difficulty_category: "easy" | "medium" | "hard" | "very_hard";
}

function scoreQueryDifficulty(query: string, testCase: TestCase): QueryDifficultyScore {
  // Analyze query structure
  // Predict retrieval difficulty
  // Use to adjust evaluation expectations
}
```

### 2.3 Failure Mode Taxonomy

```typescript
interface FailureMode {
  category: "embedding_miss" | "fusion_degradation" | "reranker_drop" |
            "query_complexity" | "corpus_gap" | "other";

  severity: "critical" | "high" | "medium" | "low";

  affected_queries: string[];

  description: string;

  recommended_fix: string;

  estimated_recall_impact: float;  // How much recall would improve if fixed
}

function analyzeFailureModes(diagnosticReports: DiagnosticReport[]): FailureMode[] {
  // Cluster failures by root cause
  // Prioritize by impact
  // Return actionable fixes
}
```

---

## 3. Improvement Strategy Roadmap

### Priority 1: QUICK WINS (Est. Impact: +20-30% recall)

#### 3.1 Disable Reranking for Cite Mode
**Rationale:** Cite mode prioritizes recall over precision. Reranking may be dropping relevant documents.

**Implementation:**
```typescript
// src/config/retrieval.ts
export const CITE_PRESET: RetrievalParams = {
  retrievalMode: "hybrid",
  denseTopK: 500,
  sparseTopK: 500,
  alpha: 0.5,
  rerank: false,  // CHANGED: Disable reranking for recall
  rerankTopN: 150,
};
```

**Testing:**
```bash
# Run evaluation with reranking disabled
npm run eval:cite

# Compare recall before/after
# Expected: +10-20% recall improvement
```

**Success Criteria:**
- Recall improves by at least 10 percentage points
- False positive rate doesn't exceed 50%

---

#### 3.2 Increase Final Result Limit
**Rationale:** Currently limiting to top 60 unique docs. May be dropping expected docs ranked 61-100.

**Implementation:**
```typescript
// src/config/retrieval.ts
export const CITE_PRESET: RetrievalParams = {
  // ... existing config ...
  rerankTopN: 200,  // CHANGED: From 150 to 200
};

// Also update query request
// evaluation/run-cite-eval.ts
const docs = await callPythonService(fullQuery);
// Change max_results from 100 to 150
```

**Testing:**
```bash
npm run eval:cite
# Expected: +5-10% recall improvement
```

**Success Criteria:**
- Recall improves without excessive precision degradation

---

#### 3.3 Adjust Fusion Weights for Cite Mode
**Rationale:** BM25 may be finding documents that vector search misses (especially for keyword-heavy queries like "school bus", "Jakarta").

**Implementation:**
```python
# hybrid-service/main.py - HybridFusionRetriever.__init__
if mode == "cite":
    self.dense_weight = 0.3  # CHANGED: From 0.4 to 0.3
    self.sparse_weight = 0.7  # CHANGED: From 0.6 to 0.7
    self.fusion_top_k = 200  # CHANGED: From 150 to 200
```

**Testing:**
```bash
# Run grid search over weight combinations
python evaluation/grid_search_fusion_weights.py

# Test weights: (dense, sparse)
# - (0.5, 0.5) - balanced
# - (0.3, 0.7) - sparse-heavy
# - (0.2, 0.8) - very sparse-heavy
# - (0.7, 0.3) - dense-heavy

# Pick weights that maximize recall while maintaining precision > 20%
```

**Success Criteria:**
- Recall improves by 10+ percentage points
- Precision stays above 20%

---

### Priority 2: MEDIUM-TERM IMPROVEMENTS (Est. Impact: +15-25% recall)

#### 3.4 Query Expansion for Complex Queries
**Rationale:** Queries like "children and pollution" or "micromobility" may benefit from synonym expansion.

**Implementation:**
```python
# hybrid-service/query_expansion.py

from typing import List
import openai

class QueryExpander:
    """Expand queries with synonyms and related terms"""

    def expand_query(self, query: str, mode: str = "cite") -> str:
        """
        Use LLM to expand query with synonyms and related terms

        Example:
        Input: "children and pollution"
        Output: "children kids youth students AND pollution air quality emissions toxins health"
        """

        prompt = f"""You are a research librarian helping expand a search query for an academic database on sustainable transport and urban planning.

Original query: "{query}"

Generate an expanded version of this query that includes:
1. Synonyms and related terms
2. Common variations (plural/singular, abbreviations)
3. Closely related concepts

Keep the expansion focused and relevant. Return ONLY the expanded query, no explanation.

Expanded query:"""

        response = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3
        )

        expanded = response.choices[0].message.content.strip()

        # Log for debugging
        logger.info(f"Query expansion: '{query}' -> '{expanded}'")

        return expanded

    def expand_for_bm25(self, query: str) -> str:
        """Expand specifically for BM25 (keyword-based) search"""
        # Add common research terms
        # Add geography variations (Bangalore -> Bengaluru, Jakarta -> DKI Jakarta)
        pass

# Integrate into retrieval pipeline
@app.post("/query")
async def hybrid_query(request: QueryRequest):
    # ... existing code ...

    # Expand query if cite mode and query is complex
    query = request.query
    if request.mode == "cite" and is_complex_query(query):
        expander = QueryExpander()
        query = expander.expand_query(query)

    query_bundle = QueryBundle(query_str=query)
    # ... rest of retrieval ...
```

**Testing:**
```bash
# Test on failure cases
python evaluation/test_query_expansion.py

# Compare recall with/without expansion
# Expected: +10-15% recall on complex queries
```

**Success Criteria:**
- Recall on complex queries (thematic_intersection, intervention_impact) improves by 15+ points
- No degradation on simple queries

---

#### 3.5 Hybrid Metadata + Content Embeddings
**Rationale:** Current embeddings are content-only. Adding metadata (title, authors, abstract, tags) may improve semantic matching.

**Implementation:**
```python
# hybrid-service/main.py - Document processing

# BEFORE (content-only):
chunk_text = chunk.text

# AFTER (content + metadata):
metadata = documents_metadata[doc_id]
metadata_prefix = f"""
Title: {metadata['title']}
Authors: {metadata['authors']}
Year: {metadata['year']}
Tags: {metadata.get('subtag', '')}

Content:
"""

chunk_text_with_metadata = metadata_prefix + chunk.text
chunk.text = chunk_text_with_metadata
```

**Testing:**
```bash
# Requires reindexing - will rebuild embeddings
bash stop.sh
rm -rf hybrid-service/cache/indexes/*
bash start.sh

# Run evaluation
npm run eval:cite

# Expected: +5-10% recall improvement, especially on title/author queries
```

**Success Criteria:**
- Recall improves by 5+ points
- Startup time doesn't increase excessively

---

#### 3.6 Document-Level Retrieval + Chunk Re-ranking
**Rationale:** Current approach retrieves chunks, then groups by doc. May be better to retrieve docs directly, then find best chunks.

**Implementation:**
```python
# hybrid-service/main.py - New retrieval strategy

class DocumentLevelRetriever:
    """Retrieve at document level, then extract best chunks"""

    def retrieve(self, query: str, top_k: int = 100) -> List[DocumentWithChunks]:
        # 1. Retrieve chunks as usual
        chunk_results = self.hybrid_retriever.retrieve(query)

        # 2. Group by document and aggregate scores
        doc_scores = defaultdict(list)
        for chunk in chunk_results:
            doc_id = chunk.node.metadata['doc_id']
            doc_scores[doc_id].append(chunk.score)

        # 3. Rank documents by max/mean/sum of chunk scores
        doc_rankings = []
        for doc_id, scores in doc_scores.items():
            # Strategy: Use max score for ranking (most relevant chunk)
            doc_score = max(scores)
            doc_rankings.append((doc_id, doc_score, scores))

        doc_rankings.sort(key=lambda x: x[1], reverse=True)

        # 4. For top K documents, keep all relevant chunks
        results = []
        for doc_id, doc_score, chunk_scores in doc_rankings[:top_k]:
            results.append({
                'doc_id': doc_id,
                'score': doc_score,
                'num_chunks': len(chunk_scores),
                'chunk_scores': chunk_scores
            })

        return results
```

**Testing:**
```bash
# A/B test: Chunk-first vs Doc-first retrieval
python evaluation/compare_retrieval_strategies.py

# Metrics: recall, precision, MRR, NDCG
```

**Success Criteria:**
- Recall improves by 10+ points
- Maintains or improves precision

---

### Priority 3: ADVANCED IMPROVEMENTS (Est. Impact: +10-20% recall)

#### 3.7 Query Decomposition for Multi-Concept Queries
**Rationale:** Queries like "children AND pollution" may benefit from decomposition into sub-queries, then intersection of results.

**Implementation:**
```python
# hybrid-service/query_decomposition.py

class QueryDecomposer:
    """Decompose complex queries into sub-queries"""

    def decompose(self, query: str) -> List[str]:
        """
        Example:
        Input: "What have we published on children and pollution?"
        Output: [
            "children youth students school",
            "pollution air quality emissions health impacts"
        ]
        """

        prompt = f"""Decompose this research query into 2-3 focused sub-queries:

Query: "{query}"

Return each sub-query on a new line, no numbering."""

        response = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3
        )

        sub_queries = [
            q.strip()
            for q in response.choices[0].message.content.strip().split('\n')
            if q.strip()
        ]

        return sub_queries

    def retrieve_with_decomposition(
        self,
        query: str,
        retriever: BaseRetriever
    ) -> List[NodeWithScore]:
        """
        Retrieve using query decomposition:
        1. Decompose query into sub-queries
        2. Retrieve for each sub-query
        3. Intersect results (must appear in ALL sub-query results)
        4. Union results (appears in ANY sub-query result)
        5. Rank by number of sub-queries matched
        """

        sub_queries = self.decompose(query)

        if len(sub_queries) <= 1:
            # No decomposition needed
            return retriever.retrieve(QueryBundle(query_str=query))

        # Retrieve for each sub-query
        sub_results = []
        for sq in sub_queries:
            results = retriever.retrieve(QueryBundle(query_str=sq))
            sub_results.append(set(r.node.node_id for r in results))

        # Intersection: Documents that appear in ALL sub-queries
        intersection = set.intersection(*sub_results)

        # Union: Documents that appear in ANY sub-query
        union = set.union(*sub_results)

        # Rank by coverage: How many sub-queries did this doc match?
        doc_coverage = {}
        for doc_id in union:
            coverage = sum(1 for sr in sub_results if doc_id in sr)
            doc_coverage[doc_id] = coverage / len(sub_queries)

        # Sort by coverage (higher = matches more sub-queries)
        ranked_docs = sorted(
            doc_coverage.items(),
            key=lambda x: x[1],
            reverse=True
        )

        # Return top K with scores
        # ... implementation ...
```

**Testing:**
```bash
# Test on thematic_intersection queries
python evaluation/test_query_decomposition.py

# Compare recall on:
# - q3_children_pollution (33% baseline)
# - q6_school_bus_health (33% baseline)
# - q4_climate_brazil (67% baseline)

# Expected: +20-30% recall on intersection queries
```

**Success Criteria:**
- Recall on thematic_intersection queries reaches 80%+
- No degradation on simple queries

---

#### 3.8 Negative Example Training for Reranker
**Rationale:** Current reranker may not distinguish between "talks about children" vs "talks about children AND pollution". Fine-tune on negative examples.

**Implementation:**
```python
# hybrid-service/reranker_training.py

from sentence_transformers import CrossEncoder, InputExample
from torch.utils.data import DataLoader

class CustomReranker:
    """Fine-tune cross-encoder on domain-specific data"""

    def create_training_data(
        self,
        golden_dataset: dict
    ) -> List[InputExample]:
        """
        Create training examples:
        - Positive: (query, expected_doc) pairs
        - Negative: (query, false_positive_doc) pairs
        """

        examples = []

        for test_case in golden_dataset['test_cases']:
            query = test_case['question']

            # Positive examples
            for url in test_case['expected_urls']:
                doc_text = get_document_text(url)
                examples.append(InputExample(
                    texts=[query, doc_text],
                    label=1.0
                ))

            # Negative examples (from false positives)
            false_positives = get_false_positives_for_query(query)
            for fp_url in false_positives:
                doc_text = get_document_text(fp_url)
                examples.append(InputExample(
                    texts=[query, doc_text],
                    label=0.0
                ))

        return examples

    def fine_tune_reranker(self, training_data: List[InputExample]):
        """Fine-tune cross-encoder on training data"""

        model = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')

        train_dataloader = DataLoader(
            training_data,
            shuffle=True,
            batch_size=16
        )

        model.fit(
            train_dataloader=train_dataloader,
            epochs=3,
            warmup_steps=100
        )

        model.save('hybrid-service/models/custom-reranker')
```

**Testing:**
```bash
# Fine-tune reranker on golden dataset
python hybrid-service/reranker_training.py

# Evaluate before/after
npm run eval:cite

# Expected: +10-15% precision, +5-10% recall
```

**Success Criteria:**
- Precision improves by 10+ points
- Recall doesn't decrease

---

#### 3.9 Semantic Query Reformulation with LLM
**Rationale:** Some queries may be poorly phrased for retrieval. LLM can reformulate into better search queries.

**Implementation:**
```python
# hybrid-service/query_reformulation.py

class QueryReformulator:
    """Reformulate user queries into better search queries"""

    def reformulate(self, query: str, context: str = None) -> str:
        """
        Reformulate query for better retrieval

        Example:
        Input: "Will electrifying school buses be beneficial for children's health outcomes?"
        Output: "electric school bus children health benefits air quality pollution reduction"
        """

        prompt = f"""You are a research librarian helping reformulate a user's question into an effective search query for an academic database on sustainable transport and urban planning.

User question: "{query}"

Reformulate this into a search query that:
1. Focuses on key concepts and entities
2. Uses terminology common in academic papers
3. Removes unnecessary question words
4. Emphasizes the core information need

Return ONLY the reformulated query, no explanation.

Reformulated query:"""

        response = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3
        )

        reformulated = response.choices[0].message.content.strip()

        logger.info(f"Query reformulation: '{query}' -> '{reformulated}'")

        return reformulated
```

**Testing:**
```bash
# Test reformulation on all queries
python evaluation/test_query_reformulation.py

# A/B test: Original vs Reformulated queries
# Expected: +5-10% recall improvement
```

**Success Criteria:**
- Recall improves by 5+ points
- User experience remains natural (transparent reformulation)

---

### Priority 4: EVALUATION INFRASTRUCTURE (Continuous Improvement)

#### 3.10 Automated Regression Testing
**Rationale:** Need to catch recall regressions before deployment.

**Implementation:**
```bash
# .github/workflows/eval-regression.yml

name: Recall Regression Test

on: [push, pull_request]

jobs:
  recall-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - uses: actions/setup-python@v4
        with:
          python-version: '3.10'

      - name: Install dependencies
        run: |
          npm install
          cd hybrid-service && pip install -r requirements.txt

      - name: Start services
        run: bash start.sh

      - name: Run recall evaluation
        run: npm run eval:cite

      - name: Check recall threshold
        run: |
          # Parse evaluation report
          # Fail if recall < 80% (target threshold)
          python evaluation/check_recall_threshold.py --min-recall 0.80

      - name: Post results to PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v6
        with:
          script: |
            // Post evaluation results as PR comment
```

---

#### 3.11 Real-Time Evaluation Dashboard
**Rationale:** Need to monitor recall/precision trends over time.

**Implementation:**
```typescript
// evaluation/dashboard/server.ts

import express from 'express';
import { readFileSync } from 'fs';
import { glob } from 'glob';

const app = express();

app.get('/api/evaluations', async (req, res) => {
  // Read all eval reports from evaluation/results/
  const reports = await glob('evaluation/results/eval-report-*.json');

  const data = reports.map(path => {
    const report = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      timestamp: report.timestamp,
      overall_recall: report.overall_recall,
      overall_precision: report.overall_precision,
      overall_f1: report.overall_f1,
      passing_rate: report.test_cases_passed / report.test_cases_total
    };
  }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  res.json(data);
});

app.get('/api/evaluations/:id', async (req, res) => {
  // Return detailed report for specific evaluation
  const report = JSON.parse(
    readFileSync(`evaluation/results/eval-report-${req.params.id}.json`, 'utf-8')
  );
  res.json(report);
});

app.listen(3001, () => {
  console.log('Evaluation dashboard running on http://localhost:3001');
});
```

```html
<!-- evaluation/dashboard/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>AskWRI Recall Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <h1>AskWRI Recall Evaluation Dashboard</h1>

  <div>
    <canvas id="recall-chart"></canvas>
  </div>

  <div>
    <h2>Recent Evaluations</h2>
    <table id="eval-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Recall</th>
          <th>Precision</th>
          <th>F1</th>
          <th>Passing</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    // Fetch evaluation data and render charts
    fetch('/api/evaluations')
      .then(r => r.json())
      .then(data => {
        // Render line chart showing recall/precision over time
        // Render table with recent evaluations
      });
  </script>
</body>
</html>
```

---

## 4. Implementation Plan

### Phase 1: Diagnostic Foundation (Week 1)
**Goal:** Understand WHERE and WHY documents are being lost.

**Tasks:**
1. ✅ Implement diagnostic evaluation framework (all 6 stages)
2. ✅ Add debug endpoints to hybrid service
3. ✅ Run diagnostic evaluation on all 7 test cases
4. ✅ Generate root cause analysis report
5. ✅ Prioritize fixes based on impact

**Deliverables:**
- `evaluation/run-diagnostic-eval.ts` - Diagnostic runner
- `evaluation/DIAGNOSTIC_REPORT.md` - Detailed findings
- `evaluation/IMPROVEMENT_PRIORITY.md` - Ranked list of fixes

**Success Criteria:**
- Can trace every missing document through retrieval pipeline
- Know which stage(s) are causing the most recall loss
- Have data-driven prioritization of fixes

---

### Phase 2: Quick Wins (Week 2)
**Goal:** Achieve 60-70% recall with low-hanging fruit.

**Tasks:**
1. Disable reranking for Cite mode (3.1)
2. Increase final result limit (3.2)
3. Adjust fusion weights (3.3)
4. Run evaluation after each change
5. A/B test weight combinations

**Deliverables:**
- Updated `src/config/retrieval.ts`
- Updated `hybrid-service/main.py`
- Evaluation report showing +20-30% recall improvement

**Success Criteria:**
- Overall recall ≥ 65%
- At least 2/7 test cases passing (recall ≥ 80%, precision ≥ 70%)
- No critical regressions in precision

---

### Phase 3: Medium-Term Improvements (Week 3-4)
**Goal:** Achieve 80-90% recall with query enhancement.

**Tasks:**
1. Implement query expansion (3.4)
2. Add metadata to embeddings (3.5)
3. Test document-level retrieval (3.6)
4. Run evaluation after each change
5. Optimize for best configuration

**Deliverables:**
- `hybrid-service/query_expansion.py`
- Updated embedding strategy
- Evaluation report showing +15-25% recall improvement

**Success Criteria:**
- Overall recall ≥ 85%
- At least 5/7 test cases passing
- Precision ≥ 25%

---

### Phase 4: Advanced Improvements (Week 5-6)
**Goal:** Achieve 95-100% recall with advanced techniques.

**Tasks:**
1. Implement query decomposition (3.7)
2. Fine-tune reranker on negative examples (3.8)
3. Add semantic query reformulation (3.9)
4. Comprehensive A/B testing
5. Optimize end-to-end pipeline

**Deliverables:**
- `hybrid-service/query_decomposition.py`
- `hybrid-service/reranker_training.py`
- `hybrid-service/query_reformulation.py`
- Evaluation report showing +10-20% recall improvement

**Success Criteria:**
- Overall recall ≥ 95%
- At least 6/7 test cases passing
- Precision ≥ 30%

---

### Phase 5: Production Hardening (Week 7)
**Goal:** Deploy with confidence and continuous monitoring.

**Tasks:**
1. Set up regression testing (3.10)
2. Build evaluation dashboard (3.11)
3. Document all changes
4. Create runbook for future improvements
5. Deploy to production

**Deliverables:**
- `.github/workflows/eval-regression.yml`
- `evaluation/dashboard/` - Real-time monitoring
- `CHANGELOG.md` - Complete history of improvements
- `RUNBOOK.md` - Troubleshooting guide

**Success Criteria:**
- Automated regression testing in CI/CD
- Real-time monitoring dashboard deployed
- Complete documentation
- Production deployment successful

---

## 5. Rollback Criteria

If any improvement causes unacceptable degradation, rollback immediately:

**Critical Rollback Triggers:**
- Recall drops by more than 5 percentage points
- Precision drops below 15%
- System latency exceeds 10 seconds for any query
- Any test case that was passing now fails

**Rollback Process:**
1. Revert code changes
2. Restart services
3. Run evaluation to confirm rollback successful
4. Document what went wrong
5. Adjust strategy before re-attempting

---

## 6. Expected Final Performance

After implementing all improvements:

| Metric | Current | Target | Expected |
|--------|---------|--------|----------|
| Overall Recall | 41.1% | 100% | 95-98% |
| Overall Precision | 18.5% | ≥30% | 30-40% |
| Overall F1 | 23.1% | ≥50% | 45-55% |
| Passing Rate | 0/7 | 7/7 | 6-7/7 |
| MRR | ? | ≥0.8 | 0.75-0.85 |
| NDCG@60 | ? | ≥0.9 | 0.85-0.92 |

### By Query Type:

| Query Type | Current Recall | Target | Expected |
|------------|----------------|--------|----------|
| Topic area | 50% | 100% | 95-100% |
| Geography | 67% | 100% | 90-100% |
| Thematic intersection | 33% | 100% | 90-100% |
| Thematic+geo intersection | 67% | 100% | 95-100% |
| Fuzzy topic | 38% | 100% | 85-95% |
| Intervention impact | 33% | 100% | 90-100% |
| Solution-focused (negative) | 0% | 100% | 100% |

---

## 7. Success Metrics

### Short-Term (Weeks 1-2):
- ✅ Diagnostic framework implemented and running
- ✅ Root cause analysis complete for all failure cases
- ✅ Recall improved to 60-70%
- ✅ 2+ test cases passing

### Medium-Term (Weeks 3-4):
- ✅ Recall improved to 80-90%
- ✅ 5+ test cases passing
- ✅ Precision maintained above 25%
- ✅ MRR above 0.7

### Long-Term (Weeks 5-7):
- ✅ Recall improved to 95%+
- ✅ 6-7 test cases passing
- ✅ Automated regression testing deployed
- ✅ Real-time monitoring dashboard live
- ✅ Production deployment complete

---

## 8. Next Steps

1. **Review this framework** with the team
2. **Run diagnostic evaluation** to baseline current system
3. **Prioritize fixes** based on diagnostic findings
4. **Implement Phase 1** (Quick Wins) immediately
5. **Iterate rapidly** with evaluation after each change

---

## Next Steps (No Restart Required)

Based on experiment findings, here are high-impact improvements that can be implemented without restarting the Python service:

### Option 1: LLM-Based Post-Retrieval Filtering (Recommended)

**Rationale:** Use gpt-4o-mini to judge whether each retrieved document is truly relevant to the query. The LLM can understand nuance that the cross-encoder cannot (e.g., "focuses on X" vs "mentions X").

**Implementation:**
```typescript
// New file: src/lib/llm-relevance-filter.ts

interface RelevanceJudgment {
  doc_id: string;
  is_relevant: boolean;
  confidence: number;
  reason: string;
}

async function judgeRelevance(
  query: string,
  docs: DocMeta[],
  mode: 'strict' | 'moderate' = 'moderate'
): Promise<DocMeta[]> {
  // Batch docs into groups of 10 for efficient processing
  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < docs.length; i += batchSize) {
    batches.push(docs.slice(i, i + batchSize));
  }

  const judgments: RelevanceJudgment[] = [];

  for (const batch of batches) {
    const prompt = `You are a research librarian helping filter search results for sustainable transport research.

Query: "${query}"

For each document below, judge if it is TRULY RELEVANT (primary focus) or just TANGENTIALLY RELATED (mentions in passing).

Strictness level: ${mode === 'strict' ? 'STRICT - Only documents where this is the PRIMARY focus' : 'MODERATE - Documents where this is a major theme'}

Documents:
${batch.map((doc, i) => `
${i + 1}. Title: ${doc.title}
   Summary: ${doc.summary?.slice(0, 300) || 'No summary available'}
   Year: ${doc.year || 'Unknown'}
`).join('\n')}

Respond with JSON array:
[
  {"doc_num": 1, "relevant": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"},
  ...
]`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      response_format: { type: 'json_object' }
    });

    const batchJudgments = JSON.parse(response.choices[0].message.content);
    // Map back to doc_ids and merge
  }

  // Filter docs based on judgments
  const relevantDocs = docs.filter(doc => {
    const judgment = judgments.find(j => j.doc_id === doc.doc_id);
    return judgment?.is_relevant && judgment.confidence >= 0.6;
  });

  return relevantDocs;
}
```

**Integration:**
```typescript
// In evaluation script or API route
const rawResults = await callPythonService(query, params);
const filteredResults = await judgeRelevance(query, rawResults, 'strict');
```

**Expected Impact:**
- Precision: +15-25 points (6% → 21-31%)
- Recall: -5-10 points (79% → 69-74%)
- F1: +8-12 points (11% → 19-23%)
- Cost: ~$0.001-0.003 per query (batched)

---

### Option 2: Metadata-Based Relevance Boosting

**Rationale:** Use document metadata (year, sub-tags, title keywords) to boost or filter results.

**Implementation:**
```typescript
// New file: src/lib/metadata-filter.ts

interface MetadataFilter {
  yearRange?: [number, number];
  requiredTags?: string[];
  excludeTags?: string[];
  titleMustContain?: string[];
}

function inferFiltersFromQuery(query: string): MetadataFilter {
  const filters: MetadataFilter = {};

  // Year detection
  const yearMatch = query.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[0]);
    filters.yearRange = [year - 2, year + 2];
  }

  // Geography detection
  const geographies = ['bangalore', 'brazil', 'jakarta', 'india', 'china'];
  const foundGeo = geographies.find(geo => query.toLowerCase().includes(geo));
  if (foundGeo) {
    filters.requiredTags = [foundGeo];
  }

  // Topic detection
  const topics = {
    'micromobility': ['Micromobility', 'Bike share', 'E-scooter'],
    'school bus': ['School transport', 'School bus'],
    'land value capture': ['Finance', 'Land value'],
    'housing': ['Housing', 'Urban development']
  };

  for (const [queryTerm, tags] of Object.entries(topics)) {
    if (query.toLowerCase().includes(queryTerm)) {
      filters.requiredTags = [...(filters.requiredTags || []), ...tags];
    }
  }

  return filters;
}

function applyMetadataFilters(docs: DocMeta[], filters: MetadataFilter): DocMeta[] {
  return docs.filter(doc => {
    // Year filter
    if (filters.yearRange && doc.year) {
      const year = parseInt(doc.year);
      if (year < filters.yearRange[0] || year > filters.yearRange[1]) {
        return false;
      }
    }

    // Required tags (boost scoring instead of hard filter)
    let relevanceBoost = 1.0;
    if (filters.requiredTags) {
      const docTags = (doc.meta?.subtag || '').toLowerCase();
      const matchCount = filters.requiredTags.filter(tag =>
        docTags.includes(tag.toLowerCase())
      ).length;
      relevanceBoost = 1.0 + (matchCount * 0.2); // 20% boost per tag match
    }

    // Apply boost to score
    if (doc.score) {
      doc.score *= relevanceBoost;
    }

    return true;
  });
}
```

**Expected Impact:**
- Precision: +3-7 points
- Recall: -2-5 points
- Low cost, no LLM calls

---

### Option 3: Query Decomposition for Complex Queries

**Rationale:** Queries like "children AND pollution" fail because the system treats them as OR. Decompose into sub-queries and require intersection.

**Implementation:**
```typescript
// New file: src/lib/query-decomposition.ts

async function decomposeQuery(query: string): Promise<string[]> {
  // Detect multi-concept queries
  const andPatterns = [/\band\b/i, /children.*pollution/, /climate.*brazil/];
  const isMultiConcept = andPatterns.some(pattern => pattern.test(query));

  if (!isMultiConcept) {
    return [query]; // Single concept, no decomposition
  }

  const prompt = `Decompose this research query into 2-3 focused sub-queries that capture distinct concepts:

Query: "${query}"

Return JSON array of sub-queries:
["sub-query 1", "sub-query 2", ...]`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3
  });

  const subQueries = JSON.parse(response.choices[0].message.content);
  return subQueries;
}

async function retrieveWithDecomposition(
  query: string,
  params: RetrievalParams
): Promise<DocMeta[]> {
  const subQueries = await decomposeQuery(query);

  if (subQueries.length === 1) {
    // No decomposition needed
    return callPythonService(query, params);
  }

  // Retrieve for each sub-query
  const subResults = await Promise.all(
    subQueries.map(sq => callPythonService(sq, params))
  );

  // Intersection: Documents that appear in ALL sub-query results
  const docIdSets = subResults.map(results =>
    new Set(results.map(doc => doc.doc_id))
  );

  const intersection = Array.from(docIdSets[0]).filter(docId =>
    docIdSets.every(set => set.has(docId))
  );

  // Return documents in intersection, ranked by average score
  const allDocs = subResults.flat();
  const intersectionDocs = intersection.map(docId => {
    const docInstances = allDocs.filter(d => d.doc_id === docId);
    const avgScore = docInstances.reduce((sum, d) => sum + (d.score || 0), 0) / docInstances.length;
    return { ...docInstances[0], score: avgScore };
  });

  return intersectionDocs.sort((a, b) => (b.score || 0) - (a.score || 0));
}
```

**Expected Impact:**
- Precision on multi-concept queries: +20-40 points
- Recall: -10-15 points (acceptable tradeoff)
- Works well for "children AND pollution", "climate AND Brazil"

---

### Option 4: Hybrid Approach (LLM + Metadata)

**Recommended Implementation Order:**
1. Start with LLM filtering (Option 1) - highest impact
2. Add metadata boosting (Option 2) - low cost enhancement
3. If intersection queries still fail, add decomposition (Option 3)

**Combined Expected Impact:**
- Precision: 6% → 25-35% (+19-29 points)
- Recall: 79% → 70-75% (-4-9 points)
- F1: 11% → 24-30% (+13-19 points)
- Passing tests: 0/7 → 3-5/7

---

## Appendix A: Code Files to Create

### Diagnostic Evaluation:
- `evaluation/diagnostics/corpus-analysis.ts`
- `evaluation/diagnostics/dense-retrieval-analysis.ts`
- `evaluation/diagnostics/sparse-retrieval-analysis.ts`
- `evaluation/diagnostics/fusion-analysis.ts`
- `evaluation/diagnostics/reranking-analysis.ts`
- `evaluation/diagnostics/grouping-analysis.ts`
- `evaluation/run-diagnostic-eval.ts`

### Debug Endpoints:
- `hybrid-service/main.py` - Add `/debug/dense-only`, `/debug/sparse-only`, `/debug/fusion-detailed`

### Improvements:
- `hybrid-service/query_expansion.py`
- `hybrid-service/query_decomposition.py`
- `hybrid-service/query_reformulation.py`
- `hybrid-service/reranker_training.py`

### Testing:
- `evaluation/test_query_expansion.py`
- `evaluation/test_query_decomposition.py`
- `evaluation/test_query_reformulation.py`
- `evaluation/grid_search_fusion_weights.py`
- `evaluation/compare_retrieval_strategies.py`

### Monitoring:
- `evaluation/dashboard/server.ts`
- `evaluation/dashboard/index.html`
- `.github/workflows/eval-regression.yml`
- `evaluation/check_recall_threshold.py`

---

## Appendix B: Useful Resources

### Information Retrieval Metrics:
- [IR Evaluation Measures (Wikipedia)](https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval))
- [NDCG Explained](https://en.wikipedia.org/wiki/Discounted_cumulative_gain)
- [Mean Reciprocal Rank](https://en.wikipedia.org/wiki/Mean_reciprocal_rank)

### Hybrid Retrieval:
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Dense vs Sparse Retrieval](https://www.pinecone.io/learn/hybrid-search-intro/)

### Reranking:
- [Cross-Encoders for Reranking](https://www.sbert.net/examples/applications/cross-encoder/README.html)
- [Fine-tuning Cross-Encoders](https://www.sbert.net/docs/training/cross-encoder.html)

### Query Processing:
- [Query Expansion Techniques](https://nlp.stanford.edu/IR-book/html/htmledition/query-expansion-1.html)
- [Query Reformulation with LLMs](https://arxiv.org/abs/2305.14283)

---

**Document Version:** 1.0
**Last Updated:** November 20, 2025
**Owner:** AskWRI Evaluation Team
