# Experts mode labeled set

The measurement instrument for `/experts` ranking (spec §10). Until a Cities
program owner fills `expected_top3` with author keys (`family, given`,
lowercase — see `src/lib/experts/authorKey.ts`), every weight in
`src/lib/experts/rank.ts` and `peers.ts` is a prototype default and no
threshold may be called tuned.

- Validate: `npx tsx evaluation/experts/validate.ts`
- Small-n (10–20 queries) justifies direction only, never thresholds.
- Score by hand for now: run each query on QA, record the top 3 keys, compare.
  A scoring script is a follow-up once at least 10 queries are labeled.
