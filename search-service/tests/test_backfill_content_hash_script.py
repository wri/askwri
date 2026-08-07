"""Unit tests for scripts/backfill_content_hash.py. Hermetic — no DB, no S3.

The dangerous behaviours are all about the unique index on
documents.content_hash: stamping two byte-identical documents violates it, and
guessing which one "wins" would silently pick a document to break.
"""
import hashlib

import pytest

from scripts import backfill_content_hash as bf


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


def _doc(ext):
    return {"id": f"id-{ext}", "external_id": ext, "s3_key": f"documents/{ext}.pdf"}


def test_targets_are_documents_with_a_file_but_no_hash():
    conn = _StubConn([("id-1", "doc-1", "documents/a.pdf")])

    targets = bf.select_targets(conn)

    assert targets == [{"id": "id-1", "external_id": "doc-1", "s3_key": "documents/a.pdf"}]
    sql = conn.queries[0][0]
    assert "content_hash IS NULL" in sql
    assert "s3_key IS NOT NULL" in sql
    assert "status <> 'withdrawn'" in sql


def test_hash_matches_intake_so_a_redrop_still_dedupes(monkeypatch):
    """intake computes sha256 of the file bytes (worker/intake_s3.py). If this
    script computed anything else, re-dropping the same PDF would register a
    second copy instead of being skipped as a duplicate."""
    content = b"%PDF-1.4 some bytes"
    monkeypatch.setattr(bf, "_load_pdf_bytes", lambda d: content)

    stampable, unreadable = bf.hash_documents([_doc("a")])

    assert stampable == {"id-a": hashlib.sha256(content).hexdigest()}
    assert unreadable == []


def test_identical_files_are_never_stamped(monkeypatch):
    """Two documents with byte-identical files cannot both take the hash — the
    unique index forbids it. Picking a winner would silently decide which
    document stays cache-eligible, so neither is stamped and both are reported."""
    monkeypatch.setattr(bf, "_load_pdf_bytes", lambda d: b"identical bytes")

    stampable, unreadable = bf.hash_documents([_doc("a"), _doc("b"), _doc("c")])

    assert stampable == {}, "a collision group must be left entirely alone"
    assert unreadable == []


def test_a_collision_does_not_block_unrelated_documents(monkeypatch):
    payloads = {"id-a": b"same", "id-b": b"same", "id-c": b"unique"}
    monkeypatch.setattr(bf, "_load_pdf_bytes", lambda d: payloads[d["id"]])

    stampable, _ = bf.hash_documents([_doc("a"), _doc("b"), _doc("c")])

    assert list(stampable) == ["id-c"]


def test_missing_file_is_reported_not_hashed(monkeypatch):
    monkeypatch.setattr(bf, "_load_pdf_bytes", lambda d: None)

    stampable, unreadable = bf.hash_documents([_doc("gone")])

    assert stampable == {}
    assert [d["external_id"] for d in unreadable] == ["gone"]


def test_hash_already_held_by_another_document_is_skipped(monkeypatch):
    """The file duplicates one already in the corpus — stamping it would violate
    the unique index at write time rather than being caught here."""
    conn = _StubConn([("dup-hash",)])
    assert bf._existing_hashes(conn, ["dup-hash", "free-hash"]) == {"dup-hash"}


def test_dry_run_writes_nothing(monkeypatch, capsys):
    conn = _StubConn([("id-1", "doc-1", "documents/a.pdf")])

    class _Pool:
        def connection(self):
            return conn

        def close(self):
            pass

    monkeypatch.setattr(bf, "get_pool", lambda: _Pool())
    monkeypatch.setattr(bf, "_load_pdf_bytes", lambda d: b"%PDF bytes")

    assert bf.run() == 0

    out = capsys.readouterr().out
    assert "DRY RUN" in out
    assert conn.commits == 0
    assert not any("UPDATE" in q for q, _ in conn.queries), "dry run must not write"


def test_execute_guards_against_a_hash_set_while_we_read_s3(monkeypatch):
    """The worker may stamp a document via intake while this script is reading
    S3. The UPDATE is guarded on content_hash still being NULL so the worker's
    value — computed from the bytes it actually ingested — always wins."""
    conn = _StubConn([("id-1", "doc-1", "documents/a.pdf")], rowcount=0)

    class _Pool:
        def connection(self):
            return conn

        def close(self):
            pass

    monkeypatch.setattr(bf, "get_pool", lambda: _Pool())
    monkeypatch.setattr(bf, "_load_pdf_bytes", lambda d: b"%PDF bytes")

    written = bf.run(execute=True)

    assert written == 0, "a row already stamped by the worker is not counted"
    update = [q for q, _ in conn.queries if q.startswith("UPDATE")][0]
    assert "content_hash IS NULL" in update
