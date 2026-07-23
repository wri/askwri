import asyncio
import logging
from datetime import datetime, timezone
import os
import time
import pickle
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager
from app.env import load_env
import certifi
import httpx

# Load environment variables from .env file
load_env()  # local dev: .env.local then .env into os.environ (see app/env.py)

# SSL Certificate workaround for Zscaler VPN
# This handles corporate proxy/VPN environments that insert custom SSL certificates
# Reference: https://community.openai.com/t/ssl-certificate-verify-failed/32442/47
# Only enabled when USE_CUSTOM_SSL_CLIENT=true
_use_custom_ssl_client = os.getenv("USE_CUSTOM_SSL_CLIENT", "false").lower() == "true"
_ca_bundle = None

def setup_ssl_certificates():
    """
    Configure SSL certificates for environments with custom CA certificates (e.g., Zscaler VPN).
    Checks for system CA bundle first, falls back to certifi, or allows custom path via env var.
    """
    # Check for custom CA bundle path (allows override via environment)
    custom_ca_bundle = os.getenv("CUSTOM_CA_BUNDLE")

    # Common system CA bundle locations
    system_ca_paths = [
        "/etc/ssl/certs/ca-certificates.crt",  # Debian/Ubuntu
        "/etc/pki/tls/certs/ca-bundle.crt",    # RHEL/CentOS
        "/etc/ssl/ca-bundle.pem",               # OpenSUSE
        "/etc/ssl/cert.pem",                    # Alpine/macOS
    ]

    ca_bundle_path = None

    if custom_ca_bundle and os.path.exists(custom_ca_bundle):
        ca_bundle_path = custom_ca_bundle
    else:
        # Check system paths
        for path in system_ca_paths:
            if os.path.exists(path):
                ca_bundle_path = path
                break

    # Fall back to certifi if no system bundle found
    if not ca_bundle_path:
        ca_bundle_path = certifi.where()

    # Set environment variables that various libraries check
    os.environ["REQUESTS_CA_BUNDLE"] = ca_bundle_path
    os.environ["SSL_CERT_FILE"] = ca_bundle_path
    os.environ["CURL_CA_BUNDLE"] = ca_bundle_path

    return ca_bundle_path

# Initialize SSL certificates before any API calls (only if enabled)
if _use_custom_ssl_client:
    _ca_bundle = setup_ssl_certificates()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
# Import caching system
from app.cache_system import AskWRICache

# Import query expansion for domain-specific term mapping
from app.query_expansion import expand_query_conservative

# LlamaIndex imports
from llama_index.core import (
    VectorStoreIndex,
    StorageContext,
    load_index_from_storage
)
from llama_index.core.retrievers import VectorIndexRetriever
from llama_index.retrievers.bm25 import BM25Retriever
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle
from llama_index.embeddings.openai import OpenAIEmbedding

from app.bedrock_rerank import BedrockReranker
from app.config import get_settings

settings = get_settings()

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

def validate_environment():
    """Validate required environment variables are set"""
    required_vars = ["OPENAI_API_KEY"]
    missing = [var for var in required_vars if not os.getenv(var)]

    if missing:
        error_msg = f"Missing required environment variables: {', '.join(missing)}"
        logger.error(error_msg)
        logger.error("Please set these in your .env file or system environment")
        raise ValueError(error_msg)

# Global service state
service_state = {
    "vector_index": None,
    "bm25_retriever": None,
    "hybrid_retriever": None,
    "reranker_answer": None,
    "reranker_cite": None,
    "documents_metadata": {},
    "document_texts": {},
    "evaluation_data": None,
    "cache": AskWRICache(cache_dir=settings.cache_dir),
    "indexing_in_progress": False,
    "indexing_error": None,
    "indexing_task": None,
    "pg_dense_ready": False,
    "embed_model": None,
    # Dense-lane degradation marker (sparse-only fallback, 2026-07-22):
    # set on a dense retrieve failure, cleared on the next success.
    "dense_degraded_at": None,
    "dense_error": None,
}

class QueryRequest(BaseModel):
    query: str
    mode: str = "cite"  # "answer" or "cite"
    max_results: int = 150  # Default for 203-doc corpus
    similarity_threshold: float = 0.0
    include_metadata: bool = True
    vector_top_k: int = 500  # Configurable vector retrieval limit
    bm25_top_k: int = 500  # Configurable BM25 retrieval limit
    rerank_top_n: int = 200  # Configurable reranker limit
    rerank: bool = True
    # Hybrid-specific parameters
    dense_weight: float = 0.5
    sparse_weight: float = 0.5
    fusion_top_k: Optional[int] = None  # RRF fusion limit (None = mode default: 500 cite, 100 answer)
    # Metadata filtering
    min_year: Optional[int] = None  # Filter documents by minimum publication year
    max_year: Optional[int] = None  # Filter documents by maximum publication year
    excluded_keywords: Optional[List[str]] = None  # Keywords to exclude from results
    required_program: Optional[str] = None  # Filter by program_series (e.g., "World Resources Report")
    # Filtering for answer mode
    cite_doc_ids: Optional[List[str]] = None  # List of doc_ids to filter results (answer mode)
    # Diagnostic parameter
    return_intermediate_results: bool = False  # Return stage-by-stage results for debugging

class DocumentResult(BaseModel):
    doc_id: str
    title: str
    content: str
    score: float
    metadata: Dict[str, Any]
    page: Optional[int] = None
    chunk_id: Optional[str] = None

class QueryResponse(BaseModel):
    docs: List[DocumentResult]
    total_results: int
    query: str
    mode: str
    debug: Dict[str, Any]
    # Optional diagnostic fields
    vector_results: Optional[List[Dict[str, Any]]] = None
    bm25_results: Optional[List[Dict[str, Any]]] = None
    fusion_results: Optional[List[Dict[str, Any]]] = None
    reranked_results: Optional[List[Dict[str, Any]]] = None

class HybridFusionRetriever(BaseRetriever):
    """Custom hybrid retriever combining dense and sparse results using RRF"""

    def __init__(
        self,
        vector_retriever: VectorIndexRetriever,
        bm25_retriever: BM25Retriever,
        mode: str = "cite",
        similarity_threshold: float = 0.0,
        dense_weight: Optional[float] = None,
        sparse_weight: Optional[float] = None,
        fusion_top_k: Optional[int] = None,
        bm25_top_k: Optional[int] = None,
        **kwargs
    ):
        super().__init__(**kwargs)
        self.vector_retriever = vector_retriever
        self.bm25_retriever = bm25_retriever
        self.mode = mode
        self.similarity_threshold = similarity_threshold
        self.bm25_top_k = bm25_top_k

        # Weights default to 0.5/0.5 if not specified by caller
        self.dense_weight = dense_weight if dense_weight is not None else 0.5
        self.sparse_weight = sparse_weight if sparse_weight is not None else 0.5

        # fusion_top_k: caller controls via preset; fall back to mode defaults
        if fusion_top_k is not None:
            self.fusion_top_k = fusion_top_k
        elif mode == "answer":
            self.fusion_top_k = 100
        else:
            self.fusion_top_k = 500

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        """Retrieve nodes using hybrid fusion with RRF"""
        import concurrent.futures

        # BM25 query expansion (done before threading — pure string work)
        expanded_query = expand_query_conservative(query_bundle.query_str, max_expansions=3)
        if expanded_query != query_bundle.query_str:
            logger.info(f"Query expansion: {query_bundle.query_str[:50]}... → {expanded_query[:80]}...")
        expanded_bundle = QueryBundle(query_str=expanded_query)

        # Run dense + sparse retrieval in parallel, timing each lane
        # (L0 instrumentation: dense vs sparse were indistinguishable in the
        # old coarse stage1 timer). self is per-request — attrs are race-free.
        self.timings = {}

        def _timed(fn, key, arg):
            def run():
                t0 = time.time()
                out = fn(arg)
                self.timings[key] = round((time.time() - t0) * 1000, 1)
                return out
            return run

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            dense_future = executor.submit(
                _timed(self.vector_retriever.retrieve, "dense_ms", query_bundle))
            sparse_future = executor.submit(
                _timed(self.bm25_retriever.retrieve, "sparse_ms", expanded_bundle))
            # Post-cutover the dense lane is a Bedrock API call with no local
            # fallback (query embed via BedrockCohereQueryEmbedding). Degrade
            # to sparse-only rather than 500 — mirrors the rerank lane's
            # degradation to fused (decision 2026-07-22). Sparse-only is
            # English-keyword-only, so surface it via /health, not silently.
            try:
                dense_results = dense_future.result()
                service_state["dense_degraded_at"] = None
                service_state["dense_error"] = None
            except Exception as exc:  # noqa: BLE001 — any embed/DB failure degrades, sparse still raises below
                from datetime import datetime, timezone
                logger.warning(
                    f"Dense lane failed ({exc}) — serving sparse-only results (degraded)"
                )
                service_state["dense_degraded_at"] = datetime.now(timezone.utc).isoformat()
                service_state["dense_error"] = str(exc)
                dense_results = []
            sparse_results = sparse_future.result()

        # Slice BM25 results to requested top_k (BM25Retriever is a singleton built
        # at startup with similarity_top_k=1000; per-request limit applied here)
        if self.bm25_top_k is not None:
            sparse_results = sparse_results[:self.bm25_top_k]

        logger.info(f"Dense retrieval: {len(dense_results)} results")
        logger.info(f"Sparse retrieval: {len(sparse_results)} results")

        # Apply RRF (Reciprocal Rank Fusion)
        fused_scores = {}

        # Process dense results
        for i, node_with_score in enumerate(dense_results):
            node_id = node_with_score.node.node_id
            rrf_score = self.dense_weight * (1.0 / (60 + i + 1))  # k=60 is standard
            fused_scores[node_id] = fused_scores.get(node_id, 0) + rrf_score

        # Process sparse results
        for i, node_with_score in enumerate(sparse_results):
            node_id = node_with_score.node.node_id
            rrf_score = self.sparse_weight * (1.0 / (60 + i + 1))
            fused_scores[node_id] = fused_scores.get(node_id, 0) + rrf_score

        # Combine and sort by fused score
        all_nodes = {node.node.node_id: node for node in dense_results + sparse_results}

        # Sort by fused score and take top k
        sorted_nodes = sorted(
            fused_scores.items(),
            key=lambda x: x[1],
            reverse=True
        )[:self.fusion_top_k]

        # Create final results
        final_results = []
        for node_id, score in sorted_nodes:
            if node_id in all_nodes:
                node_with_score = all_nodes[node_id]
                node_with_score.score = score
                final_results.append(node_with_score)

        logger.info(f"Hybrid fusion: {len(final_results)} final results")
        return final_results

def apply_metadata_filters(
    nodes: List[NodeWithScore],
    min_year: Optional[int] = None,
    max_year: Optional[int] = None,
    excluded_keywords: Optional[List[str]] = None,
    required_program: Optional[str] = None
) -> List[NodeWithScore]:
    """
    Apply metadata-based filtering to retrieved nodes

    Args:
        nodes: List of nodes with scores from retrieval
        min_year: Minimum publication year (inclusive)
        max_year: Maximum publication year (inclusive)
        excluded_keywords: Keywords to exclude (checks title, content, metadata)
        required_program: Required program_series value

    Returns:
        Filtered list of nodes
    """
    filtered = []

    for node_with_score in nodes:
        metadata = node_with_score.node.metadata or {}

        # Year filtering
        if min_year is not None or max_year is not None:
            doc_year = metadata.get('year')
            if doc_year is not None:
                try:
                    year_int = int(doc_year)
                    if min_year and year_int < min_year:
                        continue
                    if max_year and year_int > max_year:
                        continue
                except (ValueError, TypeError):
                    # If year can't be parsed, exclude it if year filter is strict
                    continue

        # Program series filtering
        if required_program is not None:
            doc_program = metadata.get('program_series', '')
            if doc_program != required_program:
                continue

        # Excluded keywords filtering
        if excluded_keywords:
            title = metadata.get('title', '').lower()
            content = node_with_score.node.text.lower()

            # Check if any excluded keyword appears in title or content
            has_excluded = False
            for keyword in excluded_keywords:
                keyword_lower = keyword.lower()
                if keyword_lower in title or keyword_lower in content:
                    has_excluded = True
                    break

            if has_excluded:
                continue

        filtered.append(node_with_score)

    return filtered

def get_passage_with_context(chunk_text: str, full_document_text: str, context_chars: int = 200) -> str:
    """Get chunk text with surrounding context from the full document"""
    # Try to find the position of the chunk in the full document
    # First try exact match with first 100 chars
    chunk_pos = full_document_text.find(chunk_text[:100])

    if chunk_pos == -1:
        # Try with first 50 chars (more tolerant)
        chunk_pos = full_document_text.find(chunk_text[:50])

    if chunk_pos == -1:
        # Try with normalized whitespace (remove extra spaces/newlines)
        normalized_chunk = ' '.join(chunk_text.split())[:50]
        normalized_doc_words = ' '.join(full_document_text.split())
        chunk_pos = normalized_doc_words.find(normalized_chunk)
        if chunk_pos != -1:
            # Convert back to original position (approximate)
            words_before = len(normalized_doc_words[:chunk_pos].split())
            doc_words = full_document_text.split()
            if words_before < len(doc_words):
                # Find approximate position by word count
                chunk_pos = full_document_text.find(doc_words[words_before]) if words_before < len(doc_words) else -1

    if chunk_pos == -1:
        # If all matching fails, return just the chunk with debug marker
        return f"**[{chunk_text}]** (context match failed)"

    # Calculate start and end positions for context
    context_start = max(0, chunk_pos - context_chars)
    chunk_end = chunk_pos + len(chunk_text)
    context_end = min(len(full_document_text), chunk_end + context_chars)

    # Extract the passage with context
    before_context = full_document_text[context_start:chunk_pos]
    after_context = full_document_text[chunk_end:context_end]

    # Clean up context boundaries (try to break on sentence boundaries)
    if before_context and context_start > 0:
        # Find last sentence boundary in before context
        sentence_break = max(before_context.rfind('. '), before_context.rfind('.\n'))
        if sentence_break > len(before_context) // 2:  # Only if it's not too far back
            before_context = before_context[sentence_break + 1:].lstrip()

    if after_context and context_end < len(full_document_text):
        # Find first sentence boundary in after context
        sentence_break = after_context.find('. ')
        if sentence_break != -1 and sentence_break < len(after_context) // 2:
            after_context = after_context[:sentence_break + 1]

    # Combine with visual separators for the target passage
    result = ""
    if before_context.strip():
        result += before_context.strip() + " "

    result += "**[" + chunk_text + "]**"  # Mark the actual passage

    if after_context.strip():
        result += " " + after_context.strip()

    return result

def init_rerankers():
    """Build mode-specific Bedrock Rerank clients. Returns (answer, cite).

    v3 (spec §4): rerank is Cohere Rerank 3.5 via the Bedrock Rerank API for
    BOTH modes — nothing is loaded in-process, so this is instant. top_n
    matches the prior mode defaults; the candidate cut happens inside
    BedrockReranker (settings.rerank_candidates).
    """
    reranker_answer = BedrockReranker(
        top_n=20, per_doc_cap=settings.answer_rerank_per_doc_cap
    )
    reranker_cite = BedrockReranker(
        top_n=1000, per_doc_cap=settings.cite_rerank_per_doc_cap
    )
    logger.info(
        f"✅ Bedrock rerankers ready ({settings.bedrock_rerank_model_id} in "
        f"{settings.bedrock_rerank_region}; candidates={settings.rerank_candidates}, "
        f"cite per-doc cap={settings.cite_rerank_per_doc_cap}, "
        f"answer per-doc cap={settings.answer_rerank_per_doc_cap})"
    )
    return reranker_answer, reranker_cite


def load_documents_and_build_indexes():
    """Load documents and build both dense and sparse indexes (synchronous, runs in thread pool)"""
    global service_state

    # Validate environment before proceeding
    validate_environment()

    logger.info("Starting document processing and index building...")

    from app.indexing import load_csv_metadata, prepare_documents, build_nodes

    service_state["documents_metadata"] = load_csv_metadata(settings.documents_local_dir)
    cache = service_state.get("cache")
    documents = prepare_documents(service_state["documents_metadata"], cache, settings.documents_local_dir)
    logger.info(f"Prepared {len(documents)} documents for indexing")

    # Build vector index (using existing embeddings approach)
    # Optionally create httpx client with SSL certificates for Zscaler VPN compatibility
    if _use_custom_ssl_client and _ca_bundle:
        http_client = httpx.Client(verify=_ca_bundle)
        embed_model = OpenAIEmbedding(
            model="text-embedding-3-small",
            api_key=os.getenv("OPENAI_API_KEY"),
            http_client=http_client
        )
    else:
        embed_model = OpenAIEmbedding(
            model="text-embedding-3-small",
            api_key=os.getenv("OPENAI_API_KEY")
        )

    document_texts = {doc["doc_id"]: doc["text"] for doc in documents}
    nodes, content_hash = build_nodes(documents, cache)
    logger.info(f"Created {len(nodes)} chunks from {len(documents)} documents")

    # Check if we have any nodes to index
    if not nodes:
        logger.warning("⚠️ No nodes created - service will run without indexes")
        service_state["vector_index"] = None
        service_state["bm25_retriever"] = None
        service_state["reranker_answer"] = None
        service_state["reranker_cite"] = None
        service_state["document_texts"] = {}
        return

    # Try to load cached index to avoid expensive OpenAI calls
    # Use content hash from nodes to create unique cache key
    index_cache_path = cache.indexes_dir / f"{content_hash}_vector_index"

    if index_cache_path.exists():
        try:
            start_time = time.time()
            cache_size_gb = sum(f.stat().st_size for f in index_cache_path.rglob('*') if f.is_file()) / (1024**3)

            logger.info(f"✅ Loading cached vector index from disk - no OpenAI calls needed!")
            logger.info(f"   📦 Cache size: {cache_size_gb:.2f} GB")
            logger.info(f"   ⏳ Loading {len(nodes)} nodes - this may take 2-5 minutes for large indexes...")

            logger.info(f"   [1/3] Loading storage context...")
            step_start = time.time()
            storage_context = StorageContext.from_defaults(persist_dir=str(index_cache_path))
            logger.info(f"   ✓ Storage context loaded in {time.time() - step_start:.1f}s")

            logger.info(f"   [2/3] Loading vector index...")
            step_start = time.time()

            # Check if we have a pickled embeddings cache (much faster than JSON)
            pickle_path = index_cache_path / "embeddings.pkl"
            if pickle_path.exists():
                logger.info(f"      Using fast pickle format for embeddings...")
                # Load embeddings from pickle and inject into storage
                with open(pickle_path, 'rb') as f:
                    embeddings_dict = pickle.load(f)
                # Monkey-patch the storage context's vector store data
                if hasattr(storage_context, '_vector_stores') and 'default' in storage_context._vector_stores:
                    storage_context._vector_stores['default']._data.embedding_dict = embeddings_dict
                    logger.info(f"      ✓ Loaded {len(embeddings_dict)} embeddings from pickle cache")

            vector_index = load_index_from_storage(storage_context, embed_model=embed_model)
            logger.info(f"   ✓ Vector index loaded in {time.time() - step_start:.1f}s")

            logger.info(f"   [3/3] Verifying index integrity...")
            logger.info(f"✅ Loaded cached index with {len(nodes)} nodes in {time.time() - start_time:.1f}s total")
        except Exception as e:
            logger.warning(f"⚠️ Failed to load cached index: {e}")
            logger.info(f"🔄 Creating new embeddings for {len(nodes)} nodes - this will take a moment...")
            vector_index = VectorStoreIndex(
                nodes=nodes,
                embed_model=embed_model
            )
            # Cache the new index
            vector_index.storage_context.persist(persist_dir=str(index_cache_path))

            # Also save embeddings in fast pickle format for next startup
            logger.info(f"💾 Caching embeddings in pickle format for faster loading...")
            pickle_path = index_cache_path / "embeddings.pkl"
            if hasattr(vector_index.storage_context, '_vector_stores') and 'default' in vector_index.storage_context._vector_stores:
                embeddings_dict = vector_index.storage_context._vector_stores['default']._data.embedding_dict
                with open(pickle_path, 'wb') as f:
                    pickle.dump(embeddings_dict, f, protocol=pickle.HIGHEST_PROTOCOL)
                logger.info(f"💾 Cached vector index + pickle embeddings to disk for future use")
    else:
        logger.info(f"🔄 Creating new embeddings for {len(nodes)} nodes - this will take a moment...")
        # Build vector index (this will call OpenAI)
        vector_index = VectorStoreIndex(
            nodes=nodes,
            embed_model=embed_model
        )

        # Cache the index to disk
        vector_index.storage_context.persist(persist_dir=str(index_cache_path))

        # Also save embeddings in fast pickle format for next startup
        logger.info(f"💾 Caching embeddings in pickle format for faster loading...")
        pickle_path = index_cache_path / "embeddings.pkl"
        if hasattr(vector_index.storage_context, '_vector_stores') and 'default' in vector_index.storage_context._vector_stores:
            embeddings_dict = vector_index.storage_context._vector_stores['default']._data.embedding_dict
            with open(pickle_path, 'wb') as f:
                pickle.dump(embeddings_dict, f, protocol=pickle.HIGHEST_PROTOCOL)
            logger.info(f"💾 Cached vector index + pickle embeddings to disk for future use")

    # Build BM25 index
    logger.info(f"📊 Building BM25 sparse index...")
    step_start = time.time()
    bm25_retriever = BM25Retriever.from_defaults(
        nodes=nodes,
        similarity_top_k=1000  # High limit for recall (BM25 not dynamically configurable)
    )
    logger.info(f"✅ BM25 index built in {time.time() - step_start:.1f}s")

    # Initialize rerankers
    reranker_answer, reranker_cite = init_rerankers()

    # Store in global state
    service_state["vector_index"] = vector_index
    service_state["bm25_retriever"] = bm25_retriever
    service_state["reranker_answer"] = reranker_answer
    service_state["reranker_cite"] = reranker_cite
    service_state["document_texts"] = document_texts

    logger.info("Successfully built indexes and initialized rerankers")

def load_from_postgres():
    """Postgres-backed boot: no CSV, no PDF parsing, no OpenAI calls at startup.

    Dense retrieval happens per-query against pgvector (PgVectorRetriever);
    BM25 is hydrated from document_chunks rows; full texts and metadata come
    from document_texts / documents.
    """
    global service_state
    from app import pg_store

    logger.info("Loading retrieval state from Postgres...")

    if settings.embedding_model == "cohere-embed-v4":
        # v3 dense lane: query encode is a Bedrock API call (spec §4) — the
        # search-service stays model-free.
        from app.bedrock_embed import BedrockCohereQueryEmbedding

        embed_model = BedrockCohereQueryEmbedding()
    elif _use_custom_ssl_client and _ca_bundle:
        http_client = httpx.Client(verify=_ca_bundle)
        embed_model = OpenAIEmbedding(
            model="text-embedding-3-small",
            api_key=os.getenv("OPENAI_API_KEY"),
            http_client=http_client,
        )
    else:
        embed_model = OpenAIEmbedding(
            model="text-embedding-3-small",
            api_key=os.getenv("OPENAI_API_KEY"),
        )

    if settings.keyword_backend == "sparse":
        from app.db import get_pool
        from app.pg_store import SparseKeywordRetriever

        with get_pool().connection() as conn:
            populated = conn.execute(
                """SELECT count(*) FROM document_chunks dc
                   JOIN documents d ON d.id = dc.document_id
                   WHERE d.status = 'searchable' AND dc.sparse IS NOT NULL"""
            ).fetchone()[0]
            null_sparse = conn.execute(
                """SELECT count(*) FROM document_chunks dc
                   JOIN documents d ON d.id = dc.document_id
                   WHERE d.status = 'searchable' AND dc.sparse IS NULL"""
            ).fetchone()[0]
        if not populated:
            raise RuntimeError(
                "KEYWORD_BACKEND=sparse but document_chunks.sparse is unpopulated — "
                "run scripts/build_sparse_keyword.py first"
            )
        if null_sparse:
            # NULL rows are safely excluded from keyword retrieval, so partial
            # coverage must not fail boot — but make it loudly visible.
            logger.warning(
                f"{null_sparse} searchable chunks have sparse IS NULL and are "
                "excluded from keyword retrieval — run "
                "scripts/build_sparse_keyword.py to backfill"
            )
        bm25_retriever = SparseKeywordRetriever(similarity_top_k=1000)
        logger.info(f"📊 Keyword lane: Postgres sparse ({populated} chunks; no in-memory build)")
    else:
        nodes = pg_store.load_nodes()
        if not nodes:
            raise RuntimeError("No searchable chunks in Postgres — run the migration script first")
        logger.info("📊 Building BM25 sparse index from Postgres chunks...")
        bm25_retriever = BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=1000)

    reranker_answer, reranker_cite = init_rerankers()

    service_state["documents_metadata"] = pg_store.load_documents_metadata()
    service_state["document_texts"] = pg_store.load_document_texts()
    service_state["bm25_retriever"] = bm25_retriever
    service_state["reranker_answer"] = reranker_answer
    service_state["reranker_cite"] = reranker_cite
    service_state["embed_model"] = embed_model
    service_state["vector_index"] = None
    service_state["pg_dense_ready"] = True
    _warm_backends()
    logger.info(f"✅ Postgres-backed retrieval ready ({len(service_state['document_texts'])} documents)")


def _warm_backends():
    """Best-effort boot warmup (L0 latency): pre-build the Bedrock clients
    and do one tiny embed so the first user query doesn't pay client
    construction + TLS handshakes (~200-500ms cold tail). Never fails boot —
    without creds (local dev) it logs and moves on; the tuned botocore
    timeouts keep the failure fast."""
    import time as _time

    t0 = _time.time()
    try:
        from app import bedrock_embed, bedrock_rerank

        bedrock_rerank.get_client()
        if settings.embedding_model == "cohere-embed-v4":
            bedrock_embed.embed_query("warmup")
        logger.info(f"🔥 Bedrock clients warmed in {_time.time() - t0:.2f}s")
    except Exception as exc:  # noqa: BLE001 — warmup is advisory
        logger.warning(f"Bedrock warmup skipped ({exc}) — first query pays the cold start")
    try:
        from app.db import get_pool

        with get_pool().connection() as conn:
            conn.execute("SELECT 1")
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"DB warmup skipped ({exc})")


async def _run_indexing_in_background():
    """Background task to load documents and build indexes in a thread pool"""
    global service_state
    service_state["indexing_in_progress"] = True
    service_state["indexing_error"] = None
    try:
        logger.info("Background indexing started (running in thread pool)...")
        # Run blocking code in thread pool to avoid blocking the event loop
        if settings.retrieval_backend == "postgres":
            await asyncio.to_thread(load_from_postgres)
        else:
            await asyncio.to_thread(load_documents_and_build_indexes)
        logger.info("Background indexing complete")
    except Exception as e:
        logger.error(f"Background indexing failed: {e}")
        service_state["indexing_error"] = str(e)
    finally:
        service_state["indexing_in_progress"] = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize the service on startup"""
    # Startup
    logger.info(f"Starting Search Service - Environment: {settings.environment}")
    try:
        logger.info("Initializing AskWRI Search Service...")
        # Start indexing in background without blocking
        service_state["indexing_task"] = asyncio.create_task(_run_indexing_in_background())
        logger.info("Background indexing task started - service is now accepting requests")
        yield
    except Exception as e:
        logger.error(f"Failed to initialize service: {e}")
        raise
    finally:
        # Cancel indexing task if still running
        if service_state.get("indexing_task") and not service_state["indexing_task"].done():
            service_state["indexing_task"].cancel()
            try:
                await service_state["indexing_task"]
            except asyncio.CancelledError:
                logger.info("Indexing task cancelled during shutdown")
        logger.info("Shutting down service")

app = FastAPI(
    title="AskWRI Search Service",
    description="Multi-stage retrieval with dense + sparse fusion and local reranking",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/api/search/docs",
    openapi_url="/api/search/openapi.json",
)

# Configure CORS allowed origins based on environment
if settings.environment.lower() in {"development", "dev", "test", "qa"}:
    allowed_origins = ["*"]
else:
    # In production-like environments, restrict CORS to the Next.js backend URL
    allowed_origins = [settings.nextjs_backend_url]

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    """Root endpoint with service info"""
    return {
        "service": "AskWRI Search Service",
        "version": "2.0.0",
        "status": "running",
        "endpoints": {
            "health": "/health",
            "query": "/query (POST)",
            "api/embeddings/query": "/api/embeddings/query (POST) - Compatible with existing AskWRI interface",
            "stats": "/stats",
            "docs": "/docs"
        }
    }


# Health check endpoint (root level for ALB health checks)
@app.get("/health")
async def health_check():
    """Health check endpoint for ALB and container health checks."""
    indexing_in_progress = service_state.get("indexing_in_progress", False)
    indexing_error = service_state.get("indexing_error")
    indexes_ready = (
        (service_state["vector_index"] is not None or bool(service_state.get("pg_dense_ready"))) and
        service_state["bm25_retriever"] is not None
    )

    # Determine overall status
    if indexing_error:
        status = "degraded - indexing error"
    elif indexing_in_progress:
        status = "initializing"
    elif indexes_ready:
        status = "healthy"
    else:
        status = "degraded - indexes not ready"

    return {
        "status": status,
        "service": "AskWRI Search Service",
        "environment": settings.environment,
        "keyword_backend": settings.keyword_backend,
        "retrieval_backend": settings.retrieval_backend,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": "2.0.0",
        "indexing": {
            "in_progress": indexing_in_progress,
            "error": indexing_error,
            "ready": indexes_ready
        },
        "indexes_loaded": {
            "vector_index": service_state["vector_index"] is not None or bool(service_state.get("pg_dense_ready")),
            "bm25_retriever": service_state["bm25_retriever"] is not None,
        },
        "documents_count": len(service_state["documents_metadata"]),
        "document_texts_count": len(service_state["document_texts"]),
        "rerankers_loaded": {
            "answer_mode": service_state["reranker_answer"] is not None,
            "cite_mode": service_state["reranker_cite"] is not None,
        },
        "dense_lane": ({"status": "degraded",
                        "degraded_at": service_state["dense_degraded_at"],
                        "error": service_state["dense_error"]}
                       if service_state.get("dense_degraded_at")
                       else {"status": "live"}),
        "cache_stats": service_state["cache"].get_cache_stats() if service_state.get("cache") else {}
    }

def make_dense_retriever(top_k: int):
    """Dense lane: pgvector-backed or legacy in-memory, per settings."""
    if settings.retrieval_backend == "postgres":
        from app.pg_store import PgVectorRetriever
        return PgVectorRetriever(
            embed_model=service_state["embed_model"], similarity_top_k=top_k
        )
    return VectorIndexRetriever(
        index=service_state["vector_index"], similarity_top_k=top_k
    )


def _emit_query_emf(mode: str, debug: dict) -> None:
    """CloudWatch EMF metric line for per-stage /query latency histograms
    (L0 instrumentation). Pure-JSON stdout line — the ECS awslogs driver
    ships it and CloudWatch parses the embedded metric format; locally it
    is one log line per query. Best-effort: never fails a request."""
    if not settings.emit_emf_metrics:
        return
    try:
        import json as _json

        lanes = debug.get("lane_timings") or {}
        metrics = {
            "total_ms": debug.get("total_ms"),
            "stage1_ms": (debug.get("stage1_time") or 0) * 1000,
            "rerank_ms": (debug.get("stage2_time") or 0) * 1000,
            "dense_ms": lanes.get("dense_ms"),
            "sparse_ms": lanes.get("sparse_ms"),
            "embed_ms": lanes.get("embed_ms"),
            "dense_db_ms": lanes.get("dense_db_ms"),
            "passage_ms": debug.get("passage_ms"),
        }
        metrics = {k: round(v, 1) for k, v in metrics.items() if v is not None}
        if not metrics:
            return
        print(_json.dumps({
            "_aws": {
                "Timestamp": int(time.time() * 1000),
                "CloudWatchMetrics": [{
                    "Namespace": "AskWRI/Query",
                    "Dimensions": [["mode"]],
                    "Metrics": [{"Name": k, "Unit": "Milliseconds"}
                                for k in metrics],
                }],
            },
            "mode": mode,
            **metrics,
        }), flush=True)
    except Exception:  # noqa: BLE001 — metrics must never break /query
        logger.debug("EMF emit failed", exc_info=True)


@app.post("/query", response_model=QueryResponse)
async def hybrid_query(request: QueryRequest):
    """
    Hybrid retrieval with two-stage processing:
    Stage 1: Dense + Sparse fusion with RRF
    Stage 2: Local reranking with mode-specific cross-encoders
    """

    dense_ready = service_state["vector_index"] is not None or service_state.get("pg_dense_ready")
    if not dense_ready or not service_state["bm25_retriever"]:
        raise HTTPException(status_code=500, detail="Service not properly initialized")

    request_start = time.time()
    try:
        logger.info(f"Processing hybrid query: '{request.query}' (mode: {request.mode})")

        query_bundle = QueryBundle(query_str=request.query)

        # Capture individual retriever results if diagnostic mode
        vector_only_results = None
        bm25_only_results = None

        if request.return_intermediate_results:
            # Stage 1a: Vector search only
            vector_retriever_temp = make_dense_retriever(request.vector_top_k)
            vector_only_results = await asyncio.to_thread(
                vector_retriever_temp.retrieve, query_bundle
            )
            logger.info(f"Diagnostic - Vector only: {len(vector_only_results)} results")

            # Stage 1b: BM25 search only
            bm25_only_results = await asyncio.to_thread(
                service_state["bm25_retriever"].retrieve, query_bundle
            )
            logger.info(f"Diagnostic - BM25 only: {len(bm25_only_results)} results")

        # Stage 1: Hybrid Fusion Retrieval
        stage1_start = time.time()
        vector_retriever = make_dense_retriever(request.vector_top_k)

        hybrid_retriever = HybridFusionRetriever(
            vector_retriever=vector_retriever,
            bm25_retriever=service_state["bm25_retriever"],
            mode=request.mode,
            similarity_threshold=request.similarity_threshold,
            dense_weight=request.dense_weight,
            sparse_weight=request.sparse_weight,
            fusion_top_k=request.fusion_top_k,
            bm25_top_k=request.bm25_top_k,
        )

        # Retrieve with hybrid fusion (worker thread — keeps the event loop
        # free for /health and concurrent requests)
        stage1_results = await asyncio.to_thread(
            hybrid_retriever.retrieve, query_bundle
        )
        stage1_elapsed = time.time() - stage1_start

        logger.info(f"Stage 1 (Hybrid Fusion): {len(stage1_results)} results in {stage1_elapsed:.1f}s")

        # If answer mode and cite_doc_ids provided, filter stage1_results
        if request.mode == "answer" and request.cite_doc_ids:
            before_filter = len(stage1_results)
            stage1_results = [n for n in stage1_results if n.node.metadata.get("doc_id") in request.cite_doc_ids]
            logger.info(f"Answer mode: Filtered to cite_doc_ids ({before_filter} -> {len(stage1_results)})")

        # Stage 2: Reranking (Bedrock Cohere Rerank — 0-1 relevance scores).
        # rerank_applied gates the cite floor/tiers downstream: they are
        # calibrated on the 0-1 relevance scale, and unreranked results carry
        # raw RRF scores (~0.008-0.03) that would all land below the floor.
        rerank_applied = False
        if request.rerank and stage1_results:
            base_reranker = (service_state["reranker_answer"] if request.mode == "answer"
                            else service_state["reranker_cite"])

            if base_reranker:
                try:
                    stage2_start = time.time()
                    # BedrockReranker (and the e2e stub): per-call top_n, no
                    # global mutation; candidate cut happens inside the client.
                    # The rerank is a blocking boto3 round-trip (~0.5s) — run
                    # in a worker thread so the event loop stays responsive
                    # (d214f3f adapted to the Bedrock reranker).
                    stage2_results = await asyncio.to_thread(
                        base_reranker.postprocess_nodes,
                        stage1_results, query_bundle, top_n=request.rerank_top_n
                    )
                    rerank_applied = True
                    stage2_elapsed = time.time() - stage2_start
                    logger.info(f"Stage 2 (Reranking): {len(stage2_results)} results from {len(stage1_results)} candidates in {stage2_elapsed:.1f}s")
                except Exception as e:
                    logger.warning(f"Reranking failed: {e}, using Stage 1 results")
                    stage2_results = stage1_results
            else:
                stage2_results = stage1_results
        else:
            stage2_results = stage1_results

        # Stage 2.1: Page-1 demotion for answer mode (abstracts → lower priority)
        if request.mode == "answer" and stage2_results:
            for node in stage2_results:
                chunk_idx = node.node.metadata.get("chunk_index", 0)
                if chunk_idx == 0:
                    node.score = node.score * 0.5
            # Re-sort after demotion
            stage2_results.sort(key=lambda n: n.score, reverse=True)
            logger.info(f"Stage 2.1 (Page-1 Demotion): applied to answer mode")

        # Stage 2.5: Apply metadata filters (year, program, excluded keywords)
        if (request.min_year or request.max_year or
            request.excluded_keywords or request.required_program):
            pre_filter_count = len(stage2_results)
            stage2_results = apply_metadata_filters(
                stage2_results,
                min_year=request.min_year,
                max_year=request.max_year,
                excluded_keywords=request.excluded_keywords,
                required_program=request.required_program
            )
            logger.info(f"Stage 2.5 (Metadata Filters): {pre_filter_count} → {len(stage2_results)} results")

        # Apply final filtering and limits - be more inclusive for cite mode
        if request.mode == "cite":
            # Group chunks by document and take best scoring chunk per document
            doc_groups = {}
            for node in stage2_results:
                doc_id = node.node.metadata.get("doc_id")
                if doc_id not in doc_groups or node.score > doc_groups[doc_id].score:
                    doc_groups[doc_id] = node

            # Floor + tiers are calibrated on the reranker's 0-1 relevance
            # scale — apply them only when reranking actually ran. Unreranked
            # results (rerank=false diagnostics, reranker outage fallback)
            # pass through unfloored and untier'd (relevance_tier is optional
            # in the contract).
            if rerank_applied:
                pre_floor = len(doc_groups)
                doc_groups = {k: v for k, v in doc_groups.items()
                              if v.score >= settings.cite_logit_floor}
                logger.info(f"Stage 3 (Relevance Floor {settings.cite_logit_floor}): {pre_floor} → {len(doc_groups)} docs")

                for node in doc_groups.values():
                    raw = node.score
                    if raw >= settings.cite_strong_threshold:
                        tier = "strong"
                    elif raw >= settings.cite_partial_threshold:
                        tier = "partial"
                    else:
                        tier = "weak"
                    node.node.metadata["relevance_tier"] = tier
            else:
                # Legacy in-memory mode shares node objects across requests —
                # drop any tier a previous reranked query stamped on them.
                for node in doc_groups.values():
                    node.node.metadata.pop("relevance_tier", None)
                logger.info("Stage 3 (Relevance Floor): skipped — results not reranked")

            filtered_results = list(doc_groups.values())[:request.max_results]
        else:
            # Answer mode: strip summary nodes — they helped retrieval find the
            # right documents but their content (title+summary) isn't a real PDF
            # passage and shouldn't be shown to users or fed to synthesis.
            stage2_results = [n for n in stage2_results
                              if not n.node.metadata.get("is_summary_node", False)]
            # Relevance filtering happens in the Next.js answer route (nano LLM filter)
            filtered_results = stage2_results[:request.max_results]

        # Convert to response format
        docs = []

        # Normalize scores to 0-1 range for user-friendly comparison
        if filtered_results:
            max_score = float(max(node.score for node in filtered_results))
            min_score = float(min(node.score for node in filtered_results))
            score_range = max_score - min_score if max_score != min_score else 1.0

        passage_start = time.time()
        for node_with_score in filtered_results:
            node = node_with_score.node
            metadata = node.metadata or {}

            # Normalize score with mode-specific strategy
            raw_score = float(node_with_score.score or 0.0)  # Convert to Python float
            if filtered_results and score_range > 0:
                # Standard min-max normalization: (score - min) / (max - min)
                normalized_score = float((raw_score - min_score) / score_range)

                # Mode-specific adjustment:
                # - Answer mode: Use full [0, 1] range for strong signal separation
                # - Cite mode: Apply relevance floor [0.15, 1.0] to show all results have some relevance
                if request.mode == "cite" and normalized_score < 1.0:
                    # Map [0, 1] → [0.15, 1.0] so minimum score is 0.15 instead of 0
                    normalized_score = 0.15 + (normalized_score * 0.85)

                # Clamp to [0, 1] to handle any edge cases
                normalized_score = max(0.0, min(1.0, normalized_score))
            else:
                normalized_score = 1.0 if raw_score > 0 else 0.0

            # Get passage with surrounding context from full document
            doc_id = metadata.get("doc_id", "")
            document_texts = service_state.get("document_texts", {})
            full_doc_text = document_texts.get(doc_id, "")

            # If document text not found in memory, try to load from cache
            if not full_doc_text and doc_id:
                cache = service_state.get("cache")
                if cache:
                    # We need to find the URL to get cached text
                    # For now, skip this fallback and let restart fix the issue
                    pass

            # Always try to add context for better passage preview
            # Skip context lookup for summary nodes — their text is title+summary,
            # not a passage from the PDF, so find() will fail or match incorrectly.
            is_summary = metadata.get("is_summary_node", False)
            if full_doc_text and not is_summary:
                content_with_context = get_passage_with_context(node.text, full_doc_text, context_chars=150)

                # Smart truncation that preserves markers
                if len(content_with_context) > 800:
                    # Find the closing marker position
                    closing_marker_pos = content_with_context.find(']**')
                    if closing_marker_pos != -1:
                        # Always truncate after the closing marker to preserve complete marked passage
                        truncate_pos = closing_marker_pos + 3  # Include the ']**'
                        if truncate_pos < len(content_with_context):
                            # Add some context after if space allows
                            extra_context = min(100, len(content_with_context) - truncate_pos)
                            truncate_pos += extra_context
                        content_with_context = content_with_context[:truncate_pos] + "..."
                    else:
                        # Fallback: normal truncation at 800 chars
                        content_with_context = content_with_context[:800] + "..."

                content = content_with_context
            else:
                logger.debug(f"No document text available for context in doc {doc_id}")
                content = node.text[:500] + "..." if len(node.text) > 500 else node.text

            doc_result = DocumentResult(
                doc_id=metadata.get("doc_id", "unknown"),
                chunk_id=metadata.get("chunk_id", "unknown"),
                title=metadata.get("title", "Untitled"),
                content=content,
                score=round(normalized_score, 4),  # Round to 4 decimal places like embeddings
                metadata={**metadata, "raw_score": raw_score},  # Keep raw score for debugging
                page=metadata.get("page", 1)
            )
            docs.append(doc_result)

        logger.info(f"Returning {len(docs)} final results")

        # Format intermediate results for diagnostics
        def format_intermediate_results(results):
            """Convert NodeWithScore list to simple dict format for diagnostics"""
            if not results:
                return []
            formatted = []
            for node_with_score in results:
                node = node_with_score.node
                metadata = node.metadata or {}
                formatted.append({
                    "doc_id": metadata.get("doc_id", "unknown"),
                    "doc_title": metadata.get("title", ""),
                    "score": float(node_with_score.score or 0.0),
                    "chunk_id": node.node_id
                })
            return formatted

        # Build response with optional intermediate results
        response_data = {
            "docs": docs,
            "total_results": len(docs),
            "query": request.query,
            "mode": request.mode,
            "cite_doc_ids": request.cite_doc_ids,
            "debug": {
                "service_version": "2.0.0",
                "retrieval_method": "hybrid_fusion_rrf",
                "stage1_results": len(stage1_results),
                "stage2_results": len(stage2_results) if 'stage2_results' in locals() else len(stage1_results),
                "final_results": len(docs),
                "reranking_applied": request.rerank and service_state.get(f"reranker_{request.mode}") is not None,
                "similarity_threshold": request.similarity_threshold,
                "stage1_time": round(stage1_elapsed, 2) if 'stage1_elapsed' in locals() else None,
                "stage2_time": round(stage2_elapsed, 2) if 'stage2_elapsed' in locals() else None,
                # L0 latency instrumentation: per-lane and per-stage splits
                # the coarse stage timers can't provide.
                "lane_timings": {
                    **getattr(hybrid_retriever, "timings", {}),
                    "embed_ms": getattr(
                        getattr(hybrid_retriever, "vector_retriever", None),
                        "embed_ms", None),
                    "dense_db_ms": getattr(
                        getattr(hybrid_retriever, "vector_retriever", None),
                        "db_ms", None),
                },
                "passage_ms": round((time.time() - passage_start) * 1000, 1)
                              if 'passage_start' in locals() else None,
                "total_ms": round((time.time() - request_start) * 1000, 1),
                "mode_config": {
                    "dense_weight": request.dense_weight,
                    "sparse_weight": request.sparse_weight,
                    "fusion_top_k": request.fusion_top_k,
                    "cite_filtering": "minimal" if request.mode == "cite" else "threshold_based"
                }
            }
        }
        _emit_query_emf(request.mode, response_data["debug"])

        # Add intermediate results if diagnostic mode
        if request.return_intermediate_results:
            response_data["vector_results"] = format_intermediate_results(vector_only_results) if vector_only_results else []
            response_data["bm25_results"] = format_intermediate_results(bm25_only_results) if bm25_only_results else []
            response_data["fusion_results"] = format_intermediate_results(stage1_results)
            response_data["reranked_results"] = format_intermediate_results(stage2_results) if 'stage2_results' in locals() else []

        return QueryResponse(**response_data)

    except Exception as e:
        logger.error(f"Query processing failed: {e}")
        raise HTTPException(status_code=500, detail=f"Query processing failed: {str(e)}")


# Compatible endpoint for existing AskWRI interface
class EmbeddingsRequest(BaseModel):
    query: str
    mode: str = "answer"
    max_results: Optional[int] = 37
    similarity_threshold: Optional[float] = 0.05
    include_metadata: Optional[bool] = True
    rerank: Optional[bool] = True

@app.post("/api/embeddings/query")
async def embeddings_query(request: EmbeddingsRequest):
    """
    Embeddings query endpoint compatible with existing AskWRI interface.
    This transforms our hybrid retrieval results into the format expected by AskWriApp.tsx
    """

    dense_ready = service_state["vector_index"] is not None or service_state.get("pg_dense_ready")
    if not dense_ready or not service_state["bm25_retriever"]:
        raise HTTPException(status_code=500, detail="Service not properly initialized")

    try:
        # Use our existing hybrid query logic
        query_req = QueryRequest(
            query=request.query,
            mode=request.mode,
            top_k=request.max_results
        )

        # Get results from our hybrid system
        hybrid_results = await hybrid_query(query_req)

        # Transform to the format expected by the existing interface
        docs = []
        for doc in hybrid_results.docs:
            # Transform each result to match LlamaCloud format
            transformed_doc = {
                "doc_id": doc["doc_id"],
                "document_id": doc["doc_id"],
                "ref": ''.join(c if c.isalnum() else '_' for c in doc["doc_id"])[:64],
                "title": doc["title"],
                "url": doc["metadata"].get("url", ""),
                "_url": doc["metadata"].get("file_path", ""),
                "host": None,
                "authors": doc["metadata"].get("authors", "").split(";") if doc["metadata"].get("authors") else None,
                "year": doc["metadata"].get("year"),
                "source": doc["metadata"].get("subtag", ""),
                "summary": doc["metadata"].get("summary", ""),
                "score": doc["score"],
                "kps": [{
                    "kp_relevance": doc["score"],
                    "snippet": doc["content"],
                    "page": doc.get("page", 1),
                    "passage_id": doc.get("chunk_id", doc["doc_id"]),
                    "citation_targets": [{
                        "score": doc["score"],
                        "page": doc.get("page", 1),
                        "passage_id": doc.get("chunk_id", doc["doc_id"])
                    }]
                }],
                "meta": {
                    "raw": doc["metadata"],
                    "hybrid_retrieval": True,
                    "chunk_info": {
                        "chunk_id": doc.get("chunk_id"),
                        "chunk_index": doc["metadata"].get("chunk_index"),
                        "total_chunks": doc["metadata"].get("total_chunks")
                    } if doc.get("chunk_id") else None
                }
            }
            docs.append(transformed_doc)

        # Return in the format expected by the existing API
        return {
            "docs": docs,
            "total_results": len(docs),
            "query": request.query,
            "mode": request.mode,
            "debug": {
                "hybrid_retrieval": True,
                "service_version": "2.0.0",
                **hybrid_results.debug
            },
            "usage": None  # Retrieval-only: no LLM tokens consumed
        }

    except Exception as e:
        logger.error(f"Embeddings query processing failed: {e}")
        raise HTTPException(status_code=500, detail=f"Embeddings query processing failed: {str(e)}")

@app.get("/api/embeddings/query")
async def embeddings_health():
    """Health check for embeddings endpoint"""
    return {
        "status": "healthy",
        "service": "hybrid-retrieval-embeddings-api",
        "version": "2.0.0",
        "documents_count": len(service_state["documents_metadata"]),
        "indexes_loaded": {
            "vector_index": service_state["vector_index"] is not None,
            "bm25_retriever": service_state["bm25_retriever"] is not None,
        }
    }

@app.get("/stats")
async def get_stats():
    """Get detailed service statistics"""
    return {
        "status": "ready",
        "service": "askwri-hybrid-retrieval",
        "version": "2.0.0",
        "documents_loaded": len(service_state["documents_metadata"]),
        "indexes": {
            "vector_index_ready": service_state["vector_index"] is not None or bool(service_state.get("pg_dense_ready")),
            "bm25_retriever_ready": service_state["bm25_retriever"] is not None,
        },
        "rerankers": {
            "answer_mode_ready": service_state["reranker_answer"] is not None,
            "cite_mode_ready": service_state["reranker_cite"] is not None,
        },
        "embedding_model": "text-embedding-3-small",
        "retrieval_method": "hybrid_fusion_rrf_with_reranking",
        "evaluation_frameworks": ["ranx", "ragas", "trulens"]
    }

# Single-flight guard for /reindex: concurrent calls (e.g. several publish
# stages finishing together) must not stack rebuilds. The load functions
# update service_state keys sequentially after the expensive work completes —
# not atomically — so a query racing a rebuild may briefly observe a mix of
# old and new state (GIL keeps each individual assignment safe). Queries no
# longer see CLEARED state during a rebuild, which is what the old
# clear-then-rebuild code caused.
_reindex_lock = asyncio.Lock()


@app.post("/reindex")
async def trigger_reindex():
    """
    Trigger a full re-index of all documents
    This will reload the CSV, rebuild caches, and recreate all indexes
    """
    if _reindex_lock.locked():
        return JSONResponse(status_code=409, content={"status": "already_running"})
    async with _reindex_lock:
        try:
            logger.info("[Reindex] Starting full re-index...")

            # Re-run startup logic in thread pool
            if settings.retrieval_backend == "postgres":
                await asyncio.to_thread(load_from_postgres)
            else:
                await asyncio.to_thread(load_documents_and_build_indexes)

            logger.info("[Reindex] Re-index complete")

            return {
                "status": "success",
                "documents_indexed": len(service_state["documents_metadata"]),
                "indexes_rebuilt": {
                    "vector_index": service_state["vector_index"] is not None,
                    "bm25_retriever": service_state["bm25_retriever"] is not None,
                }
            }
        except Exception as e:
            logger.error(f"[Reindex] Failed: {e}")
            raise HTTPException(status_code=500, detail=f"Reindex failed: {str(e)}")


# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": "Internal server error",
            "detail": str(exc) if settings.debug else "An unexpected error occurred",
        },
    )


if __name__ == "__main__":
    import uvicorn
    
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.debug,
        workers=settings.workers if not settings.debug else 1,
    )
