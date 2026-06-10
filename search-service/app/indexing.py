"""CSV loading, PDF parsing, and node building.

Extracted verbatim from main.py so the live service (legacy mode) and the
one-time Postgres migration script build IDENTICAL nodes. Do not change
chunking parameters or chunk_id formats here without re-running the
retrieval parity gate.
"""
import hashlib
import json
import logging
from pathlib import Path

import pandas as pd
from llama_index.core.node_parser import SimpleNodeParser
from llama_index.core.schema import Document, TextNode

logger = logging.getLogger(__name__)


def get_page_number_for_position(position: int, page_boundaries: list) -> int:
    """Determine which page a character position belongs to"""
    if not page_boundaries:
        return 1

    for boundary in page_boundaries:
        if position <= boundary['end_pos']:
            return boundary['page']

    # If beyond all boundaries, assume last page
    return page_boundaries[-1]['page'] if page_boundaries else 1


def load_csv_metadata(documents_local_dir: str) -> dict:
    """Returns {doc_id: metadata dict} — body is main.py lines 457-490."""
    documents_metadata = {}
    # Load CSV metadata first
    csv_path = Path(documents_local_dir) / "documents.csv"

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

            local_file_path = f"{documents_local_dir}/{file_path}"

            documents_metadata[doc_id] = {
                "title": metadata_raw.get('Publication Title', f'Document {doc_id}'),
                "authors": metadata_raw.get('All authors', ''),
                "year": metadata_raw.get('YEAR published', ''),
                "url": metadata_raw.get('Source URL', metadata_raw.get('URL', metadata_raw.get('Attribution URL', ''))),
                "summary": row.get('summary', ''),
                "subtag": metadata_raw.get('Sub-tag', '') if isinstance(metadata_raw.get('Sub-tag'), str) else '',
                "program_series": metadata_raw.get('program_series', ''),  # Add program_series for filtering
                "file_path": file_path,
                "local_file": local_file_path,
                "raw_metadata": metadata_raw
            }

    return documents_metadata


def prepare_documents(documents_metadata: dict, cache, documents_local_dir: str) -> list:
    """Returns [{doc_id, text, metadata}] — body is main.py lines 495-718."""
    documents = []

    # Import PDF processing utilities
    import requests

    # Process all documents
    for doc_id, meta in documents_metadata.items():
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
                import os
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

    return documents


def build_nodes(documents: list, cache) -> tuple:
    """Returns (nodes, content_hash) — body is main.py lines 737-858."""
    node_parser = SimpleNodeParser.from_defaults(
        chunk_size=400,  # Characters
        chunk_overlap=80
    )

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

        # Add a dedicated summary node per document for high-signal retrieval.
        # Summaries are topic-dense (~585 chars avg) and give both the vector
        # index and BM25 a concise representation of each document's subject,
        # which fragmented PDF chunks often lack.
        summary_count = 0
        for doc in documents:
            summary = doc["metadata"].get("summary", "")
            if not summary:
                continue
            title = doc["metadata"].get("title", "")
            summary_text = f"{title}\n\n{summary}" if title else summary
            summary_node = TextNode(
                text=summary_text,
                metadata={
                    "doc_id": doc["doc_id"],
                    "title": title[:100],
                    "authors": doc["metadata"].get("authors", ""),
                    "year": doc["metadata"].get("year", ""),
                    "subtag": (doc["metadata"].get("subtag", "") or "")[:50],
                    "program_series": doc["metadata"].get("program_series", ""),
                    "chunk_id": f"{doc['doc_id']}_summary",
                    "chunk_index": -1,
                    "total_chunks": -1,
                    "page": 1,
                    "chunk_start_pos": 0,
                    "url": doc["metadata"].get("url", ""),
                    "file_path": doc["metadata"].get("file_path", ""),
                    "is_summary_node": True,
                    "prev_chunk_id": None,
                    "next_chunk_id": f"{doc['doc_id']}_chunk_0",
                },
            )
            nodes.append(summary_node)
            summary_count += 1
        logger.info(f"Added {summary_count} summary nodes")

        # Cache the newly created nodes
        if cache and nodes:
            cache.cache_nodes("all_docs", content_hash, nodes)
            logger.info(f"💾 Cached {len(nodes)} nodes for future use")

    return nodes, content_hash
