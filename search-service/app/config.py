from functools import lru_cache

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# Per-row document_chunks.embedding_model values and their vector dimensions.
# Both models keep scoped HNSW indexes during the cutover window (spec v3 §8.1).
EMBEDDING_DIMENSIONS = {
    "cohere-embed-v4": 1536,
    "text-embedding-3-small": 1536,
}


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), env_file_encoding="utf-8", extra="ignore")

    # Application
    environment: str = "development"
    debug: bool = False
    port: int = 8000
    workers: int = 1
    log_level: str = "info"
    
    # Next.js Backend URL for communication
    nextjs_backend_url: str = "http://localhost:3000"

    # SecretStr so the value never renders in repr()/str(). BaseSettings has no
    # custom __repr__, so any exception embedding the settings object prints
    # every field — on 2026-07-23 a monkeypatch AttributeError in a routine
    # pytest run printed this key and the Mistral one in plaintext.
    # Consumers read os.getenv("OPENAI_API_KEY") directly, so nothing unwraps
    # this field today; it is declared for validation and must stay masked.
    OPENAI_API_KEY: SecretStr = SecretStr("")

    # Document storage paths (override for local dev, e.g. DOCUMENTS_LOCAL_DIR=./data)
    documents_local_dir: str = "/tmp/askWRI_docs"
    cache_dir: str = "/tmp/askWRI_cache"

    # Postgres-backed retrieval (Phase 0 cutover)
    database_url: str = ""          # postgresql://user:pass@host:5432/db (append ?sslmode=require for RDS)
    retrieval_backend: str = "legacy"  # "legacy" (CSV + boot-time build) | "postgres"

    # Keyword lane residency (postgres retrieval backend only):
    # "sparse" = Postgres-resident BM25 impact vectors in document_chunks.sparse,
    #            filtered per-query (status='searchable'); requires
    #            scripts/build_sparse_keyword.py to have run at least once.
    #            Rollback: set KEYWORD_BACKEND=memory to revert to legacy path.
    # "memory" = in-memory bm25s built at boot//reindex (legacy behavior, kept intact)
    keyword_backend: str = "sparse"  # "sparse" (default) | "memory"

    # English handles into SPARSE weights only (spec 2026-07-26 §3): when
    # true, build_sparse_keyword.py and the worker embed stage append
    # title_en (+ the curated English long summary, summary chunk only) to
    # the text that feeds sparse tokenization for language != 'en' docs.
    # Dense embeddings, chunk text and /query are untouched. Default OFF:
    # flag-off rebuild restores byte-identical current weights (rollback).
    sparse_en_handles: bool = False

    # Translation-pair suggestion thresholds (issue #325). Title is the primary
    # trigger; embedding is a high-bar secondary for retitled near-duplicates.
    # Measured on qa 2026-08-13: known pairs' embedding cosines span 0.63-0.76
    # while revised editions/country series reach 0.85-0.95.
    relation_title_threshold: float = 0.75
    relation_embed_threshold: float = 0.85

    # Query-time translation-pair filtering (issue #325). OFF by default:
    # activation is eval-gated (#333) — run cite+answer evals flag-off then
    # flag-on on the same harness before enabling in any environment.
    # Rollback is flag off; no reindex either way.
    translation_pairs_enabled: bool = False

    # Query-side translation for the SPARSE lane only (cross-lingual, 2026-07-24).
    # The BM25 lane is English-only by construction, so an English query cannot
    # match a Spanish body — not because the stemmer cannot handle Spanish, but
    # because nothing ever hands it Spanish. Translating the query moved bm25
    # rank 93->1 / 61->2 / 43->1 and recovered 3 outright misses on a 10-pair
    # probe. Dense (cohere-embed-v4) is already multilingual and is NOT affected.
    # Ships dark: disabled -> build_sparse_query is byte-identical to
    # expand_query_conservative.
    # DO NOT ENABLE AS-IS: sparse-only routing did not fix the cost — P7 left
    # the −42% result-list shrinkage unchanged and the flag-on cite eval (P8)
    # regressed recall 83.3 → 76.5, because RRF scores by rank and translated
    # terms push English chunks down the one sparse ranking (findings
    # 2026-07-24 §4). Enabling requires a separate translated RRF lane (the
    # recorded design direction), not this toggle. Also: zh translation is
    # useless to the sparse lane (CJK tokenizes as whole clauses).
    query_translation_enabled: bool = False
    query_translation_languages: str = "es,pt,zh"   # corpus languages, comma-separated
    # This default model+timeout PAIR is known-unusable: gpt-5-mini measured
    # >3s for a one-line translation (findings §5 Operational), so at 3.0s
    # every first-hit translation times out and degrades to the untranslated
    # query. Kept as the failure-soft reference config; a real enablement
    # needs a faster model or a precomputed dictionary.
    query_translation_model: str = "gpt-5-mini"
    query_translation_timeout_s: float = 3.0

    # Query understanding (design 2026-08-19). Dark by default: flag-off is
    # byte-identical to the pre-feature pipeline (guarded by
    # tests/test_understanding.py + the P1 gate's flag-off eval run).
    # P1 ships the deterministic tier only (facet parsers, trigram
    # did-you-mean, tag-embedding topic sensing). Cost of enabling (P1): two
    # small SQL lookups + one cached embed reuse per query; no LLM call.
    query_understanding_enabled: bool = False
    # Initial conservative thresholds — MUST be re-derived from the labeled
    # fixture sets (tests/fixtures/didyoumean_queries.json,
    # facet_queries.json) before any flag-on deploy; never hand-tuned.
    spell_suggest_similarity: float = 0.45
    # df floor for correction targets: a suggested term must appear at least
    # this many times across titles/tags/aliases. Blocks 'corrections' of
    # ordinary English words to one-off title terms. Cost of raising it:
    # misspellings of rare-but-real corpus terms stop getting suggestions.
    spell_suggest_min_df: int = 2
    topic_sense_top_k: int = 3
    topic_sense_min_cosine: float = 0.30
    # P2/P2.5 multi-lane fusion (design 2026-08-19 §4.3). Dark by default;
    # active only when query_understanding_enabled is ALSO on (lanes_active()).
    # Cost of enabling: one tag_aliases SELECT per query (diagnostic) plus,
    # when topic_sense matches tags, one TopicTagRetriever DB query (docs-by-tag)
    # and 2x weight on the original lanes. Flag-on ALSO retires
    # DOMAIN_EXPANSIONS OR-stuffing on the original sparse lane (the gated
    # retirement, spec §4.3). Flag-off is byte-identical, OR-stuffing included.
    query_expansion_lanes_enabled: bool = False
    # Which facets get a semantic retrieval lane (one lane per matching facet).
    # Default topic-only = P2.5 byte-identical. Add 'geography' to enable the
    # geo lane (gated, P2.6). No per-facet flag; the master flag above gates all.
    expansion_facets: list[str] = ["topic"]
    # Alias-expansion caps — mirror expand_query_conservative's shape
    # (3 groups x 2 terms) so what replaces it is auditable against it.
    alias_expand_max_groups: int = 3
    alias_expand_max_terms: int = 2

    # P3 LLM understanding sidecar (design 2026-08-19 §4.1, §7). Dark by
    # default; active only when query_understanding_enabled is ALSO on.
    # One strict json_schema OpenAI call per query, lru_cached, short
    # timeout, one attempt (no retry loop in the request path, design §5).
    # Model is a small fast current-gen model via the existing OpenAI path
    # (design decision #5 — NOT Bedrock/Haiku). gpt-5.4-mini: OpenAI's fast
    # mini (2x faster than gpt-5-mini), clean variants, valid structured JSON.
    # LLM facets are suggest-only (slice 1) so facet noise is invisible;
    # variants (the retrieval win) are clean. Measured ~0.8-1.0s vs
    # gpt-5.6-luna ~2-3s. Swap is an env/code change, not a contract change.
    # Flag-off is byte-identical to the deterministic-only tier.
    query_understanding_llm_enabled: bool = False
    query_understanding_llm_model: str = "gpt-5.4-mini"
    query_understanding_llm_timeout_s: float = 4.0

    # Slice 5a (design §4.3 + user direction 2026-08-25): per-mode
    # expansion-lane RRF weight. Cite (recall-first) = 1.0 — the current
    # effective behavior (lanes at 1x, originals at 2x) that produced the
    # +10.6 MAP win. Answer (precision-first) = 0.25 — fewer candidates, a
    # tighter rerank pool for known-item/quantitative answers. The 2x
    # original multiplier stays (the recall-vs-precision asymmetry that bounds
    # displacement). EXPANSION_LANE_WEIGHT env overrides both (back-compat
    # with qa.tfvars, where it's currently a dead knob — not read by code).
    cite_expansion_lane_weight: float = 1.0
    answer_expansion_lane_weight: float = 0.25

    # Phase 1 ingestion worker
    worker_poll_seconds: int = 10
    worker_max_attempts: int = 3
    worker_reap_minutes: int = 15              # requeue 'running' jobs idle longer than this
    worker_llm_model: str = "gpt-5.6-luna"   # summaries + tagging; override in env
    intake_s3_prefix: str = "intake/"          # watched S3 prefix (bulk drop)
    intake_local_dir: str = ""                 # local-dev alternative to S3 intake
    documents_s3_bucket: str = ""              # reuse the existing env var name
    documents_s3_prefix: str = "documents/"
    tag_confidence_accept: float = 0.7         # >= -> accepted, else suggested
    tag_candidate_top_n: int = 20              # retrieve-then-classify candidate set size
    tag_reclassify_concurrency: int = 4        # reclassify_jobs claim parallelism
    tag_embed_batch_size: int = 100            # one-time/batch tag-embedding build
    classify_topic_only: bool = False          # restrict a classify run to the topic facet
    reclassify_poll_first: bool = True          # poll reclassify_jobs before ingestion_jobs
    quality_min_chars_per_page: int = 200      # extraction_confidence gate input

    # Dense embedding model for BOTH worker chunk writes and query-side
    # retrieval (spec v3 §4: Cohere embed-v4 via Bedrock — an API call, no
    # self-hosted model). The English bm25s sparse lane is independent of
    # this and unchanged. Rollback: EMBEDDING_MODEL=text-embedding-3-small
    # while the 3-small rows/index still exist.
    embedding_model: str = "cohere-embed-v4"

    # PDF parse backend (bake-off 2026-07-22, spec §7 amendment):
    # "pypdf" (legacy text-layer extraction, current default until the
    # Phase 1 retrieval gate passes) | "mistral" (Mistral OCR markdown,
    # per-page emission — parser page indices fix the R4 zh page-boundary
    # bug). pypdf remains the validation oracle either way.
    parse_backend: str = "pypdf"
    # SecretStr (see OPENAI_API_KEY above). Unwrap via _mistral_auth_header()
    # in worker/stages/parse.py — a bare f-string would interpolate the mask.
    mistral_api_key: SecretStr = SecretStr("")
    mistral_ocr_model: str = "mistral-ocr-latest"
    # Parse cache escape hatch (issue #310 follow-up). The parse stage reuses a
    # stored document_texts row when its cache stamps match the document's
    # content_hash and the current backend/model, skipping the download + OCR
    # call. FORCE_REPARSE=true bypasses the read path for a deliberate re-OCR
    # (e.g. after an OCR quality regression on an unchanged model id).
    force_reparse: bool = False

    # Bedrock placement for embed-v4 (spec v3 §5): infra is us-east-2 but
    # embed-v4 is not natively there — call the nearest hosting region
    # (cross-region, still in-AWS/IAM).
    bedrock_embed_region: str = "us-east-1"
    bedrock_embed_model_id: str = "cohere.embed-v4:0"
    # Per-call text batch for bulk document embeds (Cohere API cap 96 is the
    # ceiling). Large docs at 96 blow the tokens/min bucket and error whole
    # worker jobs — bulk re-ingests/re-embeds set 24 (with
    # AWS_RETRY_MODE=adaptive).
    bedrock_embed_batch_size: int = 96

    # Bedrock placement for Cohere Rerank 3.5 (spec v3 §5): not hosted in
    # us-east-2 — call the nearest hosting region.
    bedrock_rerank_region: str = "us-east-1"
    bedrock_rerank_model_id: str = "cohere.rerank-v3-5:0"

    # Candidate-set size sent to the Rerank API. Cost/latency scale with doc
    # count (spec §9: rerank dominates the per-query budget) — the fused RRF
    # list is cut to this many before the call.
    rerank_candidates: int = 100

    # Cite-mode candidate diversification: fused chunk lists cluster in a
    # handful of top docs (measured: 100 chunks from 5 docs on the golden
    # set), so cap each doc's chunks in the candidate set to spread the
    # slots across documents. Doc-level recall lever at unchanged API cost.
    # Answer mode is uncapped — it wants the best chunks wherever they live.
    cite_rerank_per_doc_cap: int = 2

    # Answer mode leaves this None by default (best chunks wherever they
    # live). Set > 0 to diversify the reranker candidate pool when embed-v4
    # concentrates a query's top chunks in one doc (ans_006: all 15 retrieved
    # chunks came from a single doc after the cutover). Value tuned via the
    # answer per-doc-cap A/B; None preserves the pre-existing behaviour.
    answer_rerank_per_doc_cap: int | None = None

    # Cite mode thresholds on Cohere Rerank's 0-1 relevance-score scale
    # (spec v3 §0.1: re-derived, NOT the old ms-marco raw logits — those
    # values, e.g. floor -9.0, would pass everything on this scale).
    # Derived 2026-07-22 from live-Bedrock score capture (11 golden cite
    # queries + 16-query non-EN smoke set, per-doc-capped candidates) and
    # re-derived after EACH corpus change — the floor moves every time the
    # chunk text or embedding model changes (0.08 on the 3-small corpus →
    # 0.10 post-embed-cutover → 0.09 post-Mistral-re-parse, which holds the
    # recall gate at R83.1 with P30.6/F1 44.7). Re-derive with
    # scripts/capture_cite_scores.py + analyze_cite_scores.py after any
    # candidate-pool change; the deployed cutover gets its own derivation.
    # TODO(golden-set): formal per-language floor/tier recalibration.
    cite_logit_floor: float = 0.09        # Drop docs below this relevance score
    cite_strong_threshold: float = 0.70
    cite_partial_threshold: float = 0.30

    # Cite mode: show a real passage for documents whose best-scoring chunk is
    # the synthetic summary node (title+summary), keeping the summary node's
    # score and tier so ranking is unchanged by construction. Answer mode has
    # stripped summary nodes since #140; cite mode never did (issue #233).
    #
    # Cost of enabling, measured 2026-07-27 on 50 cite queries (11 golden + 39
    # cross-lingual) against the real pipeline — see the issue for the harness:
    #  - document set, order, score, tier: IDENTICAL (the score is carried over)
    #  - changes ONLY `content`, `page` and `metadata.chunk_id` for the affected
    #    docs: 19/746 rows on live qa (1.0% of the golden set, 3.1% of the
    #    cross-lingual set, where it is rank 1 in 10 of 39 queries)
    #  - 15/16 affected docs had a real chunk in the reranked set to substitute;
    #    the remainder keep today's behaviour (summary text) rather than vanish
    # Default off so the merge is behaviour-neutral; activate via env/tfvars.
    cite_substitute_summary_passage: bool = False

    # CloudWatch EMF latency metrics: one pure-JSON stdout line per /query
    # with per-stage timings (L0 latency instrumentation). The ECS awslogs
    # driver ships it; CloudWatch parses the embedded metric format.
    emit_emf_metrics: bool = True

    # SSL/Zscaler VPN Workaround
    use_custom_ssl_client: bool = False
    custom_ca_bundle: str = ""

    @property
    def embedding_dimension(self) -> int:
        return EMBEDDING_DIMENSIONS[self.embedding_model]

@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
