# AskWRI System Status (Nov 22, 2025)

## Quick Start

```bash
bash start.sh                      # Start all services
npm test                          # Run tests
npx tsx evaluation/run-cite-eval.ts  # Run Cite mode evaluation
```

## Current Performance

### Cite Mode (Research Bibliography)
- **Precision:** 29.4% (target: ≥30%, 98% achieved)
- **Recall:** 68.5% (target: ≥75%, 91% achieved)
- **F1:** 39.5%
- **Cost:** ~$0.003 per query

### Answer Mode (Quick Synthesis)
- Not evaluated (focus on Cite mode)
- Uses precision-optimized retrieval (150/150, rerank to top 10)

## System Architecture

**Query Flow:**
1. Hybrid retrieval: Vector (OpenAI) + BM25 sparse search
2. RRF fusion with balanced weights (0.5/0.5)
3. Cross-encoder reranking (top 60 for Cite, top 10 for Answer)
4. **[Cite only]** LLM relevance filtering (gpt-4o-mini)
5. Result hydration with metadata from CSV
6. LLM synthesis (Answer mode) or bibliography (Cite mode)

**Key Feature:** LLM filtering uses both document summary + retrieved chunk text for accurate relevance judgment.

## Recent Improvements (Nov 22, 2025)

**LLM-Based Relevance Filtering:**
- Precision improved 59% (18.5% → 29.4%)
- Recall improved 67% (41.1% → 68.5%)
- Moderate strictness mode (≥15% content relevance)
- Confidence threshold: 0.35
- Implementation: `src/lib/llm-relevance-filter.ts`

## Documentation Index

### For Users
- **README.md** - Project overview and getting started
- **CLAUDE.md** - Developer guide (updated with LLM filtering)
- **STARTUP.md** - Service startup details

### For Deployment
- **RAILWAY_DEPLOY.md** - Production deployment guide
- **DEPLOYMENT.md** - General deployment info

### For Development
- **ARCHITECTURE.md** - System architecture
- **DOCUMENT_MANAGEMENT.md** - Document upload/management
- **TESTING.md** - Test suite documentation

### For Evaluation
- **evaluation/README.md** - Evaluation framework
- **evaluation/RECALL_IMPROVEMENT_FRAMEWORK.md** - Complete experiment log
- **evaluation/FUTURE_IMPROVEMENTS.md** - Next steps roadmap
- **evaluation/FUTURE_IMPROVEMENTS_ROADMAP.md** - Detailed 15+ improvements
- **evaluation/IMMEDIATE_ACTIONS.md** - Top 3 priorities this week

## Key Files

**Retrieval System:**
- `src/config/retrieval.ts` - Cite/Answer mode presets
- `src/lib/llm-relevance-filter.ts` - LLM filtering (NEW)
- `src/lib/query-expansion.ts` - Query expansion (disabled for Cite)
- `hybrid-service/main.py` - Python retrieval service

**Evaluation:**
- `evaluation/run-cite-eval.ts` - Automated Cite mode eval
- `evaluation/golden-dataset.json` - 7 test queries, 27 expected docs
- `evaluation/results/` - Historical evaluation reports

## Next Steps (Do Not Implement Without Review)

See `evaluation/IMMEDIATE_ACTIONS.md` for top 3 priorities:

1. **Query-Specific LLM Filtering** (4-8 hours) - Expected +3-8% precision
2. **Confidence-Weighted Scoring** (6-10 hours) - Expected +3-7% recall
3. **Lower Confidence Threshold** (2 hours) - Expected +2-5% recall

**Expected outcome:** 32-37% precision, 71-75% recall (meeting both targets)

## Configuration

**Environment Variables (.env):**
```bash
OPENAI_API_KEY=sk-...
LLAMAINDEX_SERVICE_URL=http://127.0.0.1:8002
```

**Cite Mode Settings:**
- Retrieval: 500 dense, 500 sparse (balanced fusion)
- Reranking: Top 60 chunks
- LLM filter: Moderate mode, confidence ≥0.35
- Query expansion: Disabled

## Support

- Issues: Create GitHub issue with evaluation results
- Questions: See CLAUDE.md for system details
- Deployment: RAILWAY_DEPLOY.md for production setup
