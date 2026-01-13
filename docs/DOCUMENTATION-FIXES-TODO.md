# Documentation Fixes TODO

Subagent review completed: **79 issues found** across 6 files (6.5/10 honesty score)

## Critical Fixes Required (21 issues)

### Priority 1: Cross-File Issue - "37 Documents" Claim (Issue #82)

**Impact**: HIGH - Unverified metric repeated 8+ times across all files
**Files**: README.md, IMPLEMENTATION_SUMMARY.md, CLAUDE.md
**Fix**: Add single source of truth in introduction

```markdown
## Corpus Size
Current corpus: 37 documents (as of 2025-11-14 migration)
- Migration command: `npx tsx scripts/migrate-catalog.ts`
- Verification: Check `data/documents.csv` (should have 38 lines including header)
- Source: Legacy `public/TransportDecarb_llamacloud_metadata*.csv` (100% migrated)
```

**Action**: Add to README.md introduction, reference from other files

---

### Priority 2: README.md Critical Issues (Issues #1-8)

**File**: README.md (Lines 273-304, 410-421, 499-502, 7-10, 38-67, 16-22, 572-574)

#### Issue #1: Test Coverage Framing (Line 273-304)
**Current**:
```
**What is tested:**
- PDF text extraction (13 tests)
- CSV metadata parsing (3 tests)

**What is not tested:**
- Job queue system (24 tests skipped due to async timing issues)
```

**Fix To**:
```
**Test Coverage (as of 2025-11-14):**
- Passing: 16 tests total
  - PDF text extraction: 13 tests
  - CSV metadata parsing: 3 tests
- Skipped: 24 tests
  - Job queue: 24 tests (async timing prevents reliable execution)
- Missing: ~20 tests (Zotero parser, API routes, duplicate detection)

**Coverage Enforcement:** 70% threshold configured (actual coverage unknown)
```

**Severity**: CRITICAL
**Time**: 15 min

---

#### Issue #2: Performance Claims (Lines 410-421)
**Current**:
```
- Embeddings are computed once per document and cached
- Subsequent queries reuse cached embeddings
- Pickle files store embeddings persistently across restarts
```

**Fix To**:
```
### Embedding Caching
- Embeddings computed once per document (~2-5s depending on length)
- Cached in `hybrid-service/cache/` as pickle files
- Subsequent queries reuse cached embeddings (avoids re-computation)

**Limitations:**
- Cache invalidation: Manual (delete pickle files to recompute)
- Cache hits: Not measured or logged
- Performance impact: Not benchmarked (anecdotally "faster")
- File format: Python version-dependent pickle files
```

**Severity**: CRITICAL
**Time**: 10 min

---

#### Issue #3: Cost Estimates (Lines 499-502)
**Current**:
```
- Total: ~$0.0002 per document on average
```

**Fix To**:
```
### Per Document Cost Estimate (10-page assumption)
**Calculation:**
- Summary generation: 500 input + 100 output tokens at $0.15/$0.60 per 1M = $0.000135
- Embedding generation: 5000 tokens at $0.02/1M = $0.0001
- **Total: ~$0.0002 per 10-page document**

**Limitations:**
- No actual cost tracking/logging implemented
- Assumes 500 tokens per page (varies)
- Does not include query costs
- Pricing may change (check OpenAI dashboard)
```

**Severity**: CRITICAL
**Time**: 15 min

---

#### Issue #4: Architecture Tradeoffs Missing (Lines 38-67)
**Current**: Architecture diagram with no discussion of why these choices

**Fix To**: Add section after diagram:
```markdown
### Architecture Tradeoffs

**Python Hybrid Service (Railway):**
- Chosen for: Managed deployment, easy scaling
- Cost: $5-20/month
- Tradeoff: Vendor lock-in, cold start latency, per-instance state
- Alternative: AWS Lambda (rejected: cold start for large models)

**OpenAI APIs:**
- Chosen for: Quality, reliability, no model hosting
- Cost: Per-token (~$0.037/query), expensive at scale (>10K queries/month)
- Tradeoff: Latency (200-400ms), no fine-tuning, rate limits
- Alternative: Local models (rejected: quality, maintenance burden)

**Unified CSV Database:**
- Chosen for: Simplicity, git-friendly, no database
- Limitation: Single file, no concurrency, 10K document limit
- When to migrate: >10K documents or multi-user editing needed
```

**Severity**: CRITICAL
**Time**: 20 min

---

#### Issue #5: Document Management Features Unqualified (Lines 16-22)
**Current**: Lists features without limitations

**Fix To**:
```markdown
**Document Management:**
- Web-based admin interface at `/admin/documents` (no authentication, add as needed)
- Single or batch PDF uploads (max ~10/batch recommended, no hard limit)
- Zotero CSV import (85%+ similarity threshold, hardcoded)
- Duplicate detection (3-tier: exact, fuzzy, title collision)
- Job queue (in-memory, lost on server restart, no persistence)
```

**Severity**: CRITICAL
**Time**: 10 min

---

#### Issue #6: Similarity Thresholds Unqualified (Line 10)
**Current**: "Configurable similarity thresholds"

**Fix To**: "Similarity thresholds: Hardcoded presets (0.7 Answer, 0.6 Cite), not user-configurable via UI"

**Severity**: CRITICAL
**Time**: 5 min

---

#### Issue #7-8: Other README critical issues
See detailed findings in subagent report

**Total README time**: ~90 min

---

### Priority 3: IMPLEMENTATION_SUMMARY.md Critical Issues (Issues #59-64)

**File**: IMPLEMENTATION_SUMMARY.md (Lines 156-160, 162-166, 142-153, 208-227, 180-186)

#### Issue #59: Migration "100% Preservation" Unverified
**Fix**: Change "100% metadata preservation" to "Metadata preservation verified through manual spot-checks (not automated)"

#### Issue #60: Build & Tests Framing Bias
**Fix**: Lead with test numbers (16/40) not build status

#### Issue #61: 85% Threshold Unvalidated
**Fix**: Add "85% threshold chosen arbitrarily, false positive/negative rates unknown"

#### Issue #62: Design Rationale Has No Tradeoffs
**Fix**: Add limitations section to each design decision (CSV, 3-tier matching, duplicate detection)

#### Issue #63: Deployment Status Overstated
**Fix**: Change "Production build passes" to "Not yet deployed to production (as of 2025-11-14)"

#### Issue #64: "37 documents" Context Missing
**Fix**: See Priority 1 cross-file fix

**Total IMPLEMENTATION_SUMMARY time**: ~60 min

---

### Priority 4: CLAUDE.md & DOCUMENT_MANAGEMENT.md

**CLAUDE.md Issues**: #30-32 (Unverified claims, missing tradeoffs, test status)
**DOCUMENT_MANAGEMENT.md Issues**: #44-47 (Duration unverified, costs unverified, missing tradeoffs, test status unclear)

**Total time**: ~40 min

---

## Medium Priority Fixes (39 issues)

These are important for accuracy but lower priority than critical issues:

- Multiple instances of "easy/simple/quick" without quantification
- Framing bias (features without limitations)
- Missing troubleshooting steps
- Unqualified status claims
- Incomplete error handling documentation

**Approach**: Batch these fixes in secondary pass after critical issues

**Total time**: ~120 min

---

## Low Priority Fixes (19 minor issues)

- Marketing language cleanup
- Self-application of frameworks
- Calibration guidelines for scoring
- Minor contextual missing information

**Total time**: ~40 min

---

## Implementation Plan

### Phase 1: Quick Wins (30 min)
- [ ] Add "Corpus Size" section to README introduction (10 min)
- [ ] Fix "Configurable similarity thresholds" claim (5 min)
- [ ] Update deployment status language (5 min)
- [ ] Add "100%" metadata qualification (5 min)
- [ ] Fix "85% threshold" validation claim (5 min)

### Phase 2: Core Fixes (150 min)
- [ ] Expand test coverage section in all files (30 min)
- [ ] Add cost calculation methodology (20 min)
- [ ] Add performance limitations/caveats (20 min)
- [ ] Add architecture tradeoffs section (30 min)
- [ ] Expand feature descriptions with limitations (20 min)
- [ ] Fix framing bias in phase status claims (30 min)

### Phase 3: Comprehensive Pass (120 min)
- [ ] Remove "easy/simple" without quantification (30 min)
- [ ] Add error handling to workflows (30 min)
- [ ] Expand troubleshooting sections (30 min)
- [ ] Self-apply review frameworks to docs (30 min)

### Phase 4: Quality Check (30 min)
- [ ] Run subagent review again on updated files
- [ ] Verify all critical issues fixed
- [ ] Check for new issues introduced

---

## Estimated Total Effort

- **Critical fixes**: 3-4 hours
- **Medium fixes**: 2-3 hours
- **Minor fixes**: 30-45 min
- **Quality verification**: 30 min
- **Total**: 6.5-8.5 hours

---

## Success Criteria

After fixes:
- [ ] No unverified metrics without sources
- [ ] All costs show calculation methodology
- [ ] All features list limitations alongside benefits
- [ ] All "Complete" claims have scope qualification
- [ ] All performance claims include benchmarks or removed
- [ ] All tradeoffs acknowledged
- [ ] Test coverage clearly shows passing vs skipped vs untested
- [ ] Deployment status accurately reflects "not yet in production"
- [ ] Overall honesty score: 8.0+ / 10

---

## Files to Update (Priority Order)

1. README.md (29 issues)
2. IMPLEMENTATION_SUMMARY.md (18 issues)
3. DOCUMENT_MANAGEMENT.md (15 issues)
4. CLAUDE.md (12 issues)
5. docs/DOCUMENTATION-REVIEW-GUIDE.md (3 issues)
6. docs/evaluation-framework-documentation-quality.md (2 issues)

---

## Related Issues for Investigation

These weren't fixable from docs but may need code changes:

- Add actual test coverage reporting (`npm run test:coverage`)
- Log actual API costs instead of estimates
- Add performance benchmarks to CI/CD
- Implement cost tracking/logging
- Add metadata for cache invalidation strategy
