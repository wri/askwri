# AskWRI Model Inventory & Migration Plan

**Scope:** every model the system calls, where it's configured, deprecation status (Aug 2026), and the recommended path. Stay within OpenAI for inference/generation; OCR/embed/rerank (Mistral/Cohere-via-Bedrock) are out of scope.

## Inventory (Aug 2026, from source)

**Inference — OpenAI** (all via `OPENAI_API_KEY`):

| Job | File | Default | Override |
|---|---|---|---|
| Answer synthesis (user-facing) | `src/app/api/answer/route.ts` | `gpt-5.4` | `OPENAI_MODEL` (+ optional `gpt-5.4-nano` pre-filter, off) |
| Why / batch-why | `why/route.ts`, `batch-why/route.ts` | `gpt-4o-mini` | `OPENAI_MODEL_WHY` → `OPENAI_MODEL` |
| Relates / batch-relates | `batch-relates/route.ts` | `gpt-4o-mini` | `OPENAI_MODEL_RELATES` → `OPENAI_MODEL` |
| Translation | `translate/route.ts` | `gpt-5-mini` | `OPENAI_MODEL_TRANSLATE` → `OPENAI_MODEL` |
| Alignment | `alignment/route.ts` | `gpt-5-mini` | `OPENAI_MODEL_ALIGNMENT` → `OPENAI_MODEL` |
| Worker: summaries + classify | `search-service/app/config.py:103` | `gpt-5.6-luna` (PR pending) | `WORKER_LLM_MODEL` |
| Worker: query translation (disabled) | `config.py:96` | `gpt-5-mini` | `query_translation_model` |

**Non-OpenAI (out of scope):** embeddings `cohere-embed-v4` (Bedrock `cohere.embed-v4:0`), rerank `cohere.rerank-v3-5:0`, OCR `mistral-ocr-latest` — all in `search-service/app/config.py`.

**Cost/energy accounting:** `src/config/costs.ts` (default `openai/gpt-4o-mini`, stale `MODEL_PRICING`) and `src/config/energy.ts` (stale `MODEL_DEFAULTS`) — both fall back silently for unknown models.

**Terraform:** `worker_llm_model` in `variables.tf` (+ `qa.tfvars` pin pending). App-tier models come from `OPENAI_MODEL*` in the app task def's secret env.

## Deprecation facts (OpenAI API docs, Aug 2026)

- `gpt-4o-mini` and `gpt-5-mini` **aliases are not deprecated in the API** — only dated snapshots retire (e.g. `gpt-5-mini-2025-08-07` → Dec 11 2026, replacement `gpt-5.6-terra`).
- `gpt-4o-2024-05-13` retires Oct 23 2026 → `gpt-5.6-sol`.
- GPT-4o/4.1/o4-mini retired from **ChatGPT** Feb 2026; **no API change then**.
- Legacy ≠ broken, but migrate. OpenAI: "for new projects, start with gpt-5.6."

## Current OpenAI models (Aug 2026)

- `gpt-5.6` = `gpt-5.6-sol` — flagship, ~$5/$30/1M
- `gpt-5.6-terra` — mid, ~$2/$12
- `gpt-5.6-luna` — cost/high-volume, ~$0.20/$1.20
- `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-nano` (~$0.05/$0.40) — prev gen, current

Structured Outputs (required by `chat_json`, `alignment`, `relates`) supported on all GPT-5.x.

## Recommended mapping

| Use case | Model | Eval-gated |
|---|---|---|
| Answer synthesis | `gpt-5.6` | **Yes** (tone/length side-by-side) |
| Why / batch-why | `gpt-5.6-terra` | Yes (explanation spot-check) |
| Relates / batch-relates | `gpt-5.6-luna` | Yes (extraction spot-check) |
| Translation | `gpt-5.6-luna` | **Yes** (es/pt/zh spot-check) |
| Alignment | `gpt-5.6-luna` | Yes (structured + timeout) |
| Worker: summaries + classify | `gpt-5.6-luna` | Yes (scoped reclassify) |
| Answer nano pre-filter | `gpt-5.4-nano` (keep) | No |

**Global default** (currently missing): `gpt-5.6-luna` for most routes; `gpt-5.6` only for answer synthesis. Land via a shared `getOpenAIModel(route)` helper after the per-route PRs.

## PR sequence

1. **Worker → gpt-5.6-luna** (in flight). `config.py`, `variables.tf`, `qa.tfvars`, `topicsAdmin.ts` (EST_PER_DOC_COST 0.0008→0.0002). QA: scoped reclassify, check the log names the model.
2. **Cost/energy accounting** — `costs.ts`/`energy.ts` defaults + price maps; `.env.example` `OPENAI_MODEL` off `gpt-4o-mini`.
3. **Why/batch-why + relates** off `gpt-4o-mini` → `gpt-5.6-terra` / `gpt-5.6-luna`.
4. **Translate + alignment** off `gpt-5-mini` → `gpt-5.6-luna`.
5. **Answer synthesis** → `gpt-5.6` (eval-gated, user-facing).
6. **Shared `getOpenAIModel(route)` helper** — the global default, after 3-5 land.

## Open risks

- Eval-gated: answer, translate — don't change without a QA eval on real content.
- Eval harness (`gpt-4o*`, `claude-haiku-4-5`): not deployed; rerunning breaks on retired snapshots.
- `query_translation_model` (disabled): the >3s timeout note is model-coupled; re-baseline if enabled.
- Bedrock/Cohere/Mistral: out of scope here; same staleness check applies separately.
