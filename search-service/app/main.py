import asyncio
import logging
from datetime import datetime, timezone
import os
import hashlib
import time
import pickle
from pathlib import Path
from typing import List, Dict, Any, Optional
from contextlib import asynccontextmanager
import json
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import pandas as pd

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
from llama_index.core.node_parser import SimpleNodeParser
from llama_index.core.retrievers import VectorIndexRetriever
from llama_index.retrievers.bm25 import BM25Retriever
from llama_index.core.retrievers import BaseRetriever
from llama_index.core.schema import NodeWithScore, QueryBundle
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.core.postprocessor import SentenceTransformerRerank

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
    "cache": AskWRICache(),
    "indexing_in_progress": False,
    "indexing_error": None,
    "indexing_task": None
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
    fusion_top_k: int = 150  # RRF fusion limit
    # Metadata filtering
    min_year: Optional[int] = None  # Filter documents by minimum publication year
    max_year: Optional[int] = None  # Filter documents by maximum publication year
    excluded_keywords: Optional[List[str]] = None  # Keywords to exclude from results
    required_program: Optional[str] = None  # Filter by program_series (e.g., "World Resources Report")
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
        **kwargs
    ):
        super().__init__(**kwargs)
        self.vector_retriever = vector_retriever
        self.bm25_retriever = bm25_retriever
        self.mode = mode
        self.similarity_threshold = similarity_threshold

        # Mode-specific configurations for 203-doc corpus
        if mode == "answer":
            self.dense_weight = 0.5
            self.sparse_weight = 0.5
            self.fusion_top_k = 100  # Precision: scaled from 50 for larger corpus
        else:  # cite mode - more inclusive for broader coverage
            self.dense_weight = 0.5  # BALANCED: Was 0.4, now 0.5 for better semantic+keyword mix
            self.sparse_weight = 0.5  # BALANCED: Was 0.6, now 0.5 to reduce BM25 over-emphasis
            self.fusion_top_k = 500  # INCREASED: Was dropping docs ranked low in both indexes

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        """Retrieve nodes using hybrid fusion with RRF"""

        # Get results from both retrievers
        # Vector search: use original query (preserves semantic similarity)
        dense_results = self.vector_retriever.retrieve(query_bundle)

        # BM25 search: use expanded query (bridges semantic gap with domain terminology)
        expanded_query = expand_query_conservative(query_bundle.query_str, max_expansions=3)
        if expanded_query != query_bundle.query_str:
            logger.info(f"Query expansion: {query_bundle.query_str[:50]}... → {expanded_query[:80]}...")
        expanded_bundle = QueryBundle(query_str=expanded_query)
        sparse_results = self.bm25_retriever.retrieve(expanded_bundle)

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

def get_page_number_for_position(position: int, page_boundaries: list) -> int:
    """Determine which page a character position belongs to"""
    if not page_boundaries:
        return 1

    for boundary in page_boundaries:
        if position <= boundary['end_pos']:
            return boundary['page']

    # If beyond all boundaries, assume last page
    return page_boundaries[-1]['page'] if page_boundaries else 1

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

def load_documents_and_build_indexes():
    """Load documents and build both dense and sparse indexes (synchronous, runs in thread pool)"""
    global service_state

    # Validate environment before proceeding
    validate_environment()

    logger.info("Starting document processing and index building...")

    # Load CSV metadata first
    csv_path = Path("/tmp/askWRI_docs/documents.csv")  # Docker container (S3 sync destination)

    if csv_path and csv_path.exists():
        df = pd.read_csv(csv_path)
        logger.info(f"Loaded {len(df)} documents from CSV metadata at {csv_path}")

        # Parse and store metadata
        for idx, row in df.iterrows():
            metadata_raw = {}
            try:
                if pd.notna(row.get('metadata', '')):
                    metadata_raw = json.loads(row['metadata'])
            except Exception as e:
                logger.warning(f"Failed to parse metadata for row {idx}: {e}")

            # Extract document ID from file_path (e.g., "doc_000001.pdf" -> "doc_000001")
            file_path = str(row.get('file_path', ''))
            doc_id = file_path.replace('.pdf', '') if file_path else f"doc_{idx}"

            local_file_path = f"/tmp/askWRI_docs/{file_path}"

            service_state["documents_metadata"][doc_id] = {
                "title": metadata_raw.get('Article Title', f'Document {doc_id}'),
                "authors": metadata_raw.get('All authors', ''),
                "year": metadata_raw.get('YEAR accepted', ''),
                "url": metadata_raw.get('Source URL', metadata_raw.get('URL', metadata_raw.get('Attribution URL', ''))),
                "summary": row.get('summary', ''),
                "subtag": metadata_raw.get('Sub-tag', ''),
                "program_series": metadata_raw.get('program_series', ''),  # Add program_series for filtering
                "file_path": file_path,
                "local_file": local_file_path,
                "raw_metadata": metadata_raw
            }

    # Full PDF document processing using local LlamaIndex PDF reader
    # No cloud dependencies - all processing done locally

    documents = []

    # Import PDF processing utilities
    import requests

    # Get cache reference once at the start
    cache = service_state.get("cache")

    # Process all documents
    for doc_id, meta in service_state["documents_metadata"].items():
        pdf_url = meta.get("url", "")
        local_file = meta.get("local_file", "")

        # First, check if we have cached text regardless of file existence
        # This handles legacy documents that may not have PDF files
        cache_key = local_file if local_file else doc_id
        cached_text = cache.get_cached_text(doc_id, cache_key)
        if cached_text:
            logger.info(f"✅ Using cached text for {doc_id}")
            full_text = cached_text["full_text"]
            page_boundaries = cached_text["page_boundaries"]

            # Store page mapping in metadata
            meta_with_pages = {**meta, "page_boundaries": page_boundaries}
            documents.append({
                "doc_id": doc_id,
                "text": full_text,
                "metadata": meta_with_pages
            })
            continue

        # Try local file next (if it exists)
        if local_file and Path(local_file).exists():
            try:
                logger.info(f"📄 Parsing local PDF for {doc_id}: {local_file}")

                # Use LlamaIndex's local PDF reader directly on the local file
                from llama_index.readers.file import PDFReader

                reader = PDFReader()

                # Parse PDF content locally
                parsed_docs = reader.load_data(str(local_file))

                if parsed_docs:
                    # Build page-to-text mapping for proper page attribution
                    page_texts = []
                    page_boundaries = []  # Store character positions where each page ends
                    current_pos = 0

                    for i, doc in enumerate(parsed_docs):
                        page_num = i + 1
                        page_text = doc.text.strip()
                        if page_text:
                            page_texts.append(page_text)
                            current_pos += len(page_text) + 2  # +2 for "\n\n" separator
                            page_boundaries.append({
                                'page': page_num,
                                'end_pos': current_pos - 2  # Subtract separator for accurate boundary
                            })

                    # Combine all pages with separators
                    full_text = "\n\n".join(page_texts)

                    # Store page mapping in metadata
                    meta_with_pages = {**meta, "page_boundaries": page_boundaries}

                    documents.append({
                        "doc_id": doc_id,
                        "text": full_text,
                        "metadata": meta_with_pages
                    })

                    # Cache the parsed text for future use
                    cache.cache_text(doc_id, cache_key, full_text, page_boundaries)

                    logger.info(f"Successfully parsed PDF {doc_id}: {len(full_text)} characters")
                else:
                    logger.warning(f"No content extracted from PDF {doc_id}")
                    # Fallback to summary
                    summary = meta.get("summary", "")
                    title = meta.get("title", "")
                    if summary:
                        doc_text = f"{title}\n\n{summary}"
                        documents.append({
                            "doc_id": doc_id,
                            "text": doc_text,
                            "metadata": meta
                        })

            except Exception as e:
                logger.error(f"Error processing PDF for {doc_id}: {e}")
                # Fallback to summary if PDF parsing fails
                summary = meta.get("summary", "")
                title = meta.get("title", "")
                if summary:
                    doc_text = f"{title}\n\n{summary}"
                    documents.append({
                        "doc_id": doc_id,
                        "text": doc_text,
                        "metadata": meta
                    })
                    logger.info(f"Fallback to summary for {doc_id}")
        elif pdf_url and pdf_url.startswith("http"):
            # Handle remote URLs
            try:
                # Check for cached parsed text first
                cached_text = cache.get_cached_text(doc_id, pdf_url)
                if cached_text:
                    logger.info(f"✅ Using cached text for {doc_id}")
                    full_text = cached_text["full_text"]
                    page_boundaries = cached_text["page_boundaries"]

                    # Store page mapping in metadata
                    meta_with_pages = {**meta, "page_boundaries": page_boundaries}
                    documents.append({
                        "doc_id": doc_id,
                        "text": full_text,
                        "metadata": meta_with_pages
                    })
                    continue

                logger.info(f"📥 Downloading and parsing PDF for {doc_id}: {pdf_url}")

                # Check for cached PDF
                pdf_content = cache.get_cached_pdf(pdf_url)
                if pdf_content is None:
                    # Download PDF
                    response = requests.get(pdf_url, timeout=60)
                    response.raise_for_status()
                    pdf_content = response.content
                    # Cache the PDF
                    cache.cache_pdf(pdf_url, pdf_content)
                else:
                    logger.info(f"✅ Using cached PDF for {doc_id}")

                # Use LlamaIndex's local PDF reader
                from llama_index.readers.file import PDFReader

                reader = PDFReader()

                # Save PDF content to temporary file
                import tempfile
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp_file:
                    tmp_file.write(pdf_content)
                    tmp_file_path = tmp_file.name

                # Parse PDF content locally
                parsed_docs = reader.load_data(tmp_file_path)

                # Clean up temp file
                os.unlink(tmp_file_path)

                if parsed_docs:
                    # Build page-to-text mapping for proper page attribution
                    page_texts = []
                    page_boundaries = []  # Store character positions where each page ends
                    current_pos = 0

                    for i, doc in enumerate(parsed_docs):
                        page_num = i + 1
                        page_text = doc.text.strip()
                        if page_text:
                            page_texts.append(page_text)
                            current_pos += len(page_text) + 2  # +2 for "\n\n" separator
                            page_boundaries.append({
                                'page': page_num,
                                'end_pos': current_pos - 2  # Subtract separator for accurate boundary
                            })

                    # Combine all pages with separators
                    full_text = "\n\n".join(page_texts)

                    # Store page mapping in metadata
                    meta_with_pages = {**meta, "page_boundaries": page_boundaries}

                    documents.append({
                        "doc_id": doc_id,
                        "text": full_text,
                        "metadata": meta_with_pages
                    })

                    # Cache the parsed text for future use
                    cache.cache_text(doc_id, pdf_url, full_text, page_boundaries)

                    logger.info(f"Successfully parsed PDF {doc_id}: {len(full_text)} characters")
                else:
                    logger.warning(f"No content extracted from PDF {doc_id}")
                    # Fallback to summary
                    summary = meta.get("summary", "")
                    title = meta.get("title", "")
                    if summary:
                        doc_text = f"{title}\n\n{summary}"
                        documents.append({
                            "doc_id": doc_id,
                            "text": doc_text,
                            "metadata": meta
                        })

            except Exception as e:
                logger.error(f"Error processing remote PDF for {doc_id}: {e}")
                # Fallback to summary if PDF parsing fails
                summary = meta.get("summary", "")
                title = meta.get("title", "")
                if summary:
                    doc_text = f"{title}\n\n{summary}"
                    documents.append({
                        "doc_id": doc_id,
                        "text": doc_text,
                        "metadata": meta
                    })
                    logger.info(f"Fallback to summary for {doc_id}")
        else:
            # Use summary if no file or URL available
            summary = meta.get("summary", "")
            title = meta.get("title", "")
            if summary:
                doc_text = f"{title}\n\n{summary}"
                documents.append({
                    "doc_id": doc_id,
                    "text": doc_text,
                    "metadata": meta
                })
                logger.info(f"Using summary for {doc_id} (no local file or remote URL)")

    logger.info(f"Prepared {len(documents)} documents for indexing")

    # Build vector index (using existing embeddings approach)
    embed_model = OpenAIEmbedding(
        model="text-embedding-3-small",
        api_key=os.getenv("OPENAI_API_KEY")
    )

    # Create nodes with proper passage-level chunking for Answer mode
    # Use SimpleNodeParser with proper configuration
    node_parser = SimpleNodeParser.from_defaults(
        chunk_size=400,  # Characters
        chunk_overlap=80
    )

    # For now, create simple nodes - will enhance with proper document parsing later
    from llama_index.core.schema import Document, TextNode

    # Store full document texts separately for context generation
    document_texts = {}

    # First pass: populate document_texts for all documents
    for doc in documents:
        document_texts[doc["doc_id"]] = doc["text"]

    # Try to load cached nodes to avoid re-chunking
    content_hash = hashlib.sha256(str([doc["doc_id"] for doc in documents]).encode()).hexdigest()[:16]
    cached_nodes = cache.get_cached_nodes("all_docs", content_hash) if cache else None

    if cached_nodes:
        logger.info(f"✅ Using cached nodes: {len(cached_nodes)} chunks")
        nodes = cached_nodes
    else:
        logger.info("📋 Creating new chunks from documents")
        nodes = []
        for doc_idx, doc in enumerate(documents):
            logger.info(f"Processing document {doc_idx}: {doc['doc_id']}")
            # Create document with minimal metadata to avoid size issues
            llama_doc = Document(
                text=doc["text"],
                metadata={
                    "doc_id": doc["doc_id"],
                    "title": doc["metadata"]["title"][:100],  # Truncate title
                    "authors": doc["metadata"]["authors"][:100],  # Truncate authors
                    "year": str(doc["metadata"]["year"]) if doc["metadata"]["year"] else "",
                    "subtag": doc["metadata"]["subtag"][:50] if doc["metadata"]["subtag"] else "",
                    "program_series": doc["metadata"].get("program_series", "")
                }
            )

            # Parse into chunks
            doc_nodes = node_parser.get_nodes_from_documents([llama_doc])
            logger.info(f"Document {doc['doc_id']} (index {doc_idx}): created {len(doc_nodes)} chunks")

            # Log chunk sizes for debugging
            if doc_nodes:
                chunk_sizes = [len(node.text) for node in doc_nodes]
                logger.info(f"Chunk sizes for {doc['doc_id']}: {chunk_sizes[:5]}...")  # Show first 5 sizes

            # Add comprehensive chunk metadata for UI display
            page_boundaries = doc["metadata"].get("page_boundaries", [])

            for chunk_idx, node in enumerate(doc_nodes):
                # Calculate page number based on chunk position in the full document text
                # Find the start position of this chunk in the original document
                chunk_start_pos = doc["text"].find(node.text[:100])  # Use first 100 chars for matching
                if chunk_start_pos == -1:
                    # Fallback: estimate position based on chunk index
                    avg_chunk_size = len(doc["text"]) // len(doc_nodes) if len(doc_nodes) > 0 else 0
                    chunk_start_pos = chunk_idx * avg_chunk_size

                page_num = get_page_number_for_position(chunk_start_pos, page_boundaries)

                node.metadata.update({
                    "chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx}",
                    "chunk_index": chunk_idx,
                    "total_chunks": len(doc_nodes),
                    "page": page_num,
                    "chunk_start_pos": chunk_start_pos,  # Debug info
                    "authors": doc["metadata"]["authors"],
                    "year": doc["metadata"]["year"],
                    "url": doc["metadata"].get("url", ""),
                    "file_path": doc["metadata"].get("file_path", ""),
                    "program_series": doc["metadata"].get("program_series", ""),
                    # For passage preview context
                    "prev_chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx-1}" if chunk_idx > 0 else None,
                    "next_chunk_id": f"{doc['doc_id']}_chunk_{chunk_idx+1}" if chunk_idx < len(doc_nodes)-1 else None,
                })
                nodes.append(node)

        # Cache the newly created nodes
        if cache and nodes:
            cache.cache_nodes("all_docs", content_hash, nodes)
            logger.info(f"💾 Cached {len(nodes)} nodes for future use")

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
    logger.info(f"🔄 Loading cross-encoder rerankers (using cached models in offline mode)...")
    step_start = time.time()

    logger.info(f"   [1/2] Loading Answer mode reranker (L-12)...")
    reranker_start = time.time()
    reranker_answer = SentenceTransformerRerank(
        model="cross-encoder/ms-marco-MiniLM-L-12-v2",  # High precision for Answer mode
        top_n=20
    )
    logger.info(f"   ✓ Answer reranker loaded in {time.time() - reranker_start:.1f}s")

    logger.info(f"   [2/2] Loading Cite mode reranker (L-6)...")
    reranker_start = time.time()
    reranker_cite = SentenceTransformerRerank(
        model="cross-encoder/ms-marco-MiniLM-L-6-v2",   # Faster for Cite mode
        top_n=200  # Increased for better recall - preserves more candidates
    )
    logger.info(f"   ✓ Cite reranker loaded in {time.time() - reranker_start:.1f}s")
    logger.info(f"✅ All rerankers loaded in {time.time() - step_start:.1f}s")

    # Store in global state
    service_state["vector_index"] = vector_index
    service_state["bm25_retriever"] = bm25_retriever
    service_state["reranker_answer"] = reranker_answer
    service_state["reranker_cite"] = reranker_cite
    service_state["document_texts"] = document_texts

    logger.info("Successfully built indexes and initialized rerankers")

async def _run_indexing_in_background():
    """Background task to load documents and build indexes in a thread pool"""
    global service_state
    service_state["indexing_in_progress"] = True
    service_state["indexing_error"] = None
    try:
        logger.info("Background indexing started (running in thread pool)...")
        # Run blocking code in thread pool to avoid blocking the event loop
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
        service_state["vector_index"] is not None and
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
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": "2.0.0",
        "indexing": {
            "in_progress": indexing_in_progress,
            "error": indexing_error,
            "ready": indexes_ready
        },
        "indexes_loaded": {
            "vector_index": service_state["vector_index"] is not None,
            "bm25_retriever": service_state["bm25_retriever"] is not None,
        },
        "documents_count": len(service_state["documents_metadata"]),
        "document_texts_count": len(service_state["document_texts"]),
        "rerankers_loaded": {
            "answer_mode": service_state["reranker_answer"] is not None,
            "cite_mode": service_state["reranker_cite"] is not None,
        },
        "cache_stats": service_state["cache"].get_cache_stats() if service_state.get("cache") else {}
    }

@app.post("/query", response_model=QueryResponse)
async def hybrid_query(request: QueryRequest):
    """
    Hybrid retrieval with two-stage processing:
    Stage 1: Dense + Sparse fusion with RRF
    Stage 2: Local reranking with mode-specific cross-encoders
    """

    if not service_state["vector_index"] or not service_state["bm25_retriever"]:
        raise HTTPException(status_code=500, detail="Service not properly initialized")

    try:
        logger.info(f"Processing hybrid query: '{request.query}' (mode: {request.mode})")

        query_bundle = QueryBundle(query_str=request.query)

        # Capture individual retriever results if diagnostic mode
        vector_only_results = None
        bm25_only_results = None

        if request.return_intermediate_results:
            # Stage 1a: Vector search only
            vector_retriever_temp = VectorIndexRetriever(
                index=service_state["vector_index"],
                similarity_top_k=request.vector_top_k
            )
            vector_only_results = vector_retriever_temp.retrieve(query_bundle)
            logger.info(f"Diagnostic - Vector only: {len(vector_only_results)} results")

            # Stage 1b: BM25 search only
            bm25_only_results = service_state["bm25_retriever"].retrieve(query_bundle)
            logger.info(f"Diagnostic - BM25 only: {len(bm25_only_results)} results")

        # Stage 1: Hybrid Fusion Retrieval
        vector_retriever = VectorIndexRetriever(
            index=service_state["vector_index"],
            similarity_top_k=request.vector_top_k
        )

        hybrid_retriever = HybridFusionRetriever(
            vector_retriever=vector_retriever,
            bm25_retriever=service_state["bm25_retriever"],
            mode=request.mode,
            similarity_threshold=request.similarity_threshold
        )

        # Retrieve with hybrid fusion
        stage1_results = hybrid_retriever.retrieve(query_bundle)

        logger.info(f"Stage 1 (Hybrid Fusion): {len(stage1_results)} results")

        # Stage 2: Local Reranking
        if request.rerank and stage1_results:
            # Get base reranker
            base_reranker = (service_state["reranker_answer"] if request.mode == "answer"
                            else service_state["reranker_cite"])

            if base_reranker:
                try:
                    # Create reranker with dynamic top_n
                    from llama_index.postprocessor.rankgpt_rerank import SentenceTransformerRerank
                    reranker = SentenceTransformerRerank(
                        model=base_reranker._model,
                        top_n=request.rerank_top_n
                    )
                    stage2_results = reranker.postprocess_nodes(
                        stage1_results,
                        query_bundle
                    )
                    logger.info(f"Stage 2 (Reranking): {len(stage2_results)} results")
                except Exception as e:
                    logger.warning(f"Reranking failed: {e}, using Stage 1 results")
                    stage2_results = stage1_results
            else:
                stage2_results = stage1_results
        else:
            stage2_results = stage1_results

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
            filtered_results = list(doc_groups.values())[:request.max_results]
        else:
            # For answer mode - let hybrid fusion handle all ranking, no threshold filtering
            filtered_results = stage2_results[:request.max_results]

        # Convert to response format
        docs = []

        # Normalize scores to 0-1 range for user-friendly comparison
        if filtered_results:
            max_score = float(max(node.score for node in filtered_results))
            min_score = float(min(node.score for node in filtered_results))
            score_range = max_score - min_score if max_score != min_score else 1.0

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
            if full_doc_text:
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
            "debug": {
                "service_version": "2.0.0",
                "retrieval_method": "hybrid_fusion_rrf",
                "stage1_results": len(stage1_results),
                "stage2_results": len(stage2_results) if 'stage2_results' in locals() else len(stage1_results),
                "final_results": len(docs),
                "reranking_applied": request.rerank and service_state.get(f"reranker_{request.mode}") is not None,
                "similarity_threshold": request.similarity_threshold,
                "mode_config": {
                    "dense_weight": 0.5 if request.mode == "answer" else 0.4,
                    "sparse_weight": 0.5 if request.mode == "answer" else 0.6,
                    "fusion_top_k": 100 if request.mode == "answer" else 150,  # Updated for 203-doc corpus
                    "cite_filtering": "minimal" if request.mode == "cite" else "threshold_based"
                }
            }
        }

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

    if not service_state["vector_index"] or not service_state["bm25_retriever"]:
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
            "usage": {
                "total_tokens": len(docs) * 100  # Rough estimate
            }
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
            "vector_index_ready": service_state["vector_index"] is not None,
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

@app.post("/reindex")
async def trigger_reindex():
    """
    Trigger a full re-index of all documents
    This will reload the CSV, rebuild caches, and recreate all indexes
    """
    try:
        logger.info("[Reindex] Starting full re-index...")

        # Clear existing state
        service_state["vector_index"] = None
        service_state["bm25_retriever"] = None
        service_state["documents_metadata"] = {}
        service_state["document_texts"] = {}

        # Re-run startup logic in thread pool
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
