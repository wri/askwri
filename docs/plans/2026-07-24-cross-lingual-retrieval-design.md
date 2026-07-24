# Cross-Lingual Retrieval — Design (2026-07-24)

**Status:** **NO CORPUS MUTATION.** Two review rounds changed the plan materially. The
bridge is not written to qa until an offline simulation quantifies it.

### Decision log

| # | decision | when | why |
|---|---|---|---|
| 1-5 | see §4 | 2026-07-24 | original session |
| **6** | **REVERSED decision 4: simulate before mutating** | 2026-07-24, after review round 2 | Two facts that were not known when "ship the cheap bridge now" was chosen: the bridge **can demote its own targets** (§5.5a), and the eval as designed **cannot produce a positive result** (§5.1a). Mutating the corpus to run an experiment whose best outcome is "nothing changed", using a mechanism that can silently regress the thing it targets, is not a trade worth making. The simulation surfaces both effects with zero rows written. |

**What the two reviews changed, beyond prose.** Round 1: `embedding_model`/`dimension` were
missing from the row spec, which would have made the bridge invisible to the dense lane
(§5.4); the "additive means monotone" safety argument is **false** past the reranker (§5.5a);
a one-shot backfill would be silently deleted by any future re-ingest (§5.5b). Round 2:
the acceptance criteria could not detect a win (§5.1a); the floor criterion was
guaranteed-fail; `language='en'` was unreachable through the very helper that fixes the
re-ingest hole; and answer mode is **not** inert. §3's sparse-lane evidence is retracted —
the diagnostic sparse lane is not the lane that feeds RRF.
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

Documents do lose ground between the dense lane and fusion — mean doc-rank 2.33 → 6.67,
worse in 11 of 15. Both of those numbers come from real paths and stand. **The
*explanation* does not.** That single-lane-placement account of the loss (a non-English doc
collects one RRF contribution where an English doc collects two) is the natural reading and
is probably right, but §3's sparse column does not evidence it — see the correction there.
Treat it as a hypothesis pending the §5.2 fusion-path instrumentation.

What is solid either way: the loss **does not survive to the user**. A fused doc-rank of
6-15 sits well inside the rerank candidate window — at least the first 50 distinct
documents in fusion order (`rerank_candidates=100`, cite `per_doc_cap=2`, so 50-100
distinct docs depending on chunk distribution) — and Cohere Rerank 3.5 is multilingual.

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
  position, so the reported fused ranks are valid as positions — but "absent from fused" in
  Probe 4's rerank-off pass may be a truncation artifact rather than true absence.
- **CORRECTION (review round 1): the reported bm25 ranks are not the ranking that fed
  RRF.** The fusion path passes the sparse lane `expanded_bundle` — the query after
  `expand_query_conservative` (`main.py:216-219`, consumed at `main.py:238`) — while the
  `return_intermediate_results` diagnostic passes the raw `query_bundle`
  (`main.py:924-926`) and never applies `request.bm25_top_k` (applied only inside the
  fusion path at `main.py:260-261`). So every "bm25" column in §3 measures a *different*
  retrieval than the one that produced the fused column beside it.

  **What survives:** the dense-lane numbers (15/15 top-10, 11/15 rank-1) and the final,
  post-rerank numbers (13/15 rank-1, 15/15 present; Probe 4's 14/16). Those come from the
  dense retriever and the real pipeline output respectively and are unaffected.
  **What does not:** the sparse-rank and dense-vs-fused *attribution*. The claim that RRF
  dilution is caused by single-lane placement is still the best explanation, but §3 does
  not evidence it — it must be re-measured before it is asserted anywhere.

  Sending matching params cannot fix this. §5.2 specifies the actual fix.
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

   Rationale: the rule as written is "after any BULK re-ingest, run
   `build_sparse_keyword.py` **before any threshold derivation**"
   (`docs/document-management.md:247`, `docs/plans/2026-07-23-session-handoff.md:157`) —
   quoted precisely because §7 *does* run threshold work (`capture_cite_scores.py` +
   `analyze_cite_scores.py`) on stats that will be 0.10% drifted. That is a knowing
   deviation, not an oversight: the rule exists because Phase D
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
  to `evaluation/results/`. **Sequencing note:** `_2276` and `_9425` are both §5.3
  `title_en`-repair targets *and* `en-body` targets, and `_3254` is an `en-tr` target — so
  run the repair BEFORE the before-capture, or those three documents confound the bridge's
  effect with the repair's.
- Run the 16-query non-English smoke set for the current record (expected 16/16).
- **No new cite capture is needed.** The capture JSON retained from the 2026-07-23 floor
  re-derivation is still a valid "before" — the qa corpus has not changed since.
- Fix `main.py:917` first (§5.6); every lane measurement depends on that flag.

### 5.1 Eval set — `evaluation/cross-lingual-en.json`

Same file shape as `non-english-smoke.json` (`queries[]` with `id`, `language`, `query`,
`target_doc_ids`, `note`), plus a `class` field.

### 5.1a The class structure was wrong — and it is why decision 6 exists

Round 2's decisive finding. The `en-body` queries were authored so that the query
"cannot be satisfied by the English handle the bridge adds". **That control worked, and in
working it removed the signal**: if a query deliberately avoids abstract vocabulary, a node
containing the abstract cannot match it in sparse (BM25 needs shared tokens) and will not
sit near it in dense (a specific-detail query is not close to a general topical abstract
vector). `en-body` is therefore immune to the bridge *by construction*, `en-tr` is barred
from claiming a win because it is circular, and every other suite is a regression guard.
The best achievable measured outcome was "nothing changed."

The root error is a category mistake, not a labelling one: the anti-circularity control was
designed for **known-item** retrieval, but the bridge's value proposition is **topical**
retrieval — a non-English document competing against English documents on a broad question.
For a topical query, matching the English abstract is not circularity, it is the legitimate
mechanism: the user's question really is topical, and the abstract really does describe the
document. Probe 4 is exactly that shape, and it is where the only two genuine failures of
the session appeared (`_5028`, `_1319`).

**Corrected roles** (to be built once the simulation justifies proceeding):

| class | role |
|---|---|
| **topical** (to build — Probe 4's shape, formalized) | **SIGNAL.** The only class that can show a bridge win. Broad English questions, target lists rather than full relevance labels. |
| `en-body` (12, built) | **CONTROL.** Should NOT move. Material movement means something other than the intended mechanism is acting. |
| `en-tr` (15, built) | **REGRESSION GUARD.** Circular; cannot evidence a win. |

### 5.1b The set as built

**BUILT 2026-07-24** — the file exists; counts below are measured, not estimated.

- **`en-tr-*` (15 queries, 17 docs) — REGRESSION GUARD ONLY, not a signal class.**
  The smoke queries translated to English. These are translated **titles**, and the bridge
  indexes `title_en`, so a translated native title approximates `title_en` by construction
  ("índice de desigualdad urbana" → "urban inequality index" vs `title_en`
  "Urban Inequality Index - UII"). **Any bridge improvement measured here is circular.**
  The zh subset is circular even *without* the bridge, since zh docs already carry English
  catalog titles and slugs in every chunk's metadata header (§2.2) — `nq-zh-01` translates
  to "Zhuzhou Complete Street Design Manual", which is both. And the native baseline is
  already 16/16 rank-1, so the achievable delta is bounded at zero improvement.

  Two smoke targets were **dropped** after verifying against qa: `nq-pt-02` entirely (its
  sole target `..._6821` is `language='en'` on qa — an English-edition PDF with a
  Portuguese title, the same class as the `3778`/`5852`/`2130` caveat the smoke set already
  records; it was authored in the pypdf era when its extracted text still looked
  Portuguese), and `nq-es-01`'s `..._2705` target for the same reason (the query survives
  via `..._9471`, which is `es`). Left in, both would have been English→English tests
  inflating a cross-lingual headline.

- **`en-body-*` (12 queries, 12 docs) — THE SIGNAL CLASS.** The only class from which a
  bridge result may be claimed. Each authored from a real body chunk with
  `source_chunk_index` and `source_evidence` recorded for audit, avoiding title, slug and
  abstract vocabulary. For zh targets the source chunk was required to contain CJK
  characters, so no query can have been drawn from the English executive-summary section
  those documents carry.

15 + 12 = 27 queries covering all **29** non-English searchable qa documents exactly once
(verified). The file header documents it as a **known-item retrieval set, not a
relevance-labelled golden set** — precision is meaningless here; read rank and presence
only — and records the author-bias caveat from §3.

### 5.2 Runner — `evaluation/run-cross-lingual-eval.ts`

Modelled on `run-non-english-smoke.ts`. Two passes per query:

- `--lanes` (`rerank: false`) → dense rank, sparse rank, fused rank
- `--full` (`rerank: true`) → final rank, relevance tier, docs surviving the floor

Both passes send **identical** retrieval params at explicit `CITE_PRESET` parity.

**But param parity alone does not give lane parity, and the runner must not pretend it
does.** The `return_intermediate_results` block reports lanes that are not the lanes that
fed RRF (§3 correction): the diagnostic bm25 call passes the raw query while fusion passes
the expansion-augmented one, and it ignores `bm25_top_k`. The runner must therefore read
lane ranks **from the fusion path**, which means adding the per-lane rank of each returned
node to the `/query` `debug` payload rather than inferring it from `bm25_results` /
`vector_results`.

`debug` is already `Dict[str, Any]` in `QueryResponse`, so this is contract-preserving.
Until that exists, any dense-vs-sparse-vs-fused attribution is unevidenced and must not be
reported as a finding.

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

Cause: `summarize.py:110-111` sets `title_en = title` when `lang == 'en'`. These are among
the 7 documents whose language flipped `en` → `es` during the Phase D re-parse, so
`title_en` was frozen from the pre-flip run. Provenance is `'llm'` (not
`'human'`/`'external'`), so the existing guard at `summarize.py:108` permits overwrite.

**The repair must be targeted, not a `summarize.run()` re-run.** `summarize.run()`
regenerates both `en` and native `long`+`short` summaries *first* (deleting and re-inserting
every `source='generated'` row, `summarize.py:88-98`) and only then reaches the `title_en`
block. That is ~3 LLM calls **per document** (9 total, not 3) and — critically — it would
**rewrite the English `long` summary that the bridge is about to embed**, changing the
bridge's input mid-experiment.

Write a small repair script that calls `_translate_title` plus the provenance-guarded
`UPDATE` only, touching no summary row. Back up `(id, title_en, metadata_source)` for the 3
documents first.

Without this, 3 of 29 bridge rows carry a Spanish "English title."

The 16 zh docs also show `title_en == title`, but there both values are already English.
Not a defect. It does mean the bridge contributes **no title signal for zh** — its value for
those docs is purely the English summary body. For the 13 es/pt/id docs it contributes both.

### 5.3a THE NEXT STEP — `search-service/scripts/simulate_summary_en.py`

Per decision 6, this runs **before** any row is written. It answers two questions that
cannot be answered any other way without mutating qa: *would the bridge help?* and *how
often does §5.5a's demotion actually fire?*

**Method — a faithful offline replay of the cite pipeline with the bridge nodes injected.**

1. Build the 29 `summary_en` nodes exactly as §5.4 specifies (shared helper, so the
   simulation exercises the same construction the real backfill would).
2. Embed them via `bedrock_embed.embed_documents` (`input_type=search_document`) — 29
   vectors. Compute their sparse weights via `tokenize`/`chunk_weights` against the live
   `keyword_vocab` and frozen `keyword_corpus_stats`.
3. Per query, replay the pipeline **against the DB directly**, not through
   `return_intermediate_results` (which reports a sparse lane that is not the fusion lane —
   §3 correction):
   - dense: `_DENSE_SQL_TMPL` for the real top-500 with scores; cosine the query vector
     against the 29 simulated vectors and splice each into that ranking by score;
   - sparse: `_SPARSE_KEYWORD_SQL` for the real ranking, using
     `expand_query_conservative(query)` to match what fusion actually feeds the lane;
     score each simulated node as the inner product of the query token-count vector with
     its simulated sparse vector and splice in by score;
   - RRF at alpha 0.5, `fusion_top_k` 500;
   - **rerank for real** — `BedrockReranker` with `per_doc_cap=2`,
     `rerank_candidates=100`. This step is not optional and not simulatable: §5.5a's
     demotion only materializes here.
   - floor 0.09, max-per-doc, `maxResults` 25.
4. Report, per query and per document: rank **with** and **without** the injected node, at
   each stage, plus every instance where a bridged document's score or tier *fell*.

**Cost:** 29 document embeds + per query one query-embed and one rerank call. Tens of
Bedrock calls total. **Corpus writes: zero.**

**Credential note:** calls Bedrock locally — comment out `search-service/.env.local`'s fake
MinIO AWS keys for the run and **restore afterwards** (they beat the real `~/.aws` provider
via `load_dotenv(override=False)`).

**What it decides.** If the simulation shows no meaningful gain on the topical class, or
shows demotion firing on a material fraction of bridged documents, the bridge is dropped
without a single row written and the workstream moves to the §8 alternatives. If it shows a
real gain with rare demotion, §5.4 onwards executes as specified — with the simulation's
numbers as the pre-registered prediction that the after-measurement must confirm.

### 5.4 The bridge — `search-service/scripts/backfill_summary_en.py` (GATED on §5.3a)

One additive `document_chunks` row per non-English searchable doc (29 on qa).

**Selection:** `documents.language <> 'en'` AND `status = 'searchable'` AND a
`document_summaries` row with `language='en' AND kind='long'` exists. Docs failing the last
condition are skipped and logged, never silently dropped.

**Row — the FULL column set `embed.py:264-275` writes.** Two of these are load-bearing and
were missing from the first draft of this spec:

| column | value |
|---|---|
| `document_id` | the non-English doc (unchanged) |
| `legacy_chunk_id` | `{external_id}_summary_en` |
| `chunk_index` | `-2` (native summary node uses `-1`) |
| `unit_type` | `'summary'` |
| `page` | `1` |
| `text` | `{title_en}\n\n{english_long_summary}` |
| `language` | `doc["language"]` — **NOT `'en'`** (see below) |
| `node_metadata` | see below |
| `embedding` | the Bedrock vector |
| **`embedding_model`** | **`get_settings().embedding_model`** (`'cohere-embed-v4'`) |
| **`dimension`** | **`EMBEDDING_DIMENSIONS[model]`** (1536) |
| `corpus_order` | appended after global max under advisory lock `0x636F7270` |
| `sparse` | see below |

**On `language`:** an earlier draft specified `'en'` here, to mark the row's *indexed*
language as distinct from its document's. That is unreachable through the §5.5b shared
helper: `embed.py:272` binds `doc["language"]` once for **every** node in the insert loop —
there is no per-node language. The two round-1 blocker fixes were written against different
implementations. Resolution: **drop the `'en'` marking.** The column has no readers anywhere
in `app/`, `src/` or `evaluation/` (its only appearance is the write at `embed.py:272`), so
it buys nothing worth a schema-shaped change. Identify bridge rows by the
`_summary_en` suffix instead, which is what rollback already keys on.

**`embedding_model` and `dimension` are not optional.** The dense SQL filters
`AND dc.embedding_model = %(model)s` (`pg_store.py:42`) and the HNSW index is *partial* on
`WHERE embedding_model = 'cohere-embed-v4'` (`1783454000000-Migration.ts:12-14`). A row
without them is **invisible to the dense lane** — the bridge would silently do nothing on
the only lane that currently carries cross-lingual retrieval.

**`node_metadata` — the full key set, mirroring `embed.py:114-124`.** The document's `base`
(`embed.py:87-94`) carries only `doc_id`, `title[:100]`, `authors[:100]`, `year`, `subtag`,
`program_series`; `url`, `file_path` and the **full untruncated** `authors` are added
per-node. "base with title swapped" would therefore silently drop `url`/`file_path` and
truncate authors, producing a different `MetadataMode.EMBED` header from every other node
in the corpus — and defeating the §6.1 parity test. Enumerate explicitly: `doc_id`,
`title` → **`title_en`**, `authors` (full), `year`, `subtag`, `program_series`, `url`,
`file_path`, `chunk_id` → `{external_id}_summary_en`, `chunk_index` `-2`, `total_chunks`
`-1`, `page` `1`, `chunk_start_pos` `0`, `is_summary_node` `true`, `prev_chunk_id` `null`,
`next_chunk_id` `{external_id}_chunk_0`.

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
  second placing can only improve or hold its **pre-rerank fused** doc-rank.

### 5.5a The bridge is NOT monotone — it can demote the documents it targets

An earlier draft of this spec claimed the operation "can only improve or hold" a doc's
rank. That is false past the reranker, and the correction is the single most important
result of review round 1. Verified against the code:

`BedrockReranker._select_candidates` (`bedrock_rerank.py:73-90`) fills
`settings.rerank_candidates` (100) slots **in fusion order**, taking at most
`cite_rerank_per_doc_cap = 2` chunks per document, then backfilling leftover slots with
skipped chunks. Cite then scores each document as the **max** over its surviving chunks
(`main.py:1017-1021`) and drops anything below `cite_logit_floor = 0.09`
(`main.py:1030-1031`).

So for a bridged document:

- **before:** reranked set `{body₁, body₂}` → score `max(rerank(body₁), rerank(body₂))`
- **after:** if `summary_en` places high in fusion — which is the entire point of the
  bridge — it takes one of the two slots → `{summary_en, body₁}` → score
  `max(rerank(summary_en), rerank(body₁))`

If `body₂` was the document's best chunk for that query, its score **drops**, and can drop
below the floor. **The bridge can demote the very documents it exists to promote.**

Second-order: each bridge node also consumes one of the 100 *global* candidate slots, so an
unrelated (most likely English) document can be pushed out of the rerank window entirely.
This is the mechanism by which the bridge could regress the cite golden set.

**Consequence for the safety argument.** Safety does not come from the operation being
additive. It comes from (a) the golden-set and per-document regression checks in §7, which
are therefore the *primary* safety mechanism and not a formality, and (b) rollback being a
single instant `DELETE`. This remains a genuine two-way door — but it is one we walk
through with measurement, not one that is safe by construction.

### 5.5b Re-ingest silently destroys the bridge — fold it into the worker

`embed.py:258` runs `DELETE FROM document_chunks WHERE document_id=%s` on **every** embed
stage run. A one-shot backfill script therefore creates rows that any future re-ingest,
admin re-upload or re-embed of that document deletes, with nothing to recreate them — a
data-lane invariant known only to whoever wrote the script.

**Design response:** do not build the summary_en node in a standalone script. Extract the
summary-node construction out of `_build_nodes_for_doc` into a shared helper (the §6.1
refactor already requires this for parity), have it emit a `summary_en` node whenever the
document is non-English and an English `long` summary exists, and call that helper from
**both** `embed.py` and the backfill script. The worker then regenerates the bridge on
every re-ingest for free, and the backfill exists only to populate documents that will not
otherwise be re-ingested.

**This is more than a refactor — the helper cannot currently see either input it needs**
(round 2). Both must be added, and neither is free:

- **`title_en` is not fetched.** `worker/stages/__init__.py:35`'s `fetch_document` selects
  `id, external_id, s3_key, title, language, languages, status, source_metadata,
  metadata_source` — no `title_en`. `_build_nodes_for_doc` derives its title from
  `src["Publication Title"]` (`embed.py:76`), the *native* catalog title. Adding `title_en`
  touches a helper **every worker stage** uses.
- **The English summary is not fetched.** `embed.py:160-163` binds the lookup to
  `doc["language"]`, and `_build_nodes_for_doc` takes a single summary string. A second
  lookup for `language='en'` plus a new parameter are required.

Also specify: the helper must be **idempotent on re-ingest** (the embed stage's
delete-then-insert makes double-writing impossible within a run, but the emit condition must
not fire for documents already `en`), and `total_chunks` stays `-1` on both summary nodes.

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

**`/query`:** `DocumentResult.metadata` gains `language` and `title_en`. This
**preserves the contract exactly**: `QueryRequest`, `QueryResponse` and `DocumentResult`
shapes are untouched, and `metadata` is already typed `Dict[str, Any]`
(`main.py:161`), so adding keys breaks no consumer.

**"Joined from `documents` at hydration" was hand-waving — no such mechanism exists.**
`DocumentResult` is built purely from node metadata (`main.py:1133-1141`). The only
documents-derived state is `service_state["documents_metadata"]`, hydrated once at startup
by `load_documents_metadata` (`pg_store.py:69-90`), which selects only
`external_id, source_metadata` — no `language`, no `title_en` — and is not consulted in the
result loop at all. Three changes are required:

1. extend `load_documents_metadata` to select `language` and `title_en`;
2. look the doc up by `doc_id` in the result-construction loop and merge the two keys;
3. pass them through `route.ts:167-198`, which projects a fixed field set to the UI — new
   keys otherwise reach the client only inside `meta.raw`.

**Consequence:** because this path is startup-hydrated, the §5.3 `title_en` repair requires
a **service restart** to become visible in responses. §5.5's "no restart" property applies
to the retrieval lanes only, not to this metadata.

**UI** (`src/app/results/page.tsx`, `CitePanel`): a language badge on non-English results;
the English title as the primary label with the native title secondary; the English abstract
as the snippet for non-English documents.

**Note the interaction with §5.5a:** cite mode does *not* strip summary nodes — only answer
mode does (`main.py:1051-1056`). So a bridged document whose `summary_en` node wins will
render with `title = title_en` and its content set to the English abstract, while the same
document retrieved via a body chunk renders with the native title. Without the presentation
layer that reads as an inconsistency bug; with it, it is the desired behaviour. This is an
argument for shipping §5.7 in the *same* change as the bridge, not after it.

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

Every criterion below is stated as a decidable pass/fail on the §5.0 before-numbers. The
first draft's "rank delta narrows" and "band precisions unmoved" were not checkable and are
replaced.

| suite | decision rule |
|---|---|
| `run-cross-lingual-eval.ts`, **`en-body` class only** | **PRIMARY SIGNAL.** PASS if mean final rank does not increase AND the count of targets outside the final top-10 does not increase AND no target leaves the final 25. `en-tr` is circular vs the bridge (§5.1) and cannot be used to claim a win. |
| `run-cross-lingual-eval.ts`, **per-document** | **§5.5a demotion guard.** FAIL if ANY bridged document's final rank worsens or its `relevance_tier` drops, on any query in either class. This is the check that catches the `per_doc_cap` displacement; it is the primary safety mechanism, not a formality. |
| `run-cross-lingual-eval.ts`, `en-tr` class | **REGRESSION GUARD ONLY.** PASS if no target leaves the final 25 and no target's final rank worsens. Improvements here are not evidence. |
| `run-non-english-smoke.ts` | must hold **16/16 present, 16/16 rank-1**. Note this runner sends `max_results: 150` and **no** preset params (`run-non-english-smoke.ts:86-92`), i.e. server defaults, not `CITE_PRESET`. That is acceptable *as a regression guard* because before and after are measured identically — but it is NOT at user-facing parity, and no absolute claim may be made from it. Do not "fix" it mid-experiment; that would break comparability with the retained baseline. |
| `run-cite-eval.ts` (golden set) | **REGRESSION GUARD.** English-doc-heavy, so §5.5a's global-slot displacement shows up here first. FAIL if macro recall falls at all. |
| `capture_cite_scores.py` + `analyze_cite_scores.py` | floor **verification** per §4 item 5. PASS if the macro-F1 peak stays at **0.14** and no score band's precision moves by more than 5 percentage points. **0.14 is the peak; 0.09 is the floor we deliberately retain against it** (`docs/research/2026-07-23-cite-floor-rederivation.md:42-45`) — an earlier draft wrote "peak stays at 0.09-0.10", which conflated the two and would have failed on the unchanged corpus. |
| `run-answer-retrieval-eval.ts` | **REGRESSION GUARD — not an inertness check.** An earlier draft called this inert because answer mode strips summary nodes; that is wrong. The strip runs on `stage2_results`, i.e. *after* rerank (`main.py:1049-1054`), so bridge nodes still compete for answer mode's candidate slots — in a **tighter** window than cite (`fusion_top_k=100`, `main.py:206-207`). Summary nodes are stripped from **display and synthesis, not from retrieval**. FAIL if chunk-level recall falls. |

**Acceptance:** keep the bridge only if every rule above passes. Roll back on any failure.
Given §5.5a, a mixed result (cross-lingual improves, cite recall falls) is a **rollback**,
not a trade to be negotiated — the golden set represents the traffic the product actually
serves.

**Rollback:**

```sql
DELETE FROM document_chunks
WHERE unit_type = 'summary' AND legacy_chunk_id LIKE '%\_summary\_en';
```

29 rows, immediate, no restart, no reindex, no re-embed. Scoped to `unit_type='summary'`
as well as the suffix, so a future `legacy_chunk_id` convention cannot widen the blast
radius. Back up first per the non-negotiables
(`CREATE TABLE document_chunks_summary_en_backup_<date> AS SELECT …`), even though the
operation is additive. The `title_en` repair rolls back from its own 3-row backup (§5.3).

**What rollback does NOT undo:** the `keyword_vocab` rows the run inserts for
genuinely-new tokens (via the `embed.py:217-223` pattern). Those persist with `df=1` and
permanently consume `token_id`s. This is **intentional** — vocab is append-only and shared,
and reclaiming ids would corrupt every existing `sparse` vector. Headroom is ample
(233,936 of 1,000,000 used), so the leak is immaterial; it is recorded here so the §6
rollback test asserts vocab rows *remain* rather than flagging them as damage.

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

- [x] qa is the proving ground; no step here runs against production.
      **Caveat surfaced in review:** if the prod mirror
      (`docs/runbooks/prod-cutover-multilingual-v3.md`) copies data rather than re-running
      ingestion, the bridge rows would reach production without this script ever executing
      there. Confirm which it is before the prod cutover, and record the bridge in that
      runbook either way.
- [x] **Environment presupposition stated:** this design requires
      `RETRIEVAL_BACKEND=postgres` **and** `KEYWORD_BACKEND=sparse`. §5.5's live-query
      property holds only for `SparseKeywordRetriever` (`main.py:652`). Under
      `KEYWORD_BACKEND=memory` (`main.py:659`, hydrates via `pg_store.load_nodes()`) or the
      legacy CSV boot (`main.py:575`), new rows are invisible until restart — and
      `config.py:43` still defaults `retrieval_backend` to `"legacy"`. The stale comment at
      `main.py:258-259` ("BM25Retriever is a singleton built at startup") describes those
      other paths and should be corrected in the same change.
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
