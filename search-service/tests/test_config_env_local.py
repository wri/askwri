"""Settings env_file chain: .env.local overrides .env; real env beats files."""
from app.config import Settings


def test_env_local_overrides_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("RETRIEVAL_BACKEND=legacy\nPORT=8123\n")
    (tmp_path / ".env.local").write_text("RETRIEVAL_BACKEND=postgres\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("RETRIEVAL_BACKEND", raising=False)
    monkeypatch.delenv("PORT", raising=False)
    s = Settings()
    assert s.retrieval_backend == "postgres"  # .env.local wins
    assert s.port == 8123  # .env still read for keys .env.local lacks


def test_real_env_beats_files(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("RETRIEVAL_BACKEND=legacy\n")
    (tmp_path / ".env.local").write_text("RETRIEVAL_BACKEND=postgres\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RETRIEVAL_BACKEND", "memory")
    assert Settings().retrieval_backend == "memory"
