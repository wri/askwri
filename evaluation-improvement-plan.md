# AskWRI Evaluation Infrastructure Improvement Plan

## Executive Summary

AskWRI has **excellent parameter testing and retrieval analysis infrastructure** with 19 sophisticated test endpoints covering recall optimization, multi-query strategies, and configuration testing. However, it **lacks systematic quality evaluation** - missing ground truth datasets, answer quality metrics, and unified evaluation frameworks.

## Current Evaluation Infrastructure ✅

### Extensive Test API Endpoints (19 total)
- **Recall Testing**: `test-recall`, `test-ultra-recall`, `test-max-recall`, `test-brute-force`
- **Parameter Optimization**: `test-params`, `test-topk-variants`, `test-chat-params`, `test-message-params`
- **Mode Comparisons**: `test-multi-query`, `test-files-mode`, `test-metadata-mode`, `test-playground-mode`
- **Retrieval Analysis**: `test-retrieve`, `test-multi-direct`, `test-doc-enum`, `test-query-endpoint`
- **Format/Configuration**: `test-rerank-format`, `test-raw-response`, `test-system-message`

### Sophisticated Test Scripts
- `test_fixes.py` - Comprehensive integration testing (health checks, mode testing, API validation)
- `test_setup.py`, `test_context_debug.py` - Component-specific testing
- `scripts/test-summary.ts` - OpenAI API testing

### Advanced Evaluation Features
- Multi-strategy recall testing with brute force approaches
- Parameter sweeping across different configurations
- Document diversity analysis and coverage metrics
- Performance timing and comparison analysis
- SSE response parsing for LlamaCloud integration

## Critical Evaluation Gaps ❌

### 1. No Ground Truth/Gold Standard Datasets
- Missing curated query-answer pairs for transport decarbonization
- No relevance judgments for retrieval evaluation
- No benchmark comparisons with expected results

### 2. Missing Quality Evaluation Metrics
- No answer quality assessment (factual accuracy, completeness)
- No citation quality evaluation (precision, recall, attribution)
- No semantic similarity measurement between generated vs expected answers

### 3. No Systematic Evaluation Framework
- Tests are scattered across individual endpoints
- No unified evaluation pipeline or runner
- No regression testing to catch performance degradation
- No automated evaluation on model/config changes

### 4. No User Experience Evaluation
- Missing latency/performance benchmarks
- No evaluation of result ranking quality
- No assessment of document diversity effectiveness

### 5. No Error Analysis & Failure Case Detection
- No systematic analysis of failure modes
- Missing evaluation of edge cases (ambiguous queries, domain gaps)
- No tracking of retrieval vs synthesis failures

## High-Priority Recommendations 🎯

### 1. Create Evaluation Dataset (`eval-dataset/`)
```
eval-dataset/
├── queries.json              # 50+ transport queries
├── relevance_judgments.json  # Doc-level relevance per query
├── answer_key.json           # Expected answer quality criteria
└── edge_cases.json           # Challenging/failure cases
```

**Example Structure:**
```json
// queries.json
{
  "queries": [
    {
      "id": "q001",
      "query": "What are the main barriers to electric bus adoption in developing cities?",
      "category": "barriers",
      "difficulty": "medium",
      "expected_doc_count": 8
    }
  ]
}

// relevance_judgments.json
{
  "q001": {
    "doc_16": {"relevance": 3, "rationale": "Direct discussion of financial barriers"},
    "doc_23": {"relevance": 2, "rationale": "Mentions infrastructure challenges"},
    "doc_35": {"relevance": 1, "rationale": "Tangentially related policy discussion"}
  }
}
```

### 2. Unified Evaluation Runner (`scripts/run-eval.ts`)
- Single command to run all evaluation metrics
- Configurable test suites for different scenarios
- Automatic comparison against baselines
- Regression detection and reporting

**Example Usage:**
```bash
npm run eval                    # Full evaluation suite
npm run eval --quick           # Core metrics only
npm run eval --regression      # Compare against baseline
npm run eval --query="buses"   # Single query testing
```

### 3. Core Quality Metrics
- **Retrieval**: Precision@K, Recall@K, NDCG, document diversity
- **Answer Quality**: BLEU/ROUGE vs reference answers, factual consistency
- **Citation**: Citation precision/recall, attribution accuracy
- **Performance**: Response latency, token efficiency

### 4. Continuous Integration Evaluation
- Pre-commit evaluation hooks
- Performance regression detection
- Automated quality monitoring dashboard

## Implementation Phases 📋

### Phase 1 (Immediate - 1 week)
**Goal:** Consolidate existing testing infrastructure

- [ ] Create unified evaluation dashboard consolidating 19 test endpoints
- [ ] Develop basic evaluation dataset with 25 transport decarbonization queries
- [ ] Implement automated quality metrics runner
- [ ] Add basic regression testing framework

**Deliverables:**
- `scripts/eval-dashboard.ts` - Unified test runner
- `eval-dataset/basic-queries.json` - Initial query set
- `scripts/quality-metrics.ts` - Core metrics calculation

### Phase 2 (Short-term - 1 month)
**Goal:** Add systematic quality evaluation

- [ ] Develop ground truth relevance judgments for retrieval evaluation
- [ ] Add answer quality scoring with semantic similarity metrics
- [ ] Create CI/CD integration for regression testing
- [ ] Implement citation quality evaluation framework

**Deliverables:**
- `eval-dataset/relevance-judgments.json` - Manual relevance annotations
- `src/lib/eval-metrics.ts` - Quality scoring functions
- `.github/workflows/eval.yml` - CI evaluation pipeline
- `scripts/citation-eval.ts` - Citation accuracy measurement

### Phase 3 (Long-term - 3 months)
**Goal:** Comprehensive evaluation and benchmarking

- [ ] Build comprehensive evaluation benchmarks comparing against external systems
- [ ] Implement user study framework for UX evaluation
- [ ] Create specialized evaluation for domain-specific transport terminology
- [ ] Add automated failure case detection and analysis

**Deliverables:**
- `eval-dataset/benchmark-comparison.json` - External system comparisons
- `scripts/user-study.ts` - UX evaluation framework
- `src/lib/domain-eval.ts` - Transport-specific metrics
- `scripts/failure-analysis.ts` - Automated error detection

## File Structure

```
askwri/
├── eval-dataset/
│   ├── queries.json                 # Core evaluation queries
│   ├── relevance_judgments.json     # Manual relevance annotations
│   ├── answer_key.json              # Expected answer characteristics
│   ├── edge_cases.json              # Challenging test cases
│   └── benchmarks/
│       ├── baseline_results.json    # Historical performance data
│       └── external_comparisons.json # External system benchmarks
├── scripts/
│   ├── run-eval.ts                  # Main evaluation runner
│   ├── eval-dashboard.ts            # Unified test interface
│   ├── quality-metrics.ts           # Core metric calculations
│   ├── citation-eval.ts             # Citation quality assessment
│   ├── regression-test.ts           # Performance regression detection
│   └── failure-analysis.ts          # Error pattern analysis
├── src/lib/
│   ├── eval-metrics.ts              # Quality scoring functions
│   └── domain-eval.ts               # Transport-specific evaluation
└── .github/workflows/
    └── eval.yml                     # CI evaluation pipeline
```

## Success Metrics

### Immediate (Phase 1)
- [ ] Single command evaluation runner working
- [ ] 25+ transport queries with basic relevance judgments
- [ ] Automated regression detection on key metrics
- [ ] Developer adoption of unified testing interface

### Short-term (Phase 2)
- [ ] Comprehensive quality metrics (retrieval precision >0.8, answer quality >7/10)
- [ ] CI integration preventing quality regressions
- [ ] Citation accuracy measurement and improvement
- [ ] 50+ annotated query-document pairs

### Long-term (Phase 3)
- [ ] Competitive performance vs external research systems
- [ ] User satisfaction metrics >8/10 in studies
- [ ] Domain expertise evaluation showing transport terminology accuracy
- [ ] Automated quality monitoring and alerting system

## Next Steps

1. **Start with Phase 1** - Focus on consolidating existing infrastructure
2. **Prioritize evaluation dataset creation** - This enables all other quality metrics
3. **Implement unified runner** - Makes evaluation accessible to entire team
4. **Add CI integration** - Prevents regressions and ensures quality maintenance

This plan transforms AskWRI from having strong **performance testing** to having comprehensive **quality evaluation** - essential for research system validation and continuous improvement.