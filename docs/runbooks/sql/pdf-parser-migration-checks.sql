-- Read-only snapshot for the parser migration runbook.
-- Run via psql -X -v ON_ERROR_STOP=1 -f <this-file> against the intended DB.
-- No queue writes, model calls, extraction changes or reindexing.
BEGIN READ ONLY;

SELECT current_database() AS database_name,
       current_user AS database_user,
       now() AS captured_at;

SELECT status, count(*) AS documents
FROM documents GROUP BY status ORDER BY status;

-- Historical totals: use recorded migration job IDs for batch completion.
SELECT status, stage, count(*) AS jobs
FROM ingestion_jobs GROUP BY status, stage ORDER BY status, stage;

SELECT parse_backend, parse_model, count(*) AS text_rows
FROM document_texts GROUP BY parse_backend, parse_model
ORDER BY parse_backend, parse_model;

-- Detect absent/empty extraction and absent provenance stamps. Missing PDFs
-- and legacy summary-only records must be accounted for, not assumed parsed.
SELECT d.id, d.external_id, d.status,
       CASE WHEN t.document_id IS NULL THEN 'missing text row'
            WHEN nullif(btrim(t.full_text), '') IS NULL THEN 'empty text'
            WHEN t.parsed_content_hash IS NULL THEN 'unstamped text'
            ELSE 'source hash differs' END AS finding
FROM documents d
LEFT JOIN document_texts t ON t.document_id = d.id
WHERE d.status <> 'withdrawn'
  AND (t.document_id IS NULL OR nullif(btrim(t.full_text), '') IS NULL
       OR t.parsed_content_hash IS NULL
       OR t.parsed_content_hash IS DISTINCT FROM d.content_hash)
ORDER BY d.external_id;

SELECT c.embedding_model, c.dimension, count(*) AS chunks,
       count(*) FILTER (WHERE c.embedding IS NULL) AS missing_dense,
       count(*) FILTER (WHERE c.sparse IS NULL) AS missing_sparse
FROM document_chunks c
JOIN documents d ON d.id = c.document_id
WHERE d.status = 'searchable'
GROUP BY c.embedding_model, c.dimension
ORDER BY c.embedding_model, c.dimension;

SELECT d.id, d.external_id AS searchable_without_chunks
FROM documents d
WHERE d.status = 'searchable'
  AND NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = d.id)
ORDER BY d.external_id;

SELECT (SELECT count(*) FROM document_chunks) AS actual_all_status_chunk_count,
       n_chunks AS frozen_keyword_chunk_count, avgdl, sparse_dim, built_at
FROM keyword_corpus_stats;

-- Internal content fingerprints for baseline/candidate inspection, not backup.
SELECT d.id, d.external_id, d.language, d.status, d.content_hash,
       t.parse_backend, t.parse_model,
       char_length(t.full_text) AS extracted_chars,
       jsonb_array_length(t.page_boundaries) AS boundary_entries,
       md5(t.full_text) AS text_fingerprint,
       md5(t.page_boundaries::text) AS boundary_fingerprint
FROM documents d LEFT JOIN document_texts t ON t.document_id = d.id
WHERE d.status <> 'withdrawn'
ORDER BY d.external_id;

COMMIT;
