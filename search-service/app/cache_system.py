#!/usr/bin/env python3
"""
Caching system for AskWRI hybrid service to avoid reprocessing
"""
import json
import pickle
import hashlib
from pathlib import Path
from typing import Dict, List, Any, Optional
import logging

logger = logging.getLogger(__name__)

class AskWRICache:
    def __init__(self, cache_dir: str = "/tmp/askWRI_cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)

        # Cache subdirectories
        self.pdfs_dir = self.cache_dir / "pdfs"
        self.texts_dir = self.cache_dir / "texts"
        self.embeddings_dir = self.cache_dir / "embeddings"
        self.nodes_dir = self.cache_dir / "nodes"
        self.indexes_dir = self.cache_dir / "indexes"

        # Create subdirectories
        for dir_path in [self.pdfs_dir, self.texts_dir, self.embeddings_dir, self.nodes_dir, self.indexes_dir]:
            dir_path.mkdir(exist_ok=True)

    def _get_url_hash(self, url: str) -> str:
        """Get consistent hash for URL"""
        return hashlib.sha256(url.encode()).hexdigest()[:16]

    def _get_text_hash(self, text: str) -> str:
        """Get consistent hash for text content"""
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    # PDF Caching
    def get_cached_pdf(self, url: str) -> Optional[bytes]:
        """Get cached PDF content if available"""
        url_hash = self._get_url_hash(url)
        pdf_path = self.pdfs_dir / f"{url_hash}.pdf"

        if pdf_path.exists():
            logger.info(f"Loading cached PDF for {url[:50]}...")
            return pdf_path.read_bytes()
        return None

    def cache_pdf(self, url: str, pdf_content: bytes) -> None:
        """Cache PDF content"""
        url_hash = self._get_url_hash(url)
        pdf_path = self.pdfs_dir / f"{url_hash}.pdf"
        pdf_path.write_bytes(pdf_content)
        logger.info(f"Cached PDF for {url[:50]}...")

    # Parsed Text Caching
    def get_cached_text(self, doc_id: str, url: str) -> Optional[Dict[str, Any]]:
        """Get cached parsed text and metadata"""
        url_hash = self._get_url_hash(url)
        text_path = self.texts_dir / f"{doc_id}_{url_hash}.json"

        if text_path.exists():
            logger.info(f"Loading cached text for {doc_id}")
            return json.loads(text_path.read_text())
        return None

    def cache_text(self, doc_id: str, url: str, full_text: str, page_boundaries: List[Dict]) -> None:
        """Cache parsed text with page boundaries"""
        url_hash = self._get_url_hash(url)
        text_path = self.texts_dir / f"{doc_id}_{url_hash}.json"

        data = {
            "doc_id": doc_id,
            "url": url,
            "full_text": full_text,
            "page_boundaries": page_boundaries,
            "char_count": len(full_text)
        }

        text_path.write_text(json.dumps(data, indent=2))
        logger.info(f"Cached parsed text for {doc_id} ({len(full_text)} chars)")

    # Node/Chunk Caching
    def get_cached_nodes(self, doc_id: str, text_hash: str) -> Optional[List[Any]]:
        """Get cached nodes for a document"""
        nodes_path = self.nodes_dir / f"{doc_id}_{text_hash}.pkl"

        if nodes_path.exists():
            logger.info(f"Loading cached nodes for {doc_id}")
            with open(nodes_path, 'rb') as f:
                return pickle.load(f)
        return None

    def cache_nodes(self, doc_id: str, text_hash: str, nodes: List[Any]) -> None:
        """Cache processed nodes"""
        nodes_path = self.nodes_dir / f"{doc_id}_{text_hash}.pkl"

        with open(nodes_path, 'wb') as f:
            pickle.dump(nodes, f)
        logger.info(f"Cached {len(nodes)} nodes for {doc_id}")

    # Embeddings Caching
    def get_cached_embeddings(self, text_hash: str) -> Optional[Dict[str, Any]]:
        """Get cached embeddings"""
        emb_path = self.embeddings_dir / f"{text_hash}.pkl"

        if emb_path.exists():
            logger.info(f"Loading cached embeddings for {text_hash}")
            with open(emb_path, 'rb') as f:
                return pickle.load(f)
        return None

    def cache_embeddings(self, text_hash: str, embeddings_data: Dict[str, Any]) -> None:
        """Cache embeddings and related data"""
        emb_path = self.embeddings_dir / f"{text_hash}.pkl"

        with open(emb_path, 'wb') as f:
            pickle.dump(embeddings_data, f)
        logger.info(f"Cached embeddings for {text_hash}")

    # Index Caching
    def get_cached_indexes(self, content_hash: str) -> Optional[Dict[str, Any]]:
        """Get cached vector and BM25 indexes"""
        index_path = self.indexes_dir / f"{content_hash}.pkl"

        if index_path.exists():
            logger.info(f"Loading cached indexes for {content_hash}")
            with open(index_path, 'rb') as f:
                return pickle.load(f)
        return None

    def cache_indexes(self, content_hash: str, indexes_data: Dict[str, Any]) -> None:
        """Cache built indexes"""
        index_path = self.indexes_dir / f"{content_hash}.pkl"

        with open(index_path, 'wb') as f:
            pickle.dump(indexes_data, f)
        logger.info(f"Cached indexes for {content_hash}")

    def get_cache_stats(self) -> Dict[str, int]:
        """Get cache statistics"""
        return {
            "pdfs": len(list(self.pdfs_dir.glob("*.pdf"))),
            "texts": len(list(self.texts_dir.glob("*.json"))),
            "nodes": len(list(self.nodes_dir.glob("*.pkl"))),
            "embeddings": len(list(self.embeddings_dir.glob("*.pkl"))),
            "indexes": len(list(self.indexes_dir.glob("*.pkl")))
        }

    def clear_cache(self, cache_type: Optional[str] = None) -> None:
        """Clear specific cache or all caches"""
        if cache_type == "pdfs":
            for f in self.pdfs_dir.glob("*"):
                f.unlink()
        elif cache_type == "texts":
            for f in self.texts_dir.glob("*"):
                f.unlink()
        elif cache_type == "embeddings":
            for f in self.embeddings_dir.glob("*"):
                f.unlink()
        elif cache_type == "nodes":
            for f in self.nodes_dir.glob("*"):
                f.unlink()
        elif cache_type == "indexes":
            for f in self.indexes_dir.glob("*"):
                f.unlink()
        else:
            # Clear all caches
            for subdir in [self.pdfs_dir, self.texts_dir, self.embeddings_dir, self.nodes_dir, self.indexes_dir]:
                for f in subdir.glob("*"):
                    f.unlink()

        logger.info(f"Cleared cache: {cache_type or 'all'}")