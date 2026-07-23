"""Secret-bearing Settings fields must not render their values.

pydantic BaseSettings has no custom __repr__, so every field renders with its
value. Nothing in the codebase deliberately logs the settings object — the leak
path is exceptions that embed the target's repr. Observed live on 2026-07-23:

    monkeypatch.setattr(main.settings, "does_not_exist", 3)
    -> AttributeError: Settings(..., OPENAI_API_KEY='sk-...', ...,
       mistral_api_key='...', ...) has no attribute 'does_not_exist'

which printed both live API keys in plaintext into the test output. The same
happens for any AttributeError against the settings object and for
pydantic ValidationError at startup.

CI does not currently hold real values (no .env files, no shell profile), so
today the same failure renders empty strings — but that is an accident of
configuration, not a safeguard: the moment a real key reaches the CI
environment, a routine test failure writes it into Actions logs.

SecretStr renders as '**********' in both repr() and str(), which closes the
whole class. The str() masking is itself a footgun — see the auth-header test.
"""
import pytest

from app.config import Settings, get_settings

SENTINEL_OPENAI = "sk-test-SENTINEL-openai-value-do-not-render"
SENTINEL_MISTRAL = "SENTINEL-mistral-value-do-not-render"


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _settings_with_secrets() -> Settings:
    return Settings(
        OPENAI_API_KEY=SENTINEL_OPENAI,
        mistral_api_key=SENTINEL_MISTRAL,
    )


def test_repr_does_not_leak_secret_values():
    """The exact failure mode observed 2026-07-23: an AttributeError message
    embeds repr(settings), so repr must not carry secret values."""
    s = _settings_with_secrets()

    rendered = repr(s)

    assert SENTINEL_OPENAI not in rendered
    assert SENTINEL_MISTRAL not in rendered


def test_str_does_not_leak_secret_values():
    s = _settings_with_secrets()

    rendered = str(s)

    assert SENTINEL_OPENAI not in rendered
    assert SENTINEL_MISTRAL not in rendered


def test_monkeypatch_attribute_error_does_not_leak_secret_values(monkeypatch):
    """Faithful reproduction of the 2026-07-23 leak.

    pydantic's own AttributeError does NOT embed the repr — monkeypatch's does:
    it raises `AttributeError(f"{target!r} has no attribute {name!r}")`. That is
    the message that printed both live keys into the test output, so this is the
    vector worth pinning, not a bare getattr.
    """
    s = _settings_with_secrets()

    with pytest.raises(AttributeError) as exc:
        monkeypatch.setattr(s, "definitely_not_a_settings_field", 1)

    message = str(exc.value)
    assert SENTINEL_OPENAI not in message
    assert SENTINEL_MISTRAL not in message


def test_secret_values_are_still_retrievable():
    """Masking must not cost access — the values still have to reach the
    Mistral and OpenAI clients."""
    s = _settings_with_secrets()

    assert s.mistral_api_key.get_secret_value() == SENTINEL_MISTRAL
    assert s.OPENAI_API_KEY.get_secret_value() == SENTINEL_OPENAI


def test_missing_mistral_key_is_still_falsy():
    """worker/stages/parse.py guards on `if not settings.mistral_api_key`.
    An empty SecretStr must stay falsy or that guard silently stops firing."""
    s = Settings(mistral_api_key="")

    assert not s.mistral_api_key


def test_mistral_auth_header_carries_the_real_key_not_the_mask():
    """The trap in this change: str(SecretStr) returns '**********', so an
    f-string interpolation would send `Bearer **********` and break OCR with a
    401 rather than a visible error. Pin the real value into the header."""
    from worker.stages import parse as parse_stage

    s = _settings_with_secrets()
    header = parse_stage._mistral_auth_header(s)

    assert header == f"Bearer {SENTINEL_MISTRAL}"
    assert "**********" not in header
