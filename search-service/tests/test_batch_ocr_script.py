"""Unit tests for scripts/batch_ocr.py (Fix 3 of the #310 follow-up plan).

Hermetic — no DB, no network. The live integration is necessarily a manual ops
run, so what is pinned here is everything that would be expensive or damaging to
get wrong: the JSONL/job payload shape, that a dry run touches NOTHING, that
target selection matches what the parse cache would actually re-OCR, and that
results are stored with the cache stamps that let the follow-up pipeline pass
skip OCR entirely.

The batch entry shape (a signed URL, never inline base64) was verified against
the live API on 2026-08-05.
"""
import json

import pytest

from scripts import batch_ocr


class _StubCursor:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _StubConn:
    def __init__(self, rows=()):
        self._rows = rows
        self.queries = []

    def execute(self, sql, params=None):
        self.queries.append((" ".join(sql.split()), params))
        return _StubCursor(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def stub_db(monkeypatch):
    def _install(rows=()):
        conn = _StubConn(rows)

        class _Pool:
            def connection(self):
                return conn

            def close(self):
                pass

        monkeypatch.setattr(batch_ocr, "get_pool", lambda: _Pool())
        return conn

    return _install


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any HTTP call from these tests is a bug — fail loudly rather than hang."""
    def boom(*a, **k):
        raise AssertionError("no test here may touch the network")

    monkeypatch.setattr(batch_ocr.requests, "post", boom)
    monkeypatch.setattr(batch_ocr.requests, "get", boom)


# --- payload shape ---------------------------------------------------------

def test_entry_references_a_signed_url_not_inline_base64():
    """The whole reason batch is viable at our document sizes: the JSONL line
    stays ~500 bytes regardless of PDF size. Inlining a 50MB PDF would make one
    line ~67MB and a full-corpus job ~13GB."""
    entry = batch_ocr.build_entry("doc-1", "https://example.blob.core.windows.net/x?sig=abc")

    assert entry["custom_id"] == "doc-1"
    doc = entry["body"]["document"]
    assert doc["type"] == "document_url"
    assert doc["document_url"].startswith("https://")
    assert "base64" not in json.dumps(entry), "must not inline document bytes"
    assert len(json.dumps(entry)) < 2000


def test_job_payload_targets_the_ocr_endpoint():
    payload = batch_ocr.build_job_payload("file-abc", "mistral-ocr-latest")

    assert payload["endpoint"] == "/v1/ocr", "batch jobs must be created against the OCR endpoint"
    assert payload["input_files"] == ["file-abc"]
    assert payload["model"] == "mistral-ocr-latest"


# --- target selection ------------------------------------------------------

def test_targets_are_the_documents_the_parse_cache_would_miss(stub_db):
    conn = stub_db([("id-1", "doc-1", "documents/a.pdf", "hash-a")])

    targets = batch_ocr.select_targets(conn, "mistral-ocr-latest")

    assert targets == [{"id": "id-1", "external_id": "doc-1",
                        "s3_key": "documents/a.pdf", "content_hash": "hash-a"}]
    sql, params = conn.queries[0]
    # The predicate must mirror _cached_parse: stamps NULL, or any of
    # hash/backend/model differing from current settings.
    assert "parsed_content_hash IS NULL" in sql
    assert "parsed_content_hash <> d.content_hash" in sql
    assert "parse_backend IS DISTINCT FROM" in sql
    assert "parse_model IS DISTINCT FROM" in sql
    assert params[:2] == ["mistral", "mistral-ocr-latest"]
    # Never re-OCR a withdrawn document, and never one with no file or no hash.
    assert "status <> 'withdrawn'" in sql
    assert "s3_key IS NOT NULL" in sql
    assert "content_hash IS NOT NULL" in sql


def test_explicit_empty_id_list_never_widens_to_the_whole_corpus(stub_db):
    """Same guard as reingest_all: an empty --ids is a no-op, not a full run.
    A full-corpus batch is a real bill."""
    conn = stub_db([("id-1", "doc-1", "documents/a.pdf", "hash-a")])

    assert batch_ocr.select_targets(conn, "mistral-ocr-latest", ids=[]) == []
    assert conn.queries == [], "an empty id list must not even query"


# --- dry run ---------------------------------------------------------------

def test_dry_run_is_the_default_and_touches_nothing(stub_db, capsys):
    """No uploads, no job, no writes. The autouse no_network fixture makes any
    HTTP call fail, and the stub connection records every statement."""
    conn = stub_db([("id-1", "doc-1", "documents/a.pdf", "hash-a")])

    assert batch_ocr.run() == 0

    out = capsys.readouterr().out
    assert "DRY RUN" in out
    assert "doc-1" in out
    assert '"endpoint": "/v1/ocr"' in out, "the dry run must show the real job payload"
    assert "<signed-url>" in out, "and the entry shape, with a placeholder URL"
    # Exactly one statement: the SELECT. No INSERT, no enqueue.
    assert len(conn.queries) == 1 and conn.queries[0][0].startswith("SELECT")


def test_dry_run_reports_when_nothing_needs_ocr(stub_db, capsys):
    stub_db([])
    assert batch_ocr.run() == 0
    assert "DRY RUN" not in capsys.readouterr().out


# --- result write-back -----------------------------------------------------

def test_results_are_stored_with_cache_stamps_and_enqueued(monkeypatch):
    """The stamps are what make the follow-up pipeline pass free: it re-parses,
    hits the Fix-1 cache, and never calls OCR again."""
    conn = _StubConn()
    enqueued = []
    monkeypatch.setattr(batch_ocr, "enqueue", lambda c, doc_id: enqueued.append(doc_id))

    targets = {"doc-1": {"id": "id-1", "external_id": "doc-1",
                         "s3_key": "documents/a.pdf", "content_hash": "hash-a"}}
    pages = [{"index": 0, "markdown": "# Title\n\nBody text"},
             {"index": 1, "markdown": "Second page"}]

    written = batch_ocr.write_results(conn, targets, {"doc-1": pages}, "mistral-ocr-latest")

    assert written == 1
    assert enqueued == ["id-1"], "each stored document must be enqueued for the rest of the pipeline"
    sql, params = conn.queries[0]
    assert "INSERT INTO document_texts" in sql and "ON CONFLICT" in sql
    doc_id, full_text, boundaries, char_count, stamp_hash, model = params
    assert doc_id == "id-1"
    assert full_text == "# Title\n\nBody text\n\nSecond page"
    assert char_count == len(full_text)
    assert stamp_hash == "hash-a", "stamp the ORIGINAL document's content_hash"
    assert model == "mistral-ocr-latest"
    assert "'mistral'" in sql, "backend stamp must say mistral"


def test_batch_text_is_identical_to_the_sync_parse_path(monkeypatch):
    """Batch and sync must produce byte-identical text and boundaries — both go
    through worker.stages.parse.mistral_pages_to_text. If they diverged, a
    document's stored text would depend on which transport happened to run."""
    from worker.stages import parse as parse_mod

    pages = [{"index": 0, "markdown": "## 执行摘要\n\n纯电动公交车"},
             {"index": 1, "markdown": "   "},
             {"index": 2, "markdown": "## 研究方法"}]

    conn = _StubConn()
    monkeypatch.setattr(batch_ocr, "enqueue", lambda c, d: None)
    batch_ocr.write_results(
        conn, {"d": {"id": "i", "external_id": "d", "s3_key": "k", "content_hash": "h"}},
        {"d": pages}, "mistral-ocr-latest")
    _, params = conn.queries[0]
    batch_text, batch_boundaries = params[1], params[2].obj

    sync_text, sync_boundaries = parse_mod.mistral_pages_to_text(pages)

    assert batch_text == sync_text
    assert batch_boundaries == sync_boundaries
    assert [b["page"] for b in batch_boundaries] == [1, 3], "empty pages must not shift labels"


def test_empty_ocr_text_is_not_written(monkeypatch):
    """An entry that came back with no text must be left for the worker rather
    than stamped — stamping it would cache emptiness as a successful parse."""
    conn = _StubConn()
    enqueued = []
    monkeypatch.setattr(batch_ocr, "enqueue", lambda c, doc_id: enqueued.append(doc_id))

    written = batch_ocr.write_results(
        conn, {"doc-1": {"id": "id-1", "external_id": "doc-1",
                         "s3_key": "k", "content_hash": "h"}},
        {"doc-1": [{"index": 0, "markdown": "   "}]}, "mistral-ocr-latest")

    assert written == 0
    assert conn.queries == [] and enqueued == []


def test_result_for_an_unknown_document_is_ignored(monkeypatch):
    conn = _StubConn()
    monkeypatch.setattr(batch_ocr, "enqueue", lambda c, d: pytest.fail("must not enqueue"))

    written = batch_ocr.write_results(conn, {}, {"ghost": [{"index": 0, "markdown": "x"}]},
                                      "mistral-ocr-latest")

    assert written == 0 and conn.queries == []
