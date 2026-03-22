# Voyage Reranker Completion Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Voyage reranker migration — assemble Opus labels, run answer evals, check answer mode floor, update Dockerfile/secrets, document everything in README.

**Architecture:** Voyage rerank-2.5 API replaced local L-6/L-12 cross-encoders for both cite and answer modes. Cite mode floor calibrated at 0.50 (Voyage 0-1 scores). Answer mode floor TBD. Opus 4.6 labels replace GPT-5.4 labels for answer retrieval eval.

**Tech Stack:** Python search service (FastAPI), Voyage AI API, TypeScript eval scripts, Opus 4.6 labels

**Current state:** Voyage integration working for both modes. Cite eval: P=33.2%, R=77%, F1=45%, 8/11 passed (best ever). Opus labels for 9 answer questions sitting in `.context/labeling/`. Answer retrieval raw data captured with current Voyage reranker. No answer eval run yet with Opus labels.

**IMPORTANT:** Do NOT stop the search service (port 8000) or Next.js dev server (port 3000). They must remain running throughout.

---

### Task 1: Verify Answer Retrieval Raw Data Has Voyage Scores

**Files:**
- Read: `evaluation/answer-retrieval-raw.json`
- Maybe modify: `evaluation/answer-retrieval-raw.json` (re-capture if stale)

**Why:** The Opus labels in `.context/labeling/` were generated from this raw data. If the raw data was captured with L-12 (not Voyage), the scores won't reflect production. The chunk ORDER and CONTENT must match the labels — if we re-capture, chunks may differ and labels become invalid.

- [ ] **Step 1: Check score range in raw data**

```bash
python3 -c "
import json
d = json.load(open('evaluation/answer-retrieval-raw.json'))
chunk = d['questions'][0]['retrieved_chunks'][0]
score = chunk.get('score', 0)
print(f'First chunk score: {score}')
if score < 0:
    print('NEGATIVE — captured with L-6/L-12 logits, need re-capture')
elif 0 <= score <= 1:
    print('0-1 range — likely Voyage scores, OK')
"
```

- [ ] **Step 2: If scores are negative (L-12 logits), re-capture AND re-label**

This is a blocking dependency. If raw data has L-12 scores:
1. Re-capture: `npx tsx evaluation/generate-answer-golden-set.ts`
2. Re-label: dispatch 9 Opus labeling subagents (same as before)
3. Then proceed to Task 2

If scores are 0-1 (Voyage): proceed directly to Task 2.

---

### Task 2: Assemble Opus Labels into answer-labels-review.json

**Files:**
- Read: `.context/labeling/ans_00{1-9}_labels.json` (Opus labels)
- Read: `evaluation/answer-retrieval-raw.json` (chunk metadata — doc_id, title, content, score, page)
- Modify: `evaluation/answer-labels-review.json`

- [ ] **Step 1: Write assembly script**

```bash
python3 << 'SCRIPT'
import json

raw = json.load(open('evaluation/answer-retrieval-raw.json'))
questions = []

for q in raw['questions']:
    qid = q['id']
    labels = json.load(open(f'.context/labeling/{qid}_labels.json'))

    # Build label lookup by chunk_index
    label_by_idx = {l['chunk_index']: l for l in labels}

    chunks = []
    for i, chunk in enumerate(q['retrieved_chunks']):
        label_data = label_by_idx.get(i, {})
        chunks.append({
            'chunk_id': chunk['chunk_id'],
            'doc_id': chunk['doc_id'],
            'title': chunk.get('title', ''),
            'content': chunk['content'],
            'score': chunk.get('score', 0),
            'page': chunk.get('page', 1),
            'label': label_data.get('label', 'not_relevant'),
            'confidence': label_data.get('confidence', 0),
            'rationale': label_data.get('rationale', ''),
            'human_override': None,
        })

    questions.append({
        'id': qid,
        'question': q['question'],
        'query_type': 'research',
        'difficulty': 'medium',
        'chunks': chunks,
    })

output = {
    'labeled_at': '2026-03-22T00:00:00Z',
    'labeler': 'claude-opus-4.6',
    'questions': questions,
}
json.dump(output, open('evaluation/answer-labels-review.json', 'w'), indent=2)
print(f'Wrote {len(questions)} questions, {sum(len(q["chunks"]) for q in questions)} total chunks')

# Summary
for q in questions:
    r = sum(1 for c in q['chunks'] if c['label'] == 'relevant')
    p = sum(1 for c in q['chunks'] if c['label'] == 'partially_relevant')
    n = sum(1 for c in q['chunks'] if c['label'] == 'not_relevant')
    print(f'  {q["id"]}: {r}R {p}P {n}NR')
SCRIPT
```

- [ ] **Step 2: Verify file structure matches expected format**

```bash
python3 -c "
import json
d = json.load(open('evaluation/answer-labels-review.json'))
assert d['labeler'] == 'claude-opus-4.6'
assert len(d['questions']) == 9
for q in d['questions']:
    assert len(q['chunks']) == 20
    for c in q['chunks']:
        assert c['label'] in ('relevant', 'partially_relevant', 'not_relevant')
        assert 'chunk_id' in c and 'doc_id' in c
print('OK: 9 questions, 180 chunks, all valid')
"
```

- [ ] **Step 3: Commit**

```bash
git add evaluation/answer-labels-review.json
git commit -m "data: replace GPT-5.4 answer labels with Opus 4.6 labels"
```

---

### Task 3: Run Answer Retrieval Precision Eval

**Files:**
- Read: `evaluation/sweep-answer-retrieval.ts`
- Read: `evaluation/answer-labels-review.json` (Opus labels from Task 2)

**Prerequisites:** Search service running on port 8000 with Voyage reranker. Labels assembled in Task 2.

- [ ] **Step 1: Review sweep script to confirm it reads from answer-labels-review.json**

```bash
grep -n "answer-labels" evaluation/sweep-answer-retrieval.ts
```

Expected: it loads `answer-labels-review.json` for label matching.

- [ ] **Step 2: Run the answer retrieval sweep**

```bash
npx tsx evaluation/sweep-answer-retrieval.ts
```

This sweeps alpha × rerankTopN and measures P@8/10/12/15 against Opus labels. Capture the output — it will show whether the current `alpha=0.65, rerankTopN=20` is still optimal with Voyage + Opus labels.

- [ ] **Step 3: Run a direct P@8 eval with current production params**

If the sweep script doesn't report a simple baseline, compute it manually:

```bash
python3 << 'SCRIPT'
import json

labels = json.load(open('evaluation/answer-labels-review.json'))

total_hits = 0
total_k = 0
per_q = []

for q in labels['questions']:
    top8 = q['chunks'][:8]
    hits = sum(1 for c in top8 if c['label'] in ('relevant', 'partially_relevant'))
    p_at_8 = hits / 8
    per_q.append((q['id'], p_at_8, hits))
    total_hits += hits
    total_k += 8

avg_p8 = total_hits / total_k
print(f"Answer Mode P@8 (Voyage + Opus labels): {avg_p8:.1%}")
print()
for qid, p, h in per_q:
    print(f"  {qid}: P@8={p:.1%} ({h}/8 relevant)")
SCRIPT
```

- [ ] **Step 4: Record results and update ANSWER_PRESET if needed**

If optimal alpha or rerankTopN changed from current values (0.65, 20), update `src/config/retrieval.ts`.

- [ ] **Step 5: Commit any param changes**

```bash
git add src/config/retrieval.ts evaluation/
git commit -m "eval: answer retrieval precision with Opus labels and Voyage reranker"
```

---

### Task 4: Check Answer Mode Score Floor

**Files:**
- Read: `evaluation/answer-labels-review.json` (Opus labels)
- Read: `evaluation/answer-retrieval-raw.json` (Voyage scores)
- Maybe modify: `search-service/app/config.py` (if floor helps)
- Maybe modify: `search-service/app/main.py` (if floor helps)

- [ ] **Step 1: Analyze Voyage score distributions for answer mode**

```bash
python3 << 'SCRIPT'
import json

raw = json.load(open('evaluation/answer-retrieval-raw.json'))
labels = json.load(open('evaluation/answer-labels-review.json'))

label_lookup = {}
for q in labels['questions']:
    for c in q['chunks']:
        label_lookup[c['chunk_id']] = c['label']

rel_scores = []
irrel_scores = []

for q in raw['questions']:
    for chunk in q['retrieved_chunks']:
        score = chunk.get('score', 0)
        label = label_lookup.get(chunk['chunk_id'], 'not_relevant')
        if label in ('relevant', 'partially_relevant'):
            rel_scores.append(score)
        else:
            irrel_scores.append(score)

rel_scores.sort(reverse=True)
irrel_scores.sort(reverse=True)

print(f'Relevant chunks: {len(rel_scores)}')
print(f'  Min: {min(rel_scores):.3f}, Max: {max(rel_scores):.3f}, Median: {rel_scores[len(rel_scores)//2]:.3f}')
print(f'Irrelevant chunks: {len(irrel_scores)}')
if irrel_scores:
    print(f'  Min: {min(irrel_scores):.3f}, Max: {max(irrel_scores):.3f}, Median: {irrel_scores[len(irrel_scores)//2]:.3f}')

    # Check overlap
    min_rel = min(rel_scores)
    irrel_above_min_rel = sum(1 for s in irrel_scores if s >= min_rel)
    print(f'\nIrrelevant above min relevant ({min_rel:.3f}): {irrel_above_min_rel}/{len(irrel_scores)}')
    print(f'Overlap: {"HIGH — floor won\'t help" if irrel_above_min_rel > len(irrel_scores)*0.5 else "LOW — floor could help"}')
else:
    print('  No irrelevant chunks — all labeled relevant/partial')
SCRIPT
```

- [ ] **Step 2: Decision**

If overlap is HIGH: skip answer floor (same conclusion as the L-6 logit floor experiment from PR #124). Document finding in README.

If overlap is LOW: sweep thresholds, pick optimal, add `answer_score_floor` to config.py and apply in main.py's answer mode path before `stage2_results[:request.max_results]`.

- [ ] **Step 3: Commit if changes made**

```bash
git add search-service/app/config.py search-service/app/main.py
git commit -m "feat: answer mode score floor (or: doc: answer floor not viable)"
```

---

### Task 5: Add VOYAGE_API_KEY to QA Deployment Secrets

**Files:**
- Modify: GitHub repo secret `SEARCH_SERVICE_ENV`

**Note:** This requires GitHub repo admin access. The deploy workflow at `.github/workflows/deploy-qa.yml` passes `secrets.SEARCH_SERVICE_ENV` as `TF_VAR_search_service_secret_env`. The secret is a multi-line env var blob that gets injected into the Fargate task definition.

- [ ] **Step 1: Check current secret format**

The secret likely looks like:
```
OPENAI_API_KEY=sk-...
DOCUMENTS_LOCAL_DIR=/tmp/askWRI_docs
```

- [ ] **Step 2: Add VOYAGE_API_KEY to the secret**

Go to GitHub repo Settings → Secrets and variables → Actions → `SEARCH_SERVICE_ENV`.
Add line:
```
VOYAGE_API_KEY=pa-ka_72q93VTGBV_N0akcoGgBvIJ2hQlAvs3OIBajWJ8x
```

- [ ] **Step 3: Verify terraform passes it through**

Check `terraform/infrastructure/ecs.tf` for how `search_service_secret_env` is used — it should inject as environment variables in the container definition.

---

### Task 6: Clean Up Dockerfile and Old Reranker References

**Files:**
- Review: `search-service/Dockerfile` (already clean — verify)
- Review: `search-service/requirements.txt` (already clean — verify)
- Review: `search-service/app/main.py` (check for dead imports/comments)
- Modify: `search-service/app/main.py` (remove any stale comments about L-6/L-12)

- [ ] **Step 1: Verify no old reranker dependencies remain**

```bash
grep -rn "sentence.transformers\|SentenceTransformerRerank\|CrossEncoder\|onnx\|MiniLM\|L-6\|L-12" \
  search-service/app/main.py search-service/requirements.txt search-service/Dockerfile
```

Expected: only the comment on line 92 of main.py (`# SentenceTransformerRerank removed`). Remove that comment if present.

- [ ] **Step 2: Verify Dockerfile has no model pre-download step**

```bash
grep -n "python.*-c\|model\|download\|huggingface" search-service/Dockerfile
```

Expected: no matches.

- [ ] **Step 3: Commit cleanup**

```bash
git add search-service/
git commit -m "cleanup: remove stale reranker references"
```

---

### Task 7: Update READMEs with Voyage Migration Documentation

**Files:**
- Modify: `search-service/README.md`
- Modify: `evaluation/README.md`

- [ ] **Step 1: Update search-service/README.md**

Add/update sections covering:
- Voyage rerank-2.5 is used for both cite and answer mode reranking
- `VOYAGE_API_KEY` is required in `.env`
- Cite mode score thresholds: `cite_score_floor=0.50`, `cite_strong_threshold=0.80`, `cite_partial_threshold=0.60`
- Retrieval pipeline: hybrid fusion (dense+sparse) → Voyage reranking → score floor (cite) → tier assignment
- Parameters: `fusion_top_k`, `bm25_top_k`, `dense_weight`/`sparse_weight` all flow through from request
- No local models — reranking is API-based, ~200-500ms per call
- Migration history: L-6/L-12 cross-encoders → Voyage API (why: 28s on Fargate → <1s)

- [ ] **Step 2: Update evaluation/README.md**

Document:
- Opus 4.6 labels replaced GPT-5.4 labels for answer retrieval eval
- Why: GPT-5.4 labels were circular with GPT-5.4 nano filter; Opus provides independent judgment
- Label distribution comparison: Opus is stricter (fewer relevant per question on average)
- Cite eval results: Voyage + floor=0.50 achieves P=33.2%, R=77%, F1=45%, 8/11 passed
- Answer eval results: [fill in from Task 3 results]
- Voyage vs L-12 comparison: [fill in from earlier eval data]

- [ ] **Step 3: Commit docs**

```bash
git add search-service/README.md evaluation/README.md
git commit -m "docs: document Voyage reranker migration and eval results"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run cite eval to confirm floor=0.50 still produces expected results**

```bash
npx tsx evaluation/run-cite-eval.ts
```

Expected: P~33%, R~77%, F1~45%, 8/11 passed.

- [ ] **Step 2: Run a manual cite mode query through the full stack**

Open browser to `http://localhost:3000/results?q=How%20to%20build%20more%20equal%20cities` and verify:
- Results load with relevance tiers (strong/partial/weak)
- Overview section renders
- No console errors

- [ ] **Step 3: Run a manual answer mode query through the full stack**

Click "Ask a research question" and submit a question. Verify:
- Answer synthesizes correctly with citations
- Supporting citations show tier labels
- No errors

- [ ] **Step 4: Verify TypeScript build**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Create PR**

```bash
git add -A
git status  # review what's staged
git commit -m "feat: Voyage reranker migration — cite floor calibrated, Opus labels, parameter fixes"
```

Then create PR targeting `qa` branch.
