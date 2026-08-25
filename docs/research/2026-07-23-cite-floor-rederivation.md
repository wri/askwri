# Cite threshold re-derivation on the all-Mistral corpus (2026-07-23)

Runbook Phase C step 9, re-run after Phase D. Every prior cite calibration was
derived on a pypdf-parsed corpus; the floor has moved with every corpus change
(0.08 on 3-small → 0.10 post-embed-cutover → 0.09 post-Mistral locally), so it
had to be re-derived once qa became uniformly Mistral-parsed.

## Setup

- Corpus: deployed qa RDS after the Phase D re-parse — 168 docs, 27,878 chunks,
  100% `cohere-embed-v4`, sparse rebuilt (`n_chunks` 27,878, `avgdl` 199.8).
- Measurement: a LOCAL search-service pointed at RDS with `CITE_LOGIT_FLOOR=0`
  (the deployed floor cannot be zeroed without a redeploy). Verified untruncated:
  irrelevant scores reach 0.0042 and `floor=0.0` yields R 92.2.
- Golden set: the **corrected** one (PR #250 — q11's 4 self-contradicting
  electric-bus expectations removed; 66 expected docs total, not 70).
- `scripts/capture_cite_scores.py` sends no `fusion_top_k`, so it inherits the
  service default 500 — which now equals `CITE_PRESET.fusionTopK` after #253.
  Evals and users finally measure the same pool.

## Headline change: `CITE_PRESET.maxResults` 100 → 25. Floor stays 0.09.

The decisive fact is that **the UI renders every returned doc** —
`src/app/results/page.tsx` sets `pageDocs = supporting` with no slice, and
`CitePanel` does not paginate. So `maxResults`, not the logit floor, is what
bounds list length. At 100 the floor was being asked to do a job it is bad at:
list length ranged from a handful to **46 docs** depending on the query.

| config | med / max | P | R | F1 |
|---|---|---|---|---|
| floor 0.09, k=100 (before) | 13 / **46** | 29.2 | 83.3 | 43.3 |
| **floor 0.09, k=25 (after)** | 13 / **25** | **32.0** | **83.3** | **46.2** |
| floor 0.06, k=25 | 17 / 25 | 27.0 | 85.6 | 41.0 |
| floor 0.14, k=25 | 9 / 25 | 38.8 | 70.2 | 50.0 |

Excluding q11 (see below): before 31.4 / 90.2 / 46.6 → after **34.4 / 90.2 / 49.8**.

This is a **Pareto improvement** — recall is bit-for-bit identical because every
expected document already ranks inside the top 25. The tail the cap removes
contained no relevant documents; it was pure noise padding the list.

## Why not the macro-F1 peak (0.14)

The sweep peaks at floor 0.14 (P 36.6 / R 70.2 / F1 48.1), robustly — the peak
is 0.14 both with and without q11. It was rejected on purpose.

Cite mode is **recall-first by design**: its job is narrowing a search space and
producing an annotated bibliography, so a missed source costs more than a
marginal one. Macro-F1 weights precision equally, which does not match that.
Taking the peak would cost **13pp recall**.

Band precision says the same thing more concretely — F1's peak sits *inside* a
band that carries real signal:

| band | precision | |
|---|---|---|
| [0.00, 0.05) | 1.7% | junk |
| [0.05, 0.10) | 3.9% | junk |
| **[0.10, 0.20)** | **20.5%** | 5x jump — real signal |
| [0.40, 0.60) | 40-50% | |
| [0.70, 1.0] | 62.5% | |

Cutting at 0.14 discards part of a 20.5%-precision band to gain against a
metric we do not optimize for. The relevance **tiers** (strong ≥0.70 / partial
≥0.30 / weak) already communicate confidence, so low-scoring hits are labelled
rather than silently mixed in.

Cross-lingual is unaffected at any candidate floor: smoke relevant minimums are
es 0.824, pt 0.888, zh 0.516, all far above 0.09. **16/16 smoke targets present,
16/16 rank-1.**

## q11 excluded from the derivation

`q11_urban_finance_exclude_ebuses` is not measuring the floor. Of its 7
expected docs, **5 never enter the candidate pool at all**:

- `rail-plus-property-development-china-pilot-case-shenzhen`
- `urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations`
- `synergizing-land-value-capture-tod`
- `accelerating-nature-based-solutions-brazilian-cities`
- `accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india`

The remaining two score 0.151 and 0.045. So q11's recall is capped at 2/7
regardless of threshold, and it drags macro recall ~7pp. Three of the five
missing are land-value-capture documents — this is the **LVC vocabulary drift**
lane, compounded by the fact that q11 is a negation query and the retrieval
layer does not claim negation (already flagged in the todos alongside q9/q10).

It informs the LVC and golden-set-rescope lanes. It must not move a threshold.

## The real recall ceiling

Only **59 of 66** expected docs reach the reranker at `fusion_top_k=500`.
Macro recall plateaus at **90.7% (top-30)** and does not improve at top-40.
No threshold or cap recovers the missing 7 — that is a fusion/vocabulary gap.
**LVC vocabulary drift is a bigger lever than any further threshold tuning.**

## Still to dig into (flagged 2026-07-23)

- **Floor 0.06 as a deliberate recall purchase**: +2.3pp recall for -2.2pp
  precision / -2.3 F1 vs the shipped config. Rejected as a bundled change, not
  on the merits — decide it independently. Capture JSON is retained so this
  needs no re-run.
- **LVC vocabulary drift** — synonym/glossary expansion (land-pooling,
  readjustment, Rail+Property ↔ "land value capture"). Query-side vs
  embed-time placement is undecided.
- **Golden-set precision is systematically understated**: a doc counts as
  relevant only if it appears in `expected_urls`, so "P 32%" conflates genuine
  noise with incomplete labelling. Precision numbers here are a floor, not an
  estimate.
- **`ANSWER_PRESET` has never been re-derived on cohere** — `fusionTopK: 100`
  and its own floor still carry 3-small-era calibration.
- **Tier boundaries (0.30 / 0.70) were not re-derived** here, only the floor and
  cap. Band precision suggests the steps may have moved.
- **q9 / q10 / q11** test capabilities retrieval does not claim (program
  membership metadata, date filtering, negation) — build features or rescope.
- **Per-doc cap A/B** for answer mode (setting added in #255, default off).
- `rerank_candidates=100` + `per_doc_cap=2` caps the candidate pool at ~50-65
  docs; revisit at larger corpus scale.

## Reproduce

```
# local service -> RDS, floor zeroed
CITE_LOGIT_FLOOR=0 ./scripts/with-remote-env.sh qa <start search-service>
cd search-service && ./venv/bin/python -m scripts.capture_cite_scores <out.json>
./venv/bin/python -m scripts.analyze_cite_scores <out.json>
```
