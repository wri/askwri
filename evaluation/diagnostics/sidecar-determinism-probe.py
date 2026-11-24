"""Item 8 (#498): is the LLM understanding sidecar stable across samples?

`understanding_llm.build_understanding_llm` is @lru_cache'd per process, so
repeating an eval against ONE deployment always reports identical results —
that measures the cache, not the model. The risk this probe looks for is that
each DEPLOY draws one sample and freezes it for the process lifetime. So it
calls the real sidecar K times per eval question with the cache cleared between
samples, and diffs the fields that change retrieval: intent, facets, variants,
core_topic.

Requires the search-service venv and OPENAI_API_KEY. Run from the repo root:

  PYTHONPATH=$PWD/search-service OPENAI_API_KEY=... \\
    search-service/venv/bin/python evaluation/diagnostics/sidecar-determinism-probe.py

Writes nothing; prints the summary and (with PROBE_OUT) the per-query samples.
Result on 2026-11-24, gpt-5.4-mini, QA's eval sets: 16/27 queries unstable
(variants 14, facets 7, core_topic 3, intent 1) — see
evaluation/baselines/2026-11-24-flag-on-vs-off-qa.md.
"""
K = int(os.environ.get("PROBE_K", "3"))
queries = []
for name in ("evalset_cite_01.json", "evalset_cite_02.json"):
    d = json.load(open(f"evaluation/eval-review/evalsets/{name}"))
    for tc in d["test_cases"]:
        if "question" in tc:
            queries.append((name, tc["id"], tc["question"]))

from app.understanding_llm import build_understanding_llm as f

def fingerprint(o):
    if o is None:
        return None
    return {
        "intent": o.get("intent"),
        "facets": sorted(json.dumps(x.model_dump() if hasattr(x, "model_dump") else x, sort_keys=True) for x in (o.get("facets") or [])),
        "variants": list(o.get("variants") or []),
        "core_topic": o.get("core_topic"),
    }

diff = collections.Counter()
unstable = []
records = []
for setname, cid, q in queries:
    samples = []
    for _ in range(K):
        f.cache_clear()
        try:
            samples.append(fingerprint(f(q)))
        except Exception as e:  # failure-soft: record, don't abort
            samples.append({"error": str(e)[:80]})
    records.append({"set": setname, "id": cid, "query": q, "samples": samples})
    first = json.dumps(samples[0], sort_keys=True)
    if any(json.dumps(s, sort_keys=True) != first for s in samples[1:]):
        unstable.append(cid)
        for field in ("intent", "facets", "variants", "core_topic"):
            vals = [json.dumps(s.get(field), sort_keys=True) if isinstance(s, dict) else None for s in samples]
            if len(set(vals)) > 1:
                diff[field] += 1

out = {"k": K, "queries": len(queries), "unstable": unstable, "by_field": dict(diff), "records": records}
path = os.environ["PROBE_OUT"]
json.dump(out, open(path, "w"), indent=2)
print(f"queries={len(queries)} k={K} unstable={len(unstable)}/{len(queries)} fields={dict(diff)}")
print("unstable ids:", ", ".join(unstable) if unstable else "(none)")
