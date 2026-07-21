"""Process-env loader for local dev: .env.local (gitignored overrides), then .env.

override=False means the first value loaded wins, and anything already in the
real environment beats both files — the same precedence pydantic Settings gets
from its env_file tuple in app/config.py. Used by app.main, worker.main, and
tests/conftest so that os.environ consumers (boto3 reads AWS_ENDPOINT_URL and
credentials from the process env, never from pydantic Settings) see the same
values as everything else.
"""
from pathlib import Path

from dotenv import load_dotenv

_BASE = Path(__file__).resolve().parent.parent  # search-service/


def load_env(base: Path | None = None) -> None:
    for name in (".env.local", ".env"):
        path = (base or _BASE) / name
        if path.exists():
            load_dotenv(path, override=False)
