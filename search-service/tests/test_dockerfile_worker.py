"""B1 — the ingestion-worker package is present and importable in the Docker image.

Regression test for finding B1 in docs/plans/2026-07-01-doc-mgmt-review-findings.md.

The bug: search-service/Dockerfile only COPYed `app/` into the image. The
ingestion worker package lives at `search-service/worker/` and the worker ECS
task runs `python -m worker.main`. So the worker container hit
`ModuleNotFoundError: No module named 'worker'` and crash-looped — no
ingestion ever ran.

The fix: `COPY --chown=appuser:appgroup worker/ ./worker/` added to the
production stage.

This test is the only honest proof of the fix: it builds the actual production
image and asserts `import worker.main` resolves inside it. It is NOT a unit
test — it requires Docker and pays the full image-build cost (the Dockerfile
deps stage pre-downloads ~860MB of reranker models). It is therefore gated
behind REQUIRE_DOCKER_TESTS=1 so the fast suite is never blocked by it.

Run it explicitly:

    REQUIRE_DOCKER_TESTS=1 ./venv/bin/python -m pytest tests/test_dockerfile_worker.py -v

CI should set REQUIRE_DOCKER_TESTS=1 in a dedicated job (or run this module
on a schedule). It is intentionally not collected by the default `pytest tests/`
gate unless that env var is set.
"""
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO_ROOT / "search-service" / "Dockerfile"
WORKER_PKG = REPO_ROOT / "search-service" / "worker" / "__init__.py"

_requires_docker = pytest.mark.skipif(
    os.getenv("REQUIRE_DOCKER_TESTS") != "1",
    reason="REQUIRE_DOCKER_TESTS!=1 (builds a ~860MB image; opt-in)",
)
_requires_docker_bin = pytest.mark.skipif(
    shutil.which("docker") is None,
    reason="docker binary not on PATH",
)


@_requires_docker
@_requires_docker_bin
def test_b1_worker_package_importable_in_image():
    """`python -c 'import worker.main'` succeeds inside the built image.

    This is the exact failure the bug caused (ModuleNotFoundError) and the
    exact thing the ECS task does (`python -m worker.main`). Building the
    image is the only way to confirm the COPY line actually lands `worker/`
    at the right path with the right ownership for the non-root user.
    """
    tag = f"askwri-b1-test:{uuid.uuid4().hex[:8]}"
    try:
        build = subprocess.run(
            [
                "docker",
                "build",
                "-f",
                str(DOCKERFILE),
                "-t",
                tag,
                str(REPO_ROOT / "search-service"),
            ],
            capture_output=True,
            text=True,
        )
        assert build.returncode == 0, (
            f"docker build failed (rc={build.returncode}):\n"
            f"--- stdout ---\n{build.stdout}\n--- stderr ---\n{build.stderr}"
        )

        # `python -m worker.main` would start the poll loop and hang; we only
        # need to prove the module resolves, so import it and exit.
        run = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--entrypoint",
                "python",
                tag,
                "-c",
                "import worker.main; print('worker.main OK')",
            ],
            capture_output=True,
            text=True,
        )
        assert run.returncode == 0, (
            f"`import worker.main` failed inside the image (rc={run.returncode}). "
            f"This is the B1 regression — worker/ not in the image.\n"
            f"--- stdout ---\n{run.stdout}\n--- stderr ---\n{run.stderr}"
        )
        assert "worker.main OK" in run.stdout
    finally:
        # Best-effort cleanup; never let a dangling image fail the test.
        subprocess.run(
            ["docker", "rmi", "-f", tag],
            capture_output=True,
            text=True,
            timeout=60,
        )


def test_ghostscript_installed_in_image():
    """Issue #310 follow-up (Fix 2): the parse stage shells out to `gs` to
    shrink PDFs over Mistral OCR's 50MB limit. If the apt line loses
    ghostscript, oversized documents fail with 'Ghostscript is not installed'
    at parse time — a deploy-only failure no unit test would catch. Text
    assertion, not a build: this must run in the fast suite."""
    text = DOCKERFILE.read_text()
    assert "ghostscript" in text, (
        "search-service/Dockerfile must apt-install ghostscript — "
        "worker/stages/parse.py::_shrink_pdf shells out to `gs`"
    )


@_requires_docker_bin
def test_b1_worker_package_exists_in_source_tree():
    """Fast sanity check (no Docker): the source `worker/` package exists.

    The Docker COPY can only succeed if the directory is there to copy. This
    catches a future refactor that moves/renames `worker/` without updating
    the Dockerfile — a cheap precondition that runs without REQUIRE_DOCKER_TESTS.
    """
    assert WORKER_PKG.exists(), (
        f"{WORKER_PKG} not found — the Dockerfile COPY worker/ would fail at "
        f"build time. Did the worker package move?"
    )
