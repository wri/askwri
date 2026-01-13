# Next Steps for Evaluation Improvements

**Status**: Performance restored to baseline after catastrophic regression
**Current**: 67.3% recall, 34.2% precision, 44.7% F1 (0/11 passing)
**Target**: 80% recall, 70% precision, 6+/11 passing

---

## What Just Happened (Context)

We experienced a catastrophic regression caused by a "speed optimization" that filtered only the top 30 documents and passed through the remaining 30-50 documents unfiltered. This caused:

- Precision to collapse by 72% (36.8% → 10.3%)
- User experience to degrade (reviewing 50+ docs with 10% precision vs 10 docs with 40% precision)
- False economy: Saved $0.002/query but cost users 26 minutes reviewing false positives

**Root cause**: Quality filters exist for a reason. The LLM relevance filter is designed to catch documents that are semantically similar but tangentially related (mentions in passing). Bypassing this filter for 70% of results defeated its entire purpose.

**Key lesson**: Never optimize away quality filters. Optimize by making them faster (batching, caching, better models), not by skipping them.

---

## Current State Analysis

### What's Working Well
1. **LLM relevance filtering** - Removes tangentially related docs effectively
2. **Hybrid retrieval** - Vector + BM25 fusion provides good coverage
3. **Cross-encoder reranking** - Moves relevant docs to top positions
4. **Query parsing** - Preserving full query text helps semantic search

### Known Issues by Test Case

**Q1 (Land Value Capture)** - 100% recall, 44.4% precision
- Status: Good recall, acceptable precision
- Issue: Still retrieving some broad urban planning papers

**Q2 (Bangalore)** - 83.3% recall, 41.7% precision
- Status: Missing 1 expected doc, acceptable precision
- Issue: May need better geographic signal boosting

**Q3 (Children & Pollution)** - 66.7% recall, 28.6% precision
- Status: Missing 1 expected doc, low precision
- Issue: School bus datasets appearing instead of policy papers
- Root cause: Dataset titles match keywords but aren't policy analysis

**Q4 (Climate Brazil)** - 66.7% recall, 18.2% precision
- Status: Missing 1 expected doc, very low precision
- Issue: Retrieving general Latin America papers (Porto Alegre, etc.)
- Root cause: Geographic proximity overriding thematic focus

**Q5 (Micromobility)** - 75% recall, 60.0% precision ✨
- Status: Best performing query, good balance
- Observation: Query expansion for niche terms working well

**Q6 (School Bus Health)** - 100% recall, 50.0% precision ✨
- Status: Perfect recall, good precision
- Issue: Some general e-bus papers appearing

**Q7 (Jakarta Housing)** - 75% recall, 37.5% precision
- Status: Missing 1 expected doc, acceptable precision
- Issue: Broad housing/urban papers from other regions

**Q8 (Hydrogen)** - 60% recall, 33.3% precision
- Status: Missing 2 expected docs, low precision
- Issue: Broad energy transition papers appearing
- Root cause: "Hydrogen" appears in tangential contexts

**Q9 (World Resources Report)** - 43.8% recall, 18.9% precision ❌
- Status: **CRITICAL FAILURE** - Missing 9 of 16 WRR papers
- Issue: Program metadata added but not being used effectively
- Root cause: LLM filter can't distinguish WRR from similar topics without metadata
- Note: program_series field added to hybrid service but cache not rebuilt

**Q10 (Urban Finance since 2020)** - 20% recall, 12.5% precision ❌
- Status: **CRITICAL FAILURE** - Missing 8 of 10 expected docs
- Issue: "Urban finance" too amorphous, year filter not helping
- Root cause: Query too broad, year filter alone insufficient

**Q11 (Urban Finance excluding E-buses)** - 50% recall, 31.3% precision
- Status: Missing 5 expected docs, low precision
- Issue: Exclusion filter not working well, still seeing e-bus papers
- Root cause: Keyword-based exclusion too simplistic

---

## Prioritized Improvement Opportunities

### Tier 1: Critical Failures (Q9, Q10)

**Q9: WRR Program Filtering**
- Problem: 43.8% recall despite having program_series metadata
- Current approach: Added metadata field but not used in filtering
- Fix needed:
  1. Clear node/index cache to force rebuild with program_series
  2. Verify program_series in chunk metadata
  3. Use metadata in LLM prompt: "This document is part of [program]"
  4. Consider pre-filtering by program before LLM judgment
- Expected impact: 43.8% → 75%+ recall
- Complexity: Medium (cache rebuild + prompt engineering)

**Q10: Amorphous Queries with Temporal Constraints**
- Problem: "Urban finance since 2020" is too broad (20% recall)
- Current approach: Year filter + semantic search
- Issue: Query semantically matches too many tangential papers
- Potential fixes:
  1. Query decomposition: "finance AND (buses OR transit OR infrastructure)"
  2. Boost docs that mention specific finance terms (bonds, funding, investment)
  3. Use doc.summary field to pre-filter for finance focus
  4. Stricter LLM judgment: "PRIMARY focus on financial aspects"
- Expected impact: 20% → 50%+ recall
- Complexity: High (requires query understanding)

### Tier 2: Precision Improvements (Q3, Q4, Q8)

**Q3, Q4: Dataset vs Analysis Distinction**
- Problem: Technical datasets appearing when user wants policy analysis
- Example: "dataset-esb-adoption" appearing for "children and pollution"
- Potential fix:
  1. Add document_type metadata (analysis, dataset, technical_note, etc.)
  2. LLM prompt: "Exclude technical datasets, focus on policy analysis"
  3. Title pattern detection: "dataset-*" or "technical-note-*"
- Expected impact: Precision +10-15%
- Complexity: Low (metadata + prompt)

**Q4: Geographic Precision**
- Problem: Broad geographic matches (general Latin America vs specific Brazil)
- Potential fix:
  1. Boost exact country matches over regional matches
  2. LLM prompt: "Document must focus on [specific country], not just region"
  3. Add country metadata field for stricter filtering
- Expected impact: Precision +10-15%
- Complexity: Medium (metadata extraction)

**Q8: Niche Technology Focus**
- Problem: Tangential mentions of hydrogen in broader energy papers
- Potential fix:
  1. Query expansion already working (using synonym list)
  2. Stricter LLM: "Hydrogen must be PRIMARY focus, not brief mention"
  3. Check if "hydrogen" appears in title or abstract
- Expected impact: Recall +10-20%, maintain precision
- Complexity: Low (prompt tuning)

### Tier 3: Exclusion Logic (Q11)

**Q11: Better Exclusion Handling**
- Problem: "Exclude electric buses" not working well (50% recall)
- Current: Simple keyword matching in title/content
- Issues:
  1. "E-bus" vs "electric bus" vs "BEB" - need synonym expansion
  2. Docs about "urban finance for e-bus deployment" should be excluded
  3. Docs about "urban finance" in general e-bus context should be excluded
- Potential fixes:
  1. Expand exclusion keywords: ["electric bus", "e-bus", "BEB", "battery bus"]
  2. Check if excluded term appears in title (stricter)
  3. LLM-based exclusion: "Does this paper primarily discuss [excluded topic]?"
- Expected impact: Precision +10-15%
- Complexity: Low (synonym expansion) to Medium (LLM-based)

---

## Recommended Next Actions (In Order)

### 1. Fix Q9 (WRR Program Filtering) - HIGHEST PRIORITY
**Why**: We have the metadata, just need to use it effectively
**Steps**:
```bash
# Clear cache to rebuild with program_series
rm -rf hybrid-service/cache/nodes/*
rm -rf hybrid-service/cache/indexes/*

# Restart service
bash stop.sh && bash start.sh

# Re-run eval
npm run eval:cite
```
**Expected**: 43.8% → 75%+ recall on Q9
**Time**: 30 minutes (cache rebuild + eval)

### 2. Add Document Type Metadata - MEDIUM PRIORITY
**Why**: Distinguish datasets from analysis papers (helps Q3, Q4, Q6)
**Steps**:
1. Add document_type field to CSV metadata
2. Extract from title patterns: "dataset-*", "technical-note-*", etc.
3. Use in LLM prompt: "Focus on policy analysis, exclude technical datasets"
4. Update hybrid service to include in chunk metadata

**Expected**: +10-15% precision on Q3, Q4, Q6
**Time**: 2-3 hours (metadata extraction + testing)

### 3. Improve Q10 (Amorphous Queries) - HIGH COMPLEXITY
**Why**: Requires better query understanding and decomposition
**Approaches to explore**:
- Query decomposition: Break "urban finance" into sub-queries
- Summary-based pre-filtering: Use doc.summary to check finance focus
- Stricter LLM prompts: "PRIMARY focus on financial aspects"
- Boost specific finance terms: bonds, funding, investment, capital

**Expected**: 20% → 50%+ recall
**Time**: 4-6 hours (experimentation needed)

### 4. Better Exclusion Logic - MEDIUM PRIORITY
**Why**: Exclusion queries are common use case
**Steps**:
1. Expand exclusion synonyms in query-parser.ts
2. Add exclusion strength levels (strict vs soft)
3. Consider LLM-based exclusion for complex cases

**Expected**: +10-15% precision on Q11
**Time**: 2-3 hours

---

## Architecture Principles (Learned from Regression)

1. **Never bypass quality filters for speed** - Optimize by making them faster, not by skipping them
2. **Cost-benefit analysis** - $0.002/query API cost << 26 minutes of user time
3. **Filter all candidates** - Reranker scores ≠ document-level relevance
4. **Fail gracefully** - When in doubt, show the doc (optimize for recall in Cite mode)
5. **Validate assumptions** - Test optimizations before deploying
6. **Track metrics rigorously** - Precision/recall/F1 per query, not just overall

---

## Success Criteria

**Minimum bar** (restore baseline):
- ✅ Recall: ≥70% (achieved: 67.3% - close)
- ✅ Precision: ≥35% (achieved: 34.2% - close)
- ❌ Tests passing: ≥6/11 (achieved: 0/11 - need stricter thresholds OR better performance)

**Stretch goal** (meaningful improvement):
- Recall: ≥80%
- Precision: ≥70%
- Tests passing: ≥8/11

**Critical fixes** (blockers):
- Q9: ≥75% recall (currently 43.8%)
- Q10: ≥50% recall (currently 20%)

---

## What NOT to Do (Anti-Patterns)

❌ **Don't** optimize away quality filters to save $0.002/query
❌ **Don't** assume high reranker score = relevant doc
❌ **Don't** make architectural changes without measuring impact
❌ **Don't** batch-apply "improvements" without testing individually
❌ **Don't** ignore outlier test cases (Q9, Q10) - they reveal systemic issues
❌ **Don't** lower pass/fail thresholds to make metrics look better
❌ **Don't** add features without understanding root causes first

✅ **Do** fix critical failures (Q9, Q10) before optimizing precision
✅ **Do** add metadata that helps LLM make better judgments
✅ **Do** test changes on individual queries before full eval
✅ **Do** use git commits to enable easy rollback
✅ **Do** document assumptions and validate them with data
✅ **Do** optimize by making filters faster, not by skipping them

---

## Files Created During This Session

1. `evaluation/ROOT_CAUSE_ANALYSIS.md` - Comprehensive analysis of the regression
2. `evaluation/REVERSION_CHECKLIST.md` - Step-by-step reversion guide
3. `evaluation/QUICK_SUMMARY.md` - One-page executive summary
4. `evaluation/ANALYSIS_WHY_IMPROVEMENTS_FAILED.md` - Initial analysis
5. `evaluation/GOLDEN_DATASET_VALIDATION_REPORT.md` - Dataset validation
6. `scripts/add-wrr-metadata.ts` - Script to add WRR metadata
7. `scripts/validate-eval-urls.ts` - Script to validate golden set URLs

---

**Last Updated**: 2025-11-23
**Next Session**: Start with Q9 cache rebuild and WRR fix
