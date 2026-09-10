# Kickoff: terminology grounding for answer-mode query translation

**Date:** 2026-09-10
**Workstream:** answer-eval improvement → bucket 2 (cross-lingual retrieval)
**Status:** mid-flight. The delivery mechanism is MERGED to `qa`, flag-dark
(`ANSWER_TRANSLATION_ENABLED=false`, PR #419, deployed at `f327f40`, verified
live and inert). This session's job: close the **terminology gap** — the one
measured step between the dark flag and turning it on.

**Process:** follow the superpowers process throughout — announce skill usage;
treat this document as the plan (executing-plans); brainstorm + write a design
doc only if you depart materially from §3; systematic-debugging when a probe
surprises you; verification-before-completion before any PR; stop and ask when
blocked, don't guess.

---

## 0. Read these first (in order)

| File | Why |
|---|---|
| `docs/plans/2026-09-09-answer-mode-query-translation-design.md` — especially **§7 (implementation status)** | THE contract: what shipped, what it measured, the exact named follow-up. Do not re-derive. |
| `CLAUDE.md` | Repo conventions, branch model (**all work lands via PR to `qa`; pushing/PRing `main` IS a production deploy — never do it**), env files, pinned python deps. |
| `docs/superpowers/plans/2026-09-09-answer-eval-improvement-kickoff.md` | The workstream kickoff: eval loop, metric semantics, failure taxonomy, guardrails. |
| `evaluation/README.md` | Scoring dimensions (evidence_coverage's denominators!), stage CLIs, selection modes. |
| The code: `search-service/app/main.py` (`build_answer_translation`, `_rerank_with_translation_bundles`, `_selection_languages`, the answer-branch wiring after the `cite_doc_ids` filter), `app/query_translate.py` (`translate_query_orjoined`, `_ANSWER_SYSTEM`), `app/pg_store.py` (`dense_retrieve_doc_scoped`), `app/bedrock_rerank.py` (`score_documents`, `max_merge`), `search-service/tests/test_answer_translation.py` | The mechanism you are extending. Tests are factory-injected — follow the patterns. |
| `evaluation/baselines/2026-09-09-answer-noselection-*.json` + the `*-compare.md` files | Every number this workstream has measured so far. |

## 1. The problem, in one table

The answer-eval baseline's dominant failure (85% of missed expected passages
never enter the 15-chunk list) is cross-lingual: English questions don't rank
zh/es fact chunks. The shipped mechanism (translate → doc-scoped dense seed →
dual-query max-merge rerank) works end-to-end but the **machine translations
score the evidence 0.70–0.79 while the English-lane winners hold 0.81–0.91** —
merged ranks ~16–40, outside the 15. Rerank-isolation probe, q3's five expected
chunks (direct Cohere Rerank 3.5 calls, same candidates):

| chunk | EN question | zh machine translation | zh corpus-terminology (hand oracle) |
|---|---|---|---|
| fact_25 | 0.718 | 0.749 | **0.947** |
| fact_27 | 0.466 | 0.654 | **0.926** |
| fact_29 | 0.624 | 0.610 | **0.900** |
| fact_30 | 0.461 | 0.548 | **0.895** |
| fact_209 | 0.108 | 0.198 | **0.828** |

The oracle's edge is vocabulary: it says **新能源重卡** (the corpus's term for
the vehicle class) and **市场渗透率** where the translator says 零排放卡车 and
采用潜力. Terminology is what Cohere rewards. Mirror probes with machine
translations: q3 0/5, q4 0/4, q5 0/3, q7 0/2 expected chunks in the final 15.

## 2. Already tried — do not re-run

| translation approach | fact-chunk scores | verdict |
|---|---|---|
| faithful single rendering (shipped `_ANSWER_SYSTEM` v0) | 0.55–0.75 | short |
| "domain-aware" prompt ("as a researcher would phrase it") | top 0.8 | short |
| two renderings (literal + field-terminology) OR-joined (shipped) | 0.70–0.79 | short |

All leave the evidence below the ~0.81 cut. The missing ingredient is
**grounding the translation in the corpus's own vocabulary** — which the
translator cannot know from the question alone.

## 3. The candidate approaches (verify, don't assume)

1. **Vocabulary-grounded second pass (recommended first).** The doc-scoped
   dense seed (already retrieved at translation time, `seed_k=200` selection
   chunks under the literal translation) is sitting there — extract its
   high-frequency native-language terms (zh/es n-grams; the chunks carry the
   documents' real terminology), then re-translate with them as hints:
   "the corpus refers to these concepts as: … — render the question in the
   field's terminology". One extra LLM call, reusing text already in hand.
2. **Native-title/keyword hints** from `documents_metadata` (note: zh docs'
   catalog titles are English; check `source_metadata` for native fields
   before assuming they exist).
3. **Curated multilingual alias table** — the `DOMAIN_EXPANSIONS` precedent in
   `query_expansion.py`; stable but slow to iterate, and hand-curated lists are
   the LVC-maintenance shape. Fallback, not first.
4. Multilingual sparse / jieba segmentation — rejected scope (big, changes the
   sparse contract).

**The guardrail that separates grounding from test-tuning:** terminology may be
derived from **the selected documents / the corpus only** — never from the
evalset fixtures (`key_facts`, `canonical_answer`, `text_snippet`s). A prompt
that hard-codes the evalset's facts or their angles is tuning to the test and
will be rejected in review. (The hand oracle in §1 included a payback-period
angle lifted from the key facts — that part was diagnostic only, not a
legitimate prompt; do not reproduce it. The vocabulary itself — sourced from
the documents — is legitimate.)

## 4. The measurement loop (cheap → expensive — stay left as long as possible)

1. **Isolation probe (~$0.004, minutes).** No service needed: pull the
   expected chunks' texts from the QA RDS (`document_chunks`, join `documents`
   on `external_id`; creds from the QA ECS task def the same way
   `scripts/with-remote-env.sh` gets them), call `bedrock-agent-runtime`
   `rerank` directly (`cohere.rerank-v3-5:0`, us-east-1, explicit endpoint,
   `numberOfResults=len(sources)`), and score the chunks under a candidate
   translation. This is the fast iteration instrument — gate every prompt
   change here before anything else. Validate your instrument first by
   reproducing §1's table.
2. **Mirror probe (~$0.013/query, minutes).** Local search-service against the
   QA RDS, flag on:
   - DATABASE_URL from the QA task def + `?sslmode=require`;
     `RETRIEVAL_BACKEND=postgres KEYWORD_BACKEND=sparse RERANK_CANDIDATES=100
     ANSWER_TRANSLATION_ENABLED=true ENVIRONMENT=local-qa-rds-mirror`
   - **Hold `search-service/.env.local` aside first** (`mv` it out, restore
     after): its MinIO AWS keys shadow the real SSO credentials in boto3 and
     break Bedrock — this has bitten two sessions in a row.
   - The query path is read-only by construction; keep it that way.
   - Send the case's question + `cite_doc_ids` (the selection per case is
     recorded in `evaluation/answer/artifacts/capture-baseline-noselection-20260909.json`,
     `passes[0].selected_doc_ids`). Success = expected chunks in the final 15
     AND the EN-twin chunks retained (max-merge should keep both; losing the
     twin is a regression, not a win).
3. **Direct-mode eval A/B (real numbers).** Local mirror as the search target
   + local Next app:
   `npx next dev -p 3100` (**:3000 is another project — don't touch it**), then
   ```
   npm run eval:answer-capture -- evaluation/eval-review/evalsets/evalset_answer_02.json \
     --selection-mode no-selection --passes N \
     --direct-search http://localhost:8000 --direct-answer http://localhost:3100 \
     --label <what>-<yyyymmdd>
   ```
   Both arms identical knobs (default 8×400 is fine — the arms only need to
   match each other). Judge `--judge-model glm-5.3 --judge-thinking max`
   (stability is a guardrail; never vary it mid-comparison). Compare with
   `npm run eval:answer-compare`. Known harness quirk: `unsupported_claims`
   judge items time out (fixed 300 s) on 15×800 prompts → tombstones, excluded
   from means — don't chase them.
4. **Gateway confirmation (only if 1–3 all win).** Flag flip on QA is an ECS
   env change (separate PR + deploy), then a fresh no-selection run per the
   two-step spec §10.4, plus `npm run eval:cite` as the shared-code regression
   guard (the reranker refactor is shared; flag-off must be a no-op there).

## 5. Guardrails

- **Branch model:** PR to `qa` only. Never `main`.
- **The flag stays dark until** probes put the majority of measurable cases'
  expected chunks in the final 15 (twin retained), AND the direct A/B moves
  evidence_coverage / chunk_id_hit_rate / fact_recall_strict without
  regressing citation_precision or unsupported rate, AND the gateway
  confirmation + cite guard pass. Activation is then a proposal to the owner
  with the numbers — not a unilateral flip.
- **Judge stability:** glm-5.3 @ max for every comparison.
- **No evalset-derived terminology** (§3).
- **Costs:** probe $0.004; mirror query $0.013 (flag on); capture ≈
  $0.002/case; judge ≈ 150k tokens per 16-case pass. Fine to iterate; don't
  burn ≥3 passes without a hypothesis.
- **16 cases is small:** N=3 before believing a delta; never chase
  single-case swings (q6's strict −0.333 was one judge call).
- Local full-suite note: 6 DB-gated tests fail in a local checkout with
  `search-service/.env.local` present (stub-reranker/AWS-key artifacts) —
  byte-identical on clean `qa`; don't panic, don't fix, CI is the truth.

## 6. Suggested first session

1. Read §0. Announce the executing-plans skill; review this plan critically
   and raise concerns before starting.
2. Rebuild the isolation-probe script (§4.1) and reproduce §1's table — the
   instrument must match the recorded numbers before it can measure anything
   new.
3. Implement vocabulary grounding v1 (§3.1): extract the seed chunks' native
   terms → re-translate with them. Unit tests per
   `tests/test_answer_translation.py` patterns (factory-injected, no live
   calls).
4. Probe q3/q4/q5/q7 (expected chunks 5/4/3/2). Gate to continue: ≥ half the
   expected chunks in the final 15 with the twin retained. If a prompt variant
   fails the probe, iterate at the probe level — do not spend eval runs on it.
5. If gated through: direct A/B, 1-pass first read, N=3 if it moves.
6. PR to `qa` (flag stays dark unless the full §5 chain is green).
   verification-before-completion, then finishing-a-development-branch.

## 7. Reference index

- **PRs:** #412 (harness + first baseline), #413 (max_passages=15), #417/#418
  (passage_chars=800 + matched N=3 reference: strict 0.103→0.151), #419 (the
  mechanism, flag-dark). `qa` HEAD after all: `f327f40`.
- **Baselines (committed):** `evaluation/baselines/2026-09-09-answer-noselection-{qa,maxpass15-qa,pchars800-3pass-qa,maxpass15-3pass-qa}.json` + compare MDs.
- **Raw artifacts (gitignored):** `evaluation/answer/artifacts/{capture,judged,report}-{baseline,maxpass15,pchars800-3pass,maxpass15-3pass}-noselection-20260909.json`
- **Evalset:** `evaluation/eval-review/evalsets/evalset_answer_02.json` @ `1dcbeab` (16 cases; q11–q16 have no expected passages — 26 `facts_no_passage`, fixture work is a separate track).
- **Verified 2026-09-10:** QA deployed with #419, flag dark (live answer query shows no `query_translation` in `usage.calls`, chunk order byte-identical to baseline), response shape unchanged (chunk ids in `kps[0].passage_id`).
- **Corpus note:** QA RDS at 206 docs vs 201 at baseline time; per-case diagnostics tolerate this.
