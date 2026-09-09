# Core-topic coverage fixes for #402 and #403

Date: 2026-09-09. Base: `b3401e8` (`qa`). No deployment performed.

The off-topic coverage check now normalizes the two observed extraction forms that caused negative-query drift, matches reordered author names within one semicolon-delimited person, and consults authoritative English long summaries with legacy metadata fallback. SQL LIKE metacharacters are escaped. The TypeScript candidate mirror and exact evaluator document the same policy.

Against the same read-only QA corpus (206 documents; corpus hash `e3742444838019cdf5f8b39270ecdebb0ddbf79c561611b0db302b420ce8a595`), every distinct recorded extraction was evaluated:

| Metric | Before | After |
|---|---:|---:|
| Positive cases clear across every recorded extraction | 32/40 | 36/40 |
| Negative cases absent across every recorded extraction | 2/3 | 3/3 |
| Previously correct decisions regressed | — | 0 |

The historical d9 and d8 long-form extractions were also replayed against the old and new matching functions. Both previously matched incidental title phrases and are absent after normalization. A six-query probe showed median matching time of 134.0 ms before and 71.9 ms after, including database/network timing; this is not an ECS benchmark.

The exact evaluator is `search-service/scripts/abstention_exact.py`. It fails on blank extractions, database degradation, corpus drift, changed extraction sets, or regressions. The older TypeScript blast-radius tool is labeled as a modal-only catalog approximation.

Remaining cases are intentionally recorded rather than tuned away: `bike-share trips` still misses, `rail-water intermodal transport` and `parking meters` require chunk-text support, and `micromobility solutions` remains uncovered. These are follow-up work, so #402 and #403 remain open until fresh QA canaries confirm the deployed behavior.

Validation: 118 focused Python tests passed, including 13 temporary-table PostgreSQL tests; 28 Jest tests passed; scoped ESLint, Prettier, and `git diff --check` passed; an independent review found no new defects.
