# AskWRI Local Development TODO

## Evaluation System

### Synthesis eval cannot run without missing Next.js API routes
- `run-answer-synthesis-eval.py` depends on `/api/llamaindex` (health check) and `/api/answer` (synthesis)
- These routes don't exist in this repo — they were in the upstream
- The answer API endpoints may be changing upstream, so porting them here may not make sense
- **Options to decouple from Next.js:**
  1. Add a `/synthesize` endpoint to the Python search service — it already has OpenAI access, just needs a prompt + retrieved passages -> answer
  2. Call OpenAI directly in the eval script — inline the synthesis step, no API layer needed
  3. Use a lightweight standalone synthesis function shared between eval and app
- Retrieval evals (cite + answer-retrieval) already work without Next.js — they call the Python service directly
- **Decision needed:** Which approach best fits the evolving answer API design?

### Quick eval broken: missing `llm-relevance-filter` module
- `run-cite-eval-quick.ts` imports `filterByLLMRelevance` from `../src/lib/llm-relevance-filter`
- That module doesn't exist in this repo (not brought over from upstream)
- Full cite eval (`run-cite-eval.ts`) works fine — doesn't use this module
- **Fix:** Either port the module or remove the dependency from the quick eval

## Local Dev Setup Notes

### S3 document sync workaround
- Production syncs docs from `s3://askwri-data/` via `start.sh` (AWS CLI)
- Locally, PDFs must be placed in `/tmp/askWRI_docs/` manually
- CSV expects flat filenames (`doc_000001.pdf`) but local copy has them in `documents/` subfolder
- **Current workaround:** symlinks from `/tmp/askWRI_docs/documents/*.pdf` to `/tmp/askWRI_docs/`
- Note: macOS clears `/tmp` on reboot — symlinks will need to be recreated

### Dead LlamaCloud references
- `src/lib/llamacloud.ts` — functions are dead code, only type definitions still imported
- `.env` keys `LLAMA_CLOUD_API_KEY`, `PIPELINE_ID`, `LLAMA_CLOUD_BASE` — unused, safe to remove
- `package.json` `hybrid` script points to nonexistent `hybrid-service/` directory

## Eval Baseline (2026-02-10, local run)

### Cite Mode (11 queries)
- Passed: 3/11
- Precision: 15.8% (target: 35%)
- Recall: 78.4% (target: 75%)

### Answer Retrieval (2 stub queries)
- Doc Precision: 13.4%, Recall: 100%
- Chunk Precision: 2.0%, Recall: 100%
