# Answer Eval Harness (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the answer-eval measurement instrument: a fetch-hang-proof runner with stages capture → judge → score → compare under `evaluation/answer/`, an LLM judge reusing the app's provider client, and the gen-1 answer-eval deletion — one PR against `qa`.

**Architecture:** The harness lives in `evaluation/answer/` (TypeScript, run with `tsx`, tested with Jest against fake servers only). Each stage reads the previous stage's artifact file and writes its own, so heavy runs are replayable and scorer changes re-run only `score`. The judge wraps the app's single OpenAI-compatible client (`src/lib/llm/chat-completions.ts`) so provider resolution (env-configured base URLs, key selection) has exactly one implementation. The capture layer consumes the **shipped** PR-1 contract: `synthesis.sentences: string[]` parallel to `synthesis.cites: number[][]`, `passages_sent`, `debug.knobs`, `debug.invalid_cites`.

**Tech Stack:** TypeScript + `tsx` CLIs, Jest (`@jest-environment node` for all harness tests — no jsdom), no new dependencies (undici stays Node's builtin; no zod — hand-rolled validators), Prettier + ESLint 9.

**Spec:** `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md` §3 (harness), §4 (judge), §3.6 (fetch hang), §6 (tests), plus the gen-1 deletion list in §3's opening paragraph. §5.1's example is reconciled to the shipped shape in Task 1.

## Global Constraints

- **One shell command per Bash call** — no `&&`, `;`, pipes, env prefixes, or `2>/dev/null`. Use `git -C <worktree>`, `npm --prefix <worktree>`.
- **No Co-Authored-By trailers** in commits. Targeted edits, not rewrites; read a file before editing it. No features beyond this plan.
- **No live model/service calls from tests** — mock fetch / local fake `http.Server`s everywhere. Tests never hit `qa.askwri-app.org`, lunaroute, or OpenAI.
- **Nothing new runs in CI.** The harness is an on-demand tuning instrument; pr-check.yml is untouched.
- **Out of scope:** search-service changes, the eval-review submodule (no fixture edits, no pin bump — PR 3), retrieval tuning, answer synthesis prompts, the `/query` request/response contract, `run-evalset.ts` and `run-cite-eval.ts` (cite-mode eval stays byte-identical).
- **PR-1 leftovers report-only** (no independent SYS_V2 digest pin, the 49 pre-existing tsc errors in 8 old test files, the 8 npm audit vulns).
- Gates before the PR: `npm test`, `npm run lint`, `npm run format:check`, `npx tsc --noEmit` (gate = zero NEW errors; `evaluation/` is excluded from tsconfig so harness code must stay jest-clean and lint-clean).
- Env names: reuse `LUNAROUTE_BASE_URL` / `LUNAROUTE_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `EVAL_TARGET`. **No new env names.** Judge default model: `glm-5.2-vision` (flag-overridable, `--judge-model` / `--judge-base-url`).
- Jest: every harness test file starts with `/** @jest-environment node */`. ESLint lints `evaluation/answer/**` (do not add ignores for it); Prettier ignores `evaluation/**/*.json`.
- Work happens in worktree `.claude/worktrees/answer-eval-pr2` on branch `worktree-answer-eval-pr2` (from `origin/qa` @ 46d9ddc). Never `cd` to the main checkout.
- Artifacts land in `evaluation/answer/artifacts/` (gitignored, prettier-ignored via the JSON rule). Fixture ground truth comes only from `evaluation/eval-review/evalsets/` (submodule, read-only for this PR).

---

## Pre-made rulings (recorded; cost-if-wrong noted)

1. **`score` signature is `(fixture, capture, judged) → report`**, not the spec's literal `(fixture, judged)`. The spec's parenthetical means "pure, no API calls" — scoring needs the retrieved chunk lists, which live in the capture artifact. *Cost if wrong:* none functional; a spec-literal signature would force judged artifacts to duplicate capture data.
2. **§4.5 `--judge-only` is realized as composition:** `run-judge` on a stored capture already judges at zero synthesis cost; agreement between two judge models is `run-compare --judged <a> <b>`. No separate mode flag. *Cost if wrong:* a missing `--judge-only` flag someone looks for; documented in README.
3. **Submodule pin bump (spec §8 item 9) is deferred to PR 3** per program tasking — PR 2 must not touch `evaluation/eval-review`. *Cost if wrong:* the first real run needs the PR-3 pin before the new fixture fields appear; harness code treats them as optional today.
4. **A sentence with zero cites is excluded from the citation-precision denominator** and is instead covered by the unsupported-claims call (it has no cited passages to judge support against). *Cost if wrong:* citation precision shifts by a constant factor; visible in the report's denominators.
5. **Prompt/allowlist provenance imports route modules under tsx** (`SYS_V1`, `SYS_V2`, `FORWARDABLE_FIELDS` from `src/app/api/*/route.ts`). If importing `next/server`-touching modules under tsx proves fragile, fall back to recording the git blob SHA of each route file + `debug.knobs.prompt_version`. *Cost if wrong:* provenance is coarser (file SHA vs prompt hash), never wrong.
6. **Judge timeout wraps `chatCompletion` with `Promise.race`** rather than adding a signal parameter to `src/lib/llm/chat-completions.ts` — PR 2 changes no app-tier code. A timed-out judge item records `unjudged`. *Cost if wrong:* the underlying fetch is not aborted (socket lingers); acceptable at concurrency 1.
7. **`unjudged` items are excluded from every mean and counted in a separate block** — never scored as zero (spec §4.3), and likewise for retrieval errors per run-evalset's precedent.
8. **Cost accounting:** capture sums the gateway's `usage.total_usd` (the answer route reports no usage); judge accumulates provider `usage` token counts when present. Lunaroute $/token is unmeasured (spec §8 item 10) — tokens are recorded, not converted. *Cost if wrong:* budget estimates lack judge dollars; flagged in every report header.

---

## File map

| File | Responsibility |
|---|---|
| Create `evaluation/answer/types.ts` | All artifact + fixture interfaces (`Evalset`, `FixtureCase`, `CaptureArtifact`, `JudgedArtifact`, `Report`, …). |
| Create `evaluation/answer/normalize.ts` | `normalize()` mirroring `eval-review/scripts/lookup_chunk_id.py`; `snippetContained()`; `langOf()`. |
| Create `evaluation/answer/http.ts` | `fetchJson()` — timeout-wrapped fetch carrying the §3.6 spike conclusion (timeout covers dispatch **and** body read; retry-once on timeout). |
| Create `evaluation/answer/fixture.ts` | `loadEvalset()` + structural validation (required fields, twins well-formed, key facts present when scored). |
| Create `evaluation/answer/target.ts` | `TargetClient` interface + `gatewayTarget()` (`/api/llamaindex` + `/api/answer`) + `directTarget()` (search-service `/query` + local `/api/answer`), health snapshot, catalog ids. |
| Create `evaluation/answer/preflight.ts` | Target validation (catalog ids, snippet containment via `cite_doc_ids`, twins), provider probes, approved/draft counts, call-count estimate. |
| Create `evaluation/answer/capture.ts` | Capture stage core: per case per pass retrieval + synthesis, provenance assembly, cost accumulation. |
| Create `evaluation/answer/judge-prompts.ts` | The three judge prompts, their JSON validators, and sha256 prompt hashes. |
| Create `evaluation/answer/judge-client.ts` | `judgeCall()` — temp 0, schema validation, retry-once with error appended, `unjudged` on second failure, 429 backoff (max 5), 401 abort, race-timeout. |
| Create `evaluation/answer/judge.ts` | Judge stage core: item enumeration `(case, pass, item)`, resumable judged artifact. |
| Create `evaluation/answer/score.ts` | Pure `score(fixture, capture, judged) → report` — §2.2 + §2.3 metrics, deterministic byte-identical output. |
| Create `evaluation/answer/compare.ts` | Report comparison (guarded), judged-agreement mode, pairwise mode. |
| Create `evaluation/answer/cli.ts` | Shared control parsing: `--only/--limit/--passes/--label/--concurrency/--target/--knob/--direct-search/--direct-answer/--judge-model/--judge-base-url` + knob routing. |
| Create `evaluation/answer/run-capture.ts` … `run-judge.ts`, `run-score.ts`, `run-compare.ts` | Thin stage CLIs (npm-script entry points). |
| Create `evaluation/answer/__tests__/*.test.ts` | §6 test battery (10 files; all `@jest-environment node`). |
| Modify `package.json` | Add `eval:answer-capture` / `eval:answer-judge` / `eval:answer-score` / `eval:answer-compare`; delete the gen-1 `eval:answer-*`, `eval:golden-*`, `eval:synthesis-*`, `eval:upload`, `eval:download` scripts (Task 10). |
| Modify `.gitignore` | Ignore `evaluation/answer/artifacts/`. |
| Modify `evaluation/README.md` | Document the new stages; delete gen-1 sections (Task 10). |
| Modify `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md` | §5.1 example reconciled to the shipped shape (Task 1). |
| Delete (Task 10) | 16 gen-1 scripts, 8 gen-1 data files, 7 `/api/eval/*` routes (see Task 10 list). |

---

## Task 1: Spec §5.1 reconciliation (FIRST ACTION)

**Files:** Modify `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md`.

**Why first:** PR 2's capture layer is where the spec's stale example becomes expensive. The spec's §5.1 output-schema bullet shows `{"sentences":[{"text":"...","cites":[1,3]}], ...}` — that is the *model-facing* prompt schema, not what the route returns. The shipped response nests under `synthesis` and splits into parallel arrays.

- [ ] **Step 1:** In §5.1, replace the output-schema bullet's literal example with the shipped shape:

  ```
  - Output schema (route response):
    {"ok":true,"synthesis":{"sentences":["s1","s2"],"cites":[[1,3],[2]],"source_relevance":[…],"warning?":"low_coverage"},"passages_sent":[{"id":1,"doc_id":"…","chunk_id":"…","page":7,"text":"… as sent"}],"debug":{"knobs":{…},"invalid_cites":0,…}}.
    `synthesis.sentences` is `string[]`; `synthesis.cites` is the parallel `number[][]` (same length, present on every path including fallbacks and exceptions). Passage ids are the 1-based indices of `passages_sent` (renumbered after the nano filter). Invalid ids are dropped server-side and counted in `debug.invalid_cites`.
  ```

  Keep the rest of §5.1 (knobs, `passages_sent` bullet, `debug` echo) — they already match the shipped shape. Do not touch other sections.
- [ ] **Step 2:** Commit: `docs(spec): reconcile §5.1 output schema with shipped parallel-array shape`.

No tests (docs-only). The PR description also states the reconciliation explicitly.

---

## Task 2: Fetch-hang spike (§3.6) + `http.ts`

**Files:**
- Create: `evaluation/answer/http.ts`, `evaluation/answer/__tests__/http.test.ts`
- Scratch (not committed): reproduction scripts under `/tmp` or `evaluation/answer/spike/` (gitignored via artifacts rule if needed — prefer /tmp).

**Context:** `run-evalset.ts` already passes `AbortSignal.timeout(120_000)` to every fetch, yet the documented behavior (spec §1 table; `eval-minimal.ts` header, 2026-08-25) is a hang against a local Next dev server, worked around with per-request `curl`. The spike must reproduce, diagnose, and conclude — not guess.

- [ ] **Step 1: Reproduce.** In the worktree, start a stub upstream (a ~20-line `node` http server returning canned `{ok, docs: []}` JSON for POST /query), then `next dev` with `SEARCH_SERVICE_URL` pointing at the stub (one command per Bash call; run servers with `nohup … &` style single commands or separate terminals — record exact commands). Then run a loop script that POSTs `{query, mode:'answer'}` to `http://127.0.0.1:3000/api/llamaindex` sequentially with Node's global `fetch`, exactly as `run-evalset.ts` does (same headers, same `AbortSignal.timeout(120_000)`), logging request start/end timestamps. Run enough iterations (≥ 200 or until a stall > 60s). Record: Node version (`node --version`), whether the hang reproduces, and where it stalls.
- [ ] **Step 2: Diagnose.** Instrument the repro script with a watchdog: a `setInterval` that, whenever a request is older than 30s, logs `process.getActiveResourcesInfo()` and the pending request's age — this shows whether the fetch is stuck on a socket, an undici pool queue, or never dispatched. Secondary tools if needed: `kill -USR1 <pid>` starts the inspector (works on macOS; `SIGQUIT` does not dump JS stacks there); `NODE_DEBUG=http,net` for transport-level logs. Distinguish hypotheses: (a) undici keep-alive pool reusing a socket the dev server half-closed (HMR/compile restarts) so the request never dispatches; (b) response body read hanging past headers (signal not covering `res.json()`); (c) dev-server on-demand compile exceeding all timeouts; (d) something else the watchdog shows. The conclusion must name the mechanism, not just the symptom.
- [ ] **Step 3: Choose mitigation.** Prefer the **package-free** fix: per-request total timeout (dispatch + headers + full body read under one `AbortSignal.timeout`) plus one retry on timeout/network error. If the watchdog shows dead-socket pool reuse that the signal cannot preempt, an explicit undici `Agent` is acceptable — Node does not expose its bundled undici, so this means adding `undici` as an explicit devDependency (the spec's "explicit timeouts with undici" contemplates exactly this); do not rely on a transitive copy. The chosen mitigation is what `http.ts` implements.
- [ ] **Step 4: Write the failing test.** `evaluation/answer/__tests__/http.test.ts` (node docblock): start a local `http.Server` that accepts the request and **never responds**; `fetchJson(url, { timeoutMs: 300 })` must reject (or return a timeout error result) within ~2s wall time — assert the promise settles and the elapsed time is bounded, not that Jest times out. Second test: a server that sends headers then stalls mid-body — same assertion. Third: retry-once — a server that fails the first request with a socket error and succeeds the second; assert 2 attempts and success. Fourth: non-JSON body → error carrying status and text.
- [ ] **Step 5: Run to verify it fails** (`npx jest evaluation/answer/__tests__/http.test.ts` — module not found).
- [ ] **Step 6: Implement `http.ts`:**

  ```ts
  /** fetchJson — the harness's only HTTP primitive.
   *
   * SPIKE CONCLUSION (§3.6, <date>): <one-paragraph cause + chosen mitigation,
   * with the reproduction commands and Node version>. …
   */
  export interface FetchJsonResult { status: number; ok: boolean; text: string; json: any; wallMs: number }
  export async function fetchJson(
    url: string,
    opts: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {},
  ): Promise<FetchJsonResult>
  ```

  Defaults: `timeoutMs = 120_000`, `retries = 1`. Read the body with `res.text()` **inside** the signal's coverage. Throw a typed `HttpTimeoutError` on final timeout. The docstring carries the full spike conclusion (cause, evidence, mitigation, repro commands) — this is the deliverable the spec asks to "ship with the conclusion".
- [ ] **Step 7:** Verify the test passes. Commit: `feat(eval): fetch-hang spike — timeout-wrapped http client (conclusion in http.ts docstring)`.

---

## Task 3: `normalize.ts`, `types.ts`, `fixture.ts`

**Files:** Create `evaluation/answer/normalize.ts`, `evaluation/answer/types.ts`, `evaluation/answer/fixture.ts`, `evaluation/answer/__tests__/normalize.test.ts`, `evaluation/answer/__tests__/fixture.test.ts`.

**Contracts:**

- `normalize.ts` — a faithful TS mirror of `lookup_chunk_id.py`'s `normalize()`: strip markdown emphasis chars `*_#\``, fold full-width `，。：；！？（）【】""''—` → `,.:;!?()[]""''-`, collapse whitespace runs (incl. newlines) to one space, drop whitespace immediately around punctuation `.,:;!?()[]"'-`, trim, lowercase. Then:

  ```ts
  export function normalize(text: string): string
  /** normalize(snippet) is a substring of normalize(chunkText). */
  export function snippetContained(snippet: string, chunkText: string): boolean
  /** 'zh' when the text contains CJK codepoints, else 'latin'. */
  export function langOf(text: string): 'zh' | 'latin'
  ```

- `types.ts` — the fixture and artifact interfaces:

  ```ts
  export interface ExpectedPassage { doc_id: string; chunk_id: string; page?: number; text_snippet: string; text_snippet_translation_en?: string; supports_key_fact?: string }
  export interface FixtureCase {
    id: string; question: string; query_type?: string; difficulty?: string; source_language?: string; note?: string
    retrieval_ground_truth?: { expected_external_ids?: string[]; expected_document_ids?: string[]; expected_passages?: ExpectedPassage[] }
    synthesis_ground_truth?: { canonical_answer?: string; key_facts?: string[] }
    review_status?: 'draft' | 'expert_approved' | 'rejected'   // absent = draft
  }
  export interface Evalset { name: string; version?: string; test_cases: FixtureCase[]; twins?: [string, string][] }
  export interface RetrievedChunk { rank: number; doc_id: string; chunk_id: string | null; text: string; score?: number }
  export interface PassageSent { id: number; doc_id: string; chunk_id: string; page: number; text: string }
  export interface PassCapture {
    pass: number
    retrieval: { chunks: RetrievedChunk[]; likely_off_topic: boolean; service_ms: number | null; cost_usd: number | null; wall_ms: number; error?: string }
    answer: {
      knobs: Record<string, unknown>; passages_sent: PassageSent[]; sentences: string[]; cites: number[][]
      raw_model_json: string; source_relevance?: Array<{ doc_id: string; tier: string }>; warning?: string
      low_coverage: boolean; invalid_cites: number; fallback_reason?: string; wall_ms: number; error?: string
    }
  }
  export interface CaseCapture { case_id: string; fixture_case: FixtureCase; passes: PassCapture[] }
  export interface Provenance {
    fixture: { path: string; name: string; commit: string }      // submodule SHA
    target: { mode: 'gateway' | 'direct'; urls: string[]; config: Record<string, unknown> | null }
    knobs: { retrieval: Record<string, unknown>; synthesis: Record<string, unknown> }
    synthesis: { model: string; base_url: string; prompt_hashes: Record<string, string> }
    judge?: { model: string; base_url: string; prompt_hashes: Record<string, string> }
    passes: number; harness_sha: string; timestamp: string; node_version: string
  }
  export interface CaptureArtifact { schema: 'answer-eval/capture@1'; provenance: Provenance; preflight: PreflightReport; cases: CaseCapture[] }
  export interface PreflightReport { corpus_ok: boolean; missing_docs: string[]; snippet_failures: Array<{ case_id: string; doc_id: string; reason: string }>; twins_ok: boolean; synthesis_probe_ok: boolean; judge_probe_ok: boolean; approved: number; draft: number; rejected: number; estimated_calls: { retrieval: number; synthesis: number; judge: number } }
  export interface JudgedItemBase { prompt_hash: string; judge_model: string; unjudged?: { reason: string; raw: string } }
  export interface FactRecallVerdicts extends JudgedItemBase { kind: 'fact_recall'; verdicts: Array<{ fact_index: number; verdict: 'stated' | 'partial' | 'absent'; evidence: string }> }
  export interface SentenceSupportVerdict extends JudgedItemBase { kind: 'sentence_support'; sentence_index: number; verdict: 'supported' | 'unsupported'; span: string }
  export interface UnsupportedClaimsVerdict extends JudgedItemBase { kind: 'unsupported_claims'; unsupported_sentence_indices: number[]; reasons: string[] }
  export type JudgedItem = FactRecallVerdicts | SentenceSupportVerdict | UnsupportedClaimsVerdict
  export interface JudgedArtifact { schema: 'answer-eval/judged@1'; provenance: Provenance; items: Record<string, JudgedItem> }  // key: `${caseId}|${pass}|${kind}:${index}`
  export interface Report { schema: 'answer-eval/report@1'; provenance: Provenance; header: Record<string, unknown>; headline: Record<string, unknown>; draft_block: Record<string, unknown>; per_case: Array<Record<string, unknown>> }
  ```

- `fixture.ts`:

  ```ts
  export function loadEvalset(path: string): Evalset   // JSON.parse + structural validation
  /** twin partner of a doc id, or undefined. */
  export function twinOf(evalset: Evalset, docId: string): string | undefined
  /** key facts of a case ([] when absent). */
  export function keyFactsOf(c: FixtureCase): string[]
  /** expected doc ids (nested retrieval_ground_truth form). */
  export function expectedIdsOf(c: FixtureCase): string[]
  /** true when the case is a negative case (no expected docs AND no key facts). */
  export function isNegative(c: FixtureCase): boolean
  ```

  Structural validation errors: non-array `test_cases`, case missing `id`/`question`, a `twins` entry whose members are not 2-length arrays, `expected_passages` entries missing `doc_id`/`text_snippet`. Throw with the case id in the message.

- [ ] **Step 1: Failing tests.** `normalize.test.ts`: mirror the python behaviors — (1) full-width `"新能源重卡，包括："` folds so the half-width variant matches; (2) markdown emphasis `**bold**` + backticks stripped; (3) newlines mid-word/`", "` vs `","` collapse equal; (4) case-insensitive; (5) `snippetContained` true/false cases incl. a snippet straddling two chunks being **false** (containment, not n-gram — the harness scores exact normalized containment only; n-gram tolerance is the python lookup tool's concern). `fixture.test.ts`: valid minimal evalset loads; each structural error throws with case id; `twinOf` both directions; `isNegative` for `expected_external_ids: []` + no facts, false for a case with ids.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass; `npm run lint` clean. **Step 5:** Commit: `feat(eval): fixture types, normalize mirror, evalset loader`.

---

## Task 4: Target transports + pre-flight (§3.1, §3.4)

**Files:** Create `evaluation/answer/target.ts`, `evaluation/answer/preflight.ts`, `evaluation/answer/__tests__/target.test.ts`, `evaluation/answer/__tests__/preflight.test.ts`.

**Contracts:**

- `target.ts`:

  ```ts
  export interface RetrievalOutcome { chunks: RetrievedChunk[]; likely_off_topic: boolean; service_ms: number | null; cost_usd: number | null }
  export interface AnswerOutcome { ok: boolean; status: number; synthesis?: { sentences: string[]; cites: number[][]; warning?: string }; passages_sent: PassageSent[]; debug?: any; error?: string }
  export interface TargetClient {
    mode: 'gateway' | 'direct'
    retrieve(query: string, knobs: Record<string, unknown>): Promise<RetrievalOutcome>
    answer(query: string, docs: unknown[], knobs: Record<string, unknown>): Promise<AnswerOutcome>
    health(): Promise<Record<string, unknown> | null>
    catalogIds(): Promise<Set<string>>
  }
  export function gatewayTarget(baseUrl: string, http: typeof fetchJson): TargetClient
  export function directTarget(searchUrl: string, answerUrl: string, http: typeof fetchJson): TargetClient
  ```

  - Gateway `retrieve`: `POST {base}/api/llamaindex` body `{query, mode: 'answer', ...knobs}` → map `data.docs[]` to `RetrievedChunk` (`doc_id`, `chunk_id` from `meta.raw.chunk_id` — absent stays null; `text` from `kps[0].snippet`; `score`), plus `likely_off_topic`, `debug.total_ms`, `usage.total_usd` (run-evalset's field map). Gateway `answer`: `POST {base}/api/answer` body `{query, docs, ...knobs}`; return the synthesis contract fields (`synthesis.sentences`, `synthesis.cites`, `passages_sent`, `debug.knobs`, `debug.invalid_cites`, `debug.fallbackReason`) — never assume `cites` exists (defensive `?? sentences.map(() => [])`).
  - Direct `retrieve`: `POST {searchUrl}/query` body `{query, mode: 'answer', max_results: 15, rerank: true, similarity_threshold: 0.0, include_metadata: true, ...knobs}` — mirror the gateway's answer preset (read `src/app/api/llamaindex/route.ts` ANSWER_PRESET and mirror its exact defaults; the QueryResponse `DocumentResult` maps to `RetrievedChunk` via `doc_id`/`chunk_id`/`content`/`score`, plus `likely_off_topic`, `debug.total_ms`, `usage.total_usd`). Direct `answer`: same `/api/answer` call at `answerUrl`. Direct `health`: GET `{searchUrl}/health` → its config block (provenance); gateway `health`: GET `/api/llamaindex` → `hybrid_service` block, as run-evalset does.
  - `catalogIds`: GET `/api/catalog` (both modes — the app route serves it); parse `items[].meta.file_path` basenames minus `.pdf`.

- `preflight.ts` (implements `PreflightReport` from `types.ts` — it is part of the capture artifact contract):

  ```ts
  export interface PreflightReport { corpus_ok: boolean; missing_docs: string[]; snippet_failures: Array<{ case_id: string; doc_id: string; reason: string }>; twins_ok: boolean; synthesis_probe_ok: boolean; judge_probe_ok: boolean; approved: number; draft: number; rejected: number; estimated_calls: { retrieval: number; synthesis: number; judge: number } }
  export async function preflight(args: { evalset: Evalset; target: TargetClient; judgeCfg?: { model: string; baseUrl: string; apiKey?: string }; passes: number; only?: string[] }): Promise<PreflightReport>
  ```

  1. **Catalog check:** every `expected_external_ids` id (and both members of each twin pair) must be in `catalogIds()`; failures listed per case.
  2. **Snippet validation:** per unique expected doc, one retrieval call `retrieve(case.question, { cite_doc_ids: [doc_id], max_results: 150 })`; every `expected_passages[].text_snippet` for that doc must be `snippetContained` in **some** returned chunk's text. (cite_doc_ids is a forwardable QueryRequest field; `max_results` overrides the preset's 15 so all chunks of the doc return.) A doc with zero returned chunks is a snippet failure with that reason.
  3. **Provider probes:** synthesis — one minimal `answer('ping', [tiny fake doc], { max_passages: 1, passage_chars: 50 })`; abort when the outcome is an error. Judge (only when judging in the same run) — one `judgeCall`-equivalent ping (max_tokens 1); non-200 aborts (401 → abort message).
  4. **Counts + estimate:** approved vs draft vs rejected case counts; estimated calls = cases × passes × (retrieval + synthesis) and judge items (cases × passes × (1 fact-recall + Σ per-pass sentences + 1 unsupported)). Printed, and returned.
  Failure of (1)/(2) lists cases and **aborts before any synthesis or judge call** (snippet validation itself only spends retrieval).

- [ ] **Step 1: Failing tests** (`target.test.ts`, `preflight.test.ts` — node docblock, each spins a local `http.Server` fake): gateway retrieve maps the shipped `/api/llamaindex` shape (incl. `meta.raw.chunk_id` null and `kps[0].snippet`); gateway answer maps the shipped `/api/answer` synthesis contract incl. a fallback path with no `cites` (defensive default) and an `ok:false` 400 from a bad `base_url`; direct retrieve mirrors the answer preset onto `/query` and maps `DocumentResult`; catalog parsing; preflight: missing doc listed, bad snippet listed with case id, twins-missing listed, probes pass/fail, estimate counts exact for a 2-case × 2-pass fixture.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass. **Step 5:** Commit: `feat(eval): target transports (gateway + direct) and pre-flight validation`.

---

## Task 5: Capture stage (§3.2 capture, §3.3, §3.5)

**Files:** Create `evaluation/answer/capture.ts`, `evaluation/answer/cli.ts`, `evaluation/answer/run-capture.ts`, `evaluation/answer/__tests__/capture.test.ts`; Modify `package.json` (add `eval:answer-capture`), `.gitignore` (ignore `evaluation/answer/artifacts/`).

**Contracts:**

- `cli.ts`:

  ```ts
  export interface Controls { only: string[]; limit?: number; passes: number; label: string; concurrency: number; targetUrl: string; directSearchUrl?: string; directAnswerUrl?: string; retrievalKnobs: Record<string, unknown>; synthesisKnobs: Record<string, unknown>; judgeModel?: string; judgeBaseUrl?: string; evalsetPath: string }
  export function parseControls(argv: string[], stage: 'capture' | 'judge' | 'score' | 'compare'): Controls
  ```

  `--only` repeatable (case id), `--limit N`, `--passes N` (default 1), `--label` (default: evalset basename sans `.json`), `--concurrency` (default 1), `--target URL` (default `process.env.EVAL_TARGET || 'https://qa.askwri-app.org'`), `--knob key=value` repeatable, `--direct-search URL` / `--direct-answer URL` (presence of `--direct-search` switches to direct mode), `--judge-model` (default `glm-5.2-vision`), `--judge-base-url` (default `LUNAROUTE_BASE_URL`). **Knob routing rule:** keys in `{model, base_url, max_passages, passage_chars, prompt_version, likely_off_topic}` → synthesis knobs; anything else must be a forwardable `/query` field — import `FORWARDABLE_FIELDS` from `@/app/api/llamaindex/route` (tsx import; ruling 5 fallback: a frozen local copy is NOT allowed silently — on import failure, throw with instructions) — unknown knob → hard error at parse time.

- `capture.ts`:

  ```ts
  export async function runCapture(ctl: Controls, deps: { http: typeof fetchJson }): Promise<CaptureArtifact>
  ```

  Preflight first (its report is recorded into the artifact's `preflight` field — the pure scorer's only source of corpus-attainability) → per selected case (`--only` filter, `--limit` slice) per pass (`0..passes-1`, sequential when concurrency 1): `retrieve` then `answer` with the gateway's docs verbatim (mirror `AIResearchModal`: body `{query, docs, ...synthesisKnobs}` — the runner passes `likely_off_topic` from retrieval into the answer knobs unless the user overrode it). Record everything per `PassCapture`. A failed case records `error` and continues (run-evalset precedent). Provenance per §3.3: fixture submodule SHA (`git -C <worktree> rev-parse :evaluation/eval-review` — or read `.git` file of the submodule; implementation picks the robust one), harness SHA (`git rev-parse HEAD`), prompt hashes (`sha256(SYS_V1)`, `sha256(SYS_V2)` imported from the answer route, keyed by version), synthesis model + base URL (echoed by the route's `debug.knobs` — take the EFFECTIVE values from the first successful answer's debug, falling back to requested), target mode/URLs + health snapshot, knobs as routed, passes, ISO timestamp, node version. **Cost:** sum `retrieval.cost_usd`; print total + mean at the end. Writes `evaluation/answer/artifacts/capture-<label>.json` (pretty-printed, stable key order).

- `run-capture.ts`: parse → runCapture → write file + console summary (per-case one line: `q1 … 15 chunks  8 sent  2 sentences  $0.0123` style, mirroring run-evalset's tone). npm script: `"eval:answer-capture": "npx tsx --env-file-if-exists=.env evaluation/answer/run-capture.ts"`.

- [ ] **Step 1: Failing tests** (`capture.test.ts`, node docblock, fake gateway + fake answer route servers): (1) **capture shape** — a 2-case × 2-pass run against fakes produces `CaptureArtifact` with every `PassCapture` field populated from the fake responses, `cites` parallel to `sentences`, `raw_model_json` preserved; (2) **knob routing** — `--knob max_passages=12` reaches the answer body, `--knob dense_weight=0.8` reaches the gateway body, unknown knob errors at parse; (3) **provenance** — fixture commit, harness SHA (mock `git` via injected deps or test the pure assembler), prompt hashes present and stable, passes recorded, timestamp ISO; (4) **controls** — `--only` filters, `--limit` slices, `--passes 3` triples; (5) **error capture** — one case's answer 500s → `error` recorded, other cases complete; (6) **cost accumulation** — sum over fake `usage.total_usd`.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass + lint + `npx tsc --noEmit` (no new errors — evaluation/ is excluded; src untouched). **Step 5:** Commit: `feat(eval): capture stage — controls, provenance, cost accumulation`.

---

## Task 6: Judge client + prompts (§4.1–§4.4)

**Files:** Create `evaluation/answer/judge-prompts.ts`, `evaluation/answer/judge-client.ts`, `evaluation/answer/__tests__/judge-client.test.ts`.

**Contracts:**

- `judge-prompts.ts` — three prompts, each small, each with a strict JSON schema embedded in the prompt and a validator:

  1. **Fact recall** — inputs: numbered key facts + answer text. Output: `{"verdicts":[{"fact_index":0,"verdict":"stated|partial|absent","evidence":"<quote from answer>"}]}` — one entry per fact, indices complete.
  2. **Sentence support** — inputs: one sentence + only the passages it cites, each tagged with its language (`langOf`; zh passages presented with their text, judge instructed to judge meaning across languages). Output: `{"verdict":"supported|unsupported","span":"<quote from passage>"}`.
  3. **Unsupported claims** — inputs: numbered answer sentences + the full retrieved passage set. Output: `{"unsupported_sentence_indices":[...],"reasons":["..."]}`.

  Plus `PROMPT_HASHES: Record<string, string>` (sha256 of each prompt string) and validators `validateFactRecall(json) → FactRecallVerdicts['verdicts'] | Error`, etc. (hand-rolled: check kinds, enums, index completeness — no zod).

- `judge-client.ts`:

  ```ts
  export class JudgeAuthError extends Error {}          // 401 — aborts the run
  export interface JudgeOk<T> { ok: true; verdict: T; prompt_hash: string; judge_model: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  export interface JudgeUnjudged { ok: false; unjudged: { reason: string; raw: string }; prompt_hash: string; judge_model: string }
  export async function judgeCall<T>(p: {
    system: string; user: string; validate: (json: any) => T | Error
    judgeModel: string; baseUrl: string; apiKey: string | undefined
    timeoutMs?: number   // default 300_000 — lunaroute is ~7× slower than GPT
  }): Promise<JudgeOk<T> | JudgeUnjudged>
  ```

  Behavior (spec §4.3 exactly): `chatCompletion` (imported from `../../src/lib/llm/chat-completions` — relative import so tsx needs no alias) with body `{model, messages: [system, user], temperature: 0, max_tokens: 2000}` (glm takes temperature; no gpt-5 special-casing — judge family ≠ synthesis family by design). **401 → throw `JudgeAuthError` immediately** (abort). **429 → backoff and retry the same call**, sleeps `2^attempt` seconds (1,2,4,8,16), max 5 attempts, then unjudged with reason `rate_limited`. **Schema validation:** parse content as JSON; run validator; on parse/validation failure **one retry** with the validation error appended to the conversation (`{role:'user', content: "<previous reply>\n\nThat reply failed validation: <error>. Reply with JSON only, matching the schema."}`); second failure → `unjudged` with raw text kept. **Timeout:** `Promise.race` around each `chatCompletion` (ruling 6); timeout → one retry, then unjudged `timeout`. Network 5xx → one retry. Concurrency is the stage's concern (default 1), not the client's.

- [ ] **Step 1: Failing tests** (`judge-client.test.ts`, node docblock, fake `/chat/completions` http.Server): valid JSON → verdict extracted, prompt_hash matches sha256 of the system prompt; **invalid JSON then valid** on second call → retry message contains the validation error text (assert the second request's body); **invalid twice** → `unjudged` with raw kept, `ok:false`; **401** → throws `JudgeAuthError`, no further calls; **429 ×2 then 200** → succeeds, exactly 3 requests, sleeps respected (inject a fake `sleep` — do not actually wait 3s); **429 ×6** → unjudged `rate_limited`; validator catches a missing fact_index / wrong enum.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass + lint. **Step 5:** Commit: `feat(eval): judge client — temp 0, retry-once, unjudged, 429 backoff, 401 abort`.

---

## Task 7: Judge stage (§3.2 judge, resumable)

**Files:** Create `evaluation/answer/judge.ts`, `evaluation/answer/run-judge.ts`, `evaluation/answer/__tests__/judge.test.ts`; Modify `package.json` (`eval:answer-judge`).

**Contracts:**

```ts
export async function runJudge(args: {
  capture: CaptureArtifact; judgedPath: string /* resume source + output */; judgeModel: string; judgeBaseUrl: string
  only?: string[]; concurrency?: number
}): Promise<JudgedArtifact>
```

- Reads the capture artifact; for each case × pass, enumerates items: `fact_recall` (skip when the case has no key facts), `sentence_support:<i>` for each sentence **with ≥1 cite** (zero-cite sentences are covered by unsupported-claims, ruling 4), `unsupported_claims`. Item key: `` `${caseId}|${pass}|${kind}:${index ?? ''}` ``.
- Sentence-support inputs: the sentence + its cited `passages_sent` entries (by id), each tagged `langOf(text)`. Unsupported-claims inputs: all sentences (numbered) + full retrieved chunk texts from the pass.
- **Resumable:** load existing `judged-<label>.json` when present; skip keys that exist and are not `unjudged` (an `unjudged` item from an aborted run is retried); write the file after every item (atomic-ish: write temp + rename) so a 401 abort or Ctrl-C preserves progress. On `JudgeAuthError`: print, write partial, `process.exit(1)`.
- Provenance: copy the capture's provenance, add `judge: {model, base_url, prompt_hashes: PROMPT_HASHES}`.
- CLI: `run-judge --capture <path> [--label]` (label defaults to the capture's label parsed from filename); npm script `eval:answer-judge`.
- Judge usage tokens accumulate and print at the end (ruling 8). `--judge-only` semantics = simply running this on a stored capture (ruling 2) — document in README (Task 10).

- [ ] **Step 1: Failing tests** (`judge.test.ts`, node docblock, fake judge server): full run over a 1-case × 2-pass capture → correct item set (fact_recall + per-cited-sentence + unsupported; zero-cite sentence produces NO sentence_support item); verdicts carry prompt_hash + judge_model; **resume**: pre-write a judged file with 2 of N items → only missing items hit the server (count requests); an `unjudged` prior item is retried; **401 mid-run** → partial file written, exit non-zero; provenance carries judge block.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass. **Step 5:** Commit: `feat(eval): judge stage — resumable per-(case,pass,item) verdicts`.

---

## Task 8: Score stage (§2.2, §2.3 — pure)

**Files:** Create `evaluation/answer/score.ts`, `evaluation/answer/run-score.ts`, `evaluation/answer/__tests__/score.test.ts`; Modify `package.json` (`eval:answer-score`).

**Contract:**

```ts
export function score(evalset: Evalset, capture: CaptureArtifact, judged: JudgedArtifact): Report
```

Pure — no I/O, no clock, no randomness. Every mean excludes `unjudged` items and retrieval-error passes (counted in their own blocks). Report structure (fixed key order; deterministic):

- `header`: `judge: 'uncalibrated'` (§4.5 — until human labels exist), judge model, fixture name+commit, target, knobs, passes, case counts (approved/draft/rejected), unjudged counts, cost totals.
- `headline` (expert_approved cases only) and `draft_block` (draft cases, never mixed — §2.4), each with per-metric means:
  - **Retrieval (per §2.2):** evidence coverage (fraction of key facts with ≥1 retrieved chunk whose normalized text contains a supporting passage's normalized `text_snippet` — twin passages count: a snippet under a twin doc is matched against twin chunks too); doc MAP + attainable recall **with twin collapse** (map each doc id to its twin-pair representative before `averagePrecision`/recall; corpus gaps excluded from denominators using the capture's preflight-validated catalog? — no: score is pure, so corpus gaps come from the fixture×capture only via expected ids present in retrieved ∪ catalog? **Correction:** attainability is a preflight fact; the report records `missing_from_corpus` from the capture's provenance-preflight block — simplest pure rule: a doc is attainable iff it appears in the capture's recorded `preflight.missing_docs === false`; wire preflight results INTO the capture artifact in Task 5 as `provenance.preflight`), concentration (distinct docs in list; top-doc share), chunk-id hit rate (diagnostic only: exact `chunk_id` matches).
  - **Synthesis (per §2.3):** fact recall strict (stated only) and lenient (stated+partial); citation precision (`supported / (supported + unsupported)` over judged sentences with ≥1 cite); unsupported-claims count and rate; contract compliance — computed: `cites_valid` (every id ≤ `passages_sent.length`, i.e. `invalid_cites === 0`), `parsed_clean` (`JSON.parse(raw_model_json)` succeeds on first try), `all_english` (`langOf(sentences[i]) !== 'zh'` for all), `sentence_count` distribution; abstention (negative cases: `low_coverage` warning present OR gateway `likely_off_topic` true → abstained), reported apart from means.
- `per_case`: per case — fixture fields passed through + per-metric values + `per_pass` arrays (the pass spread compare prints).

Determinism rule: the report contains **no timestamp of its own** — provenance is copied verbatim from the capture/judged artifacts. Same inputs → byte-identical `JSON.stringify` (§6).

- [ ] **Step 1: Failing tests** (`score.test.ts`, node docblock). Build ONE hand-written fixture + capture + judged set with known scores, asserting exact numbers:
  - evidence coverage with a twin passage (fact expected on doc A; retrieved chunk carries twin A′'s snippet → covered) = e.g. 1.0 with 2 facts, one covered by a full-width-punctuation variant snippet;
  - normalization edge (snippet with `", "` vs chunk's `","` and a markdown-emphasized snippet) still counts;
  - twin collapse in doc MAP: expected [A, B], retrieved [A′(twin of A), C, B] → A credited at rank 1 (A′ collapses to A);
  - concentration: 5 chunks from 2 docs, top doc 3/5;
  - fact recall strict 0.5 / lenient 1.0 (one stated, one partial); citation precision 1/2; unsupported rate 1/3;
  - negative case → abstention block; unjudged fact item → excluded from mean, counted;
  - headline vs draft split: an `expert_approved` case and a `draft` case never mix;
  - **replay determinism**: `JSON.stringify(score(...)) === JSON.stringify(score(...))` and the file bytes equal on two runs.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass + lint. **Step 5:** Commit: `feat(eval): pure score stage — §2.2/§2.3 metrics, byte-identical replay`.

---

## Task 9: Compare stage (§3.2 compare, §4.6 pairwise, §4.5 agreement)

**Files:** Create `evaluation/answer/compare.ts`, `evaluation/answer/run-compare.ts`, `evaluation/answer/__tests__/compare.test.ts`; Modify `package.json` (`eval:answer-compare`).

**Contracts:**

```ts
export function compareReports(a: Report, b: Report): string        // guarded; stdout text
export function judgedAgreement(a: JudgedArtifact, b: JudgedArtifact): string  // per-verdict-type agreement %
export async function runPairwise(args: { captureA: CaptureArtifact; captureB: CaptureArtifact; judge: typeof judgeCall; judgeModel: string }): Promise<PairwiseArtifact>
```

- `compareReports`: **refuses** differing fixture commit, pass count, or case set (exit with a clear error — §6 guard test); otherwise prints per-case deltas for every headline metric with the per-pass spread (`min–max` across passes).
- `judgedAgreement`: two judged artifacts over the same capture → per-verdict-type agreement (fact stated/partial/absent; sentence supported/unsupported), reported separately for zh-source and English-source cases (§4.4).
- `runPairwise` (§4.6): same fixture, cases, passes (guard). Per case × pass: the judge sees question, **shared passages** (`passages_sent` entries whose `chunk_id` appears in both captures' passes, presented once, language-tagged), and both answers **in randomized order** — run **twice with order swapped**; store `{case, pass, orderAB: verdict, orderBA: verdict, reason}` in `pairwise-<labelA>-vs-<labelB>.json` (resumable by the same key scheme). Win rate counts a case for A only when A wins in **both** orders; split verdicts surface as position-bias counts. The pairwise prompt (in `judge-prompts.ts`: preference + reason, strict JSON) gets its own `PROMPT_HASHES` entry.
- CLI: `run-compare <reportA> <reportB>` | `--judged <a> <b>` | `--pairwise <captureA> <captureB>`; npm script `eval:answer-compare`.

- [ ] **Step 1: Failing tests** (`compare.test.ts`, node docblock, fake judge server for pairwise): **guard** — fixture SHA mismatch → refuses (non-zero/throw); passes mismatch → refuses; case-set mismatch → refuses; matching reports → per-case delta lines include spread; `judgedAgreement` computes exact % on a hand-built pair (one disagreement); pairwise — fake judge returns A-pref in order1 and A-pref in order2 → win for A; A-pref then B-pref → position-bias, no win counted; shared-passage filtering: only chunk_ids in both captures are sent (assert request body); resume: pre-written pairwise artifact skips existing (case,pass) pairs.
- [ ] **Step 2:** Verify fail. **Step 3:** Implement. **Step 4:** Verify pass + lint. **Step 5:** Commit: `feat(eval): compare stage — guarded diff, judged agreement, order-swapped pairwise`.

---

## Task 10: Gen-1 deletion (§3 opening list)

**Files:** Delete + modify per the exact spec list:

- **Scripts** (`evaluation/`): `run-answer-retrieval-eval.ts`, `run-answer-synthesis-capture.ts`, `run-answer-synthesis-llm-eval.ts`, `prepare-synthesis-review.ts`, `assemble-synthesis-ground-truth.ts`, `generate-answer-golden-set.ts`, `generate-answer-report.ts`, `relabel-answer-chunks.ts`, `calibrate-answer-thresholds.ts`, `sweep-answer-retrieval.ts`, `eval-nano-filter.ts`, `chart-answer-precision.py`, `eval-minimal.ts`, `serve-label-review.ts`, `upload-eval-to-s3.ts`, `download-eval-from-s3.ts`.
- **Data** (`evaluation/`): `answer-golden-dataset.json`, `answer-golden-dataset.backup-20260722.json`, `answer-labels-review.json`, `answer-retrieval-raw.json`, `answer-synthesis-eval-final.json`, `answer-synthesis-llm-eval.json`, `answer-synthesis-raw.json`, `answer-question-bank.json`.
- **npm scripts**: `eval:answer-retrieval`, `eval:answer-report`, `eval:golden-retrieve`, `eval:golden-label`, `eval:golden-assemble`, `eval:golden-review`, `eval:synthesis-capture`, `eval:synthesis-llm-eval`, `eval:synthesis-prepare-review`, `eval:synthesis-assemble`, `eval:upload`, `eval:download`.
- **Routes** (`src/app/api/eval/`): `labels/`, `labels/override/`, `review-labels/`, `review-synthesis/`, `synthesis-eval/`, `synthesis-eval/review/`, `synthesis-raw/` — **keep `cite-report/` and `review-cite/`** (cite-mode, out of scope).
- **README** (`evaluation/README.md`): remove the sections documenting the deleted scripts; add a section for `evaluation/answer/` (stages, artifacts, controls, `--judge-only` composition ruling 2, cost caveats ruling 8).
- **Stay**: `run-evalset.ts`, `run-cite-eval.ts`, `calibrate-cite-thresholds.ts`, `generate-report.ts`, `run-baseline-suite.sh`, `eval:qa`, `eval:cite`, `eval:report`, `eval:baseline-suite`, `evaluation/lib/`, `evaluation/results/`, `golden-dataset.json` (gen-1 English cite baseline, still used by run-evalset's URL branch).

- [ ] **Step 1:** Before deleting, grep the whole worktree for references to each deleted name (scripts, routes, data files, npm script names): `rg -l 'run-answer-retrieval-eval|eval-minimal|upload-eval-to-s3|api/eval/labels|api/eval/synthesis|eval:golden|eval:synthesis|answer-golden-dataset' src evaluation docs scripts package.json`. Triage every hit: delete the reference with its file, or (docs) update the prose. `evaluation/lib/service-client.ts` / `types.ts`: keep only what remaining scripts import — if a helper becomes orphaned by the deletions, delete it and its test; if still used (by `run-cite-eval.ts` etc.), it stays.
- [ ] **Step 2:** Delete the files/routes/scripts/README sections. Check for tests under `src/__tests__/` that import the deleted routes — delete those tests with them.
- [ ] **Step 3:** Run the full gates: `npm test`, `npm run lint`, `npm run format:check`, `npx tsc --noEmit` — expect green / zero NEW errors (49 pre-existing stand).
- [ ] **Step 4:** Commit: `chore(eval): delete gen-1 answer eval scripts, data, routes, and npm scripts (spec §3)`.

---

## Task 11: Full verification, cross-cutting review, PR

- [ ] **Step 1:** Gates in the worktree: `npm test` (count suites/tests — expect all Task 2–10 suites green plus the pre-existing ones), `npm run lint`, `npm run format:check`, `npx tsc --noEmit` (diff error count vs `origin/qa` — must be zero new).
- [ ] **Step 2:** Cross-cutting self-review against the spec (§3, §4, §6): every §3.2 artifact field, §3.3 provenance field, §3.4 preflight step, §3.5 control, §4.2 call type, §4.3 reliability rule, §6 test — walk the checklist in this plan's Self-review section; fix gaps as a final commit.
- [ ] **Step 3:** Push + PR (base `qa`):

  ```bash
  git push -u origin worktree-answer-eval-pr2
  gh pr create --base qa --title "feat(eval): answer eval harness — capture/judge/score/compare + fetch-hang fix + gen-1 deletion" --body-file - <<'EOF'
  Implements §3 (harness), §3.6 (fetch-hang spike), §4 (judge) of docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md, plus the gen-1 deletion from §3. Spec §5.1's example is reconciled to the shipped parallel-array contract (first commit).

  - Fetch-hang spike: <cause + mitigation summary from http.ts docstring>.
  - New evaluation/answer/: stages capture → judge → score → compare, each an artifact file with full provenance; pre-flight validation; controls; cost accumulation. Score is pure and byte-identical on replay; compare refuses mismatched fixture/passes.
  - Judge reuses src/lib/llm/chat-completions.ts (one provider implementation): temp 0, schema validation, retry-once, unjudged-never-zero, 429 backoff (max 5), 401 aborts, concurrency 1; three JSON-schema prompt types; language-aware; calibration header (uncalibrated until human labels); order-swapped pairwise.
  - Deleted: 16 gen-1 scripts, 8 data files, 12 npm scripts, 7 /api/eval/* routes (cite routes stay); run-evalset.ts / run-cite-eval.ts untouched.
  - Nothing new runs in CI. Out of scope: eval-review submodule (PR 3), retrieval tuning, prompts.
  EOF
  ```

- [ ] **Step 4:** Watch CI by polling (`gh run list --branch worktree-answer-eval-pr2` then `gh run view <id> --json status,conclusion` — do NOT use `gh run watch`, tool timeouts kill it). Mergeability drift from dependabot: check with `git merge-tree` rather than rebasing. Report PR URL + CI conclusion to the user. **Do not merge without explicit authorization.**

---

## Self-review (fill at Task 11, walk at Step 2)

**Spec coverage (§3, §4, §6):**
- §3 opening deletion list → Task 10 (exact list, cite routes preserved).
- §3.1 targets (gateway + direct; direct records `/health` config) → Task 4.
- §3.2 stages/artifacts + resumable judged + pure score + guarded compare → Tasks 5–9.
- §3.3 provenance (fixture commit, target config, knobs, models/base URLs, prompt hashes, passes, harness SHA, timestamp) → Task 5 (`Provenance`); verify each named field exists in the artifact.
- §3.4 pre-flight (snippet containment, catalog, twins, provider probes, approved/draft + call estimate, abort before paid calls) → Task 4.
- §3.5 controls + cost → Tasks 5–7.
- §3.6 spike first + timeout-not-hang test → Task 2 (shipped before the runner, per §5.5 ordering).
- §4.1 single client reuse + judge defaults → Tasks 6–7 (`chat-completions.ts` import, `glm-5.2-vision`, `--judge-model/--judge-base-url`).
- §4.2 three calls + schemas → Tasks 6–7. §4.3 reliability → Task 6. §4.4 language → Tasks 6–7 (`langOf` tagging, zh/es split in agreement).
- §4.5 uncalibrated header + `--judge-only` composition → Tasks 8–9 (rulings 2). §4.6 pairwise with order swap → Task 9.
- §6 tests: scorer known scores incl. twins/normalization/twin-collapse → Task 8; determinism → Task 8; compare guard → Task 9; judge client (validation/retry/unjudged/401/429) → Task 6; runner (fake gateway + answer, capture shape, partial-judged resume, timeout-not-hang) → Tasks 2, 5, 7.
- Not in this PR by design: §2.1 fixture additions + ingest (PR 3, eval-review repo), §5.3 sweeps (PR 4), §7 sweep runs themselves, §2.4 human-review loop (colleague), submodule pin bump (ruling 3).

**Ruling audit:** the 8 pre-made rulings above each carry cost-if-wrong; any ruling made during execution is appended to the PR report with its cost.

**Placeholder scan:** none at plan time; Task 11 re-scans.

**Type consistency:** `PassageSent`/`RetrievedChunk` shared between target/capture/judge/score via `types.ts`; judged item keys `${caseId}|${pass}|${kind}:${index}` produced in Task 7 and consumed verbatim in Tasks 8–9; the shipped route contract (`sentences`/`cites` parallel arrays, `passages_sent`, `debug.knobs`, `debug.invalid_cites`) is consumed only through `AnswerOutcome` mapping in Task 4.
