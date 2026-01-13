# Evaluation Framework: Documentation Optimization Theater Detection

## Executive Summary

This framework detects documentation that prioritizes appearing impressive over being accurate and actionable. It provides systematic checks for unverified claims, framing bias, marketing language, unqualified status claims, missing tradeoffs, and metrics without context.

**Primary Goal**: Ensure documentation serves users who need accurate information for decision-making, not stakeholders who want to be reassured that everything is great.

**Key Principle**: Good documentation makes you slightly uncomfortable because it acknowledges reality. Bad documentation makes you feel good but leaves you unprepared for actual implementation challenges.

---

## Evaluation Dimensions

### 1. Unverified Claims Detection

#### What to Look For
Statements presented as facts without corresponding evidence in code, tests, or data sources.

#### Evaluation Checklist

**Quantitative Claims**
- [ ] Every metric has a traceable source (code reference, log, database query)
- [ ] Numbers update automatically or have a "last verified" date
- [ ] Aggregated metrics show calculation method ("sum of X", "average across Y")
- [ ] Claims about scale ("thousands of chunks", "millions of tokens") link to measurement code

**Performance Claims**
- [ ] Words like "fast", "optimal", "efficient" are quantified with benchmarks
- [ ] Performance claims include comparison baseline ("faster than X", "uses 40% less Y than baseline")
- [ ] Claims about latency/throughput reference specific test conditions
- [ ] "High-performance" is backed by actual performance tests in test suite

**Feature Completeness Claims**
- [ ] "Comprehensive" claims link to test coverage reports or feature checklists
- [ ] "Full support for X" is verified by test cases covering edge cases
- [ ] "Complete implementation" acknowledges known gaps or scope limits

**Quality Claims**
- [ ] "Robust" is backed by error handling tests and edge case coverage
- [ ] "Reliable" references uptime metrics, error rates, or retry logic
- [ ] "Production-ready" includes deployment checklist and monitoring setup

#### Red Flags

🚩 **Precision Without Source**
```markdown
BAD:  "The system indexes 4,649 searchable chunks"
GOOD: "The system indexed 4,649 chunks (as of 2025-01-15, see catalog.ts:42)"
GOOD: "The system indexes ~5K chunks (query: SELECT COUNT(*) FROM chunks)"
```

🚩 **Superlatives Without Context**
```markdown
BAD:  "Our optimal retrieval algorithm ensures high-performance results"
GOOD: "Retrieval typically takes 200-400ms for 10-chunk queries (benchmark: tests/perf.spec.ts)"
GOOD: "We use semantic search with a 0.7 similarity threshold (tuned via A/B test, see ADR-003)"
```

🚩 **Implied Certainty**
```markdown
BAD:  "Comprehensive test coverage ensures reliability"
GOOD: "Test coverage: 73% line, 82% branch (npm run coverage). Key gaps: error handling in llamacloud.ts"
```

#### Verification Questions

1. **Source Tracing**: Can I find the code/query that produces this number?
2. **Reproducibility**: If I run the measurement today, would I get this number?
3. **Staleness**: When was this claim last verified? Could it be outdated?
4. **Scope**: Is the claim about the whole system, or just one part?

#### Automated Detection Patterns

```typescript
// Pattern: Numbers without attribution
regex: /\d{1,3}(,\d{3})*(\.\d+)?(?!\s*(ms|MB|tokens|%|items?|files?|tests?|as of|from|via|see))/

// Pattern: Performance claims without measurement
regex: /(fast|slow|efficient|optimal|high-performance|low-latency)(?!.*\d+\s*(ms|s|MB|GB|tokens|ops\/sec))/

// Pattern: Absolute terms without qualification
words: ["always", "never", "all", "every", "complete", "comprehensive", "full"]
check: Is there a caveat within 2 sentences?
```

---

### 2. Framing Bias Detection

#### What to Look For
Technically true statements that create misleading impressions through selective presentation.

#### Evaluation Checklist

**Selective Reporting**
- [ ] Test results report both passes AND failures/skips
- [ ] Feature lists are paired with limitation lists
- [ ] Success metrics are paired with failure/edge cases
- [ ] Status updates include both progress AND blockers

**Balanced Coverage**
- [ ] Each "what works" section has a "what doesn't work" or "known issues" counterpart
- [ ] Positive results don't hide negative results elsewhere
- [ ] High-level summaries reflect the nuance in detailed sections

**Temporal Honesty**
- [ ] Claims about future plans are clearly marked as future ("planned", "roadmap", "not yet implemented")
- [ ] Past issues aren't erased from history (keep "fixed in v2.3" notes)
- [ ] Current state is distinguished from ideal state

**Comparison Fairness**
- [ ] Comparisons show both strengths and weaknesses of each option
- [ ] "Better than X" acknowledges where X is better
- [ ] Selection rationale includes rejected alternatives and why

#### Red Flags

🚩 **Cherry-Picked Test Results**
```markdown
BAD:  "Test Suite: 16 tests passing ✅"
GOOD: "Test Suite: 16 passing, 24 skipped (legacy), 3 failing (non-critical, see issues #45, #67, #89)"
```

🚩 **Feature Completeness Without Gaps**
```markdown
BAD:  "Features: ✅ Answer mode ✅ Cite mode ✅ CSV catalog ✅ Debug endpoints"
GOOD: "Features: Answer mode (stable), Cite mode (beta, no pagination), CSV catalog (no multi-file support), Debug endpoints (dev only)"
```

🚩 **Success Metrics Without Failure Modes**
```markdown
BAD:  "Success Metrics
       - 99.2% query response rate
       - Average latency: 340ms"

GOOD: "Response Quality
       - 99.2% queries return results (0.8% fail: timeout or no matches)
       - Average latency: 340ms (95th percentile: 1.2s, see timeout spike investigation)"
```

🚩 **Highlighting Strengths, Hiding Weaknesses**
```markdown
BAD:  "CSV Database Benefits:
       ✅ Simple to edit
       ✅ Git-friendly version control
       ✅ No database setup required"

GOOD: "CSV Database Tradeoffs:
       Strengths: Simple editing, git-friendly, no setup
       Limitations: No concurrent writes, slow for >10K rows, no relational queries
       Alternative considered: SQLite (rejected: adds deployment complexity)"
```

#### Verification Questions

1. **Completeness**: What's the bad news that should be here but isn't?
2. **Proportion**: If 40% of the reality is negative, is 40% of the doc negative?
3. **Findability**: If someone is looking for limitations, how easily can they find them?
4. **Equivalence**: Are negative findings presented with the same specificity as positive findings?

#### Automated Detection Patterns

```typescript
// Pattern: Test results without context
regex: /(\d+)\s+tests?\s+(pass(ing|ed)?|✅)/
check: Is there a nearby mention of failures, skips, or total count?

// Pattern: Feature lists without limitations
structure: If section contains >3 checkmarks, does it contain "limitation", "known issue", "not yet", "planned"?

// Pattern: All-positive tone
check: In a section >200 words, are there negation words ("not", "cannot", "doesn't", "limitation", "issue", "bug")?
```

---

### 3. Marketing Language Detection

#### What to Look For
Words chosen for emotional persuasion rather than technical clarity.

#### Evaluation Checklist

**Superlative Overuse**
- [ ] Adjectives like "intelligent", "smart", "powerful" are replaced with specific descriptions
- [ ] "Robust" → "handles X error cases" or "retries with exponential backoff"
- [ ] "Comprehensive" → "covers X, Y, Z" or "70% test coverage"
- [ ] "Optimal" → "chose X because it minimizes Y" or "tuned to maximize Z"

**Emoji and Decoration**
- [ ] No checkmarks used as status indicators without qualification (✅)
- [ ] No decorative emoji (🚀, 🎯, 💡) in technical docs
- [ ] Emoji only used for actual status (🔴 failing build, 🟡 warning, 🟢 all clear)

**Success-Oriented Framing**
- [ ] "Success Metrics" → "Results" or "Measurements"
- [ ] "Achievements" → "Completed Work" or "Changes"
- [ ] "Wins" → "Improvements" or "Changes"
- [ ] "Challenges" instead of "Issues" or "Bugs" (only if truly challenging, not routine bugs)

**Vague Intensifiers**
- [ ] "Very", "really", "extremely" are removed or quantified
- [ ] "Significantly" → "by X%"
- [ ] "Highly" → specific measurement
- [ ] "Quite" → removed or made specific

#### Red Flags

🚩 **Intelligence/Smart Claims**
```markdown
BAD:  "Intelligent metadata hydration system smartly merges catalog data"
GOOD: "Metadata hydration merges CSV catalog with LlamaCloud results using a 3-tier lookup (docId → fileId → CSV fileName)"
```

🚩 **Marketing Superlatives**
```markdown
BAD:  "Robust error handling ensures optimal reliability"
GOOD: "Error handling: retries 3x with exponential backoff (100ms, 400ms, 1600ms), then returns cached result or error message"
```

🚩 **Decorative Emoji**
```markdown
BAD:  "🚀 Features
       🎯 Answer Mode: Synthesizes concise answers
       💡 Cite Mode: Builds annotated bibliographies
       ✅ Debug Endpoints: Inspect system state"

GOOD: "Features
       Answer Mode: Synthesizes concise answers with sentence-level citations
       Cite Mode: Builds annotated bibliographies (beta: no pagination)
       Debug Endpoints: Inspect catalog loading and hydration (dev environment only)"
```

🚩 **Success Framing**
```markdown
BAD:  "Success Metrics
       🎉 37 documents migrated
       🏆 Zero critical bugs in production
       📈 Query latency improved 40%"

GOOD: "Migration Results (2025-01-10)
       Migrated: 37 documents (92% of corpus, remaining 3 blocked by encoding issues)
       Production Issues: 0 critical, 4 minor (avg resolution time: 2.3 days)
       Latency: Reduced from 580ms to 340ms (40% reduction via caching, see PR #234)"
```

#### Verification Questions

1. **Synonym Test**: Would a more neutral word be more accurate?
   - "intelligent" → "rule-based" or "configurable"
   - "robust" → "tested for X scenarios" or "handles Y error types"
2. **Removal Test**: If I remove this adjective, do I lose information?
   - If no → it's decoration
3. **Justification Test**: Can I point to code/tests that justify this word?
4. **Audience Test**: Would an experienced engineer use this word, or is it for non-technical stakeholders?

#### Automated Detection Patterns

```typescript
// Pattern: Marketing adjectives
words: [
  "intelligent", "smart", "powerful", "advanced", "sophisticated",
  "robust", "reliable", "stable", "mature", "production-ready",
  "comprehensive", "complete", "full", "extensive", "thorough",
  "optimal", "optimized", "efficient", "performant", "scalable",
  "seamless", "effortless", "easy", "simple", "intuitive",
  "cutting-edge", "state-of-the-art", "best-in-class", "world-class",
  "innovative", "revolutionary", "groundbreaking", "next-generation"
]
check: Is there a quantification or specific example within 1 sentence?

// Pattern: Decorative emoji
regex: /(🚀|🎯|💡|🎉|🏆|📈|⚡|🔥|✨|💪|👍|👌)/
exception: Status emoji in CI/CD contexts (🔴🟡🟢)

// Pattern: Intensifiers without quantification
regex: /(very|really|extremely|highly|significantly|quite)\s+(\w+)/
check: Is there a number or specific example nearby?
```

---

### 4. Unqualified Status Claims Detection

#### What to Look For
Status indicators that create false certainty without context or caveats.

#### Evaluation Checklist

**Status Labels**
- [ ] "Complete" is qualified with scope ("Complete: core features. Remaining: admin UI")
- [ ] "Working" acknowledges known issues ("Working: 95% queries. Known issue: times out on >50 results")
- [ ] "Done" specifies what "done" means ("Done: deployed to staging, pending prod approval")
- [ ] "Fixed" references the specific issue and verification method

**Progress Indicators**
- [ ] Percentages show denominator ("80% (4/5 modules)")
- [ ] Checkmarks distinguish "implemented" from "tested" from "documented"
- [ ] Status is dated ("Complete as of 2025-01-15") when it might change

**Readiness Claims**
- [ ] "Production-ready" has a checklist (tests, monitoring, rollback, docs)
- [ ] "Stable" references time period ("stable for 6 months") or test coverage
- [ ] "Beta" defines what's incomplete or might change

**Issue Status**
- [ ] "Resolved" includes verification ("resolved: verified in staging, deployed 2025-01-10")
- [ ] "Fixed" links to PR and test that prevents regression
- [ ] "Won't fix" explains why (out of scope, too costly, acceptable workaround)

#### Red Flags

🚩 **Unqualified Completeness**
```markdown
BAD:  "✅ CSV Catalog System - Complete"
GOOD: "CSV Catalog System - Complete
       Implemented: Loading, parsing, metadata lookup, error handling
       Tested: Unit tests for parsing, integration tests for hydration
       Known limitations: Single-file only, no concurrent updates"
```

🚩 **Status Without Context**
```markdown
BAD:  "Migration Status: ✅ Complete"
GOOD: "Migration Status: 37/40 documents (92%)
       Complete: All core documents, metadata verified
       Remaining: 3 PDFs with encoding issues (manual review needed)
       Next: Fix encoding or convert to different format"
```

🚩 **False Certainty**
```markdown
BAD:  "✅ All tests passing
       ✅ Zero known bugs
       ✅ Production-ready"

GOOD: "Test Status (2025-01-15):
       Passing: 16 integration tests, 42 unit tests
       Skipped: 24 legacy tests (flagged for removal or rewrite)
       Failing: 3 non-blocking (UI edge cases, see issue #89)

       Known Issues:
       - Minor: Tooltip overflow on narrow screens (issue #45)
       - Minor: Rate limit not enforced in dev mode (issue #67)

       Production Readiness Checklist:
       ✅ Core functionality tested
       ✅ Error handling for API failures
       ✅ Monitoring dashboard configured
       ⚠️ Performance testing pending (issue #123)
       ⚠️ Load testing at 10x scale pending (issue #124)"
```

🚩 **Vague Progress**
```markdown
BAD:  "Implementation: 80% complete"
GOOD: "Implementation Progress: 4/5 modules complete
       ✅ Retrieval (tested, documented)
       ✅ Metadata hydration (tested, documented)
       ✅ OpenAI synthesis (tested, documented)
       ✅ UI components (tested, documented)
       🚧 Admin dashboard (in progress, ETA 2025-01-20)"
```

#### Verification Questions

1. **Scope**: Complete/done according to what definition of scope?
2. **Verification**: How was this status verified? (Tests? Manual review? User feedback?)
3. **Stability**: Is this status expected to remain true, or might it change?
4. **Caveats**: What would make someone say this is NOT complete/working/done?

#### Automated Detection Patterns

```typescript
// Pattern: Status claims without qualification
regex: /(✅|Complete|Done|Working|Fixed|Resolved)(?!.*\(.*\))/
check: Is there a caveat, percentage, or date within 2 sentences?

// Pattern: Unqualified readiness
words: ["production-ready", "stable", "reliable", "mature"]
check: Is there a checklist, time period, or test reference?

// Pattern: Progress without denominator
regex: /(\d+)%\s+(complete|done)/
check: Is there "X/Y" notation nearby?
```

---

### 5. Missing Tradeoffs Detection

#### What to Look For
Design decisions presented as pure advantages without acknowledging downsides.

#### Evaluation Checklist

**Technology Choices**
- [ ] Each technology choice explains what was gained AND what was sacrificed
- [ ] "We chose X" is followed by "over Y because Z, trading off A for B"
- [ ] Alternatives are listed with their pros/cons
- [ ] Future migration paths are mentioned when current choice has scaling limits

**Architecture Decisions**
- [ ] Simplicity benefits acknowledge future complexity costs
- [ ] Performance optimizations mention maintenance costs
- [ ] Flexibility features mention complexity costs
- [ ] "Good enough for now" decisions mention when they'll need revisiting

**Implementation Tradeoffs**
- [ ] Fast implementations mention technical debt
- [ ] Simple solutions mention scaling limits
- [ ] Powerful features mention learning curve
- [ ] Flexible designs mention configuration complexity

**Operational Tradeoffs**
- [ ] Cost savings mention capability losses
- [ ] Latency improvements mention resource costs
- [ ] Reliability improvements mention complexity costs
- [ ] Manual processes mention automation roadmap

#### Red Flags

🚩 **All-Upside Technology Choice**
```markdown
BAD:  "CSV Database
       ✅ Simple to edit in any text editor
       ✅ Git-friendly version control
       ✅ No database setup or maintenance
       ✅ Easy backup and portability"

GOOD: "CSV Database
       Why chosen: Prioritized simplicity over scalability for initial launch

       Strengths:
       - Simple editing (any text editor, no SQL knowledge needed)
       - Git-friendly (track changes, review diffs, rollback)
       - Zero setup (no database server, credentials, or migrations)
       - Easy backup (just copy file)

       Limitations:
       - Single-file limit (no sharding for >100K rows)
       - No concurrent writes (file locking issues)
       - No relational queries (can't JOIN across datasets)
       - Slow full-table scans for large files

       When to revisit: If catalog grows beyond 10K entries or we need multi-user editing
       Migration path: SQLite (local) or Postgres (cloud) with same API interface"
```

🚩 **Optimization Without Cost**
```markdown
BAD:  "Performance Optimizations
       ✅ Implemented caching layer for 40% latency reduction
       ✅ Added request batching for 3x throughput
       ✅ Optimized database queries"

GOOD: "Performance Changes (2025-01-15)

       Caching Layer (PR #234)
       Impact: 40% latency reduction (580ms → 340ms avg)
       Tradeoff: Increases memory usage by ~200MB, stale data risk
       Mitigation: 5-minute TTL, cache invalidation on writes

       Request Batching (PR #245)
       Impact: 3x throughput (20 req/s → 60 req/s)
       Tradeoff: Higher P99 latency (+800ms), more complex error handling
       Mitigation: 100ms batch window, per-request timeouts

       Query Optimization (PR #256)
       Impact: 50% reduction in database load
       Tradeoff: More complex SQL (harder to maintain), relies on specific indexes
       Mitigation: Added query comments, documented index requirements"
```

🚩 **Simplicity Without Limits**
```markdown
BAD:  "Simple Architecture
       We keep things simple with a straightforward design that's easy to understand and maintain."

GOOD: "Simple Architecture (Initially)

       Current: Monolithic Next.js app with embedded API routes
       Rationale: Optimized for small team velocity and single-developer maintenance

       Strengths:
       - Single deployment unit (easy CI/CD)
       - Shared types between frontend/backend
       - Fast iteration (no cross-service coordination)

       Limitations:
       - Can't scale frontend/backend independently
       - All API routes share Node.js memory limit
       - Difficult to add non-JS services (Python ML models, etc.)

       Scaling threshold: If we need >4GB RAM for API routes or Python integration
       Future architecture: Separate Next.js frontend + API service layer"
```

#### Verification Questions

1. **TANSTAAFL Test**: "There ain't no such thing as a free lunch" - what's the cost?
2. **Scale Test**: At what scale/complexity does this decision break down?
3. **Alternative Test**: What did you NOT choose, and what was better about it?
4. **Regret Test**: In hindsight, what aspect of this decision do you wish were different?

#### Automated Detection Patterns

```typescript
// Pattern: Technology choice without tradeoff
structure: If section describes a choice/technology/approach:
  check: Contains words like "tradeoff", "limitation", "downside", "cost", "sacrifice"?
  check: Contains "vs", "over", "instead of" (comparison)?
  check: Contains future tense about changing ("when", "if", "threshold")?

// Pattern: All-positive lists
structure: If section contains >3 bullet points:
  check: Do any bullets mention negatives?
  check: Is there a separate "Limitations" or "Tradeoffs" section?

// Pattern: Optimization claims
regex: /(optimi[zs]ed|improv(ed|ement)|faster|better|reduced)/
check: Is there mention of cost, tradeoff, or downside within 3 sentences?
```

---

### 6. Metrics Without Context Detection

#### What to Look For
Numbers that sound impressive but lack perspective to interpret meaningfully.

#### Evaluation Checklist

**Absolute vs Relative**
- [ ] Absolute numbers include total ("37 out of 40")
- [ ] Relative numbers include absolute ("92% (37/40)")
- [ ] Percentages show denominator and what it represents
- [ ] Counts explain what was counted and what was excluded

**Baselines and Comparisons**
- [ ] Improvements show before/after ("reduced from 580ms to 340ms")
- [ ] Scale metrics show comparison ("4,649 chunks - typical for 40-document corpus")
- [ ] Performance numbers show baseline ("3x faster than naive approach")

**Time Context**
- [ ] Metrics have timestamp ("as of 2025-01-15")
- [ ] Rates specify time period ("60 queries per second", not "60 queries")
- [ ] Trends show time range ("over 6 months", "since launch")

**Scope and Boundaries**
- [ ] Metrics specify what they measure ("end-to-end latency including network")
- [ ] Test conditions are stated ("under load of 100 concurrent users")
- [ ] Exclusions are noted ("excluding admin queries")

#### Red Flags

🚩 **Impressive Absolute Number**
```markdown
BAD:  "The system contains 4,649 searchable chunks"
GOOD: "Chunk Count: 4,649 chunks from 37 documents (avg 125 chunks/doc)
       Calculation: SELECT COUNT(*) FROM chunks WHERE type='searchable'
       Typical range: 100-150 chunks per document depending on length
       Last updated: 2025-01-15 during re-indexing"
```

🚩 **Percentage Without Denominator**
```markdown
BAD:  "Migration: 92% complete"
GOOD: "Migration: 92% complete (37/40 documents)
       Complete: 37 documents fully indexed and metadata verified
       Remaining: 3 PDFs with encoding issues (manual review in progress)
       Target: 100% by 2025-01-20"
```

🚩 **Improvement Without Baseline**
```markdown
BAD:  "Performance Improvements
       - Query latency: 340ms
       - Throughput: 60 queries/sec
       - Cache hit rate: 78%"

GOOD: "Performance Comparison (before/after caching, 2025-01-15)

       Query Latency:
       Before: 580ms (p50), 1,200ms (p95), 2,400ms (p99)
       After:  340ms (p50), 800ms (p95), 1,600ms (p99)
       Change: -41% (p50), -33% (p95), -33% (p99)

       Throughput:
       Before: 20 queries/sec (limited by LlamaCloud API latency)
       After:  60 queries/sec (3x improvement via caching)
       Test conditions: 100 concurrent users, 70% repeated queries

       Cache Hit Rate: 78%
       Meaning: 78% of queries served from cache, 22% require API call
       Cache size: 200MB, TTL: 5 minutes
       Hit rate calculation: (cache_hits / total_queries) over 24hr window"
```

🚩 **Scale Without Comparison**
```markdown
BAD:  "Successfully processed 1.2 million tokens"
GOOD: "Token Usage (January 2025)
       Total: 1.2M tokens processed
       Breakdown:
       - Retrieval: 400K tokens (33%, LlamaCloud API)
       - Synthesis: 800K tokens (67%, OpenAI API)
       Cost: $18.40 total ($15.20 OpenAI, $3.20 LlamaCloud)
       Per-query average: 2,400 tokens, $0.037
       Comparison: Baseline approach would use ~3.5K tokens/query (46% more)"
```

#### Verification Questions

1. **Context**: What does this number mean? Is it good or bad?
2. **Comparison**: Compared to what? (Baseline, industry standard, previous version)
3. **Scope**: What exactly was measured? What was excluded?
4. **Stability**: Is this typical, or was it measured during a specific test/scenario?

#### Automated Detection Patterns

```typescript
// Pattern: Large numbers without context
regex: /\d{1,3}(,\d{3})+(?!\s*(out of|of|\/|%))/
check: Is there comparison, baseline, or "typical" nearby?

// Pattern: Percentages without denominator
regex: /\d+%(?!\s*\(\d+\/\d+\))/
check: Is there "X out of Y" or "X/Y" within 1 sentence?

// Pattern: Performance metrics without baseline
regex: /(\d+)(ms|sec|MB|GB|tokens)(?!.*(from|was|previously|baseline|vs|compared))/
check: Is there a before/after comparison?

// Pattern: Rates without time period
regex: /\d+\s+(queries|requests|operations)(?!\s+(per|\/)\s+(second|minute|hour|day))/
check: Is the time period specified?
```

---

## Practical Review Protocol

### Phase 1: Initial Scan (5 minutes)

**Gut Check Questions**
1. After reading this, do I feel confident or uncomfortable?
   - Confident → Warning sign (docs should surface uncertainty)
   - Uncomfortable → Good sign (honest about limitations)

2. What questions do I still have after reading?
   - Many questions → Good (sparks inquiry)
   - No questions → Warning sign (false completeness)

3. Can I implement/use this based solely on the docs?
   - No → Bad (missing critical details)
   - Yes, but concerned → Good (honest about risks)
   - Yes, confident → Warning sign (overconfident docs)

### Phase 2: Systematic Review (15-30 minutes)

**Section-by-Section Checklist**

For each major section, ask:

1. **Verification** (Dimension 1)
   - [ ] Can I trace claims to code/tests/data?
   - [ ] Are metrics up-to-date or dated?
   - [ ] Are performance claims quantified?

2. **Balance** (Dimension 2)
   - [ ] Are both successes and failures mentioned?
   - [ ] Does positive coverage match negative coverage?
   - [ ] Are limitations easy to find?

3. **Tone** (Dimension 3)
   - [ ] Would an engineer use these words?
   - [ ] Are there decorative elements?
   - [ ] Is the framing neutral or success-oriented?

4. **Certainty** (Dimension 4)
   - [ ] Are status claims qualified?
   - [ ] Are checkmarks explained?
   - [ ] Is "complete" defined?

5. **Tradeoffs** (Dimension 5)
   - [ ] Are design decisions explained with alternatives?
   - [ ] Are both pros and cons listed?
   - [ ] Are scaling limits acknowledged?

6. **Context** (Dimension 6)
   - [ ] Do numbers have baselines?
   - [ ] Are percentages shown as fractions?
   - [ ] Are metrics explained?

### Phase 3: Pattern Detection (10 minutes)

**Run Automated Checks**

Use regex patterns from each dimension to find:
- Unverified claims (numbers, superlatives, absolute terms)
- Framing bias (test results, feature lists, all-positive sections)
- Marketing language (adjectives, emoji, success framing)
- Unqualified status (checkmarks, progress percentages)
- Missing tradeoffs (technology choices without limitations)
- Metrics without context (absolute numbers, percentages, improvements)

**Count Violations by Severity**

- 🔴 Critical: Factually misleading (wrong number, false claim)
- 🟡 Warning: Technically true but misleadingly framed
- 🟢 Info: Could be more specific/neutral but not misleading

### Phase 4: Comparison Testing (5 minutes)

**Good Documentation vs Bad Documentation**

Pick 3-5 key sections and rewrite them both ways:

**Example 1: Test Results**

```markdown
🔴 THEATER VERSION:
"Test Suite: 16 tests passing ✅
Our comprehensive test suite ensures reliability and quality."

🟢 HONEST VERSION:
"Test Suite (as of 2025-01-15):
- Passing: 16 integration tests covering core workflows
- Skipped: 24 legacy tests (flagged for removal or migration)
- Failing: 3 non-critical UI edge cases (see issues #45, #67, #89)
Coverage: 73% line, 82% branch (see coverage/index.html)"
```

**Example 2: Architecture Decision**

```markdown
🔴 THEATER VERSION:
"CSV Database ✅
We use a simple CSV database that's easy to edit, git-friendly, and requires no setup. This optimal choice ensures maintainability and portability."

🟢 HONEST VERSION:
"CSV Database (Tradeoff: Simplicity over Scale)

Chosen for: Small team, <10K rows, version control priority

Strengths:
- Edit in any text editor (no SQL knowledge needed)
- Git-friendly (diff/merge/rollback)
- Zero setup (no server/credentials)

Limitations:
- Single file only (no sharding)
- No concurrent writes (file locking)
- Slow for >10K rows (full table scan)
- No relational queries (can't JOIN)

When to migrate: If catalog >10K entries or need multi-user editing
Migration path: SQLite (same API, add relational queries)"
```

**Example 3: Metrics**

```markdown
🔴 THEATER VERSION:
"Success Metrics:
- 1.2M tokens processed ✅
- 37 documents migrated ✅
- 92% completion rate ✅"

🟢 HONEST VERSION:
"January 2025 Activity:

Token Usage: 1.2M total
- Retrieval: 400K (33%, LlamaCloud)
- Synthesis: 800K (67%, OpenAI)
- Cost: $18.40, avg $0.037/query
- Comparison: 46% more efficient than baseline

Migration: 37/40 documents (92%)
- Complete: Core documents + metadata verified
- Remaining: 3 PDFs (encoding issues, manual review)
- Target: 40/40 by 2025-01-20

Query Success: 99.2% (as of 2025-01-15)
- Successful: 2,473 queries returned results
- Failed: 20 queries (0.8%)
  - Timeout: 12 queries (>5s, investigate spike)
  - No match: 8 queries (very specific terms)"
```

---

## Documentation Quality Rubric

### Scoring System

For each dimension, score 0-4:

**4 - Exemplary**
- All claims verified with sources
- Balanced coverage of strengths/limitations
- Neutral technical language
- Status claims fully qualified
- Tradeoffs explicitly discussed
- Metrics with full context

**3 - Good**
- Most claims verified
- Limitations mentioned but could be more prominent
- Mostly neutral with occasional marketing language
- Status claims mostly qualified
- Some tradeoffs discussed
- Metrics have some context

**2 - Needs Improvement**
- Some unverified claims
- Limitations buried or incomplete
- Frequent marketing language
- Status claims often unqualified
- Tradeoffs rarely discussed
- Metrics lack context

**1 - Poor**
- Many unverified claims
- Limitations hidden
- Heavy marketing language
- Status claims unqualified
- No tradeoff discussion
- Metrics without context

**0 - Misleading**
- False or misleading claims
- Actively hides limitations
- Purely marketing-focused
- Status claims create false certainty
- Presents all decisions as pure wins
- Metrics cherry-picked or misleading

### Overall Assessment

| Dimension | Weight | Score | Weighted |
|-----------|--------|-------|----------|
| 1. Unverified Claims | 25% | ? | ? |
| 2. Framing Bias | 20% | ? | ? |
| 3. Marketing Language | 15% | ? | ? |
| 4. Unqualified Status | 15% | ? | ? |
| 5. Missing Tradeoffs | 15% | ? | ? |
| 6. Metrics Without Context | 10% | ? | ? |
| **Total** | **100%** | - | **?** |

**Interpretation:**
- 3.5-4.0: Exemplary documentation (honest, specific, actionable)
- 2.5-3.4: Good documentation (minor improvements needed)
- 1.5-2.4: Needs revision (significant optimization theater)
- 0.0-1.4: Unacceptable (misleading or useless)

---

## Documentation Review Subagent Prompt

```markdown
You are a documentation quality reviewer focused on detecting "optimization theater" - documentation that prioritizes sounding impressive over being accurate.

Your task is to review documentation and identify issues in 6 dimensions:

1. UNVERIFIED CLAIMS: Statements without code/test/data evidence
   Look for: Metrics without sources, performance claims without benchmarks, superlatives without quantification

2. FRAMING BIAS: Selective presentation creating misleading impressions
   Look for: Test results without failures, features without limitations, all-positive sections

3. MARKETING LANGUAGE: Persuasive words instead of technical clarity
   Look for: "Intelligent", "robust", "comprehensive", "optimal", decorative emoji, success framing

4. UNQUALIFIED STATUS: Certainty without context
   Look for: "Complete" without scope, checkmarks without caveats, progress without denominators

5. MISSING TRADEOFFS: Decisions presented as pure wins
   Look for: Technology choices without limitations, optimizations without costs, simplicity without scale limits

6. METRICS WITHOUT CONTEXT: Impressive numbers without perspective
   Look for: Absolute numbers without totals, percentages without denominators, improvements without baselines

For each issue found:
- Quote the problematic text
- Identify which dimension(s) it violates
- Explain why it's misleading or unhelpful
- Provide a "good version" that fixes the issue

After reviewing, provide:
- Overall score (0-4) for each dimension
- Weighted total score
- Top 3 most critical issues to fix
- Summary: Is this documentation trustworthy for decision-making?

Focus on being helpful, not punitive. The goal is honest documentation that serves users making real implementation decisions.
```

---

## Examples: Good vs Bad Documentation

### Example 1: API Endpoint Documentation

**🔴 Theater Version**
```markdown
## /api/llama/chat - Intelligent Query Processing

Our advanced chat endpoint provides optimal query processing with robust error handling and comprehensive response formatting.

Features:
✅ Smart query enhancement
✅ Intelligent metadata hydration
✅ High-performance retrieval
✅ Seamless error recovery

Success Metrics:
- 99.2% uptime ✅
- Fast response times ✅
- High user satisfaction ✅
```

**🟢 Honest Version**
```markdown
## /api/llama/chat - Query Processing

Processes natural language queries against the document corpus using LlamaCloud Pipeline API.

### Request
POST /api/llama/chat
Body: { message: string, mode: 'answer' | 'cite' }

### Response
{ text: string, sourceNodes: Array<Node> }

### Implementation Details
- Calls LlamaCloud Pipeline chat endpoint (lib/llamacloud.ts:45)
- Retrieval parameters: top_k=10, similarity_threshold=0.7 (config/retrieval.ts:12)
- Hydrates metadata from CSV catalog (may fail if file not found)
- Returns raw LlamaCloud response (minimal processing)

### Error Handling
- LlamaCloud timeout (>5s): Returns cached result or error (cache TTL: 5min)
- Invalid pipeline ID: Returns 500 (should be 400, see issue #234)
- CSV catalog missing: Proceeds without metadata (returns only LlamaCloud data)
- Rate limit: No retry logic (fails immediately, issue #245)

### Performance (as of 2025-01-15)
- p50 latency: 340ms (down from 580ms before caching)
- p95 latency: 1,200ms (timeout threshold: 5,000ms)
- Success rate: 99.2% (20/2,493 queries failed in Jan 2025)
  - Failures: 12 timeouts, 8 no-match
- Cost: ~$0.037 per query (LlamaCloud + OpenAI)

### Known Issues
- #234: Should return 400 for invalid pipeline_id, not 500
- #245: No retry logic for transient failures
- #267: Metadata hydration failure logs misleading warning

### Limitations
- Single pipeline only (no multi-corpus search)
- No streaming (waits for full response)
- No request cancellation (once started, must complete)
- CSV catalog required for full metadata (graceful degradation if missing)

### Test Coverage
- Unit tests: lib/llamacloud.test.ts (80% line coverage)
- Integration tests: api/llama/chat.test.ts (covers happy path + timeout)
- Missing: Rate limit tests, concurrent request tests
```

### Example 2: System Architecture

**🔴 Theater Version**
```markdown
## Architecture Overview 🏗️

AskWRI uses a modern, streamlined architecture that prioritizes simplicity and performance.

✅ Next.js App Router - Fast, SEO-friendly, server-rendered
✅ LlamaCloud Integration - Powerful retrieval capabilities
✅ OpenAI Synthesis - Intelligent answer generation
✅ CSV Catalog - Simple, maintainable metadata storage
✅ Tailwind CSS - Beautiful, responsive UI

This architecture ensures optimal performance while maintaining flexibility for future enhancements.
```

**🟢 Honest Version**
```markdown
## Architecture Overview

AskWRI is a monolithic Next.js application optimized for single-developer maintenance. Tradeoff: Simplicity now, potential refactoring at scale.

### Components

**Next.js App Router**
- Role: Frontend + API routes in single deployment
- Why: Fast iteration for small team (no cross-service coordination)
- Limitation: Can't scale frontend/backend independently
- When to split: If API routes exceed 4GB Node.js heap limit

**LlamaCloud Pipeline (External Service)**
- Role: Document indexing, chunking, vector search
- API: pipeline.run(), ~200-500ms latency
- Why: Avoid maintaining vector DB, chunking logic, embeddings
- Limitation: Vendor lock-in, no control over chunking algorithm, $0.02/query
- Alternative considered: Pinecone + custom chunking (rejected: too much maintenance)

**OpenAI API (External Service)**
- Role: Answer synthesis, summarization
- Models: gpt-4o-mini ($0.15/1M tokens in, $0.60/1M tokens out)
- Why: High quality, reliable, good enough for v1
- Limitation: Latency (200-400ms), cost at scale, no fine-tuning control
- When to revisit: If >10K queries/month (cost) or need <100ms latency

**CSV Catalog**
- Role: Metadata storage (titles, authors, URLs, tags)
- File: public/TransportDecarb_llamacloud_metadata250904.csv (~2MB, 40 docs)
- Why: Simple editing, git-friendly, no database setup
- Limitations:
  - Single file only (no sharding for >100K rows)
  - No concurrent writes (file locking issues)
  - Slow for >10K rows (full table scan on load)
  - Loaded fully into memory on each request (~2MB)
- When to migrate: If catalog >10K entries or need multi-user editing
- Migration path: SQLite (local) or Postgres (cloud) with same interface

**Tailwind CSS + shadcn/ui**
- Role: UI styling and components
- Why: Fast UI development, good defaults, accessible components
- Limitation: Large CSS bundle (~200KB), needs purging for production
- Tradeoff: Accepting larger bundle size for development speed

### Data Flow

```
User Query (browser)
  ↓
Next.js API Route (/api/llama/chat)
  ↓
LlamaCloud Pipeline (external, 200-500ms)
  ↓ chunks + scores
Group by document_id (in-memory)
  ↓
CSV Catalog lookup (in-memory, <10ms)
  ↓ title, authors, URL
OpenAI API (external, 200-400ms)
  ↓ synthesized answer
Next.js Response
  ↓
Browser (render)
```

### Scaling Considerations

Current architecture handles:
- ~100 queries/day comfortably
- ~40 documents, ~5K chunks
- Single-user admin (no concurrent CSV edits)

Will break at:
- >1K queries/day (LlamaCloud cost, OpenAI cost)
- >100 documents (CSV load time >1s)
- Multiple admin users (CSV conflicts)
- API routes >4GB memory (Node.js limit)

Future architecture (if needed):
- Separate API service (Go/Python) for better resource control
- SQLite or Postgres for metadata (concurrent writes, relational queries)
- Caching layer (Redis) for expensive API calls
- CDN for static assets (Next.js on Vercel/Netlify)

### Cost Model (January 2025 actual)

Per query average:
- LlamaCloud: $0.020
- OpenAI: $0.017
- Total: $0.037/query

At scale:
- 1K queries/month: $37/month
- 10K queries/month: $370/month (consider caching)
- 100K queries/month: $3,700/month (definitely need optimization)

### Known Issues
- #123: CSV loaded on every request (should cache)
- #234: No connection pooling for external APIs
- #456: No request timeout for LlamaCloud (can hang indefinitely)

### Test Coverage
- Integration tests: 16 covering core flows
- Unit tests: 42 covering utils, parsing, hydration
- Missing: Load tests, concurrent user tests, failure injection tests
```

---

## Quick Reference: Red Flags Checklist

Print this checklist and use it during reviews:

### Unverified Claims
- [ ] Numbers without attribution or source code reference
- [ ] "Fast/optimal/efficient" without benchmarks
- [ ] "Comprehensive/complete/full" without test coverage or scope definition
- [ ] "Robust/reliable" without error handling tests

### Framing Bias
- [ ] Test results showing only passes, not failures/skips
- [ ] Features listed without limitations
- [ ] All positive bullets, no negative bullets
- [ ] Success metrics without failure modes

### Marketing Language
- [ ] "Intelligent", "smart", "powerful", "advanced"
- [ ] Decorative emoji (🚀, 🎯, 💡, 🎉)
- [ ] "Success Metrics" instead of "Results"
- [ ] "Very", "really", "extremely" without quantification

### Unqualified Status
- [ ] "Complete ✅" without scope definition
- [ ] "Done" without what "done" means
- [ ] Progress percentage without denominator
- [ ] "Production-ready" without checklist

### Missing Tradeoffs
- [ ] Technology choice without mentioning alternatives
- [ ] Design decision with only pros, no cons
- [ ] Optimization without cost or complexity mention
- [ ] "Simple" without scale limits

### Metrics Without Context
- [ ] Large numbers without totals ("4,649 chunks" → "out of how many docs?")
- [ ] Percentages without fractions ("92%" → "92% of what?")
- [ ] Improvements without baselines ("40% faster" → "than what?")
- [ ] Counts without time period ("60 queries" → "per what?")

---

## Conclusion

Good documentation makes you slightly uncomfortable because it acknowledges reality. Bad documentation makes you feel good but leaves you unprepared.

When in doubt, ask:
1. "Would this help me make a real implementation decision?"
2. "Does this prepare me for likely problems?"
3. "Is this written for users or for stakeholders?"

If the answer to 1 and 2 is "no", or the answer to 3 is "stakeholders", you've found optimization theater.

Fix it by:
- Adding evidence for claims
- Balancing positive with negative
- Removing marketing language
- Qualifying status claims
- Discussing tradeoffs
- Contextualizing metrics

The goal is documentation that serves real users making real decisions, not documentation that looks impressive in demos.
