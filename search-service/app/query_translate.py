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

# Answer-mode rendering (design 2026-09-09 §3.2): a single faithful rendering
# leaves the terminology up to the translator's coin flip (measured 2026-09-09:
# the literal 零排放卡车 scored the evalset's zh evidence 0.20-0.75 under
# Cohere; the corpus's own term 新能源重卡 scored 0.81-0.95). Two renderings
# — literal + field-terminology — OR-joined into one query bracket the
# vocabulary space at one rerank call per language.
_ANSWER_SYSTEM = (
    "You translate research questions for a retrieval system over transport, "
    "energy and climate policy publications. For each requested language, "
    "return TWO renderings: 'literal' (a faithful translation) and 'field' "
    "(rephrased the way a transport-energy policy researcher publishing in "
    "that language would put it — using that field's standard terminology for "
    "the concepts, e.g. the sector's usual term for the vehicle class and for "
    "market adoption). Return JSON mapping each language code to an object "
    "with 'literal' and 'field' keys. No commentary, no extra terms."
)

# Grounded re-rendering (plan 2026-09-10 §3.1, vocabulary grounding v1): the
# selection's seed chunks are the documents' own words; their frequent native
# terms are extracted (extract_native_terms below) and fed to this prompt as
# vocabulary hints, so the rendering lands on the corpus's terminology instead
# of the translator's coin flip (measured: OR-joined renderings score the zh
# evidence 0.70-0.79; corpus terminology 0.83-0.95). GUARDRAIL (plan §3): the
# vocabulary comes from the selected documents ONLY — never from evalset
# fixtures (key_facts, canonical_answer, text_snippets).
_GROUNDED_SYSTEM = (
    "You render a research question for a retrieval system over transport, "
    "energy and climate policy publications. The corpus's documents in the "
    "requested language use the field vocabulary listed with the question. "
    "Render the question in the requested language the way that field would "
    "phrase it, preferring the listed vocabulary's terms wherever they fit "
    "the question's concepts. Return JSON with a single key 'grounded' whose "
    "value is the rendering — one rendering, no alternatives, no commentary, "
    "no extra terms."
)


def _languages() -> tuple:
    raw = get_settings().query_translation_languages or ""
    return tuple(x.strip() for x in raw.split(",") if x.strip())


@lru_cache(maxsize=512)
def _translate_cached(query: str, languages: tuple, timeout_s: float) -> str:
    """Returns a JSON string so the cache holds a hashable, immutable value.

    timeout_s is part of the cache key: cite (3s) and answer (8s) budgets
    produce separate entries — a call that succeeds under one budget is
    reused only by callers with the same budget, never silently re-fetched
    under a tighter one.
    """
    import os

    from openai import OpenAI

    settings = get_settings()
    wanted = ", ".join(f"{code} ({_LANG_NAMES.get(code, code)})" for code in languages)
    client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY"),
        timeout=timeout_s,
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


def translate_query(query: str, languages, timeout_s: float | None = None) -> dict:
    """{lang: translated_text}. Raises on failure — build_sparse_query catches.

    timeout_s defaults to the sparse lane's query_translation_timeout_s
    (cite-mode budget); answer-mode translation passes its own."""
    languages = tuple(languages)
    if not languages or not query or not query.strip():
        return {}
    if timeout_s is None:
        timeout_s = get_settings().query_translation_timeout_s
    raw = _translate_cached(query, languages, timeout_s)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Query translation returned non-JSON — ignoring")
        return {}
    return {k: v for k, v in data.items()
            if isinstance(v, str) and k in languages}


def _translate_answer_cached(query: str, languages: tuple, timeout_s: float) -> str:
    """Answer-mode two-rendering translation (see _ANSWER_SYSTEM). Separate
    cache entry from the single-rendering call: different prompt, different
    result shape."""
    import os

    from openai import OpenAI

    settings = get_settings()
    wanted = ", ".join(f"{code} ({_LANG_NAMES.get(code, code)})" for code in languages)
    client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY"),
        timeout=timeout_s,
        max_retries=0,          # the request path cannot absorb retries
    )
    resp = client.chat.completions.create(
        model=settings.query_translation_model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _ANSWER_SYSTEM},
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


def translate_query_orjoined(query: str, languages, timeout_s: float | None = None) -> dict:
    """{lang: "literal / field"} — the answer-mode two-rendering translation,
    OR-joined into one query string per language (design 2026-09-09 §3.2).
    Raises on failure — build_answer_translation catches."""
    languages = tuple(languages)
    if not languages or not query or not query.strip():
        return {}
    if timeout_s is None:
        timeout_s = get_settings().query_translation_timeout_s
    raw = _translate_answer_cached(query, languages, timeout_s)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Answer translation returned non-JSON — ignoring")
        return {}
    out = {}
    for lang in languages:
        entry = data.get(lang)
        if not isinstance(entry, dict):
            continue
        parts = [str(entry.get(k, "")).strip() for k in ("literal", "field")]
        parts = [p for p in parts if p]
        if parts:
            out[lang] = " / ".join(parts)
    return out


# --- vocabulary grounding v1 (plan 2026-09-10 §3.1) ---------------------------

_ZH_FUNCTION_CHARS = set("的了是在和有不这上中大为个就也到以说要对会可将从把被其还让等之很着地时点更最比后内下年月日")

_LATIN_TERM_LANGS = {"es", "pt", "fr", "id"}

# Short hard-coded function-word list (Spanish/Portuguese, with a few shared
# French/Indonesian items) — a dependency or a big list is not warranted for
# prompt hints; anything stopword-touched is dropped, not scored.
_LATIN_STOPWORDS = {
    "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas",
    "y", "e", "o", "u", "en", "em", "con", "com", "para", "por", "al",
    "ao", "aos", "que", "se", "su", "sus", "sua", "seu", "seus", "suas",
    "es", "son", "sao", "são", "como", "mas", "mais", "más", "pero",
    "porque", "si", "sí", "sim", "no", "não", "nao", "este", "esta",
    "esto", "estos", "estas", "esse", "esa", "eso", "esas", "entre",
    "sobre", "desde", "hasta", "até", "ate", "según", "segundo", "sin",
    "sem", "ha", "han", "hay", "há", "fue", "foi", "ser", "muy",
    "muito", "también", "tambem", "também", "ya", "ja", "já", "le",
    "les", "des", "du", "et", "dan", "yang", "untuk", "dengan",
}


def _cjk_runs(text: str) -> list:
    import re
    return re.findall(r"[\u4e00-\u9fff]+", text)


def _latin_tokens(text: str) -> list:
    import re
    return re.findall(r"[^\W\d_]+", text.lower(), flags=re.UNICODE)


def extract_native_terms(texts, lang: str, max_terms: int = 12) -> list:
    """High-frequency native-language terms from the seed chunk texts
    (plan 2026-09-10 §3.1). The seed chunks ARE the selected documents' own
    words — corpus text, legitimate grounding material per the plan's
    guardrail (never evalset fixtures).

    Pure and deterministic: candidates are ranked by distinct-text frequency
    first (a term repeated inside one chunk is not corpus vocabulary), then
    length (longer forms beat their own substrings: 新能源重卡 survives,
    能源重卡 goes), then total occurrences. A small function-word stoplist
    drops pure mush; zh candidates are CJK-only so punctuation, digits and
    latin never leak into the hints. Unknown languages return [] — grounding
    silently degrades and the shipped rendering stays.
    """
    texts = [t for t in (texts or []) if t]
    if not texts or not lang or max_terms <= 0:
        return []
    if lang == "zh":
        df, total = {}, {}
        for text in texts:
            counts = {}
            for run in _cjk_runs(text):
                # n=2..6: the corpus's real terms run five and six characters
                # (新能源重卡, 市场渗透率) — the plan's named vocabulary must be
                # extractable, so the n-gram window covers it.
                for n in (2, 3, 4, 5, 6):
                    for i in range(len(run) - n + 1):
                        g = run[i:i + n]
                        counts[g] = counts.get(g, 0) + 1
            for g, c in counts.items():
                df[g] = df.get(g, 0) + 1
                total[g] = total.get(g, 0) + c
        min_df = 3 if len(texts) >= 3 else 2
        candidates = [g for g, d in df.items() if d >= min_df
                      and not all(ch in _ZH_FUNCTION_CHARS for ch in g)]
        candidates.sort(key=lambda g: (-df[g], -len(g), -total[g], g))
        kept = []
        for g in candidates:
            if any(g in k for k in kept):
                continue
            kept.append(g)
            if len(kept) >= max_terms:
                break
        return kept
    if lang in _LATIN_TERM_LANGS:
        df, total = {}, {}
        for text in texts:
            counts = {}
            toks = _latin_tokens(text)
            for n in (1, 2):
                for i in range(len(toks) - n + 1):
                    gram = " ".join(toks[i:i + n])
                    if any(w in _LATIN_STOPWORDS for w in gram.split()):
                        continue
                    counts[gram] = counts.get(gram, 0) + 1
            for g, c in counts.items():
                df[g] = df.get(g, 0) + 1
                total[g] = total.get(g, 0) + c
        min_df = 3 if len(texts) >= 3 else 2
        candidates = [g for g, d in df.items() if d >= min_df]
        candidates.sort(key=lambda g: (-df[g], -len(g), -total[g], g))
        return candidates[:max_terms]
    return []


@lru_cache(maxsize=512)
def _translate_grounded_cached(query: str, lang: str, terms: tuple,
                               timeout_s: float) -> str:
    """Raw response for the grounded re-rendering; separate cache entry from
    the other translators (different prompt, different result shape). terms
    is a tuple so the cache stays hashable."""
    import os

    from openai import OpenAI

    settings = get_settings()
    wanted = f"{lang} ({_LANG_NAMES.get(lang, lang)})"
    client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY"),
        timeout=timeout_s,
        max_retries=0,          # the request path cannot absorb retries
    )
    resp = client.chat.completions.create(
        model=settings.query_translation_model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _GROUNDED_SYSTEM},
            {"role": "user",
             "content": (f"Language: {wanted}\n"
                         f"Corpus vocabulary: {', '.join(terms)}\n"
                         f"Question: {query}")},
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


def translate_query_grounded(query: str, lang: str, terms,
                             timeout_s: float | None = None) -> str:
    """One grounded rendering (plan 2026-09-10 §3.1): the first-pass
    translation re-rendered in the corpus's own vocabulary. Raises on any
    bad input or bad response — build_answer_translation catches and keeps
    the shipped rendering (failure-soft, the bundle is never dropped).
    """
    cleaned = tuple(t.strip() for t in (terms or ()) if t and t.strip())
    if not query or not query.strip() or not lang or not cleaned:
        raise ValueError(
            "translate_query_grounded needs a query, a language and corpus terms")
    if timeout_s is None:
        timeout_s = get_settings().query_translation_timeout_s
    raw = _translate_grounded_cached(query, lang, cleaned, timeout_s)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Grounded translation returned non-JSON")
        raise ValueError("grounded translation returned non-JSON")
    text = data.get("grounded") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise ValueError("grounded translation missing a usable 'grounded' rendering")
    return text.strip()


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
