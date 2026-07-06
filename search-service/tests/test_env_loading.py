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
