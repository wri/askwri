# Translation pairs and duplicate documents — design

Issue: #325. Related: #332 (crossed language labels), #333 (sparse lane follow-up), #323 (taxonomy).
Date: 2026-08-13. Ground truth: qa environment data.

## Problem

Some papers exist in the corpus twice: a non-English original and an official English
translation, catalogued as unrelated documents. Both are indexed, so one paper can occupy
two result slots and be cited twice as if it were two independent sources. The pairs also
have to be managed as unrelated rows in the DMS.

## What qa shows (2026-08-13, 201 active docs)

- **Byte-identical dupes: already solved.** The 4 known pairs each have one member
  withdrawn. Every active doc has a `content_hash`; the unique index blocks recurrence.
- **10 translation pairs**, both members `searchable` (double-counted today):
  6 zh/en, 2 es/en found by exact `title_en` match, plus 2 zh/en pairs hidden by wrong
  language labels (#332: `_9025` and `_2130` are stamped `zh` by a human pass but their
  PDFs contain zero Chinese characters — they are the English editions of `_00015` and
  `_00092`).
- **0 same-language duplicates.** The four suspected en/en and zh/zh "dupes" turned out
  to be: a full report vs its executive summary, a 2020 vs 2022 revised edition, and the
  two mislabeled translation pairs above.
- **A few related-but-distinct families** (editions, summaries, companion notes) that
  fuzzy-match on title. Any detector will surface them; a human must be able to say
  "related, not a duplicate."

Phase 0 removed translation/version grouping under a "one paper = one original document"
assumption (`docs/document-management.md`). This design reopens exactly that, minimally.

## Requirements (settled with product owner)

1. Results display in English only. Users are English-speaking WRI staff.
2. **The original always wins.** In both modes the cited, returned, counted entity is the
   original document. The English translation is a rendition.
3. **Passage citations must come from the original source**, never from a translation.
4. Docs with no English translation are a growing class and must work standalone
   (English display comes from `title_en` + English summaries, which every doc has).
5. Links are system-suggested, human-confirmed and human-editable, following the
   `document_tags` precedence pattern.
6. The `/query` request/response contract is unchanged. No fusion/rerank/threshold tuning.

## Design

### 1. Data model

New table `document_relations` (entity + raw-SQL migration, usual conventions):

| column | notes |
|---|---|
| `id` | uuid PK |
| `document_id` | FK → documents. The rendition (translation). |
| `related_document_id` | FK → documents. The original. |
| `relation_type` | text. Only `'translation_of'` for now. |
| `status` | `'suggested'` \| `'confirmed'` \| `'rejected'` |
| `source` | `'system'` \| `'human'` |
| `confidence` | numeric, null for human-created rows |
| `signals` | jsonb. What fired, shown to the reviewer. |
| `created_at`, `reviewed_by`, `reviewed_at` | audit |

Constraints:
- Unique `(document_id, related_document_id, relation_type)`.
- Partial unique index: a document has at most one **confirmed** `translation_of` edge.
- Edge direction is fixed: from translation to original. "Original wins" is readable
  straight off the edge.

Rejected rows persist — they are the don't-re-suggest memory.

Ownership: the worker (Python) inserts `source='system', status='suggested'` rows only
and never modifies human-touched rows. The app tier owns confirm/reject/unlink/manual
creation. Same two-writer precedence as `document_tags`.

### 2. Suggestion generation

- Runs worker-side at the end of each doc's ingestion (after embed — vectors must exist),
  comparing the new doc against every active doc.
- The same comparison logic ships as a re-runnable, idempotent full-corpus sweep script:
  seeds the current corpus, and can be re-run after threshold changes. Pairs with any
  existing relation row (any status) are skipped.
- Signals, all saved in `signals` jsonb:
  1. English-summary embedding cosine similarity (main signal; comparing the English
     bridges avoids cross-language skew).
  2. `title_en` exact/fuzzy match (corroborating).
  3. Stamped language contradicts detected text language on either member (#332 case).
- Thresholds are config values. Initial values: whatever makes all 10 known qa pairs
  fire. Small corpus justifies direction, not permanent numbers.
- **No gate on language labels.** The two mislabeled pairs were zh/zh on paper and must
  still fire.
- Proposed direction: the non-English member is the original, judged by **detected text
  language, not stamps** (the stamps are exactly what is wrong in #332). Reviewer can
  flip it. If both members' text reads as the same language, no direction is proposed —
  the human picks.

### 3. Retrieval behavior per mode

Only **confirmed** edges affect retrieval. All filtering is query-time (a join against
confirmed `translation_of` edges) — no index or ingest changes, so confirming or
unlinking a pair takes effect immediately.

- **Answer mode:** translation docs' chunks are excluded from retrieval. Passages can
  only come from originals; citations are always to the source; pairs cannot
  double-count. English queries still reach zh passages via the cross-lingual dense
  lane, as today.
  - Accepted consequence: answers quoting a zh-original work quote the zh source (the
    synthesizer writes English prose; the citation anchors to the zh PDF).
- **Cite mode:** translation chunks stay in — the English full text helps find the work.
  At assembly, a hit on a translation is credited to its original and the pair collapses
  to one result: the original's identity and `title_en`. Snippet rule: if the original
  also matched, show the original's best-scoring text; if only the translation matched,
  show its text with a metadata flag saying the excerpt is from the English translation.
  Response metadata notes that an English translation exists (additive keys inside the
  existing metadata dict; response shape unchanged).
- `mode` is already a `QueryRequest` field; no contract change.

### 4. DMS surfaces

- **Review queue** (new tab/section in `/admin/review`): pending suggestions with both
  docs side by side (title, language, year, pages) and the signals that fired. Actions:
  confirm (pick or flip direction), reject, edit.
- **Document detail page:** shows confirmed links ("Translation of X" / "Has translation
  Y") with unlink, plus a manual "link as translation of…" picker.
- **Corpus health card:** counts of pending suggestions and confirmed pairs, so an
  unworked queue is visible.

### 5. Seeding and rollout

Three independent pieces, each inert until the next:

1. **Table + migration.** No behavior change.
2. **Sweep + review UI.** Run the sweep on qa; ~10 pairs land in the queue; humans
   confirm. The two #332 pairs go to the zh reviewer — her stamps are reviewed by her,
   not overwritten. Confirmed edges still change nothing in retrieval.
3. **Retrieval filters** behind a config flag, default off. Gate: cite + answer evals on
   qa with the flag off, then on — same harness, same parameters — activate only on
   acceptable deltas. Rollback is flag off.

Production: `clone-corpus.sh` / `verify-corpus-parity.sh` learn to carry
`document_relations`, matched by `external_id` (ids differ across environments), so
confirmations are not redone by hand.

### 6. Failure modes and tests

- Wrong confirm (two distinct docs merged): unlink restores both instantly (query-time
  filter, no reindex). Every confirm/reject/unlink writes an `audit_log` row.
- Withdrawing an original: the whole work drops from results (the translation stays
  filtered because the edge remains). The DMS warns when a withdraw/confirm combination
  would orphan a rendition.
- Tests:
  - Unit tests on sweep signals: all 10 known pairs fire; the exec-summary and edition
    families produce (at most) suggestions, never automatic links.
  - SQL-level tests for both mode filters (translation excluded in answer; remapped and
    collapsed in cite).
  - Jest tests for review-queue API routes (confirm/reject/flip/unlink, precedence
    rules).
  - The eval before/after run is the activation gate, not a nice-to-have.

## Retrieval/evals interplay (#333)

This design does **not** fix sparse-lane weakness for non-English docs — that remains a
separate, eval-gated workstream (`SPARSE_EN_HANDLES`, query translation). What it changes:

- **Cost:** Answer mode loses the en translation's chunks for paired works — accidental
  sparse reach traded for citation correctness. Measured by the activation-gate evals,
  not assumed small.
- **Asset:** a confirmed edge identifies real human-written English full text for a
  non-en work. Future sparse work can source richer English handles from the translation
  (attached to the original's chunks as retrieval signal only, never citable text)
  instead of auto-generated summaries. Tracked in #333.

## Out of scope

- Activating `SPARSE_EN_HANDLES` or query translation (#333).
- Modeling editions/summaries/companion docs (`relation_type` leaves room; nothing built).
- Taxonomy work (#323).
- Repairing the #332 language labels by hand — they flow through the review queue.
