# Documentation Review Guide

This project includes tools for detecting and preventing "optimization theater" in documentation - content that prioritizes appearing impressive over being accurate.

## What is Documentation Optimization Theater?

Documentation that:
- Uses emoji and checkmarks to create false impressions of completeness
- Includes unverified metrics ("4,649 searchable chunks" without a source)
- Lists features without listing limitations
- Uses marketing language ("intelligent", "optimal", "comprehensive") without evidence
- Reports test passes without mentioning skipped/failed tests
- Presents design decisions as pure wins without acknowledging tradeoffs

## Available Tools

### 1. Evaluation Framework
**File**: `docs/evaluation-framework-documentation-quality.md`

A comprehensive checklist for manually reviewing documentation across 6 dimensions:
- Unverified claims
- Framing bias
- Marketing language
- Unqualified status claims
- Missing tradeoffs
- Metrics without context

Includes:
- Detailed red flag examples (before/after)
- Automated detection patterns (regex)
- Verification questions
- Scoring rubric

**Use when**: You want to manually audit documentation quality or train team members.

### 2. Documentation Review Subagent
**File**: `.claude/subagent-documentation-review.md`

A specialized agent prompt for automated documentation review.

**Use when**: You want Claude/LLM to scan documentation for optimization theater automatically.

**How to invoke in Claude Code**:
```bash
claude-code --task "review README.md" --subagent documentation-honesty-reviewer
```

Or in a Task:
```
Use the documentation-honesty-reviewer subagent to review [file] for optimization theater.
```

## How We Caught Optimization Theater in This Project

During documentation review, we identified and fixed:

### Removed Decorative Elements
- Emoji headers (🚀, 🎯, 📊, ⚡, 🏗️)
- Success checkmarks (✅) on status labels
- Marketing adjectives ("comprehensive", "intelligent", "optimal")

### Removed Unverified Claims
- "4,649 searchable chunks" - where did this number come from? Never measured.
- "high-performance retrieval" - without any actual latency benchmarks
- "comprehensive test coverage" - later admitted only 16/40 tests written

### Fixed Framing Bias
- Changed from "16 tests passing ✅" to "16 tests passing, 24 skipped due to async timing issues"
- Added "What is NOT tested" section listing untested systems
- Changed feature list to include known limitations

### Simplified Framing
- "Success Metrics" → "Implementation Results"
- "Performance Optimizations" → "Performance Considerations"
- "Executive Overview" → "Overview"

## Best Practices

### When Writing Documentation

1. **Quantify superlatives**:
   - ❌ "Comprehensive test coverage"
   - ✅ "Test coverage: 73% line, 82% branch"

2. **Include limitations with features**:
   - ❌ "CSV database: simple, git-friendly, easy to backup"
   - ✅ "CSV database: simple, git-friendly, easy to backup. Limitation: scales to ~100K documents"

3. **Report complete test results**:
   - ❌ "16 tests passing"
   - ✅ "16 tests passing, 24 skipped (async timing), 3 failing (non-critical)"

4. **Avoid absolute language**:
   - ❌ "Always returns results"
   - ✅ "Returns results 99.2% of the time (0.8% timeout failures)"

5. **Source your metrics**:
   - ❌ "Fast retrieval at scale"
   - ✅ "Retrieval: 200-400ms for 10-chunk queries (benchmark: tests/perf.spec.ts)"

6. **Acknowledge tradeoffs**:
   - ❌ "Hybrid retrieval combines the best of both approaches"
   - ✅ "Hybrid retrieval combines dense + sparse search (tradeoff: requires tuning similarity_threshold)"

7. **Mark future work clearly**:
   - ❌ "Multi-user sync"
   - ✅ "Multi-user sync (not yet implemented, planned for v2.0)"

### When Reviewing Documentation

Use the framework checklist:

1. **Scan for red flags** (2 min):
   - Emoji in headers?
   - Checkmarks (✅, ⚠️, etc.)?
   - Superlatives without quantification?

2. **Section-by-section review** (15 min):
   - Does each claim have a source?
   - Are limitations mentioned alongside features?
   - Is framing selective or balanced?
   - Are tradeoffs acknowledged?

3. **Pattern analysis** (2 min):
   - What's this documentation optimizing for?
   - What would someone miss reading this?
   - What misconceptions could develop?

4. **Verification** (5 min):
   - For major claims, can I find them in code?
   - Are metrics up-to-date?
   - Has anything changed since docs were written?

## Honesty Scoring

Rate documentation 1-10:

- **1-2**: Pure marketing material, highly misleading
- **3-4**: Significant optimization theater, unverified claims
- **5-6**: Mostly honest with some missing tradeoffs
- **7-8**: Good documentation with minor framing issues
- **9-10**: Ruthlessly honest, acknowledges all limitations

**Target**: 7+ for user-facing documentation, 8+ for technical decisions

## References

- Evaluation Framework: `docs/evaluation-framework-documentation-quality.md`
- Subagent Prompt: `.claude/subagent-documentation-review.md`
- Historical Example: See commit `28006e1` for what we cleaned up

## Further Reading

The evaluation framework includes:
- 6 evaluation dimensions with detailed checklists
- Automated detection patterns
- Before/after examples for each dimension
- Complete review protocol
