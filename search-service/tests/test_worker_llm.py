"""Tests for worker.llm.chat_json robustness (None content, truncation, retry)."""
from unittest.mock import patch, MagicMock

import pytest


def _choice(content, finish_reason="stop"):
    msg = MagicMock()
    msg.content = content
    ch = MagicMock()
    ch.message = msg
    ch.finish_reason = finish_reason
    return ch


def _resp(*choices):
    r = MagicMock()
    r.choices = list(choices)
    return r


def _make_client(resps):
    """Return a fake OpenAI client whose chat.completions.create returns resps in order."""
    client = MagicMock()
    client.chat.completions.create = MagicMock(side_effect=resps)
    return client


def test_chat_json_parses_valid_json():
    from worker.llm import chat_json

    client = _make_client([_resp(_choice('{"long":"x","short":"y"}'))])
    with patch("openai.OpenAI", return_value=client):
        out = chat_json("sys", "user", {"type": "object"}, "m")
    assert out == {"long": "x", "short": "y"}


def test_chat_json_retries_on_none_content_then_succeeds():
    """finish_reason='length' with content=None (truncated) then a good response → succeed."""
    from worker.llm import chat_json

    client = _make_client(
        [_resp(_choice(None, "length")), _resp(_choice('{"long":"x","short":"y"}'))]
    )
    with patch("openai.OpenAI", return_value=client):
        out = chat_json("sys", "user", {"type": "object"}, "m")
    assert out == {"long": "x", "short": "y"}
    assert client.chat.completions.create.call_count == 2


def test_chat_json_retries_on_unparseable_json_then_succeeds():
    """A non-JSON content string then a good response → succeed (retry)."""
    from worker.llm import chat_json

    client = _make_client(
        [_resp(_choice("not json")), _resp(_choice('{"long":"x","short":"y"}'))]
    )
    with patch("openai.OpenAI", return_value=client):
        out = chat_json("sys", "user", {"type": "object"}, "m")
    assert out == {"long": "x", "short": "y"}


def test_chat_json_raises_clear_error_after_max_retries_on_none_content():
    """Persistent content=None → clear RuntimeError mentioning finish_reason, not json.loads."""
    from worker.llm import chat_json

    client = _make_client(
        [_resp(_choice(None, "length")), _resp(_choice(None, "length"))]
    )
    with patch("openai.OpenAI", return_value=client):
        with pytest.raises(RuntimeError, match="empty or truncated.*length"):
            chat_json("sys", "user", {"type": "object"}, "m")
