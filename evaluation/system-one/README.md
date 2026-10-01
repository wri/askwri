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

Gold is `document_tags.source = 'external'` — the tags imported from WRI's own
metadata. Exactly one value per document per facet.

| Facet | Distinct values | Usable? |
|---|---|---|
| `office` | 9 | yes |
| `doc_type` | 7 | yes, **but see the caveat** |
| `topic` | **1** | no — one value, `Transport decarbonization`, smeared across a batch |
| `program` | **1** | no — one value, `Cities` |

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

### doc_type — 166 documents

All three systems score 17–24% against a 54% majority-class baseline, because
the publication series is a catalog attribute the summary text never states.
Picks scatter across `Report` and `Issue Brief`; none says `Working Paper`,
which is the gold for 54% of documents. A bad input, not a bad model.

