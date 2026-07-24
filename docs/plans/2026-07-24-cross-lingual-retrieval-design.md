# Cross-Lingual Retrieval — Design (2026-07-24)

**Status:** design approved, not implemented.
**Branch:** `design/cross-lingual-retrieval` (worktree `.worktrees/multilingual-v3`, based on `qa`).
**Problem:** queries arrive in English; the corpus is mixed-language. How do English
queries resolve against non-English chunks, and how do we make that measurably better?

Companions: `docs/plans/2026-07-23-session-handoff.md`,
`docs/research/2026-07-23-cite-floor-rederivation.md`,
`docs/plans/2026-07-22-multilingual-v3-todos.md`,
`docs/runbooks/qa-deploy-multilingual-v3.md`.

Filed in `docs/plans/` to match repo convention (every prior design doc lives here),
not the `docs/superpowers/specs/` default.

---

## 1. Headline

**English → non-English retrieval on qa is already close to ceiling.** That is not what
this workstream was scoped to expect, and it changes what is worth building.

Measured this session against the deployed qa corpus (method in §3):

| measurement | result |
|---|---|
| Body-derived English queries, dense lane alone | 15/15 in top-10, 11/15 rank-1, **0 misses** |
| Same queries, after RRF fusion | mean doc-rank 2.33 → **6.67**; worse in 11/15, never better |
| Same queries, after multilingual rerank | **13/15 rank-1, 15/15 present**, 14/15 top-10 |
| Competitive topical, 16 (query, non-English doc) pairs | 14/16 present in final 25, 8/16 top-10 |

The RRF asymmetry predicted in the session brief is **real and measurable** — a doc that
can only place in the dense lane collects one RRF contribution while an English doc
collects two. It just **does not survive to the user**, because a fused doc-rank of 6-15
is far inside the ~55-doc rerank candidate window (`rerank_candidates=100`,
cite `per_doc_cap=2`), and Cohere Rerank 3.5 is multilingual.

Consequence for the English-bridge hypothesis: on current evidence there is very little
*measurable retrieval* headroom to buy. The bridge is worth shipping anyway (decision
recorded in §4) because its true cost is far below what the handoff assumed — 29 INSERTs,
not a re-parse/re-embed cycle — and because the two genuine topical misses and future
corpus growth are exactly the cases it protects.

**The highest-value defect found this session is not retrieval at all.** `/query` and the
UI carry neither `language` nor `title_en`. We already successfully retrieve Spanish
documents for English-speaking users and then show them a Spanish title, a Spanish
snippet, and no indication of the language — while a curated English abstract and an
English title sit unused in the same database row.

---

## 2. Corpus characterization (three premise corrections)

### 2.1 The at-risk set is es/pt/id, not zh

The intuition inverts. Chinese looks like the hard case and is the easier one.

Per-document English reachability (measured on the local docker corpus, whose non-English
language counts match qa exactly at zh 16 / es 9 / pt 3 / id 1; chunk counts are local and
approximate for qa):

| language | docs | chunks | English body share | title / slug |
|---|---|---|---|---|
| zh | 16 | ~4,507 | 4-9% (English executive-summary sections); 4 docs are 100% CJK | **English** catalog title *and* English slug |
| es | 9 | ~1,951 | 0-15%, median ~2% | native |
| pt | 3 | ~980 | 1-8% | native |
| id | 1 | ~139 | 12% | native |

So **13 es/pt/id docs (~3,070 chunks) are the true cross-lingual exposure**: native title,
native slug, effectively no English body. The 16 zh docs already carry an English handle on
every chunk.

### 2.2 The sparse lane is not uniformly English-blind

Both the dense embed and the sparse tokenizer consume
`node.get_content(metadata_mode=MetadataMode.EMBED)` — `embed.py:186` and `embed.py:204`.
That content is the chunk text **prefixed with a metadata header**: `doc_id` (the slug),
`title`, `authors`, `year`, `subtag`, `program_series`, `url`, `file_path`.

For zh documents the catalog `Publication Title` and the slug are already English
(`Zhuzhou Complete Street Design Manual`,
`2019_zhuzhou-complete-street-design-manual_2976`), so **every zh chunk already carries an
English title-level handle in BM25**. For es/pt/id they are native, so those docs have
essentially none.

This is visible in the probe data: docs with an English handle score bm25 rank 1-15, docs
without score 38-93 or miss entirely.

### 2.3 `documents.title` and `node_metadata.title` are different fields

`_build_nodes_for_doc` (`embed.py:76`) indexes
`src["Publication Title"] or src["Article Title"] or doc["title"]` — the **native** title.
Meanwhile `documents.title` / `documents.title_en` hold the **English** one.

Concrete: `2020_indice-de-desigualdad-urbana_3387` is indexed under
`Índice de Desigualdad Urbana`, while `Urban Inequality Index - UII` sits in the same row,
unindexed. An English query for "urban inequality index" gets bm25 rank **93** and dense
rank 1.

The English title is already in the database. The indexer picked the other one.

---

## 3. Baseline evidence and how it was produced

All probes ran read-only against the **deployed qa RDS** through a local search-service
already pointed at it with the dense lane live — the same rig used for the 2026-07-23 floor
re-derivation. No corpus was mutated.

Parameters were held at `CITE_PRESET` parity where a final-rank number is reported
(`vector_top_k`/`bm25_top_k` 500, `rerank_top_n` 500, `max_results` 25, `alpha` 0.5,
`fusion_top_k` left unset so it inherits the service default 500 = `CITE_PRESET.fusionTopK`).

### Probe 1 — title-shaped English queries (16 queries, rerank off)

All 16 targets found by both lanes. The signal is in the spread:

| query | bm25 | dense | fused |
|---|---|---|---|
| "urban inequality index" (es, native indexed title) | **93** | 1 | **6** |
| "guidelines for designing safe walkable neighborhoods" (es, native) | **43** | 2 | **5** |
| all 14 queries whose target has an English handle | 1-11 | 1 | 1 |

These queries are title-derived and therefore **circular** with respect to the bridge
hypothesis — they demonstrate that the *title* handle works, not that body content is
reachable. Retained only as the observation that motivated Probe 2.

### Probe 2 — body-derived English queries (15 queries, rerank off)

Each query authored from an actual body chunk of the target, deliberately avoiding title,
slug and abstract vocabulary (e.g. "pedestrian refuge islands required when a crosswalk
exceeds sixteen meters" for the 100%-CJK `2020_design-manual-on-safe-access-to-public_5869`).

- dense: 15/15 top-10, 11/15 rank-1, 0 misses
- fused vs dense: worse in **11/15**, equal in 4, better in 0
- mean doc-rank dense **2.33** → fused **6.67**; median 1 → 7
- bm25 found the target in only 10/15

### Probe 3 — the same 15 queries through the full cite pipeline (rerank on)

- final rank 1 in **13/15**; the other two at rank 3 and rank 15
- 15/15 present in the final 25

**The reranker absorbs the fusion dilution completely.**

### Probe 4 — competitive topical (7 broad English queries, 16 (query, doc) pairs)

Broad questions where a non-English doc is genuinely relevant and competes against many
English docs on the same topic ("how can cities make streets safer for pedestrians?",
"how should cities decarbonize freight and trucking?").

- 14/16 pairs present in the user-visible final 25; 8/16 in the top 10
- **2 genuine misses**: `2021_ruas-completas-no-brasil-promovendo-uma-mudanca_5028` (pt) on
  pedestrian safety, and `2021_zero-emission-logistic-vehicles-promotion_1319` (zh) on
  freight decarbonization. Both are documents whose subject *is* the query.

### Caveats on this evidence — read before citing it

- **Known-item bias.** Probes 1-3 are known-item retrieval, which is easier than real
  topical search. Absolute numbers overstate health. Probe 4 is the honest one and it is
  the one with misses.
- **Fused-rank measurement.** Probes 1-3 read fused rank from a 150-chunk cut while dense
  rank came from the full 500. Truncation can only cause *misses*, never inflate a
  position, so the reported fused ranks are valid — but "absent from fused" in Probe 4's
  rerank-off pass may be a truncation artifact rather than true absence. **The production
  runner must pass matching params on both passes.**
- **n is small** (15 and 16). These justify a direction, not a threshold.
- **Author bias.** The queries were written by the same agent that formed the hypothesis.
  The committed eval set should be reviewed by a human before it becomes a gate.

---

## 4. Decisions taken (dgutelius, 2026-07-24)

1. **Metric: both, phased.** Known-item first as the baseline and regression gate; a
   topical mixed-language set afterwards as the user-facing metric.
2. **Query provenance: mixed.** The 16 smoke queries translated to English (identical
   targets → native-vs-English delta) *plus* body-derived queries for the docs those 16 do
   not cover. The two classes are reported separately and **never pooled into one number**.
3. **Success unit: retrieval + presentation, same design.** Retrieval sequenced first.
4. **Approach: ship the cheap bridge now, measure after.** Chosen over the recommended
   measure-and-simulate-first ordering. Recorded honestly: the reviewing agent's advice was
   to capture a baseline and simulate the bridge offline before mutating the corpus, on the
   grounds that re-deriving a floor on a changed corpus is the cost the floor work was built
   to avoid paying twice. The decision stands; the before-capture is folded in as a ~30
   minute step (§5.0) rather than a gate, which is what makes "measure after" interpretable.
5. **Sparse stats and floor: frozen stats, verify the floor.** Write the 29 rows against the
   current frozen `keyword_corpus_stats` — precisely the path `embed.py` takes for any
   newly ingested document — and do **not** run `build_sparse_keyword.py`. Then run
   `capture_cite_scores.py` and *verify* 0.09 rather than re-derive it.

   Rationale: the runbook rule ("rebuild after ANY bulk re-ingest") exists because Phase D
   rewrote all 27,878 chunks. 29 additive rows through the sanctioned new-doc path is
   ordinary ingestion, which never triggers a rebuild. A full rebuild would re-weight all
   27,907 chunks and perturb the sparse lane corpus-wide — a **larger** change than the
   inserts themselves, incurred to correct a 0.10% stats delta, and it would confound the
   bridge's effect with its own.

   Accepted risk: `keyword_corpus_stats` drifts 0.10% and stays drifted until the next real
   rebuild. Recorded in the todos so the next rebuild is not surprised by it.

---

## 5. Design

### 5.0 Before-capture (~30 min, not a gate)

Nothing here blocks the bridge; all of it becomes uninterpretable if run afterwards.

- Build the eval set (§5.1) and runner (§5.2); run both passes against qa; commit the JSON
  to `evaluation/results/`.
- Run the 16-query non-English smoke set for the current record (expected 16/16).
- **No new cite capture is needed.** The capture JSON retained from the 2026-07-23 floor
  re-derivation is still a valid "before" — the qa corpus has not changed since.
- Fix `main.py:917` first (§5.6); every lane measurement depends on that flag.

### 5.1 Eval set — `evaluation/cross-lingual-en.json`

Same file shape as `non-english-smoke.json` (`queries[]` with `id`, `language`, `query`,
`target_doc_ids`, `note`), plus a `class` field.

- **`en-tr-*`** — the 16 `non-english-smoke.json` queries translated to English, targets
  byte-identical. Purpose: a controlled native-vs-English delta on the same documents.
- **`en-body-*`** — body-derived English queries for the non-English docs the 16 do not
  reach. The smoke set covers 19 of the 29 non-English docs, so ~10 need new queries
  (compute the exact uncovered set at implementation time; do not trust this count).
  Each query authored from a real body chunk, avoiding title/slug/abstract vocabulary, with
  the source chunk recorded in `note` for auditability.

Documented in the file header as a **known-item retrieval set, not a relevance-labelled
golden set** — the same honesty the smoke set carries.

### 5.2 Runner — `evaluation/run-cross-lingual-eval.ts`

Modelled on `run-non-english-smoke.ts`. Two passes per query:

- `--lanes` (`rerank: false`) → dense rank, sparse rank, fused rank
- `--full` (`rerank: true`) → final rank, relevance tier, docs surviving the floor

Both passes send **identical** retrieval params at explicit `CITE_PRESET` parity. This is
the fix for the Probe 1-3 caveat and is non-negotiable: a constant can never explain a delta
between two measurements, but a mismatched parameter silently can.

Headline metric: the **dense → fused → final rank delta**, per class and per language.
That triple is the dilution the bridge is meant to move and the only quantity with visible
headroom. Emit it generically so the LVC workstream can reuse the runner (§8).

### 5.3 Prerequisite — repair `title_en` on 3 es docs

Verified on qa: 29/29 non-English searchable docs have an English `long` summary, so bridge
eligibility is 100%. But three es docs carry a **Spanish** `title_en`:

| doc | title_en |
|---|---|
| `2020_las-mujeres-y-el-transporte-en-bogota-las-cuentas_3254` | `Las Mujeres y el transporte en Bogotá: las cuentas` |
| `2023_base-de-datos-ajustada-de-la-encuesta-origen_2276` | `Base de Datos Ajustada de la Encuesta Origen-Destino…` |
| `2025_aire-limpio-en-barrios-vitales_9425` | `Aire Limpio en Barrios Vitales` |

Cause: `summarize.py:110` sets `title_en = title` when `lang == 'en'`. These are among the 7
documents whose language flipped `en` → `es` during the Phase D re-parse, so `title_en` was
frozen from the pre-flip run. Provenance is `'llm'` (not `'human'`/`'external'`), so the
existing guard at `summarize.py:108` permits overwrite — re-running the title path repairs
them in 3 LLM calls.

Without this, 3 of 29 bridge rows carry a Spanish "English title."

The 16 zh docs also show `title_en == title`, but there both values are already English.
Not a defect. It does mean the bridge contributes **no title signal for zh** — its value for
those docs is purely the English summary body. For the 13 es/pt/id docs it contributes both.

### 5.4 The bridge — `search-service/scripts/backfill_summary_en.py`

One additive `document_chunks` row per non-English searchable doc (29 on qa).

**Selection:** `documents.language <> 'en'` AND `status = 'searchable'` AND a
`document_summaries` row with `language='en' AND kind='long'` exists. Docs failing the last
condition are skipped and logged, never silently dropped.

**Row:**

| column | value |
|---|---|
| `document_id` | the non-English doc (unchanged) |
| `legacy_chunk_id` | `{external_id}_summary_en` |
| `unit_type` | `'summary'` |
| `language` | `'en'` — the row's *indexed* language, distinct from the document's |
| `text` | `{title_en}\n\n{english_long_summary}` |
| `chunk_index` | `-2` (native summary node uses `-1`) |
| `corpus_order` | appended after global max under advisory lock `0x636F7270` |

**`node_metadata`:** the document's existing `base` metadata with `title` → `title_en`,
`chunk_id` → `{external_id}_summary_en`, `total_chunks` `-1`, `page` `1`,
`is_summary_node` `true`, `prev_chunk_id` `null`, `next_chunk_id` `{external_id}_chunk_0`.

**Embedding:** `app.bedrock_embed.embed_documents` on
`node.get_content(metadata_mode=MetadataMode.EMBED)` — `input_type=search_document`,
identical encoding to `embed.py`.

**Sparse:** `tokenize` + `chunk_weights` against the **current frozen**
`keyword_corpus_stats` and `keyword_vocab`, with genuinely-new tokens upserted via the same
anti-join-then-`ON CONFLICT DO NOTHING` pattern and `lucene_idf(1, n_chunks)` that
`embed.py:211-227` uses. The `SPARSE_DIM` exhaustion guard applies unchanged.

**Idempotency:** delete-then-insert on the `_summary_en` suffix. Two runs → 29 rows.

**Credential note:** this script calls Bedrock locally. `search-service/.env.local` carries
FAKE MinIO AWS keys that load via `load_dotenv(override=False)` and beat the real `~/.aws`
provider. Comment them out for the run and **restore afterwards**.

### 5.5 Why this is safe (verified, not assumed)

- **Both lanes query Postgres live, per request.** `SparseKeywordRetriever._retrieve`
  (`pg_store.py:169`) tokenizes and scans on every call; the dense lane queries pgvector
  directly. There is **no startup hydration of the sparse index**. New rows take effect
  immediately — no restart, no reindex — and rollback is equally immediate.
- **`is_summary_node` is already handled end to end.** Answer mode strips summary nodes
  (`main.py:1053`) and passage-context lookup skips them (`main.py:1105`), because the
  native summary node already has the "summary text is not in `document_texts.full_text`"
  problem. A `summary_en` node inherits both fixes for free.
- **No existing row is modified.** `SimpleNodeParser` chunks the document text, which is
  untouched. Chunk boundaries, every `legacy_chunk_id`, and every golden-set chunk
  reference stay exactly where they are. This is why the operation is 29 INSERTs and not
  the re-parse/re-embed cycle the handoff assumed.
- **The HNSW index covers new rows automatically**; the sparse lane is an exact scan with
  no index to rebuild.
- **RRF is chunk-level and the final list dedupes to docs**, so a document that gains a
  second placing can only improve or hold its doc-rank.

### 5.6 Fix `main.py:917` — dense call outside the degradation guard

`main.py:917` runs `make_dense_retriever(...).retrieve(...)` for the
`return_intermediate_results` diagnostic path **outside** the try/except at `main.py:244`
that implements sparse-only degradation. A dense-lane failure therefore returns HTTP 500
instead of degrading.

This broke the first probe run of this session (expired local AWS credentials → 500 rather
than a degraded response). It matters here specifically because **every lane-level
cross-lingual measurement sets that flag**, and it matters generally because cross-lingual
retrieval depends *entirely* on the dense lane — the sparse-only fallback is
English-keyword-only by construction.

Fix: wrap the diagnostic dense call in the same degradation handling, returning an empty
`vector_results` and setting the same `service_state` markers. Cover with a test alongside
`tests/test_dense_fallback.py`.

### 5.7 Presentation layer

**`/query`:** `DocumentResult.metadata` gains `language` and `title_en`, joined from
`documents` at hydration. No re-index required.

This **preserves the `/query` contract exactly**: `QueryRequest`, `QueryResponse` and
`DocumentResult` shapes are untouched, and `metadata` is already typed `Dict[str, Any]`, so
adding keys breaks no consumer.

**UI** (`src/app/results/page.tsx`, `CitePanel`): a language badge on non-English results;
the English title as the primary label with the native title secondary; the English abstract
as the snippet for non-English documents.

---

## 6. Testing (TDD)

`search-service/tests/test_backfill_summary_en.py`, against the local docker Postgres:

1. **Parity with `embed.py`.** The new node's `MetadataMode.EMBED` content and its sparse
   weights must be produced by the *same* helper `embed.py` uses. Extract the summary-node
   builder out of `_build_nodes_for_doc` into a shared function and have both call it —
   duplicating the construction and asserting equality would test the copy, not the
   contract. This refactor is in scope: we are already working in that file.
2. **Idempotency** — two runs produce 29 rows, byte-identical.
3. **Rollback** — the `DELETE` restores `document_chunks` exactly (row count, `corpus_order`
   max, no orphaned `keyword_vocab` damage).
4. **Skip path** — a doc with no English `long` summary is skipped and logged.
5. **Non-mutation** — no pre-existing row's `text`, `embedding`, `sparse`, `node_metadata`
   or `legacy_chunk_id` changes.
6. **Sparse correctness** — weights equal
   `chunk_weights(tokenize(embed_content), idf_map, avgdl)` under the frozen stats.

Plus the `main.py:917` degradation test (§5.6), and a unit test for the runner's rank
extraction.

---

## 7. Measurement, acceptance and rollback

**After the backfill, re-run and compare against §5.0:**

| suite | expectation |
|---|---|
| `run-cross-lingual-eval.ts` (both passes) | **primary**: dense→fused→final rank delta narrows; no target regresses out of the final 25 |
| `run-non-english-smoke.ts` | must hold **16/16 present, 16/16 rank-1** — native-language retrieval must not regress |
| `run-cite-eval.ts` (golden set) | **regression guard**. The golden set is English-doc-heavy, so a bridge-induced ranking shift shows up here first. Recall must not fall. |
| `capture_cite_scores.py` + `analyze_cite_scores.py` | floor **verification** per §4.5: if the macro-F1 curve and band precisions are unmoved, 0.09 stands. If they moved, stop and re-derive properly. |
| `run-answer-retrieval-eval.ts` | answer mode strips summary nodes by construction, so this should be inert. Run it to confirm that reasoning, not to tune. |

**Acceptance:** the bridge is kept if the cross-lingual delta improves or holds *and*
neither the smoke set nor cite recall regresses. It is rolled back otherwise — this is a
two-way door and should be treated as one.

**Rollback:**

```sql
DELETE FROM document_chunks WHERE legacy_chunk_id LIKE '%\_summary\_en';
```

29 rows, immediate, no restart, no reindex, no re-embed. Back up first per the
non-negotiables (`CREATE TABLE document_chunks_summary_en_backup_<date> AS SELECT …`),
even though the operation is purely additive. The `title_en` repair rolls back from the
same backup-table pattern the runbook already uses.

---

## 8. Alternatives considered

| alternative | verdict |
|---|---|
| **Index `title_en` in place of the native `node_metadata.title`** | **Deferred, not rejected.** The more direct fix for the 13 es/pt/id docs, and cheaper than assumed — a 29-doc re-embed (~7.5k chunks) with **stable chunk IDs**, so no golden-set reference moves. But it rewrites existing rows, which is a bigger door than 29 INSERTs. Revisit if the bridge under-delivers. |
| **Query-side translation into es/pt/id** | **Deferred, genuinely viable.** Works today with zero index change: the English Snowball stemmer is applied identically on both index and query sides, so stemming Spanish "wrongly" still *matches* — it is suboptimal, not broken. Would not help zh, which needs segmentation. Worth its own experiment; costs query latency. |
| **Per-language fusion weighting** | **Rejected.** Boosting non-English RRF contributions is hand-tuning a weight, which the project's non-negotiables forbid. It also requires `documents.language` on the node (not currently there) and distorts the main retrieval path for every query. |
| **Multilingual sparse lane** (per-language FTS configs, jieba segmentation for zh) | **Rejected for now.** Large, changes the sparse contract, and the evidence says the sparse lane is not the binding constraint — the reranker already recovers what fusion loses. |
| **Measure-and-simulate before mutating** (the reviewing agent's recommendation) | **Not taken** — see §4.4. Retained here because if the bridge is rolled back, the simulation approach is the next step, and its design is: embed the 29 English summaries via Bedrock, score them against each query using the live `keyword_vocab` + `chunk_weights`/`lucene_idf` for sparse and cosine for dense, inject the node into each lane's ranking, re-run RRF, report the counterfactual rank delta. Zero corpus mutation. |

---

## 9. Interaction with the LVC workstream (noted, not conflated)

Land-value-capture vocabulary drift is a **separate** workstream (7 of 66 golden expected
docs never reach the reranker; 5 are q11's, 3 of those LVC). It is not merged into this one.

They interact in exactly one place: both are fusion/vocabulary-**reach** problems, and both
are diagnosed by the same instrument — where a document sits at dense vs fused vs final.
`run-cross-lingual-eval.ts` should therefore emit that triple generically rather than
cross-lingual-specific fields, so the LVC lane can reuse the runner instead of building a
second one.

The distinction that matters: cross-lingual documents **do** reach the reranker and get
rescued (this design's finding). LVC documents **do not reach it at all** — a strictly
harder failure, and the reason LVC remains the larger recall lever.

---

## 10. Open questions carried forward

- **The two topical misses are unexplained.** `ruas-completas_5028` and
  `zero-emission-logistic-vehicles_1319` — is each a floor failure, a fusion failure, or a
  candidate-pool failure? The "streets safer for pedestrians" query returned only 12 docs
  after the floor, which hints at a floor cut rather than a pool miss for that one. Worth
  root-causing after the bridge lands, since the bridge may resolve them.
- **Corpus scale.** `rerank_candidates=100` + `per_doc_cap=2` caps the pool at ~50-65 docs.
  Today a diluted non-English doc at fused rank 6-15 still enters. At 10× corpus that
  window bites hard and the RRF asymmetry becomes user-visible. **This is the strongest
  forward-looking argument for the bridge** and should be re-tested at scale.
- **Dense-lane degradation erases cross-lingual entirely.** The sparse-only fallback is
  English-keyword-only, so a Bedrock outage silently drops all 29 non-English docs from
  reach. The bridge gives partial survivability. Consider surfacing this explicitly at
  `/health` beyond the existing `dense_degraded_at` marker.
- **The eval set needs human review** before it becomes a gate (§3 caveat: author bias).
- **`keyword_corpus_stats` drift** of 0.10% is accepted and unrepaired until the next real
  rebuild — record in the todos.
- **Phase 2 topical set** (per decision §4.1) is not designed here. It is the user-facing
  metric and needs relevance labelling; scope it after the bridge result is in.

---

## 11. Non-negotiables checklist

- [x] qa is the proving ground; nothing here touches production
      (`docs/runbooks/prod-cutover-multilingual-v3.md` governs that mirror).
- [x] `/query` request/response contract preserved exactly (§5.7).
- [x] Thresholds re-derived, never hand-tuned — floor is **verified**, and if it moved the
      design says stop and re-derive properly (§7).
- [x] Measurement parity: both runner passes send identical explicit params (§5.2).
- [x] Credential footgun: fake MinIO keys commented out for local Bedrock work, restored
      after (§5.4).
- [x] Sparse: frozen-stats path is the sanctioned new-doc path; the rebuild rule's scope is
      argued explicitly rather than waived silently (§4.5).
- [x] Back up before corpus mutation; rollback is one `DELETE` (§7).
- [x] TDD (§6); conventional commits; no Co-Authored-By; `git add <explicit paths>`.
