"""R1 — start.sh keeps the S3 documents sync in postgres mode.

Regression test for finding R1 in docs/plans/2026-07-01-doc-mgmt-review-findings.md.

The bug: start.sh skipped the ENTIRE S3 sync (documents AND cache) when
RETRIEVAL_BACKEND=postgres. The public /api/pdf/[filename] route serves PDFs
from /tmp/askWRI_docs, which the frontend still links to, so flipping to
postgres mode emptied /tmp/askWRI_docs and 404'd every "Open PDF".

The fix: documents sync runs in all modes where DOCUMENTS_S3_BUCKET is set;
only the cache sync is skipped in postgres mode (embeddings live in pgvector).

This test stubs `aws`, `mkdir`, `uvicorn`, and `sleep` and sources start.sh
under each env-var combination, capturing which `aws s3 sync` calls fire and
to which destinations. It asserts the three-branch contract directly, so it
does not need Docker, S3, or a database.
"""
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

START_SH = Path(__file__).resolve().parents[1] / "start.sh"


def _run_startsh(env: dict[str, str]) -> tuple[int, str, list[str]]:
    """Run start.sh under a sandboxed env with stubbed commands.

    Returns (exit_code, combined_output, aws_sync_dests_in_order).
    `aws_sync_dests_in_order` is the list of dest arguments passed to each
    `aws s3 sync <source> <dest>` invocation, in call order — the thing we
    assert on (which syncs fired, and to where).
    """
    sandbox = Path(__file__).resolve().parent / "_startsh_sandbox"
    if sandbox.exists():
        shutil.rmtree(sandbox)
    sandbox.mkdir(parents=True)

    # Log file the stubs write to. aws stub records each sync dest, in order.
    log = sandbox / "calls.log"
    log.write_text("")

    # Stub bin dir. We shadow `aws`, `mkdir`, `sleep`, and `uvicorn` so the
    # script never touches the real system or network.
    stub_bin = sandbox / "bin"
    stub_bin.mkdir()
    (stub_bin / "aws").write_text(
        textwrap.dedent(
            """\
            #!/bin/sh
            # Record only `s3 sync <src> <dest>` calls; pass through others.
            if [ "$1" = "s3" ] && [ "$2" = "sync" ]; then
                echo "$4" >> "$AWS_CALLS_LOG"
                exit 0
            fi
            exit 0
            """
        )
    )
    (stub_bin / "mkdir").write_text("#!/bin/sh\nexit 0\n")
    (stub_bin / "sleep").write_text("#!/bin/sh\nexit 0\n")
    # uvicorn is exec'd at the end; exit 0 so the script terminates cleanly.
    (stub_bin / "uvicorn").write_text("#!/bin/sh\nexit 0\n")
    for stub in stub_bin.iterdir():
        stub.chmod(0o755)

    full_env = {
        **os.environ,
        "PATH": f"{stub_bin}:/usr/bin:/bin",
        "AWS_CALLS_LOG": str(log),
        # Neutralize any inherited RETRIEVAL_BACKEND / DOCUMENTS_S3_BUCKET /
        # PORT / WORKERS so the test fully controls them.
        "PORT": "8000",
        "WORKERS": "1",
    }
    # Neutralize start.sh-relevant vars leaked into os.environ by
    # conftest's load_env() (which loads .env.local). Pop them BEFORE the
    # caller's env is applied so each test fully controls these vars.
    for _k in (
        "RETRIEVAL_BACKEND",
        "DOCUMENTS_S3_BUCKET",
        "DOCUMENTS_S3_PREFIX",
        "CACHE_S3_PREFIX",
    ):
        full_env.pop(_k, None)
    # Caller env wins for the variables under test.
    full_env.update(env)
    # Make sure no leftover .env is auto-loaded by the script (it doesn't load
    # .env itself, but be defensive about shells that do).
    full_env.pop("ENV", None)

    proc = subprocess.run(
        ["sh", str(START_SH)],
        env=full_env,
        capture_output=True,
        text=True,
        cwd=str(sandbox),
    )
    calls = [
        line.strip() for line in log.read_text().splitlines() if line.strip()
    ]
    return proc.returncode, proc.stdout + proc.stderr, calls


def test_r1_documents_sync_runs_in_postgres_mode():
    """The bug fix: documents sync MUST fire under RETRIEVAL_BACKEND=postgres."""
    rc, out, calls = _run_startsh(
        {
            "RETRIEVAL_BACKEND": "postgres",
            "DOCUMENTS_S3_BUCKET": "askwri-data",
            "DOCUMENTS_S3_PREFIX": "documents/",
            "CACHE_S3_PREFIX": "cache/",
        }
    )
    assert rc == 0, f"start.sh exited {rc}:\n{out}"
    docs_dest = "/tmp/askWRI_docs"
    assert docs_dest in calls, (
        f"documents sync did NOT fire in postgres mode (regression R1). "
        f"aws sync dests observed: {calls}\nfull output:\n{out}"
    )


def test_r1_cache_sync_skipped_in_postgres_mode():
    """Postgres mode must skip the cache sync (embeddings live in pgvector)."""
    rc, out, calls = _run_startsh(
        {
            "RETRIEVAL_BACKEND": "postgres",
            "DOCUMENTS_S3_BUCKET": "askwri-data",
            "DOCUMENTS_S3_PREFIX": "documents/",
            "CACHE_S3_PREFIX": "cache/",
        }
    )
    assert rc == 0, f"start.sh exited {rc}:\n{out}"
    cache_dest = "/tmp/askWRI_cache"
    assert cache_dest not in calls, (
        f"cache sync fired in postgres mode (should be skipped). "
        f"aws sync dests observed: {calls}\nfull output:\n{out}"
    )


def test_r1_both_syncs_run_in_non_postgres_mode():
    """Non-postgres (legacy/memory) mode syncs BOTH documents and cache."""
    rc, out, calls = _run_startsh(
        {
            "RETRIEVAL_BACKEND": "memory",
            "DOCUMENTS_S3_BUCKET": "askwri-data",
            "DOCUMENTS_S3_PREFIX": "documents/",
            "CACHE_S3_PREFIX": "cache/",
        }
    )
    assert rc == 0, f"start.sh exited {rc}:\n{out}"
    assert "/tmp/askWRI_docs" in calls, (
        f"documents sync did not fire in non-postgres mode; calls={calls}"
    )
    assert "/tmp/askWRI_cache" in calls, (
        f"cache sync did not fire in non-postgres mode; calls={calls}"
    )


def test_r1_no_bucket_skips_all_syncs():
    """DOCUMENTS_S3_BUCKET unset → no syncs at all (unchanged behavior)."""
    rc, out, calls = _run_startsh({"RETRIEVAL_BACKEND": "postgres"})
    assert rc == 0, f"start.sh exited {rc}:\n{out}"
    assert calls == [], (
        f"syncs fired with no DOCUMENTS_S3_BUCKET (should be none): {calls}"
    )
