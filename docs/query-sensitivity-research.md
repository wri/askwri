# Query Sensitivity Research & Diagnostics

*Research notes on improving query robustness in LlamaCloud + Gemini embedding retrieval system*

## Problem Statement

Query sensitivity: Small changes in query wording produce dramatically different retrieval results, even when the semantic intent remains the same. This affects Answer mode quality and consistency.

**Current Setup:**
- LlamaCloud Pipeline with hybrid retrieval (dense + sparse)
- Gemini embeddings (768 dimensions)
- Transport decarbonization domain
- Aggressive retrieval parameters for document diversity

## Root Causes

### 1. Embedding Space Geometry
- **Vector proximity ≠ semantic similarity**: Small word changes → large vector distances
- **Curse of dimensionality**: In 768-D space, most vectors equidistant
- **Training bias**: Gemini embeddings reflect general training patterns, not domain-specific semantics
- **Tokenization effects**: Different tokenization of similar phrases

### 2. Retrieval Architecture Issues
- **Dense/sparse fusion algorithms**: How LlamaCloud combines scores amplifies sensitivity
- **Document chunking artifacts**: Semantic coherence broken at chunk boundaries
- **Metadata weighting**: Title/abstract fields may dominate inappropriately
- **Score normalization**: Different query lengths affect similarity scores

### 3. Domain-Specific Challenges
- **Technical terminology variations**: "decarbonization" vs "carbon reduction" vs "emissions reduction"
- **Transport sector synonyms**: "freight" vs "cargo" vs "goods transport" vs "commercial vehicles"
- **Academic vs industry language**: "HDV" vs "heavy-duty trucks" vs "commercial vehicles"

## Diagnostic Approaches

### 1. Embedding Analysis
```bash
# Test query variations and measure embedding similarity
queries = [
  "What special considerations are there for decarbonizing freight?",
  "What are freight decarbonization considerations?", 
  "How to decarbonize freight transport?",
  "Freight sector carbon reduction challenges",
  "Commercial vehicle emissions reduction strategies"
]

# Compute pairwise cosine similarity matrix
# Identify which semantic equivalents have low embedding similarity
```

### 2. Retrieval Debugging
- **LlamaCloud debug logs**: Enable to see dense vs sparse contribution scores
- **Retrieval-only testing**: Remove synthesis to isolate retrieval effects
- **Document ranking comparison**: Track how rankings change across query variations
- **Score distribution analysis**: Understand score gaps between top results

### 3. Query Sensitivity Mapping
```bash
# Test systematic variations
base_query = "decarbonizing freight"
variations = [
  "decarbonize freight",           # verb form
  "freight decarbonization",       # noun form  
  "carbon reduction in freight",   # alternative phrasing
  "reducing freight emissions",    # different verb
  "freight sector decarbonization" # added specificity
]
```

### 4. Domain Terminology Analysis
- **Synonym detection**: Map transport domain synonyms
- **Co-occurrence analysis**: Which terms appear together in relevant documents
- **TF-IDF analysis**: Identify distinctive terms for query expansion

## Solution Strategies

### 1. Query Preprocessing
- **Automatic query expansion**: Add domain synonyms before retrieval
  ```
  "freight" → ["freight", "cargo", "goods transport", "commercial vehicles"]
  "decarbonization" → ["decarbonization", "carbon reduction", "emissions reduction"]
  ```
- **Keyword extraction**: Identify core concepts and weight them
- **Multi-query generation**: Generate 3-5 variations and merge results
- **Query normalization**: Standardize verb forms, remove stop words

### 2. Retrieval System Tuning
- **Hybrid weight optimization**: Fine-tune dense vs sparse retrieval balance
  - Current: Review denseTopK/sparseTopK parameters
  - Test: Different ratios for different query types
- **Re-ranking models**: Add second-stage ranker trained on domain data
- **Query-time field boosting**: Weight title/abstract more for certain queries
- **Minimum score thresholds**: Filter low-confidence results

### 3. Embedding Enhancement
- **Domain adaptation**: Fine-tune embeddings on transport/energy corpus
- **Multiple embedding models**: Compare Gemini vs OpenAI vs domain-specific
- **Ensemble retrieval**: Combine results from multiple embedding approaches
- **Contextual embeddings**: Consider document context when computing similarities

### 4. Pipeline Architecture Improvements
- **Multi-stage retrieval**: Broad recall → precise ranking
- **Query understanding**: Classify query intent (technical vs general)
- **Feedback loops**: Learn from user interactions and result quality
- **Caching strategies**: Cache results for semantically similar queries

## Evaluation Framework

### 1. Query Variation Testing
```bash
test_cases = [
  {
    "concept": "freight_decarbonization",
    "queries": [...variations...],
    "expected_docs": [...relevant_doc_ids...],
    "quality_metrics": ["precision@5", "recall@10", "ndcg"]
  }
]
```

### 2. Relevance Assessment
- **Manual evaluation**: Rate top-K results for query variations
- **Inter-annotator agreement**: Multiple evaluators for consistency
- **Domain expert validation**: Transport researchers validate results

### 3. System Metrics
- **Query-document similarity distributions**
- **Result overlap across query variations**
- **Score variance for semantically equivalent queries**
- **User interaction patterns** (if available)

## Implementation Priorities

### Phase 1: Diagnostics (Immediate)
1. **Query embedding similarity analysis**
2. **Retrieval debugging for key query pairs**
3. **Document ranking comparison dashboard**

### Phase 2: Quick Wins (1-2 weeks)
1. **Query expansion with transport domain synonyms**
2. **Hybrid retrieval weight tuning**
3. **Query preprocessing pipeline**

### Phase 3: Advanced (1-2 months)
1. **Domain-adapted embeddings**
2. **Multi-model ensemble retrieval**
3. **Learning-to-rank re-ranking**

## Specific to AskWRI System

### Current Configuration Analysis Needed
- **LlamaCloud Pipeline settings**: Dense/sparse weights, chunking strategy
- **Retrieval presets**: ANSWER_PRESET vs CITE_PRESET parameters
- **Document preprocessing**: Metadata extraction, filtering logic

### Domain-Specific Considerations
- **Transport terminology**: Comprehensive synonym mapping
- **Academic paper structure**: Abstract/conclusion often most relevant
- **Policy vs technical documents**: Different language patterns

### Integration Points
- **Pre-processing in `/api/llama/chat`**: Add query expansion
- **Post-processing in retrieval logic**: Re-ranking and filtering
- **UI feedback**: Collect user ratings on result quality

## Resources for Further Research

### Academic Papers
- "Dense Passage Retrieval for Open-Domain Question Answering" (Karpukhin et al.)
- "Improving Document Representations by Generating Pseudo Query Embeddings" (Ma et al.)
- "Query Expansion Techniques for Information Retrieval" (Carpineto & Romano)

### Technical Resources
- LlamaIndex retrieval optimization guides
- Google AI embedding model documentation
- Transport domain ontologies and vocabularies

---

**Next Actions:**
1. Set up query variation testing framework
2. Implement basic synonym expansion
3. Create retrieval debugging dashboard
4. Collect baseline metrics for improvement tracking