"""app.env.load_env: .env.local wins over .env; real env wins over both."""
import os

from app.env import load_env


def test_env_local_wins_and_env_still_loads(tmp_path):
    (tmp_path / ".env").write_text("ASKWRI_CANARY_A=from_env\nASKWRI_CANARY_B=base\n")
    (tmp_path / ".env.local").write_text("ASKWRI_CANARY_A=from_env_local\n")
    try:
        load_env(tmp_path)
        assert os.environ["ASKWRI_CANARY_A"] == "from_env_local"
        assert os.environ["ASKWRI_CANARY_B"] == "base"
    finally:
        os.environ.pop("ASKWRI_CANARY_A", None)
        os.environ.pop("ASKWRI_CANARY_B", None)


def test_real_env_beats_both(tmp_path, monkeypatch):
    monkeypatch.setenv("ASKWRI_CANARY_A", "real")
    (tmp_path / ".env").write_text("ASKWRI_CANARY_A=from_env\n")
    (tmp_path / ".env.local").write_text("ASKWRI_CANARY_A=from_env_local\n")
    load_env(tmp_path)
    assert os.environ["ASKWRI_CANARY_A"] == "real"


def test_missing_files_are_fine(tmp_path):
    load_env(tmp_path)  # no .env/.env.local in tmp_path — must not raise


def test_every_s3_touching_script_bootstraps_the_environment():
    """Any script that reads documents from S3 must call load_env() at import.

    pydantic Settings reads .env.local by itself, so every Settings-derived
    value looks right without it — but boto3 reads os.environ, and without the
    bootstrap AWS_ENDPOINT_URL is absent and the script silently talks to REAL
    S3 instead of local MinIO. That happened for real on 2026-08-05 with
    scripts/batch_ocr.py: a live run read the production bucket while every
    other signal (database, bucket name, config) said 'local'.

    Checked at source level because the failure is an import-time side effect,
    and the symptom is silent rather than an exception.

    Scoped to scripts that read the DOCUMENT CORPUS, which is what MinIO
    substitutes for locally. scripts/parse_fixture.py is deliberately excluded:
    it drives Bedrock Data Automation, a real AWS service with no local
    stand-in, so pointing it at MinIO would be wrong.
    """
    from pathlib import Path

    scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
    offenders = []
    for path in sorted(scripts_dir.glob("*.py")):
        source = path.read_text()
        reads_corpus = "_load_pdf_bytes" in source or "documents_s3_bucket" in source
        if reads_corpus and "load_env()" not in source:
            offenders.append(path.name)

    assert not offenders, (
        f"these scripts read S3 but never call load_env(), so boto3 will use real "
        f"AWS instead of MinIO in local runs: {offenders}"
    )
