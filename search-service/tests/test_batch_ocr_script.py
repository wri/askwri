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
    def __init__(self, rows, rowcount=1):
        self._rows = rows
        self.rowcount = rowcount

    def fetchall(self):
        return self._rows


class _StubConn:
    def __init__(self, rows=(), rowcount=1):
        self._rows = rows
        self._rowcount = rowcount
        self.queries = []
        self.commits = 0

    def execute(self, sql, params=None):
        self.queries.append((" ".join(sql.split()), params))
        return _StubCursor(self._rows, self._rowcount)

    def commit(self):
        self.commits += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def mistral_env(monkeypatch):
    """check_environment refuses to run outside a mistral, non-FORCE_REPARSE
    setup, so every test needs that baseline."""
    from app.config import get_settings
    monkeypatch.setenv("PARSE_BACKEND", "mistral")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-key")
    monkeypatch.delenv("FORCE_REPARSE", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


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
    url = "https://example.blob.core.windows.net/x?sig=abc"
    entry = batch_ocr.build_entry("doc-1", url)

    assert entry == {"custom_id": "doc-1",
                     "body": {"document": {"type": "document_url", "document_url": url}}}
    # The size of the line is independent of the document: same entry, whether
    # the PDF behind that URL is 1KB or 50MB.
    assert len(json.dumps(entry)) < 500


def test_job_payload_targets_the_ocr_endpoint():
    payload = batch_ocr.build_job_payload("file-abc", "mistral-ocr-latest")

    assert payload["endpoint"] == "/v1/ocr", "batch jobs must be created against the OCR endpoint"
    assert payload["input_files"] == ["file-abc"]
    assert payload["model"] == "mistral-ocr-latest"


# --- target selection ------------------------------------------------------

def test_targets_are_the_documents_the_parse_cache_would_miss(stub_db):
    conn = stub_db([("id-1", "doc-1", "documents/a.pdf", "hash-a")])

    targets = batch_ocr.select_targets(conn, "mistral-ocr-latest", backend="mistral")

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
    assert conn.commits == 1, "each document commits on its own — a late failure "\
                              "must not roll back everything already collected"
    sql, params = conn.queries[0]
    assert "INSERT INTO document_texts" in sql and "ON CONFLICT" in sql
    full_text, boundaries, char_count, model, doc_id, guard_hash = params
    assert doc_id == "id-1"
    assert full_text == "# Title\n\nBody text\n\nSecond page"
    assert char_count == len(full_text)
    assert guard_hash == "hash-a", "the write is guarded on the hash we OCR'd"
    assert model == "mistral-ocr-latest"
    assert "'mistral'" in sql, "backend stamp must say mistral"
    assert "d.content_hash" in sql, "the stamp comes from the CURRENT row, not a stale copy"


def test_batch_text_matches_the_sync_parse_output_exactly(monkeypatch):
    """Batch and sync must produce byte-identical text and boundaries; text that
    differed by transport would make the cache serve one shape where the
    pipeline expects another. Asserted against the LITERAL expected values, not
    against mistral_pages_to_text — comparing the helper to itself would pass
    even if write_results stopped calling it."""
    pages = [{"index": 0, "markdown": "## 执行摘要\n\n纯电动公交车"},
             {"index": 1, "markdown": "   "},
             {"index": 2, "markdown": "## 研究方法"}]

    conn = _StubConn()
    monkeypatch.setattr(batch_ocr, "enqueue", lambda c, d: None)
    batch_ocr.write_results(
        conn, {"d": {"id": "i", "external_id": "d", "s3_key": "k", "content_hash": "h"}},
        {"d": pages}, "mistral-ocr-latest")
    _, params = conn.queries[0]
    text, boundaries = params[0], params[1].obj

    assert text == "## 执行摘要\n\n纯电动公交车\n\n## 研究方法"
    # Page 2 came back empty (a full-bleed graphic) and must NOT shift page 3's
    # label — the R4 fix, which the batch path has to preserve too.
    assert boundaries == [
        {"page": 1, "end_pos": len("## 执行摘要\n\n纯电动公交车")},
        {"page": 3, "end_pos": len(text)},
    ]


def test_stamp_written_is_one_the_parse_cache_accepts(monkeypatch):
    """The end-to-end claim — 'the enqueued pass hits the cache and skips OCR' —
    is only true if the stamp this script writes is one _cached_parse accepts.
    Feed the written values straight back into it and require a hit."""
    from worker.stages import parse as parse_mod

    conn = _StubConn()
    monkeypatch.setattr(batch_ocr, "enqueue", lambda c, d: None)
    batch_ocr.write_results(
        conn, {"d": {"id": "i", "external_id": "d", "s3_key": "k", "content_hash": "hash-a"}},
        {"d": [{"index": 0, "markdown": "text"}]}, batch_ocr._parse_model(
            __import__("app.config", fromlist=["get_settings"]).get_settings()))
    sql, params = conn.queries[0]
    text, boundaries, _, model = params[0], params[1], params[2], params[3]

    # Replay what the row now looks like to the parse stage's read path.
    stored = (text, boundaries.obj, "hash-a", "mistral", model)

    class _Conn:
        def execute(self, *a, **k):
            return type("C", (), {"fetchone": lambda self: stored})()

    hit = parse_mod._cached_parse(_Conn(), {"id": "i", "content_hash": "hash-a"})
    assert hit is not None, (
        "the stamp batch_ocr writes must satisfy _cached_parse, or the enqueued "
        "pipeline pass re-OCRs everything this script paid for"
    )
    assert hit[0] == "text"


def test_refuses_to_run_under_a_non_mistral_backend(monkeypatch):
    """Under pypdf (the code DEFAULT, and production's setting) every row is
    stamped 'pypdf', so every document looks like a cache miss — a full-corpus
    OCR bill whose results the follow-up pypdf parse would then overwrite."""
    from app.config import get_settings
    monkeypatch.setenv("PARSE_BACKEND", "pypdf")
    get_settings.cache_clear()

    with pytest.raises(RuntimeError, match="PARSE_BACKEND=mistral"):
        batch_ocr.check_environment(get_settings())


def test_refuses_to_run_with_force_reparse_set(monkeypatch):
    """FORCE_REPARSE makes the enqueued pass bypass the cache and re-OCR every
    document at full price — the batch spend would be pure waste. The plan names
    this exact combination as a use case, so the guard has to be explicit."""
    from app.config import get_settings
    monkeypatch.setenv("FORCE_REPARSE", "true")
    get_settings.cache_clear()

    with pytest.raises(RuntimeError, match="FORCE_REPARSE"):
        batch_ocr.check_environment(get_settings())


def test_result_is_discarded_when_content_hash_changed_since_selection(monkeypatch):
    """A version replaced at intake mid-job has already been re-parsed from the
    new bytes. Overwriting that with OCR of the OLD bytes would store stale text
    under a stale stamp, so the guarded INSERT matches no row and we skip."""
    conn = _StubConn(rowcount=0)
    monkeypatch.setattr(batch_ocr, "enqueue",
                        lambda c, d: pytest.fail("must not enqueue a discarded result"))

    written = batch_ocr.write_results(
        conn, {"d": {"id": "i", "external_id": "d", "s3_key": "k", "content_hash": "old"}},
        {"d": [{"index": 0, "markdown": "stale text"}]}, "mistral-ocr-latest")

    assert written == 0
    sql = conn.queries[0][0]
    assert "d.content_hash = %s" in sql, "the write must be guarded on the current hash"
    assert conn.commits == 0


def test_fetch_results_parses_the_batch_output_shape(monkeypatch):
    """The output line shape is the least documented part of the flow and the
    one that silently drops every result if wrong. Shape below is the real
    response captured from the live API on 2026-08-05."""
    lines = [
        json.dumps({"id": "batch-1", "custom_id": "doc-ok", "error": None,
                    "response": {"status_code": 200, "body": {
                        "pages": [{"index": 0, "markdown": "Batch OCR probe page one"}]}}}),
        json.dumps({"id": "batch-2", "custom_id": "doc-failed",
                    "error": {"message": "boom"}, "response": None}),
        json.dumps({"id": "batch-3", "custom_id": "doc-500", "error": None,
                    "response": {"status_code": 500, "body": {}}}),
        "",
    ]

    class _Resp:
        text = "\n".join(lines)

        def raise_for_status(self):
            pass

    monkeypatch.setattr(batch_ocr.requests, "get", lambda *a, **k: _Resp())

    from app.config import get_settings
    results = batch_ocr._fetch_results(get_settings(), "out-file")

    assert list(results) == ["doc-ok"], "only 200-status entries are usable"
    assert results["doc-ok"] == [{"index": 0, "markdown": "Batch OCR probe page one"}]


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
