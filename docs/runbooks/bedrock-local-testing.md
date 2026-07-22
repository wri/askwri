# Bedrock Local Testing — Cohere embed-v4 + Rerank 3.5

How to call the real AWS Bedrock APIs from your laptop to test the v3
retrieval substrate (spec: `docs/plans/2026-07-07-multilingual-retrieval-ingestion-design-spec.md`).

There is **no local Bedrock emulator** — you test against the real service.
That is fine and cheap:

| Operation | Cost |
|---|---|
| embed-v4 | $0.12 per 1M tokens (full 30k-chunk corpus re-embed ≈ $2–4) |
| Rerank 3.5 | ~$1 per 1k queries at 100 candidates (a smoke-set run is pennies) |

The code already targets the right regions per model — you only supply
credentials:

| Model | Bedrock model id | Region (config default) |
|---|---|---|
| Dense embed | `cohere.embed-v4:0` | `us-east-1` (`BEDROCK_EMBED_REGION`) |
| Rerank | `cohere.rerank-v3-5:0` | `us-west-2` (`BEDROCK_RERANK_REGION`) |

---

## Step 1 — One-time AWS account setup (console)

1. Sign in to the AWS console for the account the project deploys to.
2. Go to **Amazon Bedrock → Model access** (bottom of the left nav), **in
   region `us-east-1`** → *Manage model access* → check **Cohere Embed v4**
   → submit. Cohere models only need the EULA click; access is granted
   immediately.
3. Switch the console region to **`us-west-2`** and repeat for
   **Cohere Rerank 3.5**.
4. IAM: the identity you will use locally needs
   `bedrock:InvokeModel` and `bedrock:Rerank`. An admin/poweruser identity
   already has both. (The ECS task-role policy in
   `terraform/infrastructure/ecs.tf` covers the deployed services, not your
   laptop.)

Verify from a terminal (after Step 2):

```bash
aws bedrock list-foundation-models --region us-east-1 \
  --by-provider cohere --query 'modelSummaries[].modelId'
# expect cohere.embed-v4:0 in the list
aws bedrock list-foundation-models --region us-west-2 \
  --by-provider cohere --query 'modelSummaries[].modelId'
# expect cohere.rerank-v3-5:0 in the list
```

## Step 2 — Get credentials into your shell

Pick whichever matches how you normally authenticate:

**Option A — IAM Identity Center / SSO (recommended):**

```bash
aws configure sso          # one-time: creates a profile, e.g. "askwri"
aws sso login --profile askwri
eval $(aws configure export-credentials --profile askwri --format env)
```

The `eval` line exports `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` into the current shell. **Session tokens expire** (often
hourly) — re-run the `login` + `eval` lines when calls start failing with
`ExpiredTokenException`.

**Option B — long-lived IAM access keys:**

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
```

**Why the `export`s are required (not just a profile):**
`search-service/.env.local` contains fake MinIO credentials
(`AWS_ACCESS_KEY_ID=local-askwri`) which `app/env.py` loads into the process
environment. boto3 checks env-var credentials *before* profiles, so with only
`AWS_PROFILE` set, the fake keys would win and Bedrock returns
`UnrecognizedClientException`. Precedence is **real shell env > `.env.local`
> `.env`**, so exporting real keys in the shell fixes it. Never edit
`.env` / `.env.local` credential lines for this.

**Side-effect to know:** in a shell with real AWS keys exported, local
**MinIO S3 calls fail auth** (MinIO expects `local-askwri`). This only
affects worker intake/publish e2e — run those in a separate shell without
the exports. Retrieval, calibration, and the re-embed do not touch S3, and
the Bedrock clients pin their own `endpoint_url`, so the MinIO
`AWS_ENDPOINT_URL` never leaks into them.

**Long-running scripts (the full re-embed): do NOT use static exports.**
`aws configure export-credentials` snapshots a login-session token that
expires ~hourly and is NOT refreshed by re-running the export while still
valid — the 2026-07-22 full-corpus attempt died mid-run this way. Instead
install `botocore[crt]` in the venv (in `requirements-dev.txt`) and run
via a driver that pops the fake `.env.local` AWS_* keys from `os.environ`
after the app imports — boto3 then falls through to the CLI's `login`
credential provider, which auto-refreshes for as long as the refresh token
lives. Verify with `boto3.Session().get_credentials().method == "login"`.

## Step 3 — Sanity-check both APIs through the repo's own code paths

From the repo root, in the shell with the exports:

```bash
cd search-service
./venv/bin/python - <<'EOF'
import time
from app.bedrock_embed import embed_documents, embed_query
from app.bedrock_rerank import get_client
from app.config import get_settings

# --- dense ---
t0 = time.time()
q = embed_query("株洲完整街道设计指南")
print(f"embed query: dim={len(q)}  {time.time()-t0:.2f}s")
docs = embed_documents(["Complete street design guide for Zhuzhou, China.",
                        "Solar panel manufacturing supply chains."])
sim0 = sum(a*b for a, b in zip(q, docs[0]))
sim1 = sum(a*b for a, b in zip(q, docs[1]))
print(f"zh query vs relevant-en doc: {sim0:.3f}   vs irrelevant doc: {sim1:.3f}")
assert len(q) == 1536 and sim0 > sim1

# --- rerank ---
s = get_settings()
arn = f"arn:aws:bedrock:{s.bedrock_rerank_region}::foundation-model/{s.bedrock_rerank_model_id}"
t0 = time.time()
r = get_client().rerank(
    queries=[{"type": "TEXT", "textQuery": {"text": "电动公交车运营挑战"}}],
    sources=[{"type": "INLINE", "inlineDocumentSource": {"type": "TEXT",
              "textDocument": {"text": t}}} for t in
             ["Operational challenges of electric buses in Latin America.",
              "A recipe for tomato soup."]],
    rerankingConfiguration={"type": "BEDROCK_RERANKING_MODEL",
        "bedrockRerankingConfiguration": {
            "modelConfiguration": {"modelArn": arn},
            "numberOfResults": 2}},
)
print(f"rerank: {time.time()-t0:.2f}s  results={r['results']}")
scores = {x['index']: x['relevanceScore'] for x in r['results']}
assert scores[0] > scores[1], "relevant doc must outscore soup"
print("OK — both Bedrock lanes live")
EOF
```

Expected: both blocks pass, each call well under a second plus the
cross-region hop (§9 budget: embed ~100–250 ms, rerank ~400–700 ms at 100
candidates).

## Step 4 — Run the search service against Bedrock rerank

The service reranks via Bedrock regardless of the embedding pin, so this
works **before** any re-embed:

```bash
npm run search-service:stop
cd search-service && ./venv/bin/python -m app.main   # same shell as the exports
```

Then exercise the full cite pipeline (floor + tiers) on the non-English
smoke set:

```bash
npx tsx evaluation/run-non-english-smoke.ts --label bedrock-rerank --rerank
```

All 16 targets should surface; note the `tier=` and `floor_docs=` columns.
This is also the data for re-deriving the provisional 0–1 thresholds in
`app/config.py` (`cite_logit_floor`/`cite_partial_threshold`/
`cite_strong_threshold`) — currently 0.01 / 0.30 / 0.70, marked PROVISIONAL.

English regression baselines:

```bash
npm run eval:cite
npm run eval:answer-retrieval
```

## Step 5 — Canary re-embed (500 chunks), then STOP

```bash
cd search-service
export AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10
./venv/bin/python -m scripts.reembed_cohere --limit 500 --batch-size 24
```

**Do not use the default `--batch-size 96`**: the on-demand embed-v4 quota
is 150k tokens/min and a 96-chunk batch bursts past it — botocore's default
standard retry mode (4 attempts) gives up with `ThrottlingException: Too
many tokens`. Batch 24 + adaptive client-side rate limiting completes the
500-chunk canary in ~45s (measured 2026-07-22); extrapolated full corpus
(~30k chunks) ≈ 45–60 min. If more headroom is ever needed, the
cross-region inference profile has a 300k tokens/min quota (2×).

This rewrites 500 chunk rows in place to `embedding_model='cohere-embed-v4'`.
While the corpus is mixed, the dense lane serves whichever model
`EMBEDDING_MODEL` selects — the canary chunks are only reachable after the
full cutover, which is fine; the canary proves auth, throughput, and write
shape.

**Do not run the full-corpus re-embed without review** — the spec mandates a
pause here, and the re-embed replaces the 3-small vectors in place (rollback
after that point means re-embedding back via OpenAI, not a config flip).

## Step 6 — Full cutover (after review sign-off)

```bash
export AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10
./venv/bin/python -m scripts.reembed_cohere --batch-size 24   # full corpus
```

Then remove the pre-cutover pin: delete the `EMBEDDING_MODEL=text-embedding-3-small`
line at the bottom of `search-service/.env.local`, restart the service, and
re-run Step 4's smoke set + evals for the before/after report.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `UnrecognizedClientException` / `InvalidSignatureException` | The fake MinIO keys from `.env.local` are being used — re-run the Step 2 exports in *this* shell. |
| `AccessDeniedException ... is not authorized to perform: bedrock:InvokeModel` | Model access not enabled in that region (Step 1), or your IAM identity lacks the action. Check the region in the error matches the model's region. |
| `ExpiredTokenException` | SSO session expired — `aws sso login` + re-`eval` the export line. |
| `ValidationException: The provided model identifier is invalid` | Region/model mismatch — embed only in `us-east-1`, rerank only in `us-west-2` (or set `BEDROCK_EMBED_REGION`/`BEDROCK_RERANK_REGION` to wherever you enabled access). |
| `ThrottlingException` during re-embed | Default Bedrock quotas are low on fresh accounts — lower `--batch-size`, or request a quota bump (Service Quotas → Bedrock → InvokeModel TPS for the model). |
| S3/MinIO `SignatureDoesNotMatch` in the same shell | Expected (see Step 2) — run worker/S3 work in a shell without the real-key exports. |
