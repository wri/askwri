# Experts mode labeled set

The measurement instrument for `/experts` ranking (spec §10). Until a Cities
program owner fills `expected_top3` with author keys (`family, given`,
lowercase — see `src/lib/experts/authorKey.ts`), every weight in
`src/lib/experts/rank.ts` and `peers.ts` is a prototype default and no
threshold may be called tuned.

## Status field

`queries.json` carries a top-level `"status"`, either `"skeleton"` or
`"labeled"`. This is the mechanical signal for "has this actually been
labeled yet" — don't infer it from whether the arrays look full.

- **`skeleton`** — the committed default. `expected_top3` may be empty.
  `npx tsx evaluation/experts/validate.ts` (no flag) passes.
- **`labeled`** — every query must carry exactly 3 well-formed author keys.
  Flipping `status` to `"labeled"` also flips
  `evaluation/__tests__/experts-queries.test.ts`'s main test into strict
  mode, so a set that says "labeled" but wasn't actually filled in fails
  the build instead of silently passing.

## Moving skeleton → labeled

1. With the Cities program owner, run each query in `queries.json` against
   QA and record the top 3 result author keys (`family, given`, lowercase)
   in that query's `expected_top3`.
2. Once every query has exactly 3 keys, set `"status": "labeled"`.
3. Validate: `npx tsx evaluation/experts/validate.ts --strict` (exits
   non-zero and lists every under-filled query until step 1 is complete).
   Plain `npx tsx evaluation/experts/validate.ts` always runs in skeleton
   mode regardless of the file's declared status — use `--strict` to assert
   the set is genuinely labeled.
4. Run `npm test -- evaluation/__tests__/experts-queries.test.ts` — with
   `status: "labeled"` this now runs the same strict check, so it stays the
   enforcement point in CI.

Small-n (10–20 queries) justifies direction only, never thresholds. Score by
hand for now — a scoring script is a follow-up once the set is labeled.
