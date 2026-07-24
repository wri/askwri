# Cross-lingual retrieval — findings (2026-07-24)

Record of a measurement session on the qa corpus. **Nothing was shipped and no
corpus row was written.** Two candidate mechanisms were investigated (an English
"bridge" node per non-English document, and query-side translation); neither is
recommended for production as designed. The durable outputs are the measurements
below, a corrected understanding of the retrieval path, and an eval set.

Companion: `docs/plans/2026-07-24-cross-lingual-retrieval-design.md` (the bridge
design, twice revised by review and now gated behind a simulation that has not
been built).

---

## 1. Headline

**English → non-English retrieval on qa is already close to ceiling.** The
session was scoped expecting a deficiency; the measurements did not find a large
one.

| measurement | result |
|---|---|
| Body-derived English queries, dense lane alone | 15/15 in top-10, 11/15 rank-1, **0 misses** |
| Same, after RRF fusion | mean doc-rank 2.33 → **6.67**, worse in 11/15 |
| Same, after multilingual rerank | **13/15 rank-1, 15/15 present** |
| Competitive topical, 16 (query, non-English doc) pairs | 14/16 reach the user's final 25; 8/16 top-10 |

Documents do lose ground between the dense lane and fusion. The multilingual
reranker then recovers it, because a fused doc-rank of 6-15 sits well inside the
rerank candidate window. Only **two genuine failures** were found across the
whole session: `ruas-completas_5028` (pt) on pedestrian safety and
`zero-emission-logistic-vehicles_1319` (zh) on freight decarbonization.

**The clearest defect found is not retrieval.** `/query` and the UI carry
neither `language` nor `title_en`. Spanish documents are already being retrieved
successfully for English-speaking users and shown with a Spanish title, a
Spanish snippet, and no language indication — while a curated English abstract
and an English title sit unused in the same database row.

---

## 2. Corpus characterization

Language labels are **trustworthy**: zero documents labelled `en` have a
non-English body (verified on qa by an English-function-word density test over
all `en` documents). The converse assumption — that a non-English label implies
an unreachable document — is where the intuition fails.

### 2.1 The at-risk set is es/pt/id, not zh

| lang | docs | chunks* | English body share* | indexed title / slug |
|---|---|---|---|---|
| zh | 16 | ~4,507 | 4-9% (English exec-summary sections); 4 docs are 100% CJK | **English** catalog title AND English slug |
| es | 9 | ~1,951 | 0-15%, median ~2% | native |
| pt | 3 | ~980 | 1-8% | native |
| id | 1 | ~139 | 12% | native |

\* chunk counts and body shares measured on the local docker corpus, whose
non-English language counts match qa exactly (16/9/3/1). Treat as approximate
for qa.

**13 es/pt/id documents (~3,070 chunks) are the real cross-lingual exposure.**
The 16 zh documents already carry an English handle on every chunk. The
intuition inverts: Chinese looks like the hard case and is the easier one.

### 2.2 Why the sparse lane is not uniformly English-blind

Both the dense embed and the sparse tokenizer consume
`node.get_content(metadata_mode=MetadataMode.EMBED)` (`embed.py:186`, `:204`),
which is the chunk text **prefixed with a metadata header** — `doc_id` (the
slug), `title`, `authors`, `year`, `url`, `file_path`, `program_series`, plus
every per-chunk key. For zh documents the catalog `Publication Title` and slug
are already English, so **every zh chunk carries an English title-level handle
in BM25**. For es/pt/id they are native, so those documents have essentially
none.

Visible in the data: documents with an English handle score bm25 rank 1-15;
documents without score 38-93 or miss entirely.

### 2.3 Two different titles exist, and the indexer picked the native one

`_build_nodes_for_doc` (`embed.py:76`) indexes
`src["Publication Title"] or src["Article Title"] or doc["title"]` — the
**native** title. `documents.title` / `documents.title_en` hold the English one.
`2020_indice-de-desigualdad-urbana_3387` is indexed as
`Índice de Desigualdad Urbana` while `Urban Inequality Index - UII` sits
unindexed in the same row. An English query for "urban inequality index" gets
bm25 rank **93** and dense rank 1.

Caveat: this is not a universal rule. Three es documents have a *Spanish*
`title_en` (`_3254`, `_2276`, `_9425`) because `summarize.py:110-111` sets
`title_en = title` when the document is labelled `en`, and these were among the
7 documents whose language flipped `en` → es/zh/id during the Phase D re-parse.
Provenance is `'llm'`, so a targeted repair may overwrite them.

### 2.4 English summaries exist for every non-English document

29/29 non-English searchable qa documents have an English `long` summary
(verified on qa). Locally these carry `source='external'` — curated catalog
abstracts, not LLM output. Length: es ~786 chars avg, pt ~797, zh ~523.

---

## 3. Measurements

All probes ran **read-only against the deployed qa RDS** through a local
search-service with the dense lane live — the same rig used for the 2026-07-23
floor re-derivation. Local rerank region is us-west-2 vs the deployed us-east-1;
same model, so ranks are comparable and only latency differs.

### 3.1 Baseline: does English reach non-English content?

| # | probe | config | result |
|---|---|---|---|
| P1 | 16 title-shaped English queries | rerank off | all 16 found by dense; bm25 rank 43 and 93 for the two documents lacking an English handle, 1-11 for the rest |
| P2 | 15 body-derived English queries | rerank off | dense 15/15 top-10, 11/15 rank-1, 0 misses. Fused worse than dense in 11/15, equal in 4, better in 0. Mean rank 2.33 → 6.67. bm25 found only 10/15 |
| P3 | the same 15 | rerank on, `CITE_PRESET` params | **13/15 final rank-1**, 15/15 present, 14/15 top-10 |
| P4 | 7 broad topical queries, 16 (query, doc) pairs | rerank on | 14/16 present in the final 25, 8/16 top-10. **2 genuine misses** |

P1 is circular (title-derived) and retained only as the observation that
motivated P2.

### 3.2 Query-side translation

| # | probe | result |
|---|---|---|
| P5 | 10 known-item pairs, **oracle** translations, whole query | bm25: English found 7/10, translated **10/10**, translated better **10/10**, worse 0. Ranks 93→1, 61→2, 43→1, three misses→1. Dense better in only 2/10 (already multilingual). Final: English 9/10, translated 10/10 |
| P6 | 12 topical queries, translations appended to `request.query` (reaching sparse **and** dense **and** rerank) | targets: 13/17 better, 3 worse. Competitors: 10 better, **11 worse, 4 displaced**. Result lists ~40% shorter |
| P7 | the same 12, **auto**-translation routed to the **sparse lane only** | targets: **12/17 better, 1 worse, 17/17 present**; recovered `_5028` from absent → rank 4. Competitors: 12 better, **7 worse, 3 displaced**. Result lists **256 → 148 docs (−42%)** |
| P8 | cite golden set, `run-cite-eval.ts`, both arms on the identical harness | translation **off**: P 29.2 / R **83.3** / F1 42.1 (9/11 passed). translation **on**: P 32.2 / R **76.5** / F1 42.6 (8/11 passed) |

**P8 is the disqualifying result**: −6.8pp recall for +3.0pp precision, F1 flat.
Cite is recall-first by design.

**But P8 measures only one side of the trade.** The cite golden set is
English-document-heavy with almost no non-English expected documents, so it sees
translation's cost to English retrieval and is structurally blind to its benefit
(P7). A verdict on cross-lingual quality cannot be read from it.

---

## 4. Why translation regresses, and why the obvious fix will not work

The natural hypothesis — that the shrinkage came from polluting the reranker's
query with multilingual text — is **wrong**. Routing translations to the sparse
lane alone (P7) left the −42% unchanged.

The actual mechanism: **RRF scores by rank, not membership.**
`main.py:272-279` computes `weight * 1/(60 + rank)`. A chunk at sparse rank 5
contributes ~0.015; at rank 300, ~0.003. A translated query matches non-English
chunks strongly, so English chunks are pushed *down* the sparse ranking — they
do not fall off it. Their fused contribution collapses anyway.

**Consequence:** raising `bm25_top_k` cannot fix this. More budget appends
entries whose RRF contribution is near zero; it cannot restore a rank. The cite
eval was already running at `bm25_top_k=800` when it regressed, which is
consistent.

The design implication — untested, and the reason a proper design session is
needed — is that the translated query likely needs its **own lane** with its own
RRF contribution (dense + sparse-English + sparse-translated), so English chunks
keep their English-query ranks instead of competing for position. Weights would
have to be derived, not hand-tuned.

---

## 5. Code findings

Verified against the source; several corrected claims made earlier in the
session.

**Retrieval path**
- `main.py:216` — query expansion is applied to the **sparse lane only**; dense
  receives the original bundle. This is the hook translation belongs in.
- `SparseKeywordRetriever._retrieve` (`pg_store.py:169`) tokenizes and scans
  Postgres **per request**; there is no startup hydration under
  `KEYWORD_BACKEND=sparse`. New chunk rows would take effect with no restart.
  The comment at `main.py:258-259` describing a startup-built BM25 singleton
  refers to the `memory` and legacy CSV paths and is stale for this config.
- `pg_store.py:42` — the dense SQL filters `dc.embedding_model`, and the HNSW
  index is **partial** on the same predicate. Any hand-written chunk row must
  set `embedding_model` and `dimension` or it is invisible to dense.

**Reranking and scoring**
- `bedrock_rerank.py:73-90` — candidates fill 100 slots **in fusion order**, at
  most `cite_rerank_per_doc_cap=2` per document, then backfill.
- `main.py:1020` — a cite document scores as the **max** over its surviving
  chunks; `main.py:1030-1031` drops anything under `cite_logit_floor`.
- Together these mean **adding a chunk to a document is not monotone**: a new
  chunk can take one of that document's two slots and displace a
  higher-scoring one, lowering the document's score, possibly below the floor.
  This is what parked the bridge.

**Measurement instruments (read before trusting any number)**
- The `return_intermediate_results` diagnostic **does not report the lanes that
  feed RRF**. The fusion path passes the sparse lane the *expanded* query
  (`main.py:216-219, 238`); the diagnostic passes the raw query
  (`main.py:924-926`) and never applies `request.bm25_top_k`. Cross-lane
  attribution from this path is invalid. The dense diagnostic **is** at parity.
- `run-cite-eval.ts:138-141` sends `vector_top_k: 800, bm25_top_k: 800,
  rerank_top_n: 500, max_results: 100` — **not** `CITE_PRESET` (500/500/500/25).
  Comparisons across harnesses are therefore unsafe; comparisons within it are
  fine. Both P8 arms used it identically.
- `main.py:917` runs the diagnostic dense retrieval **outside** the sparse-only
  degradation guard at `main.py:244`, so a dense failure returns HTTP 500
  instead of degrading. This broke the first probe run of the session.

**Ingestion**
- `embed.py:258` deletes all of a document's chunks on every embed run, so any
  hand-written row is destroyed by the next re-ingest.
- `embed.py:272` binds `doc["language"]` for **every** node — there is no
  per-node language column value.
- `document_chunks.language` has **no readers** anywhere in `app/`, `src/` or
  `evaluation/`; its only appearance is that write.

**Presentation**
- Neither `language` nor `title_en` appears in `/query`'s response or the UI.
  `DocumentResult` is built purely from node metadata (`main.py:1133-1141`);
  `load_documents_metadata` (`pg_store.py:69-90`) selects only `external_id`
  and `source_metadata` and is not consulted in the result loop.

**Operational**
- `gpt-5-mini` exceeded a 3s request-path budget for a one-line translation.
  Production translation needs a faster model, a precomputed dictionary, or an
  off-path design. The failure-soft path behaved correctly: logged a warning and
  degraded to the untranslated query rather than failing the search.

---

## 6. The evaluation problem

Every intervention tried today was **un-evaluable for the same reason**, and
this is the session's most useful conclusion.

- The **bridge** could not show a win: the `en-body` control queries were
  authored to avoid title and abstract vocabulary, which makes them immune to a
  mechanism that indexes title and abstract text. The control worked so well it
  removed the signal. The root error was a category mistake — an
  anti-circularity control designed for *known-item* retrieval, applied to a
  mechanism whose value is *topical*.
- **Translation** shows a cost (P8) on an instrument that cannot see its benefit
  (P7), because the cite golden set has almost no non-English expected
  documents.

**No multilingual evaluation set exists.** `non-english-smoke.json` tests
non-English query → non-English document, which is not the usage pattern. Until
cost and benefit can be read off the *same* instrument, no cross-lingual
retrieval change can be justified or refuted.

Two defects found in the existing set while working on this: `nq-pt-02`'s sole
target (`_6821`) and `nq-es-01`'s `_2705` target are both `language='en'` on qa —
English-edition PDFs with Portuguese/Spanish titles, the same class as the
`3778`/`5852`/`2130` caveat the file already records. Both were authored in the
pypdf era when the extracted text still looked non-English.

---

## 7. Artifacts produced

- `evaluation/cross-lingual-en.json` — 27 queries covering all 29 non-English qa
  documents exactly once: 15 `en-tr` (translated smoke queries; **regression
  guard only**, circular against any mechanism that indexes `title_en`) and 12
  `en-body` (body-derived, with `source_chunk_index` and `source_evidence` for
  audit). **Needs human review before use as a gate** — authored by the same
  agent that formed the hypotheses.
- 12 broad topical queries with verified English competitors, authored for P6/P7
  but **not yet filed** into the eval set. Recorded in the session; should be
  added as an `en-topical` class.
- `search-service/app/query_translate.py` + `build_sparse_query` in
  `query_expansion.py` — sparse-lane translation behind
  `QUERY_TRANSLATION_ENABLED`, **default off**, byte-identical to prior
  behaviour when disabled. 10 tests; full suite 226 passed / 2 skipped.

---

## 8. Open questions

- **The multilingual eval set** — the blocking item. What queries, what labels,
  and how cost and benefit are read from one instrument.
- **Three-lane fusion** (dense + sparse-English + sparse-translated) — the
  design implication of §4, untested and unweighted.
- **The two real misses** — `_5028` and `_1319`. Floor, fusion, or candidate
  pool? The pedestrian-safety query returned only 12 documents after the floor,
  hinting at a floor cut for that one. Translation recovered `_5028`.
- **Production translation** — fast model vs precomputed dictionary vs off-path,
  given the >3s measurement.
- **The bridge** — parked, not refuted. Its simulation was specified but never
  built.
- **Corpus scale** — the rerank window (at least the first 50 distinct documents
  in fusion order) currently rescues everything fusion demotes. At 10× corpus
  that stops being true, which is the strongest forward-looking argument for
  doing anything here at all.
- **Interaction with other `/query` ideas** — further expansion and tuning are
  planned and touch the same sparse query path; they may conflict with a third
  lane.
- **Presentation** — `language` + `title_en` through `DocumentResult.metadata`.
  Cheap, contract-preserving, and the clearest user-facing defect found.
