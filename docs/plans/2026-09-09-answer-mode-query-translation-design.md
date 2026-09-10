# Answer-Mode Query Translation — Design (2026-09-09)

**Status:** design complete, implementation to follow. Flag-dark: default OFF.
**Scope:** answer mode only (`mode: 'answer'` + `cite_doc_ids`). Cite mode is untouched.
**Companions:** `docs/research/2026-07-24-cross-lingual-findings.md` (P5–P8),
`docs/plans/2026-07-24-cross-lingual-retrieval-design.md` (the summary_en bridge — a
different problem, still unshipped), the 2026-09-09 answer-eval baselines
(`evaluation/baselines/2026-09-09-answer-noselection-*.json`).

## 1. Problem, with this session's evidence

The answer-eval baseline's dominant failure (85% of missed expected passages never
enter the 15-chunk list) is cross-lingual: an English question does not rank zh/es
fact-bearing chunks, even when the expected document is safely inside the selection
(`expected_doc_in_selection` = 16/16).

Three probes (2026-09-09, local search-service mirrored read-only against the QA RDS —
the 07-24 rig):

1. **Where the evidence loses.** q3's five expected zh chunks sit at dense ranks
   190–460 and fused ranks 255–363 (lanes/window wide open). The chunks that win from
   the same zh document are its *English executive-summary section* — which paraphrases
   the findings without the numbers. That is exactly why the eval scores lenient 1.0 /
   strict 0 on q3: partials from the English summary, specifics never delivered.
2. **The reranker is the wall, and it is reversible.** Rerank-isolation probe (same
   candidate set, direct Cohere Rerank 3.5 calls): expected zh fact chunks score
   **0.108–0.718 under the English question** vs **0.828–0.947 under a Chinese
   translation of it** — the top of the entire candidate set under zh, while the
   English twin's chunks drop from 0.82–0.91 to 0.47–0.73. Widening the candidate
   pipeline alone (candidates 100→400) was already probed and does nothing: Cohere
   sees the evidence and buries it, because the query is English.
3. **End-to-end confirmation.** The zh question through the real answer pipeline
   (same selection): dense ranks 190–460 → **6–84**; a fact chunk reaches final rank 1
   (Cohere 1.00). The trade-off is real: with a zh-only query the English twin leaves
   the 15 (0.47–0.73) — the fix must carry **both** queries, not swap.

## 2. Prior art and why this shape

The 2026-07-24 findings measured query translation on cite mode: oracle translations
moved BM25 rank 93→1 (10/10 known-item pairs, P5), but translations in the shared
sparse query regressed cite recall 83.3→76.5 (P8) — RRF scores by *rank*, so translated
terms push English chunks down the one sparse ranking (findings §4). The recorded
direction was "a separate translated RRF lane."

Answer mode changes the safety calculus and the mechanism:

- **The selection bounds the blast radius.** Translated retrieval can only promote
  chunks of documents the user already selected (`cite_doc_ids` filter after fusion).
  Cite mode has no such filter — which is why it regressed.
- **Fusion rank is the wrong carrier anyway.** With the answer expansion weight at 0.25
  (and base lanes doubling when any extra lane exists), a translated RRF lane at any
  sane weight leaves zh fact chunks below the top-100 fused cut — the same
  rank-not-membership collapse the findings describe. The reranker, not fusion, decides
  the 15; the evidence should go straight to it.
- **The reranker needs the translated query too.** Probe 2: the fact chunks' Cohere
  scores under EN vs zh differ by 0.3–0.7. Fixing fusion without fixing the rerank query
  would still bury them (that is precisely what the candidates-400 falsification showed).

So: **translated dense retrieval as a candidate seed, plus a dual-query max-merge
rerank.** No RRF lane, no fusion change, no corpus mutation.

## 3. Design

When `mode == 'answer'` AND `cite_doc_ids` present AND rerank on AND the flag on:

1. **Detect the selection's languages.** Distinct `language` of the `cite_doc_ids`
   documents from the startup-hydrated `service_state["documents_metadata"]` (already
   carries `language` — `pg_store.load_documents_metadata:84`). Drop `'en'` and
   unknowns; cap at `answer_translation_max_langs` (default 2).
2. **Translate once per language.** Existing `query_translate.translate_query`
   (one OpenAI call covering all languages, LRU-cached, hard-timeout, failure-soft —
   a translation outage degrades to today's behavior, never fails the search).
3. **Seed candidates from translated dense retrieval.** Per language: one
   `make_dense_retriever(k).retrieve(QueryBundle(translated))` (cohere-embed-v4, the
   same lane the e2e probe validated), filtered to `cite_doc_ids`, top
   `answer_translation_seed_k` (default 20), deduped against the standard candidates
   (`_select_candidates` output). The seed UNIONs with the standard candidates —
   nothing is displaced (the 07-24 §5.5a lesson).
4. **Dual-query max-merge rerank.** Score the full candidate set once per query
   (original English + each translation), take each chunk's **max** score, sort, cut at
   `rerank_top_n` as today. Max-merge is "or" semantics: zh fact chunks ride their zh
   score (0.83–0.95), the English twin rides its EN score (0.82–0.91), both coexist in
   the 15. Stage 2.1 page-1 demotion applies to the merged list unchanged.

**Config (all default-off / inert):**

| flag | default | meaning |
|---|---|---|
| `answer_translation_enabled` | `False` | master switch; off ⇒ byte-identical behavior |
| `answer_translation_max_langs` | `2` | cap distinct non-EN languages handled per query |
| `answer_translation_seed_k` | `20` | per-language dense seed size into the rerank candidates |

**Cost/latency (per answer query, flag on, one language):** one cached translation call
(gpt-5-mini, ~$0.0002), one query embed + dense retrieval (~0.2 s), one extra rerank
call (~0.5 s, +$0.002; candidate count 100+K may bill a second query — recorded in
`usage.calls` via the existing meter). Answer mode already runs multi-second with
synthesis; acceptable, and visible in the eval's cost block.

**Failure modes:** translation timeout/error ⇒ no seed, no extra rerank query, standard
path (existing `translate_query` soft-failure posture). Seed retrieval error ⇒ same.
No new hard dependencies in the request path.

## 4. Tests (TDD)

`search-service/tests/test_answer_translation.py` — pure/factory-injected, no live calls:

1. Language detection: selection languages from injected metadata; `'en'` dropped;
   cap applied; empty when flag off.
2. Seed construction: filtered to `cite_doc_ids`, top-K per language, deduped against
   standard candidates.
3. `BedrockReranker.score_candidates` (new pure scoring method that
   `postprocess_nodes` refactors onto): per-node scores from a fake client, no mutation.
4. Max-merge: two score maps → per-node max → sorted → `rerank_top_n` cut; ties stable.
5. Flag-off byte-identity: the answer branch with the flag off produces the same
   candidate list and rerank call sequence as before (regression guard).
6. Translation failure: `translate_query` raising ⇒ standard path, no seed, single
   rerank call.

## 5. Validation plan

1. **Mirror probes** (local service + QA RDS, flag on via env): q3/q4 — the expected
   zh chunks must appear in the final 15 with competitive scores; the twin must remain.
2. **Direct-mode eval A/B** (the harness's `--direct-*` loop): 1-pass first read, then
   N=3 if it moves — `direct-baseline` (flag off) vs `direct-translation` (flag on),
   both no-selection, compare. Watch evidence_coverage (zh snippets now reachable),
   chunk_id_hit_rate, fact recall, and unsupported/precision for regressions.
3. **Cite regression guard** (`npm run eval:cite`): the code touches the shared reranker
   class refactor — flag-off must be a no-op there, and the guard proves it.
4. **Gateway confirmation**: only after a PR merges and the flag is flipped on QA
   (env change, per the two-step spec §10.4 — any default change needs a fresh
   no-selection run before shipping).

## 6. Out of scope

- Cite-mode translation (the P8 regression shape; revisit only with its own eval).
- Translated sparse/BM25 lanes (zh needs segmentation; es/pt would work — the
  07-24 P5 evidence — but dense + rerank carry the case; sparse can follow if es
  cases plateau).
- The summary_en bridge (07-24 design, cite-mode doc reachability; still gated on
  its simulation).
- Corpus mutation of any kind.

---

## 7. Implementation status (2026-09-09, same session)

**Landed flag-dark; do not activate yet.** Pieces:

- `config.py`: `answer_translation_enabled` (False), `answer_translation_max_langs` (2),
  `answer_translation_seed_k` (200), `answer_translation_timeout_s` (8.0 — the sparse
  lane's 3 s cite budget was measured too tight for a gpt-5-mini zh translation).
- `pg_store.dense_retrieve_doc_scoped`: doc-scoped dense seed (the answer-mode universe
  is the selection; scoping at the SQL level keeps the seed's k counting only selected
  docs).
- `bedrock_rerank.score_documents` + pure `max_merge`; `postprocess_nodes` refactored
  onto them (un-returned candidates now default to 0.0 rather than keeping fused
  scores — aligns with the module's never-mix-scales invariant; Cohere returns all
  requested results in practice).
- `query_translate.translate_query_orjoined`: two renderings per language (literal +
  field-terminology), OR-joined into one rerank query — measured 2026-09-09: a single
  faithful rendering leaves the terminology to a coin flip (零排放卡车 vs the corpus's
  新能源重卡), and terminology is what Cohere rewards.
- `main.build_answer_translation` + wiring in the answer branch; 14 new tests
  (365 python tests green).

**Measured state (mirror probes, read-only against the QA RDS):** the mechanism works
end-to-end — translation fires, the doc-scoped seed delivers 200 selection chunks, the
dual-query max-merge applies (verified with in-service instrumentation: the zh map's
top scores land in the merged list, e.g. zh 0.806 → merged rank 13). But with current
machine translations the expected zh chunks score **0.70–0.79 under the translated
query** while the English-lane winners hold 0.81–0.91 — merged ranks ~16–40, outside
the 15. Probes: q3 0/5, q4 0/4, q5 0/3, q7 0/2 expected chunks in the final 15.

The gap is terminology, measured directly: the corpus's own term for the subject
(新能源重卡, hand-verified) scores the same chunks **0.81–0.95**; every machine rendering
tried (faithful, domain-prompted, two-variant or-joined) lands 0.55–0.79. The
15-slot cut sits exactly between them.

**The follow-up that unlocks activation:** terminology grounding — anchor the
translation in the selection's own vocabulary (second-pass re-translation fed the
target docs' frequent native terms, or native-title/keyword hints in the prompt).
Then re-probe; expect the hand-translation arm's 0.83–0.95. The direct-mode eval
A/B is not worth running until then (no case crosses; it would measure noise).

**Cost when on (one language):** one cached gpt-5-mini call + one extra query embed +
two rerank calls over 100+seed candidates — measured $0.013/answer query (6.5× the
$0.002 baseline answer query; the usage meter records every call). A cost-trim option
if it ever matters: score the EN query over the standard candidates only and the
translated query over the seeds only (the max-merge loses almost nothing — measured:
seeds' EN scores and standards' zh scores are both dominated).

**Validation log:** mirror probes above (design §5.1 done, negative); §5.2–5.4 pending
the terminology work.
