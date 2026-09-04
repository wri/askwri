# Answer Eval Fixtures + Review Loop (PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship PR 3 of the answer-eval overhaul: fixture additions (`twins`, negative cases, `review_status`) and the annot-ingest script in the eval-review repo, the system-output review notebook (human labels for judge calibration), then the app-repo side — submodule pin bump plus §4.5 label consumption in the score stage.

**Architecture:** Two PRs in order. PR A (eval-review repo, branch `answer-eval-pr3` off `origin/main` @ `baf0b14`) adds data + tooling: `twins` and 3 negative cases in `evalset_answer_02.json`, `scripts/ingest_review_status.py` (annot → `review_status`, spec §2.4 rules exactly), a negative-case branch in the existing evalset-review notebook, a new system-output review notebook emitting `answer-eval/human-labels@1` artifacts, and workflow docs. PR B (app repo, branch `worktree-answer-eval-pr3` from `origin/qa` @ `82c32ac`, opened after PR A merges) bumps the submodule pin to PR A's merge commit and adds §4.5: `evaluation/answer/labels.ts` + an optional `labels` parameter on `score()` so reports carry judge-vs-human agreement per verdict type.

**Tech Stack:** Eval-review repo: Python 3.12 + uv (marimo notebooks with PEP-723 inline deps, `molabel`/`mohtml`/`httpx`; scripts with `psycopg`/`pyyaml`), pytest added as the first `[dependency-groups]` dev entry. App repo: TypeScript + tsx CLIs, Jest (`@jest-environment node`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-answer-eval-overhaul-design.md` §2.1 (fixture additions), §2.4 (human review loop: ingest rules + system-output review mode), §4.5 (label consumption), §5.5 item 3, §8 items 1/3/4/5/9.

## Global Constraints

- **One shell command per Bash call** — no `&&`, `;`, pipes, env prefixes, or `2>/dev/null`. Use `git -C <path>`, `npm --prefix <path>`, `uv --directory <path>`.
- **No Co-Authored-By trailers** in commits. Targeted edits, not rewrites; read a file before editing it. No features beyond this plan.
- **No live model/service calls from tests** — mock fetch / local fake `http.Server`s everywhere. The notebooks POST to the Apps Script endpoint only on a human's Save click (never from tests); the ingest script and label loader are pure-file code.
- **Nothing new runs in CI.** pr-check.yml (app repo) untouched; the eval-review repo has no CI at all.
- **Out of scope:** clusters 4–5 data (already done on eval-review `origin/main`), Apps Script/Drive plumbing (colleague's, operational), retrieval tuning, answer synthesis prompts, the `/query` contract, `run-evalset.ts` / `run-cite-eval.ts` / cite-mode evals, pairwise adjudication label types (§4.6 — future; schema leaves room). Twin-passage DATA for the two twinned clusters (q1–q7) IS in scope (Tasks A2–A3) — DB access verified 2026-09-04.
- **Harness contract preservation:** `score()` gains only an optional 4th parameter; existing capture/judged/report artifacts and tests stay valid; `run-score` without `--labels` behaves byte-identically to today.
- **Eval-review data conventions:** `expected_document_ids` stays `[]`; every field the harness treats as optional stays optional; the evalset file keeps its exact JSON style (2-space indent, `ensure_ascii=False`).
- **Worktrees:** app repo `.claude/worktrees/answer-eval-pr3` (branch `worktree-answer-eval-pr3` from `origin/qa` @ `82c32ac`) — never `cd` the main checkout; eval-review submodule inside it on branch `answer-eval-pr3` off `baf0b14`. Bash cwd does not persist between calls.
- **Gates (app repo, PR B):** `npm test`, `npm run lint`, `npm run format:check`, `npx --prefix <worktree> tsc --project <worktree>/tsconfig.json --noEmit` (gate = zero NEW errors; `evaluation/` is excluded from tsconfig so harness code must stay jest-clean and lint-clean). Jest: harness test files start with `/** @jest-environment node */`; fake-server tests call `closeAllConnections()` before `close()`.
- **Gates (eval-review repo, PR A):** `uv run pytest tests/ -v` green; `python -m py_compile` on both notebooks; the harness's `loadEvalset` accepts the edited evalset (run from the app worktree).
- **PR flow:** PR A to `gofenris/askwri-eval-review` main first; PR B (app repo, base `qa`) only after PR A merges (user authorizes both merges). Monitor CI with `gh run view <id> --json status,conclusion`, never `gh run watch`. Do not push to either repo or merge anything without explicit authorization (opening PRs is fine).

---

## Pre-made rulings (recorded; cost-if-wrong noted)

1. **The system-output review mode is a separate notebook file** (`notebooks/review-system-output-answer.py`), not a second mode inside `review-evalset-answer.py`. Spec §2.4 says "second notebook mode", but the two flows have different inputs (uploaded capture file vs. repo evalset dir), different outputs (`labels-*.json` vs `annot-*.json`), and marimo's reactive graph makes a conditional dual-flow single page messy. The planning notes' own concern about page overload supports the split. *Cost if wrong:* user wanted one file; a merge is a mechanical refactor, no data-format impact.
2. **Label artifact schema `answer-eval/human-labels@1`** (below) is presented for user approval before implementation per the tasking. It carries `capture_fingerprint` — the same sha256-over-compact-JSON-of-cases guard the judged artifact uses — computed in the notebook by a Python mirror of `captureFingerprint()`, pinned by a cross-language test pair. *Cost if wrong:* schema revision before any real labels exist = one notebook + one loader change; nothing downstream has shipped.
3. **Negative-case review is a case-validity judgment.** The spec's §2.4 rules don't say how a negative case (no passages, no canonical answer) is reviewed; the mode-1 notebook gains a branch that shows the question + note and asks "Is this a valid negative case (AskWRI should NOT answer it)?" yes/no/skip, saved as `negative_case_review`. Ingest treats it as the answer-equivalent item. *Cost if wrong:* colleague wants different UX — one notebook cell tweak.
4. **The ingest script never writes `rejected`.** Spec §2.4 defines only draft/expert-approved transitions; `rejected` stays a manual maintainer edit. *Cost if wrong:* a rejected-flow rule added later — small, contained change.
5. **Ingest is idempotent over the full annot directory.** Review markers in `note` are lines starting `[review ` — stripped and regenerated deterministically from every annot file present, so re-running over the same directory produces identical output. Passage drops are re-derived the same way (a no-labeled chunk absent from `expected_passages` is a no-op drop, still blocking approval). Usage: always pass the whole `review-output/` dir. *Cost if wrong:* a maintainer ingests a partial subset and a previously-dropped passage's no-vote goes unseen — documented in the script's help text.
6. **`twins` data = the 2 confirmed pairs** from `documents-list_20260817.txt` (`translation_of`/`has_translations`, both `confirmed`, mirroring DB `document_relations`): trucks↔charging-toward-2035, dockless-bike↔how-dockless. Clusters 3–5 (container ports zh, both Mexico es) have no twin in the corpus. *Cost if wrong:* a pair is wrong versus the live DB — the documents list is the DB's own refresh artifact and marks both pairs confirmed; re-check on first DB access.
7. **Twin-passage DATA for clusters 1–2 is IN scope (user-approved 2026-09-04)** — DB access verified via `scripts/with-remote-env.sh qa` + `--sslmode require` (self-test passed against qa RDS). Only those two clusters have twins in the corpus. Resolution follows the migration plan's "Refined workflow" (Tasks A2–A3): fact → locate the EN passage in the twin's markdown (guided by `text_snippet_translation_en`) → unique 15–40 char anchor → batch lookup → append an `expected_passages` entry with the same `supports_key_fact`, `text_snippet` = the DB's `chunk_text`, no translation field. *Cost if wrong:* a mis-resolved twin passage is an additive, optional entry that surfaces as a reviewable passage card in the mode-1 notebook — the review loop catches it; the scorer treats it as another expected passage.
8. **§4.5 label consumption is INCLUDED** (tasking default: include, small): `score()` optional `labels` param + `run-score --labels`; `header.judge` flips from `'uncalibrated'` to a calibration object and a `judge_agreement` block is added. Agreement reuses `judgedAgreement`'s symmetric per-verdict-type tally (agree/either denominators). *Cost if wrong:* cut later — deleting one module + one optional param reverts it.
9. **`updated` only, never `version`, from ingest.** The evalset's version-bump convention (once, after deliberate content milestones, by hand) is preserved; the script refreshes the top-level `updated` date. *Cost if wrong:* version numbering drifts from maintainer convention — trivially fixed.
10. **Language split of agreement is not implemented** (§4.4's zh/en split): all 16 current cases are zh/es-source, so the split is one empty bucket today. *Cost if wrong:* an English-source evalset arrives — add the grouping then, data is already per-case in the report.
11. **PR B's pin bump targets PR A's merge commit**, not `baf0b14` (tasking: "the merged eval-review commit"). PR B's harness tasks are developed against the worktree's `baf0b14` submodule state (synthetic fixtures only — no dependency on PR A's data), then the pin is bumped after the merge. *Cost if wrong:* pin points at an unmerged SHA — impossible, the bump commit is authored after merge.
12. **Negative-case questions are authored in this plan** (3 drafts: two clearly off-domain, one deliberately-hard near-domain). They ship with `review_status` absent (= draft) and are subject to the same expert-review loop. *Cost if wrong:* a reviewer rejects one — delete or reword; the ingest/notebook machinery is unaffected.

---

## The human-label artifact schema (FOR USER APPROVAL)

The contract between the system-output notebook and the harness's score stage. One file = one reviewer's labels for one (capture, case, pass).

```json
{
  "schema": "answer-eval/human-labels@1",
  "capture_file": "capture-baseline.json",
  "capture_fingerprint": "<sha256 hex — same guard as judged artifacts>",
  "case_id": "q1_zero-emission-heavy-duty-trucks",
  "pass": 0,
  "reviewer": "fenris",
  "question": "What is the projected market penetration rate …",
  "key_facts": ["The study evaluates two policy scenario categories …", "…"],
  "fact_verdicts": [
    { "fact_index": 0, "verdict": "stated", "evidence": "quote from the answer" },
    { "fact_index": 1, "verdict": "partial", "evidence": "" },
    { "fact_index": 2, "verdict": "absent", "evidence": "" }
  ],
  "sentence_verdicts": [
    { "sentence_index": 0, "verdict": "supported", "span": "quote from passage", "note": "" },
    { "sentence_index": 1, "verdict": "unsupported", "span": "", "note": "no citation matches" }
  ],
  "overall_note": "optional free text"
}
```

Filename: `labels-<capture-label>-<case_id>-pass<N>-by-<reviewer>.json` (capture label parsed from the uploaded capture filename). Saved to `review-output/` + POSTed to the existing Apps Script Drive folder, like `annot-*.json`.

Design decisions, each with its reason:

- **Fingerprint, not echo-texts.** The judged artifact already refuses resume against a re-captured file via `captureFingerprint()` (sha256 over `JSON.stringify(capture.cases)`). The notebook computes the identical hash in Python (`json.dumps(cases, separators=(',',':'), ensure_ascii=False)` — JSON.stringify does not escape non-ASCII either, and both preserve key order from the same parsed file). The harness re-verifies; a mismatch refuses the label file with the reason. A cross-language pin test (same fixture capture committed in both repos, same expected hex asserted in pytest and Jest) locks the mirror.
- **`fact_verdicts` uses the judge's own vocabulary** (`stated|partial|absent`) with optional `evidence`, so §4.5 agreement is a direct verdict-to-verdict comparison.
- **`sentence_verdicts` labels EVERY sentence** (`supported|unsupported`): cited sentences are judged against the passages they cite (the `sentence_support` lane); zero-cite sentences are judged against the full retrieved set (the `unsupported_claims` lane). One array feeds both agreement computations.
- **`question`/`key_facts` echoes** are for the maintainer reading the file in Drive without the capture open; the score stage ignores them.
- **Partial labeling is legal** — a reviewer may label 2 of 4 facts and save. Unlabeled items are excluded from agreement and counted, never treated as a verdict.
- **Room left for §4.6** (pairwise adjudication) — a future `pairwise` block can be added without touching these fields.

Flow: notebook (local or molab/WASM) → `review-output/` + Drive → maintainer collects → `npm run eval:answer-score -- --capture … --judged … --labels <dir-or-files>` → report carries `judge: {calibrated: …}` + `judge_agreement`.

---

## File map

**PR A — eval-review repo (branch `answer-eval-pr3`)**

| File | Responsibility |
|---|---|
| Modify `evalsets/evalset_answer_02.json` | Add `twins` (2 confirmed pairs); add 3 negative cases (q17–q19). |
| Modify `evalsets/evalset_answer_02.json` (Tasks A2–A3) | Append EN twin-passage entries to q1–q4 and q5–q7 `expected_passages`. |
| Create `scripts/ingest_review_status.py` | §2.4 ingest: annot dir → `review_status` + passage drops + note markers; idempotent; `--dry-run`. |
| Create `tests/test_ingest_review_status.py` | Rules table over synthetic annot sets. |
| Create `tests/test_capture_fingerprint.py` | Python mirror of `captureFingerprint()` pinned against a committed fixture. |
| Create `tests/fixtures/capture-fingerprint-pin.json` | Minimal capture artifact (zh text, nested objects, float, null) shared byte-identically with the app repo's copy. |
| Modify `notebooks/review-evalset-answer.py` | Negative-case branch: validity card + `negative_case_review` payload field + progress-chip semantics. |
| Create `notebooks/review-system-output-answer.py` | System-output review: capture upload → case/pass → per-fact and per-sentence verdicts → `labels-*.json` + Drive submit. |
| Modify `pyproject.toml` + `uv.lock` | `[dependency-groups] dev = ["pytest>=8"]`. |
| Create `eval-generation-notes/twin-passages-workflow_20260904.md` | Maintainer workflow for resolving twin passages with the existing lookup script. |
| Modify `README.md` | Molab link for the new notebook; "Review workflow (Answer mode)" section: notebook → annot files → ingest. |

**PR B — app repo (branch `worktree-answer-eval-pr3`)**

| File | Responsibility |
|---|---|
| Modify `evaluation/eval-review` (gitlink) | Pin bump to PR A's merge commit. |
| Create `evaluation/answer/labels.ts` | `HumanLabels` parsing/validation, dir/file loading, `judgeHumanAgreement()` tallies. |
| Modify `evaluation/answer/types.ts` | `HumanLabels` + `JudgeAgreement` interfaces (re-exported by labels.ts). |
| Modify `evaluation/answer/score.ts` | Optional `labels` param; `header.judge` calibration object + `judge_agreement` block; determinism preserved. |
| Modify `evaluation/answer/run-score.ts` | `--labels <path>` (repeatable; file or dir); prints agreement summary. |
| Create `evaluation/answer/__tests__/labels.test.ts` | Parse/reject matrix, dir loading, agreement tallies, fingerprint pin. |
| Create `evaluation/answer/__tests__/fixtures/capture-fingerprint-pin.json` | Byte-identical copy of PR A's pin fixture. |
| Modify `evaluation/answer/__tests__/score.test.ts` | Labels param: header flip, agreement numbers, byte-identical replay with labels. |
| Modify `evaluation/README.md` | Document `--labels` and the label artifact. |

---

## Part A — eval-review repo

### Task A1: `twins` + negative cases (fixture data)

**Files:** Modify `evalsets/evalset_answer_02.json`.

**Interfaces:**
- Consumes: harness `Evalset.twins?: [string, string][]`, `isNegative` (empty `expected_external_ids` AND empty `key_facts`) — already shipped and tested in PR 2.
- Produces: evalset v3.1 + `twins` + q17–q19, loadable by `loadEvalset()` and accepted by `isNegative`.

- [ ] **Step 1:** After the `test_cases` array (before the closing brace), add:

```json
  "twins": [
    ["2025_zero-emission-heavy-duty-trucks_00015", "2025_charging-toward-2035-policies-to-accelerate-zero_7455"],
    ["2020_dockless-bike-sharing_00124", "2020_how-dockless-bike-sharing-changes-lives-an_2277"]
  ],
```

  (Both pairs `confirmed` in `eval-generation-notes/documents-list_20260817.txt` lines 1070/1187 and 331/350 — `translation_of`/`has_translations` mirroring DB `document_relations`.)

- [ ] **Step 2:** Append three cases to `test_cases`:

```json
    {
      "id": "q17_negative-offdomain-schengen-visa",
      "question": "How do I apply for a Schengen tourist visa?",
      "query_type": "negative",
      "difficulty": "easy",
      "note": "Negative case (spec §2.1): no corpus document answers this; the correct system behavior is to abstain (low-coverage warning) rather than synthesize. Clearly off-domain by construction. Draft pending expert review.",
      "retrieval_ground_truth": {
        "expected_external_ids": [],
        "expected_document_ids": [],
        "expected_passages": []
      },
      "synthesis_ground_truth": {
        "canonical_answer": "",
        "key_facts": []
      }
    },
    {
      "id": "q18_negative-offdomain-boiling-point",
      "question": "What is the boiling point of water at sea level?",
      "query_type": "negative",
      "difficulty": "easy",
      "note": "Negative case (spec §2.1): off-domain trivia; correct behavior is abstention. Draft pending expert review.",
      "retrieval_ground_truth": {
        "expected_external_ids": [],
        "expected_document_ids": [],
        "expected_passages": []
      },
      "synthesis_ground_truth": {
        "canonical_answer": "",
        "key_facts": []
      }
    },
    {
      "id": "q19_negative-neardomain-lagos-commute",
      "question": "What was the average commute time in Lagos, Nigeria in 2023?",
      "query_type": "negative",
      "difficulty": "hard",
      "note": "Negative case (spec §2.1), deliberately hard: topically adjacent to the corpus (urban mobility) but no corpus document reports this statistic; correct behavior is abstention. Reviewer should confirm no corpus doc answers it — reject if one does. Draft pending expert review.",
      "retrieval_ground_truth": {
        "expected_external_ids": [],
        "expected_document_ids": [],
        "expected_passages": []
      },
      "synthesis_ground_truth": {
        "canonical_answer": "",
        "key_facts": []
      }
    }
```

- [ ] **Step 3: Validate.** First `npm --prefix .claude/worktrees/answer-eval-pr3 install` (the fresh worktree has no node_modules; jest cold-cache runs take a couple of minutes — normal). Then, from the app worktree root, one command: `npx tsx -e "import {loadEvalset, isNegative} from './evaluation/answer/fixture'; const es = loadEvalset('evaluation/eval-review/evalsets/evalset_answer_02.json'); console.log(es.twins, es.test_cases.length, es.test_cases.filter(isNegative).map(c => c.id));"`. Expected output: the 2 pairs, 19, and the three q17–q19 ids. Also bump the top-level `updated` to `2026-09-04`; leave `version` and `description` untouched (ruling 9).
- [ ] **Step 4:** Commit (in the submodule): `feat(evalset): add twins pairs and 3 negative cases (spec §2.1)`.

### Task A2: Twin passages — cluster 1 (q1–q4, EN twin `charging-toward-2035`)

**Files:** Modify `evalsets/evalset_answer_02.json` (q1–q4 `expected_passages` only); scratch batch files under `/tmp` (not committed).

**Interfaces:**
- Consumes: the 14 facts of q1–q4 with their zh passages (`text_snippet`, `text_snippet_translation_en`, `supports_key_fact`); the twin's markdown `kp-docs/markdown/2025_charging-toward-2035-policies-to-accelerate-zero_7455.md`; `scripts/lookup_chunk_id.py` batch mode against qa RDS.
- Produces: one additional `expected_passages` entry per resolvable fact: `{"doc_id": "2025_charging-toward-2035-policies-to-accelerate-zero_7455", "chunk_id": <resolved>, "page": <resolved>, "text_snippet": <chunk_text from the DB>, "supports_key_fact": <same string as the zh entry>}` — NO `text_snippet_translation_en` (the passage is already English). Two facts resolving to the same twin chunk merge their `supports_key_fact` via `" | "` (migration workflow rule 9).

- [ ] **Step 1:** For each fact of q1–q4: locate the passage in the EN twin's markdown that states it — guided by the fact's `text_snippet_translation_en` and `supports_key_fact` text. The twin is WRI's official English publication: same content in the publication's own English — the `text_snippet_translation_en` is only a finding aid, never the anchor source.
- [ ] **Step 2:** Pick a 15–40 character anchor phrase from the REAL EN text at that location; verify its normalized occurrence count in the twin's markdown is exactly 1 (same normalization as `lookup_chunk_id.py`'s `normalize()` — full/half-width folding, whitespace collapse).
- [ ] **Step 3:** Collect anchors into `/tmp/twin-cluster1-quotes.json` as `[{"id": "<case_id>#fact<idx>", "external_id": "2025_charging-toward-2035-policies-to-accelerate-zero_7455", "quote": "<anchor>"}, …]` and resolve against the DB (run from the session cwd `/Users/gutelius/dev/askwrimvp` — the wrapper cds to the worktree root, so `--directory` stays relative):

```
.claude/worktrees/answer-eval-pr3/scripts/with-remote-env.sh qa uv --directory evaluation/eval-review run scripts/lookup_chunk_id.py --input /tmp/twin-cluster1-quotes.json --output /tmp/twin-cluster1-resolved.json --sslmode require
```

  Every result must be `match_method: "exact"` or an n-gram match with `low_confidence: false` — otherwise SKIP that fact and flag it in the case's `note` (migration "Edge case" rule — never fabricate an entry).
- [ ] **Step 4:** Patch the evalset via a small one-off Python script (`json.load`, append entries, `json.dump(..., ensure_ascii=False, indent=2)`) — never hand-edit long zh/es strings. Diff before committing; untouched cases must be byte-identical.
- [ ] **Step 5:** Report resolved/total facts per case. Commit: `feat(evalset): resolve EN twin passages for q1-q4 (spec §2.1, §8 item 1)`.

**Review note (reviewer subagent):** re-check a sample of anchors against the twin's markdown — each anchor must appear (normalized) exactly once AND its surrounding text must actually state the fact it is attached to.

### Task A3: Twin passages — cluster 2 (q5–q7, EN twin `how-dockless-bike-sharing`)

Same workflow as Task A2 for the 10 facts of q5–q7, twin doc `kp-docs/markdown/2020_how-dockless-bike-sharing-changes-lives-an_2277.md`, batch files `/tmp/twin-cluster2-quotes.json` / `/tmp/twin-cluster2-resolved.json`, entry `doc_id` `2020_how-dockless-bike-sharing-changes-lives-an_2277`. Commit: `feat(evalset): resolve EN twin passages for q5-q7 (spec §2.1, §8 item 1)`.

### Task A4: Ingest script (§2.4, TDD)

**Files:** Create `scripts/ingest_review_status.py`, `tests/test_ingest_review_status.py`; Modify `pyproject.toml`, `uv.lock`.

**Interfaces:**
- Consumes: annot payload produced by `notebooks/review-evalset-answer.py` (read from a real saved file's shape):

```json
{
  "query_id": "q1_zero-emission-heavy-duty-trucks",
  "question": "…",
  "reviewer": "fenris",
  "reviewed_passages": [
    { "chunk_id": "2025_zero-emission-heavy-duty-trucks_00015_chunk_14", "doc_id": "2025_zero-emission-heavy-duty-trucks_00015", "label": "yes", "notes": "", "timestamp": "2026-09-04T10:00:00" }
  ],
  "synthesis_review": { "label": "yes", "notes": "", "timestamp": "2026-09-04T10:00:00" },
  "negative_case_review": { "label": "yes", "notes": "", "timestamp": "…" }
}
```

  (`negative_case_review` only on negative cases — Task A5 adds it; `synthesis_review` may be `null`.) Labels are `"yes" | "no" | "skip"` (molabel `SimpleLabel`).
- Produces: `ingest(evalset_dict, annot_files) -> (new_evalset_dict, report_lines)` as a pure function; CLI wrapper writes the evalset in place.

- [ ] **Step 1:** `uv --directory <submodule> add --dev pytest` (updates pyproject + uv.lock; no app-repo effect).
- [ ] **Step 2: Write the failing tests** — `tests/test_ingest_review_status.py`. One synthetic evalset (2 positive cases with 2 passages each + facts; 1 negative case) + annot files written to `tmp_path`. Cover the full rules table:

```python
def _annot(qid, reviewer, passages=(), answer=None, validity=None):
    return {
        "query_id": qid, "question": f"q {qid}", "reviewer": reviewer,
        "reviewed_passages": [
            {"chunk_id": c, "doc_id": "d", "label": l, "notes": "", "timestamp": "2026-09-04"}
            for c, l in passages],
        "synthesis_review": answer and {"label": answer, "notes": "", "timestamp": "2026-09-04"},
        "negative_case_review": validity and {"label": validity, "notes": "", "timestamp": "2026-09-04"},
    }
```

  1. all-yes single reviewer → `review_status == "expert_approved"`, no note markers, passages unchanged;
  2. one passage `no` → passage absent from `expected_passages`, note gains a line starting `[review ` naming the chunk and containing the dropped `supports_key_fact` text, status `draft`;
  3. answer `no` → status `draft` + marker quoting the reviewer's note;
  4. conflicting reviewers (a: all yes; b: one passage `no`) → status `draft`, marker lists both reviewers on the conflicting chunk;
  5. `skip` anywhere → not approved (status stays absent/draft), no drop, no conflict;
  6. partial labeling (one of two passages labeled) → not approved;
  7. negative case validity `yes` → `expert_approved`; validity `no` → `draft` + marker;
  8. idempotency: run `ingest` twice over the same dir → identical `json.dumps` output (markers regenerated, not appended);
  9. re-ingest after a drop: the no-labeled chunk is already gone from `expected_passages`, second run with the same annots → status still `draft`, byte-identical file;
  10. unknown `query_id` in an annot → raises with the file name in the message;
  11. label not in `{yes,no,skip}` → raises;
  12. `updated` top-level field set to today; `version` untouched;
  13. case with no annots → untouched (`review_status` stays absent).
- [ ] **Step 3:** Run: `uv --directory <submodule> run pytest tests/ -v` — expect module/file-not-found failures.
- [ ] **Step 4: Implement** `scripts/ingest_review_status.py`:

```python
"""Ingest annot-*.json review files into evalset review_status (spec §2.4).

Usage:
  uv run scripts/ingest_review_status.py --evalset evalsets/evalset_answer_02.json \
      --annot review-output/ [--dry-run]

Rules (spec §2.4, exact):
- a passage labeled `no` (any reviewer) is dropped from expected_passages and
  its supports_key_fact is flagged in the case note;
- a canonical answer (or negative-case validity) labeled `no` sets the case
  to draft with the reviewer's note;
- all passages yes and answer yes (>=1 yes on every item, no `no` anywhere,
  nothing unlabeled) sets expert_approved;
- conflicting reviewers (yes and no on the same item) leave draft and list both;
- `skip` and absent labels are neutral;
- `rejected` is never written (manual maintainer edit);
- review markers are note lines starting `[review ` — regenerated from the
  full annot set on every run, so always pass the whole directory (idempotent).

Pure core: ingest(evalset: dict, annots: list[dict]) -> (dict, list[str]).
"""
```

  CLI: finds `annot-{evalset-name}-*` under `--annot` (dir or explicit files), loads JSON, calls the pure `ingest`, prints the report lines (per case: old→new status, drops, conflicts), writes back with `json.dump(..., ensure_ascii=False, indent=2)` + trailing newline (match the file's existing style), unless `--dry-run`. Approval state machine per the rules table: per item collect `{reviewer: label}`; `has_no`, `conflict` (no AND yes); drops apply always; approval requires every remaining passage ≥1 yes + 0 no AND answer/validity yes + 0 no AND no item unlabeled AND no conflicts AND no `has_no`; `updated = date.today().isoformat()`.
- [ ] **Step 5:** Run pytest — all green. Run the CLI against the real evalset with an empty tmp annot dir → expect "no annot files found" exit, evalset untouched.
- [ ] **Step 6:** Commit: `feat(review): ingest annot files into review_status per spec §2.4`.

### Task A5: Negative-case branch in the mode-1 notebook

**Files:** Modify `notebooks/review-evalset-answer.py`.

**Interfaces:**
- Consumes: the payload shape from Task A4 (adds `negative_case_review`).
- Produces: negative cases reviewable end-to-end (validity card → save → ingest).

- [ ] **Step 1:** Read the notebook in full. Add a negative-case predicate cell (mirroring the harness's `isNegative`): `is_negative_case = (not selected_query["retrieval_ground_truth"].get("expected_external_ids")) and (not selected_query["synthesis_ground_truth"].get("key_facts"))`.
- [ ] **Step 2:** In the passage-review section: when `is_negative_case`, replace the (empty) passage widget with a single-item `SimpleLabel` card showing question + `note` + the prompt "Is this a valid negative case (AskWRI should NOT produce an answer)?" — reuse `render_synthesis_card`'s styling pattern with a new `render_negative_case_card`. Hide the synthesis-review section (nothing to review). Passage cards render the "English translation:" block only when `text_snippet_translation_en` is non-empty (twin passages from Tasks A2–A3 are already English). When not negative: behavior byte-identical to today.
- [ ] **Step 3:** In the save cell: payload gains `"negative_case_review": {label, notes, timestamp}` for negative cases (and `reviewed_passages: []`, `synthesis_review: null`); positive cases' payload unchanged. The dirty-tracking cell adds the validity widget as a dependency. The progress-chip "done" logic treats a negative case as done when its validity was saved.
- [ ] **Step 4:** Verify: `python3 -m py_compile notebooks/review-evalset-answer.py` (from the submodule dir); manual smoke per the notebook's own header (`uv run marimo edit notebooks/review-evalset-answer.py`, select the evalset, confirm q17 shows the validity card and q1 shows passages+synthesis; Save writes `review-output/annot-evalset_answer_02-q17_...-by-<name>.json` with `negative_case_review` — delete the smoke file after).
- [ ] **Step 5:** Commit: `feat(notebook): review negative cases via a case-validity card`.

### Task A6: System-output review notebook (mode 2)

**Files:** Create `notebooks/review-system-output-answer.py`, `tests/test_capture_fingerprint.py`, `tests/fixtures/capture-fingerprint-pin.json`.

**Interfaces:**
- Consumes: `CaptureArtifact` (harness `types.ts`) — uploaded as a file; `captureFingerprint` = `sha256(JSON.stringify(capture.cases))` from `evaluation/answer/judge.ts`; the label schema `answer-eval/human-labels@1` (above).
- Produces: `labels-<capture-label>-<case_id>-pass<N>-by-<reviewer>.json` files; the Python fingerprint mirror.

- [ ] **Step 1: The pin fixture.** Create `tests/fixtures/capture-fingerprint-pin.json` — a minimal valid `answer-eval/capture@1` artifact: 1 case (`fixture_case` with zh `text_snippet` containing full-width punctuation `，：` and a `key_facts` list), 1 pass (`pass: 0`) with 2 sentences (one citing passage 1, one zero-cite), 2 `passages_sent`, a float score, a null `chunk_id`, `provenance` with the required fields. Keep it under ~60 lines. Compute the reference hash from the app worktree (inlining `captureFingerprint`'s body — `createHash('sha256').update(JSON.stringify(capture.cases)).digest('hex')` — avoids importing the judge module graph; PR B's test then pins the REAL function against the same hex): `npx tsx -e "import {createHash} from 'crypto'; import fs from 'fs'; const c = JSON.parse(fs.readFileSync('evaluation/eval-review/tests/fixtures/capture-fingerprint-pin.json','utf8')); console.log(createHash('sha256').update(JSON.stringify(c.cases)).digest('hex'));"`.
- [ ] **Step 2: Write the failing test** — `tests/test_capture_fingerprint.py`:

```python
import hashlib, json
from pathlib import Path

PIN = Path(__file__).parent / "fixtures" / "capture-fingerprint-pin.json"
EXPECTED = "<hex from Step 1>"

def mirror(capture: dict) -> str:
    cases = capture["cases"]
    return hashlib.sha256(
        json.dumps(cases, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()

def test_mirror_matches_harness_fingerprint():
    capture = json.loads(PIN.read_text(encoding="utf-8"))
    assert mirror(capture) == EXPECTED
```

- [ ] **Step 3:** Run pytest — fails if the hex or mirror is wrong; fix until green (this pins the cross-language contract).
- [ ] **Step 4: The notebook.** Create `notebooks/review-system-output-answer.py` following `review-evalset-answer.py`'s boilerplate (same PEP-723 deps header, `REPO_ROOT`/`REVIEW_OUTPUT_DIR`/`SUBMIT_ENDPOINT_URL`/`submit_to_review_dashboard` verbatim). Cells:
  1. Header markdown: purpose (judge calibration §4.5 — human labels vs stored captures) + how to get a capture file (the maintainer shares `evaluation/answer/artifacts/capture-<label>.json`).
  2. `capture_file = mo.ui.file(filetypes=["json"], kind="area", label="Upload a capture-<label>.json")` — parse contents; validate `schema == "answer-eval/capture@1"`; compute the fingerprint via the inline `mirror()` (copy the 3-line function from the test); display a summary (case count, passes, synthesis model from provenance, fingerprint prefix).
  3. Case dropdown (question → case) + pass radio (`options=[0..passes-1]`, default 0) + reviewer-name input (reused pattern).
  4. Context panel: question, `key_facts` (numbered, from `fixture_case.synthesis_ground_truth.key_facts`), review_status if present, and the pass's `passages_sent` rendered as reference cards (id, doc_id, page, text) — all read-only.
  5. **Fact verdicts**: for each key fact, `mo.ui.radio(options=["stated", "partial", "absent"], label=f"Fact {i}")` + optional `mo.ui.text_area(label="evidence quote (optional)")`. No default (explicit choice required).
  6. **Sentence verdicts**: per sentence: the sentence text + its cited passages (resolve `cites[i]` ids against `passages_sent`); zero-cite sentences show "no citations — judge against ALL retrieved passages above". `mo.ui.radio(options=["supported", "unsupported"])` + optional note field.
  7. Save cell (`mo.ui.run_button`): build the label payload exactly per the schema; require every fact and every sentence to have a verdict before saving (else a callout listing what's missing); filename `labels-{capture_label}-{case_id}-pass{pass}-by-{reviewer}.json` where `capture_label` is the uploaded file's name minus `capture-`/`.json`; write to `review-output/`, POST to the dashboard (same helper), show the same saved/submitted status markdown.
  8. Session progress: chips per (case, pass) labeled in this session, reusing the chip-grid pattern.
- [ ] **Step 5:** Verify: `python3 -m py_compile notebooks/review-system-output-answer.py`; manual smoke: `uv run marimo edit`, upload the pin fixture (or any capture), label one case, save, confirm `review-output/labels-…-pass0-by-me.json` matches the schema and its fingerprint matches the notebook's computed value; delete the smoke file.
- [ ] **Step 6:** Commit: `feat(notebook): system-output review — human labels on stored captures (§2.4 mode 2)`.

### Task A7: Docs

**Files:** Create `eval-generation-notes/twin-passages-workflow_20260904.md`; Modify `README.md`.

- [ ] **Step 1:** The workflow note (maintainer-facing, mirroring the migration plan's "Refined workflow" tone): for a fact whose source passage is zh/es and whose doc has a twin (see `twins` in the evalset / `documents-list` `translation_of`): (1) read the fact's `text_snippet_translation_en` and locate the corresponding passage in the twin document's `kp-docs/markdown/<twin-id>.md`; (2) pick a 15–40 char unique anchor phrase from the twin's English text; (3) add `{"external_id": <twin-id>, "quote": <anchor>}` entries to a batch file and run `uv run scripts/lookup_chunk_id.py --input quotes.json --output resolved.json`; (4) append the resolved chunk as another `expected_passages` entry with the SAME `supports_key_fact`, `text_snippet` = the returned `chunk_text`, and `text_snippet_translation_en` = the English text itself; (5) only `confirmed` twins count. Note the DB prerequisite (`PGPASSWORD` via `mise.local.toml`, CA bundle; or the app repo's `scripts/with-remote-env.sh qa` wrapper which exports the libpq vars).
- [ ] **Step 2:** README: add the molab badge link for `notebooks/review-system-output-answer.py` (same pattern as the existing two); add a "Review workflow (Answer mode)" section — notebook 1 reviews the evalset (annot files) → `scripts/ingest_review_status.py` writes `review_status` (usage line + the always-pass-the-whole-dir caveat) → notebook 2 labels stored captures for judge calibration (`labels-*.json`, consumed by the harness's `run-score --labels`).
- [ ] **Step 3:** Commit: `docs: twin-passage workflow + answer review workflow sections`.

### Task A8: PR A verification + PR

- [ ] **Step 1:** Full gates in the submodule: `uv --directory <submodule> run pytest tests/ -v` (all test files green — ingest, fingerprint pin); `python3 -m py_compile` on both notebooks; the Task A1 harness-loader validation still passes (19 cases, 2 twins, 3 negatives); twin-passage counts from Tasks A2–A3 reported (resolved/total); `git -C <submodule> diff --stat` review — no stray files (`review-output/` stays untracked/ignored).
- [ ] **Step 2:** Push + open PR against `gofenris/askwri-eval-review` main: title `feat: answer-eval PR 3 — twins, negative cases, review-status ingest, system-output review notebook`. Body: spec §2.1/§2.4 mapping, the label schema (full JSON), the rulings that touch data (twins source, negative-case questions, idempotent ingest), the DB-blocked twin-passage DATA scope, and a note that the app-repo pin bump follows in the app repo's PR. Report the PR URL to the user. **Do not merge without authorization.**

---

## Part B — app repo (after PR A merges)

### Task B1: Submodule pin bump

- [ ] **Step 1:** `git -C <submodule> fetch origin` then `git -C <submodule> switch --detach <PR A merge commit>` (user supplies/confirms the SHA after authorizing the merge).
- [ ] **Step 2:** From the app worktree: `git add evaluation/eval-review` + commit `chore(eval): pin eval-review to answer-eval PR 3 merge` — include the shortlog of what the bump brings in (notebook, clusters 4–5, ingest, twins/negatives data).

### Task B2: `labels.ts` + types (TDD)

**Files:** Create `evaluation/answer/labels.ts`, `evaluation/answer/__tests__/labels.test.ts`, `evaluation/answer/__tests__/fixtures/capture-fingerprint-pin.json`; Modify `evaluation/answer/types.ts`.

**Interfaces:**
- Consumes: `captureFingerprint` from `./judge`; `CaptureArtifact`, `JudgedArtifact`, `JudgedItem` from `./types`; the schema from Part A.
- Produces:

```ts
export interface HumanFactVerdict { fact_index: number; verdict: 'stated' | 'partial' | 'absent'; evidence?: string }
export interface HumanSentenceVerdict { sentence_index: number; verdict: 'supported' | 'unsupported'; span?: string; note?: string }
export interface HumanLabels {
  schema: 'answer-eval/human-labels@1'
  capture_file: string
  capture_fingerprint: string
  case_id: string
  pass: number
  reviewer: string
  question?: string
  key_facts?: string[]
  fact_verdicts: HumanFactVerdict[]
  sentence_verdicts: HumanSentenceVerdict[]
  overall_note?: string
}
/** Throws on any schema violation, with the file path in the message. */
export function parseLabels(text: string, origin: string): HumanLabels
/** Files and/or directories (dirs glob *.json, sorted for determinism). */
export function loadLabelsFrom(paths: string[]): HumanLabels[]
/** Fingerprint + case + pass existence against THIS capture. */
export function validateLabelsAgainstCapture(labels: HumanLabels, capture: CaptureArtifact): { ok: true } | { ok: false; reason: string }
export interface VerdictTally { agree: Record<string, number>; either: Record<string, number>; excluded: number }
export interface JudgeAgreement {
  fact_recall: Record<'stated' | 'partial' | 'absent', VerdictTally>
  sentence_support: Record<'supported' | 'unsupported', VerdictTally>
  unsupported_claims: { agree: number; compared: number }
  labels: number
  reviewers: string[]
}
/** judged-vs-human per verdict type, symmetric either-denominator (judgedAgreement's measure). */
export function judgeHumanAgreement(judged: JudgedArtifact, labels: HumanLabels[], capture: CaptureArtifact): JudgeAgreement
```

- [ ] **Step 1: Write the failing tests** (`labels.test.ts`, node docblock): a hand-built minimal capture (reuse the pin fixture + a fuller 2-case synthetic) + judged artifact + labels — (1) parse accepts the schema (all fields) and rejects: wrong `schema` string, non-hex/short fingerprint, empty reviewer, `fact_verdicts` with out-of-range index or bad enum, `sentence_verdicts` same — each error names the origin; (2) `loadLabelsFrom` over a dir: sorted, `*.json` only; (3) `validateLabelsAgainstCapture`: fingerprint mismatch → reason; unknown case/pass → reason; (4) **fingerprint pin**: `captureFingerprint(pinFixture)` equals the same hex constant PR A's pytest asserts (copy the fixture + hex); (5) `judgeHumanAgreement` exact tallies: 3 facts (judge stated/stated/absent vs human stated/partial/absent → stated 1/2, partial 0/1, absent 1/1, excluded 0), 2 cited sentences (one disagreement → supported 1/2, unsupported 1/1... adjust to concrete numbers in the test), zero-cite sentence agreement vs `unsupported_sentence_indices` (agree/compared exact), labels whose (case,pass) has no judged item → `excluded` counts, reviewers deduped, deterministic key order.
- [ ] **Step 2:** Run to verify fail. **Step 3:** Implement `labels.ts` (pure; no fs beyond `loadLabelsFrom`; mirror `judgedAgreement`'s tally logic from `compare.ts` — same symmetric either-denominator). **Step 4:** Verify pass + lint. **Step 5:** Commit: `feat(eval): human-label loader + judge-vs-human agreement tallies (§4.5)`.

### Task B3: `score()` labels param + `run-score --labels` (TDD)

**Files:** Modify `evaluation/answer/score.ts`, `evaluation/answer/run-score.ts`, `evaluation/answer/__tests__/score.test.ts`.

**Interfaces:**
- Consumes: `HumanLabels`, `JudgeAgreement`, `judgeHumanAgreement` from B2.
- Produces: `score(evalset, capture, judged, labels?: HumanLabels[]): Report` — with labels: `header.judge = { calibrated: true, labels: N, reviewers: [...] }` and `header.judge_agreement = JudgeAgreement`; without: byte-identical to today.

- [ ] **Step 1: Failing tests** (extend `score.test.ts`): (1) score with labels → header flips from `'uncalibrated'` to the calibration object, `judge_agreement` present with exact tallies from a hand-built pair; (2) score without labels → `header.judge === 'uncalibrated'`, no `judge_agreement` key; (3) **replay determinism with labels**: two calls over the same 4 inputs → identical `JSON.stringify`; (4) labels referencing a case the capture lacks → throws (validation surfaced from B2, not silently skipped).
- [ ] **Step 2:** Verify fail. **Step 3:** Implement: `score()` gains the optional param; compute `judgeHumanAgreement` once when labels are present and merge into `header` (after `judge: 'uncalibrated'`'s current position — replace the literal with the calibration object; keep every other header field and its order untouched). `run-score.ts`: parse `--labels <path>` (repeatable) after `--capture`/`--judged`/`--label` (same parser loop); when present: `loadLabelsFrom`, validate each against the capture (hard error listing every rejected file + reason), pass to `score`, and print after the current `judge:` line:

```
[score] judge: calibrated against N label file(s) by reviewer(s): fenris
[score] judge-vs-human: fact stated a/e (p%), partial …, absent …; sentence supported …, unsupported …; unsupported_claims agree/compared
```

  **Step 4:** Verify pass + lint. **Step 5:** Commit: `feat(eval): score consumes human labels — judge-vs-human agreement per verdict type (§4.5)`.

### Task B4: README + gates + PR B

**Files:** Modify `evaluation/README.md`.

- [ ] **Step 1:** README: document `--labels` on `eval:answer-score` (the label artifact schema in full, where labels come from — the system-output notebook / Drive, the fingerprint guard, the meaning of the agreement numbers, and that without `--labels` nothing changes).
- [ ] **Step 2:** Full gates in the app worktree: `npm test` (expect the known-clean baseline + new suites green — count and report), `npm run lint` (warnings pre-existing only), `npm run format:check`, `npx --prefix <worktree> tsc --project <worktree>/tsconfig.json --noEmit` (zero new errors).
- [ ] **Step 3:** Push + PR against `qa`: title `feat(eval): answer-eval PR 3 — submodule pin bump + judge calibration from human labels`. Body: pin-bump shortlog, §4.5 consumption summary, schema reference (link to PR A), rulings 8/10/11, out-of-scope list. Report PR URL + CI (poll `gh run view <id> --json status,conclusion`). **Do not merge without authorization.**

### Task B5: Cross-cutting review + report

- [ ] **Step 1:** Whole-branch review of both diffs against the spec (§2.1, §2.4, §4.5, §8 items 1/3/4/5/9): walk the Self-review checklist below; fix gaps as a final commit each repo.
- [ ] **Step 2:** Report to the user: PR URLs, test counts, every ruling with its cost-if-wrong, the DB-blocked items (twin-passage DATA, any corpus validation), and anything left out with the reason.

---

## Self-review (fill at the final task; walk against the spec)

**Spec coverage:**
- §2.1 `twins` at evalset top level → Task A1 (data; harness support shipped in PR 2).
- §2.1 twin passages → Tasks A2–A3 (data, both twinned clusters) + Task A7 (workflow note for future clusters); harness support shipped in PR 2.
- §2.1 `review_status` written by ingest → Task A4.
- §2.1 negative cases → Task A1 (data) + A5 (review branch) + A4 (ingest rules) + PR 2 (scoring).
- §2.4 ingest rules (passage no → dropped + fact flagged; answer no → draft + note; all-yes → expert_approved; conflicts → draft listing both) → Task A4 rules table, tests 1–9.
- §2.4 second notebook mode (per-fact stated/absent, per-sentence supported/unsupported on a stored capture) → Task A6.
- §4.5 label consumption (score prints judge vs human agreement per verdict type; header uncalibrated until labels) → Tasks B2/B3.
- §8 item 9 submodule pin bump → Task B1 (to PR A's merge commit).
- §8 items 1/3/4/5 — item 1 (twin passages) executed in Tasks A2–A3 per user approval 2026-09-04; items 3/4/5 tooling in-repo, operation with the colleague.

**Placeholder scan:** every task's steps contain the actual JSON/code/commands; no TBDs.

**Type consistency:** `HumanLabels` fields match the notebook's payload exactly (Task A4 Step 4 cell 7 vs B2 interface); the fingerprint pin hex + fixture are shared byte-identically between repos; `JudgeAgreement`'s tally shape mirrors `compare.ts`'s `VerdictTally`.

**Process:** every dispatch is `context: "fresh"`; reviewer prompts open with "Review only — return findings only."; tests run by the orchestrator before the reviewer dispatch; fix rounds resume the implementer; minor findings park in the ledger with rulings.
