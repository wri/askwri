"""Automatic query translation for the sparse lane (see query_expansion.py).

One LLM call per distinct query, LRU-cached, hard-timeout'd, and failure-soft:
a translation outage degrades to the untranslated query rather than failing the
search (mirrors the dense lane's sparse-only degradation, main.py:244).

This sits in the request path, so latency is the binding constraint:
  - ONE call covering every configured language, never one call per language
  - LRU cache keyed on (query, languages) — repeat queries, eval loops and
    re-searches skip the hop entirely, exactly like bedrock_embed.embed_query
  - a short timeout; a slow translator must not hold a search hostage

Only the SPARSE lane consumes this. Dense is already multilingual and the
reranker must never see the multilingual text — putting it there cost 4 English
competitors and ~40% of result-list length in the 2026-07-24 probe.
"""
import json
import logging
from functools import lru_cache

from app import usage_meter
from app.config import get_settings

logger = logging.getLogger(__name__)

_LANG_NAMES = {
    "es": "Spanish", "pt": "Portuguese", "zh": "Simplified Chinese",
    "id": "Indonesian", "fr": "French", "en": "English",
}

_SYSTEM = (
    "You translate short search queries for a document retrieval system. "
    "Return JSON mapping each requested language code to a faithful translation "
    "of the query into that language. Preserve proper nouns, place names, "
    "organization names and technical terms as they would appear in published "
    "documents in that language. Translate the query only — add no commentary, "
    "no explanation, and no extra terms."
)


def _languages() -> tuple:
    raw = get_settings().query_translation_languages or ""
    return tuple(x.strip() for x in raw.split(",") if x.strip())


@lru_cache(maxsize=512)
def _translate_cached(query: str, languages: tuple) -> str:
    """Returns a JSON string so the cache holds a hashable, immutable value."""
    import os

    from openai import OpenAI

    settings = get_settings()
    wanted = ", ".join(f"{code} ({_LANG_NAMES.get(code, code)})" for code in languages)
    client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY"),
        timeout=settings.query_translation_timeout_s,
        max_retries=0,          # the request path cannot absorb retries
    )
    resp = client.chat.completions.create(
        model=settings.query_translation_model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user",
             "content": f"Languages: {wanted}\nQuery: {query}"},
        ],
    )
    usage = getattr(resp, "usage", None)
    if usage:
        usage_meter.record_tokens(
            "query_translation", settings.query_translation_model,
            input_tokens=usage.prompt_tokens,
            output_tokens=usage.completion_tokens,
        )
    return resp.choices[0].message.content or "{}"


def translate_query(query: str, languages) -> dict:
    """{lang: translated_text}. Raises on failure — build_sparse_query catches."""
    languages = tuple(languages)
    if not languages or not query or not query.strip():
        return {}
    raw = _translate_cached(query, languages)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Query translation returned non-JSON — ignoring")
        return {}
    return {k: v for k, v in data.items()
            if isinstance(v, str) and k in languages}


def get_translator():
    """The callable build_sparse_query expects, or None when disabled.

    None is the default and makes build_sparse_query byte-identical to
    expand_query_conservative, so the feature ships dark.
    """
    settings = get_settings()
    if not settings.query_translation_enabled:
        return None
    if not _languages():
        return None
    return translate_query
