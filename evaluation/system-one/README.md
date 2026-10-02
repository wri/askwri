# System One eval harness

Single-label classification, scored against tags that already exist. No
labelling work, no LLM judge.

Compares TypeSafe-style "System One" decision models (`choice` primitive:
typed answers plus calibrated probabilities) against the LLM calls the system
already makes, on identical inputs.

## Running it

Against QA:

```bash
export SYSTEMONE_API_KEY=...                       # lunaroute gateway / TypeSafe key
export DATABASE_SSL_REJECT_UNAUTHORIZED=false      # match libpq `require` on RDS

./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/run.ts --facet office
```

Useful flags:

| Flag | Default | Meaning |
|---|---|---|
| `--facet` | `topic` | `office` or `doc_type` are the measurable ones (see below) |
| `--top-n` | `20` | candidate set size for embedded facets |
| `--limit` | all | score only the first N gold documents |
| `--concurrency` | `4` | documents in flight |
| `--systems` | all defaults | e.g. `llm:gpt-5.6-luna,systemone:kev-4b` |
| `--reps` | `1` | independent passes over the whole document set |
| `--out` | `results-<date>-<facet>.json` | artifact path |

## What it measures

Every system gets the identical `state` (the document basis the worker uses),
the identical question, and the identical candidate set. Differences are the
model's alone.

| Column | Meaning |
|---|---|
| `err` | calls that produced nothing usable — retry-exhausted, unparseable, out-of-enum. Not patched over, because that rate is itself a result. |
| `top1` | top-1 accuracy against gold, over every document |
| `top1\|cand` | accuracy restricted to documents whose gold was in the candidate set. The fair model-vs-model number. |
| `Brier` | mean squared error of the reported confidence. Lower is better. `—` when a system reports none. |
| `meanConf` | mean self-reported confidence |
| `p(gold)` | mean probability mass the system put on the gold label. Catches "confidently wrong" and "right by luck". |
| `ms` | mean wall-clock per document |

The reliability table at the bottom is the trust check: bucket the answers by
reported confidence and compare each bucket's confidence with its actual
accuracy. A system worth thresholding on shows accuracy rising with
confidence. One that reports ~0.95 everywhere and is right 78% of the time
does not, and you cannot route on it.

Candidate recall is printed once, above the table, because it is a property of
the retrieval step and not of any model. When it is low, the loss is in
retrieval and no classifier change will fix it.

## Repeats

`--reps N` runs the whole document set N times. Scoring pools the passes
(`n = documents × reps`) and prints per-pass accuracy on its own line. That
spread is the point: a gap between two systems that sits inside one system's
run-to-run variation is not a difference.

On this corpus the System One models are deterministic — kev-4b returned the
identical accuracy on all five passes — so all the variance is the reasoning
LLM's. Repeating is cheap for the System One side.

## Ground truth, and its limits

Gold is `document_tags.source = 'external'`. **These are legacy labels, not verified
truth.** They were force-applied across the founding corpus (then a single
decarbonization-related collection) and carried over unchanged. Exactly one value
per document per facet, and nothing checked any of them.

| Facet | Distinct values | What it is |
|---|---|---|
| `office` | 9 | legacy assignment — varied, unverified |
| `doc_type` | 7 | legacy assignment — varied, unverified; also not derivable from the input, see below |
| `topic` | **1** | degenerate — `Transport decarbonization` smeared across a batch |
| `program` | **1** | degenerate — `Cities` |

Read every accuracy number here as **agreement with a legacy assignment**. Model
comparisons against each other stay valid, since all of them face the same labels.
Absolute levels do not mean correctness, and some of the residual error is probably
the label being wrong rather than the model.

`topic` and `program` are not label sets; they are a portfolio stamp applied to
an import batch. The harness refuses to run on a facet with fewer than three
distinct gold values rather than report chance-level accuracy that reads as a
model failure.

**`doc_type` caveat.** The publication series (`Working Paper`, `Report`,
`Technical Note`, …) is a catalog attribute, not something the summary text
states. Every system tested scores *below* the trivial majority-class baseline
on it (17–24% against 54%), because the answer is not in the input. Do not
read doc_type numbers as a model quality signal until the basis includes cover
or front-matter text.

There are 15 `source='human'` tag rows across 11 documents. Too few to be a
gold set, but a useful second opinion once there are more: they are the cases a
person cared enough to correct.

## Measurable facets in production shape

- `office` / `doc_type` have no `tag_embeddings`, so the harness enumerates the
  whole vocabulary — which is exactly what the worker does for them.
- `topic` / `geography` are embedded, so the harness ranks candidates by cosine
  distance from the document's stored summary-chunk embedding, mirroring the
  worker's retrieve-then-classify. The document vector is read from
  `document_chunks` rather than re-embedded, which keeps Bedrock out of the
  harness.

## What production actually does — read this before reading any result

The worker attaches **0–5** topic tags per document, each with its own
confidence. `document_tags.status` is `accepted` when confidence ≥
`tag_confidence_accept` (0.7), otherwise `suggested`. The QA corpus averages
~4.9 `source='llm'` topic rows per document, consistent with top-5.

**The harness asks for a single label. That is a deliberate simplification, not
the production task.** It exists only because the one scoreable gold set
(`external`) is single-valued, so a tag *set* could not be scored against it.
The consequence is not cosmetic: forcing one label manufactures
hypernym/hyponym disagreements (`Pollution` vs `Air Pollution`) that a 0–5
answer would simply absorb by returning both. Single-label agreement figures
are therefore a **lower bound** on top-5 agreement, and should never be quoted
as a prediction of top-5 behaviour.

`choice` is single-select by construction, so the System One shape for top-5 is
**one `noul` per candidate** — "does this tag apply?" — which is also what
TypeSafe's own guidance recommends for labels that can apply together. It maps
onto production better than `choice` does, because a `noul` returns P(yes) per
tag, which is exactly the number the 0.7 accept/suggest threshold consumes.

## Measured API limits

Measured on the lunaroute gateway, 2026-10-01. These decide what shapes are
possible at all, so they are recorded with the error that established them.

| limit | value | evidence |
|---|---|---|
| `choice` options | **255** | kev-4b and djev both 400 at 300/500/757: `choice question "pick" has 757 options; the limit is 255` |
| `questions` per request, `djev` | **32** | 400 at 40/60: `"questions" exceeds this model's max_questions of 32`. Exactly 32 also fails with a generic invalid-request error; 20 works |
| `questions` per request, `kev-4b` | **> 60** | 60 `noul` questions accepted, 0.5s |
| latency, 255-option `choice` | 0.8–1.0s | candidate sets can grow far beyond the current `tag_candidate_top_n = 20` at negligible cost |
| latency, 20 `noul` questions | 0.4–0.6s | |

`topic` has **757** tags and `geography` **201**, so neither fits in a single
`choice`. System One can only ever do `topic` via retrieve-then-classify over a
subset, or via `noul`-per-candidate.

## Silver labels

`consensus.ts` writes a label file next to its artifact:

| mode | file | label |
|---|---|---|
| `choice` | `<out>.jsonl` | one plurality label per document |
| `noul` | `<out>.labels.jsonl` | `silver_tags` (top-K that a majority accepted), plus `unanimous_tags`, `disputed_tags`, per-tag `votes`, `mean_probability`, and each generator's own set |

Every row carries `provenance` — threshold, top-k, the generator list with each
one's thinking setting, timestamp — and `not_ground_truth: 'model consensus, not
human labels'`. Documents where any generator failed are **skipped**, because
otherwise "unanimous" would mean "the two that replied agreed".

**Validated against varied reference labels, and it does not hold up.** On `office`,
where the legacy column varies, four generators spanning three families reach 80.7% when unanimous, while
the best single generator reaches 82.0% alone. Consensus buys nothing, because the
errors are correlated: all four fail the same way on the same ambiguous input.

Treat these labels as a **prior for human review**, never as the reference for
validating models. A 19% label error rate cannot referee the 1-3 point differences
this harness exists to measure. Third time on this workstream that an unvalidated
label source produced a conclusion that did not survive checking.

## A trap when adding a facet

Scoring documents that have **no gold** counts them as automatic misses. On
`office` this silently deflated every accuracy figure by ~18 points (65.9%
reported against a true 83.3%), because the corpus holds 206 documents and only
167 have office gold.

`consensus.ts` now restricts to gold-bearing documents whenever the facet has
usable gold. If you add a facet, keep that behaviour: a null gold must never reach
an accuracy denominator.

## Pointing at a self-hosted model

`systemOne()` speaks the `/v1/systemone` contract, so a locally served model needs
no code — only the base URL:

```bash
SYSTEMONE_BASE_URL=http://127.0.0.1:8010/v1 \
  ./scripts/with-remote-env.sh qa npx tsx evaluation/system-one/run.ts \
  --facet office --systems systemone:my-model
```

Verified against AWS Strands Decider 2B, which serves the identical contract.
Two traps found while doing it:

- **Apple Metal crashes under concurrent requests.** Serving a PyTorch model on
  MPS with `--concurrency > 1` died with
  `failed assertion _status < MTLCommandBufferStatusCommitted` in
  `IOGPUMetalCommandBuffer`. Every in-flight request then failed in ~2ms with
  `TypeError: fetch failed`, which reads like a harness bug and is not. Use
  `--concurrency 1`.
- **`causal_conv1d` missing** makes Qwen-family models fall back to a slow
  reference kernel and emit a warning. Install it, or expect single-digit
  seconds per call rather than tens of milliseconds.

Cold start also matters: fetching and loading a 2B model took ~10 minutes, during
which the port is closed. Poll it rather than concluding the server failed.

See `docs/research/2026-10-01-system-one-decision-models.md` for the full
findings — which call sites this class fits, what ground truth exists, and results.

## Adding a model variant

Write one `pick` function in `systems.ts` and add it to `defaultSystems()`.
Nothing else knows about any provider.

```ts
export function systemOne(model: string, baseUrl?: string): System
```

`systemOne` speaks the `/v1/systemone` contract, so it already covers hosted
Jev, the lunaroute gateway, and a self-hosted Kev of any size — pass a
different `baseUrl` for the last one. The gateway currently exposes `kev-4b`
and `djev` only.

Note the `choice` cardinality cap: TypeSafe documents a maximum of 255 options,
so a facet larger than that cannot go through a single `choice`. The harness
returns an explicit `error` rather than silently truncating.

`llm` reproduces `search-service/worker/llm.py` `chat_json`, including its
single retry with a doubled token budget, so the incumbent number is the
production behaviour rather than an idealised one.

## Results so far

`results-2026-10-01-office-5reps.json`, `results-2026-10-01-doc_type.json`
(QA corpus, 2026-10-01).

### office — 167 documents, 5 passes, majority-class baseline 46.7%

| system | top1 (pooled) | per-pass top1 | Brier | meanConf | ms |
|---|---|---|---|---|---|
| `llm:gpt-5.6-luna` | 78.1% | 76.6 / 78.4 / 79.0 / 78.4 / 77.8 | 0.204 | 0.968 | 1512 |
| `systemone:kev-4b` | 77.8% | 77.8 × 5 | 0.206 | 0.576 | 241 |
| `systemone:djev` | 65.3% | 65.3 × 5 | 0.280 | 0.921 | 262 |

The gap between the incumbent and kev-4b is 0.3 points — inside the
incumbent's own 2.4-point run-to-run spread. **Accuracy is a tie.**

What separates them is the confidence. Thresholding the incumbent's answers
changes nothing: 92.6% of them land in one bin at 0.985 mean confidence, right
79.7% of the time there. kev-4b's confidence rises monotonically with accuracy
(64.7% → 76.3% → 83.9% → 85.3% → 100% across ascending bins), so its confident
subset can be routed without a human. djev is worse on both axes, and its
confidence is non-monotone in the middle bins so it carries no usable ordering.

Single facet, single corpus. Directional.

### Consensus as a label source — `office`, 167 docs with reference labels

Four generators, single-label question:

| System | accuracy |
|---|---|
| `opus-5.5` | 82.0% |
| unanimous consensus (all four) | **80.7%** |
| `sonnet-5.5` | 79.0% |
| `glm-5.3` | 73.7% |
| `deepseek-4.1-flash` | 71.3% |

Agreement does not imply correctness. See "Silver labels" above.

### doc_type — 166 documents

All three systems score 17–24% against a 54% majority-class baseline, because
the publication series is a catalog attribute the summary text never states.
Picks scatter across `Report` and `Issue Brief`; none says `Working Paper`,
which is the gold for 54% of documents. A bad input, not a bad model.

