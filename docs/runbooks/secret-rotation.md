# Secret & env-var rotation runbook (ECS via GitHub secrets)

How deployed environment variables and API keys actually flow, why you cannot
durably change one in the AWS console, and the proven procedure for rotating one
without leaking it. Written 2026-07-23 from the qa Mistral-key rotation, which is
the worked example throughout.

---

## How a deployed env var actually gets there

```
GitHub Actions secret (JSON blob)
  -> TF_VAR_<...>_secret_env  (deploy-<env>.yml)
  -> terraform apply renders it into the ECS task definition `environment` block
  -> container reads it as a plain env var at start
```

Three sources merge into the container `environment` (see
`terraform/infrastructure/ecs.tf`): terraform-static keys, an optional tfvars
map, and `jsondecode(var.<...>_secret_env)` — the GitHub secret. For the
ingestion worker the secret carries **8 keys** (the live task def's 14 minus 6
terraform-static ones): `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `DATABASE_URL`,
`PARSE_BACKEND`, `AWS_RETRY_MODE`, `AWS_MAX_ATTEMPTS`, `BEDROCK_EMBED_MODEL_ID`,
`BEDROCK_EMBED_BATCH_SIZE`.

**Secret scope differs by environment — this is load-bearing:**

| Environment | Secret scope | `gh secret set` form |
|---|---|---|
| qa | **repo-level** (jobs declare no `environment:`) | `gh secret set NAME --repo wri/askwri` |
| production | **`production` environment-scoped** (jobs declare `environment: production`, which shadows the repo secret) | `gh secret set NAME --env production` |

A repo-level write touches **qa only**. Production has its own env-scoped copies
that shadow it. Verified 2026-07-23: there is a `production` GitHub environment
with its own `INGESTION_WORKER_ENV`/`SEARCH_SERVICE_ENV`; there is no `qa`
environment.

---

## Why you cannot durably edit these in the AWS console

The task definition is **Terraform-managed** and re-rendered from the GitHub
secret on every `terraform apply` (which runs on every deploy).

- Task defs are immutable, so a console "edit" creates a **new revision**; point
  the service at it and it takes effect in ~2-5 min (rolling restart, no image
  rebuild). That part works.
- **But the next `terraform apply` overwrites it** with the GitHub-secret value.
  That is any subsequent deploy, including an unrelated one.

For a rotation this is a footgun: rotate in the console, it works for a while,
then a routine deploy silently reverts the worker to the *old* key. If you have
already revoked the old key, the worker breaks with no obvious cause. **The
GitHub secret is the source of truth; change it there.**

### The console flow you actually want exists — via Secrets Manager

If these keys move from the plaintext `environment` block to a **`secrets`
block** (`valueFrom` a Secrets Manager ARN), rotation becomes: edit the value in
the Secrets Manager console, then `aws ecs update-service --force-new-deployment`
(~2 min rolling restart, no task-def change, no terraform, no image build — the
container resolves the secret from the ARN at start). It is Terraform-compatible
(the task def references a stable ARN; the value lives outside TF state, no
drift) and it also closes the plaintext-in-task-def exposure. This migration is
**tracked but not yet done** — see the todos.

---

## Rotation procedure (proven on qa, 2026-07-23)

Two steps live outside anything the agent can do — **create** the new key and
**revoke** the old one both happen in the provider's console. The agent prepares
the secret-rebuild script and verifies the result; the human runs the script
(secret writes are classifier-blocked for the agent).

1. **Create** the new key in the provider console. Use an **org/team key, never
   personal** (qa's original Mistral key was personal — that was debt).
2. **Rebuild the GitHub secret**, values pulled from the live task def, only the
   rotated key swapped, nothing printed. Run in **your own terminal, not the
   Claude `!` prefix** — the new key must not enter the transcript. The script:
   - validates the new key against the provider API (status only) so a typo can
     never reach the worker;
   - reads the current 8 values from the live task def;
   - rebuilds the JSON by an explicit key allowlist (not subtraction), asserts
     exactly 8 keys and that the rotated value actually changed;
   - writes the correctly-scoped secret (`--repo` for qa, `--env production` for
     prod).
3. **Redeploy** — `gh workflow run deploy-qa.yml --ref qa` (or the prod release
   mechanism). Terraform re-renders the task def from the new secret and forces a
   new deployment.
4. **Verify** (agent, read-only) before revoking anything:
   - Service rolled to the new task-def revision, `rolloutState: COMPLETED`,
     desired == running.
   - The deployed value actually changed — compare the rotated key's SHA-256
     across the old and new task-def revisions (digests only, never the value):
     ```
     aws ecs describe-task-definition --task-definition <family>:<rev> \
       --query "taskDefinition.containerDefinitions[].environment[] | [?name=='MISTRAL_API_KEY'].value | [0]" \
       --output text | shasum -a 256
     ```
     Different, non-empty digests = the new value is live. (An all-`e3b0c442…`
     digest is the hash of an empty string — a bad query, not a real value.)
   - **Canary**: exercise the key in situ. For a worker key, ingest ONE doc
     (`reingest_all --ids <id>`) and confirm it reaches `done` through the parse
     stage (where the key is used) with clean output. A stable *running* task
     only proves it booted; the canary proves the key works.
5. **Revoke** the old key in the provider console — **only after** step 4 passes.

### qa Mistral rotation — EXECUTED 2026-07-23

Personal key -> org key on qa. New key validated against `api.mistral.ai` before
the secret write; deployed value confirmed changed (task-def rev :4 -> :5,
distinct non-empty digests); worker rolled to :5, `COMPLETED`, 1/1; canary
re-ingest of `2014_the-trillion-dollar-question_3289` reached `done` through the
Mistral parse stage with clean Mistral markdown, 0 `/gid`, cohere chunks, sparse
present, `searchable`. Old personal key cleared for revocation after the canary
— **confirm revocation completed**. Production has no Mistral key at all
(pypdf, no `PARSE_BACKEND=mistral`), so nothing to rotate there.

---

## Gotchas carried from the qa work

- **A stable running task is not proof.** Boot succeeds before the key is
  exercised; only a canary that hits the key path proves it.
- **Digest-compare, never print.** To confirm a deployed secret changed without
  revealing it, pipe the value straight into `shasum` in one command so only the
  digest reaches the operator/agent.
- **Scope is easy to get wrong.** A repo-level `gh secret set` does nothing to
  production (its env-scoped copy shadows it) and vice-versa. Match the scope.
- **Rebuild by allowlist, not subtraction.** Assert the exact expected key count
  before writing — a dropped required key boots the worker into a crash loop
  (same failure class as the VOYAGE_API_KEY finding).
- **`.env.local` fake-MinIO keys are a LOCAL footgun only** (they load via
  `load_dotenv(override=False)` and beat the real `~/.aws` provider). Deployed
  envs use the task role and are immune.

---

## Outstanding rotations

- **OpenAI key** — printed in the same 2026-07-23 pytest leak; present in **both**
  environments' secrets, and the local value originates from the shell profile.
  Same procedure; not yet done. Masking (`SecretStr`, PR #258) stops future
  leaks but does not un-expose the current value.
- **Secrets Manager migration** — the durable fix for both the plaintext-in-task-def
  exposure and console-based rotation. Tracked in the todos.
