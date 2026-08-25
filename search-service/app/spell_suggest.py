"""Trigram did-you-mean against search_vocab (design §3, §4.1).

Evidence rule, server half: suggest only when a query word is
out-of-corpus-vocabulary AND a close trigram neighbor exists. The client
half (auto-switch when results are near-empty) lives in the UI. One
suggestion max per query; lookup failure is silent (failure-soft, spec §5).
"""
import logging
import re

from app.understanding import Suggestion

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[a-zA-Z][a-zA-Z-]{3,}")  # >=4 chars: short words are noise

_SKIP = {
    "have", "what", "where", "when", "which", "about", "with", "from",
    "published", "papers", "reports", "report", "study", "studies",
    "cities", "city", "urban", "their", "does", "into", "this", "that",
}


class TrigramSuggester:
    def __init__(self, exact_lookup, fuzzy_lookup, similarity_threshold: float,
                 min_df: int = 1):
        self._exact = exact_lookup
        self._fuzzy = fuzzy_lookup
        self._threshold = similarity_threshold
        # df floor: a correction target must be an established corpus term.
        # The vocabulary is titles+tags+aliases, so ordinary English words are
        # structurally OOV — without the floor, any of them can be 'corrected'
        # to a one-off title word that happens to clear the similarity bar.
        self._min_df = min_df

    def suggest(self, query: str) -> Suggestion | None:
        words = [w.lower() for w in _WORD_RE.findall(query) if w.lower() not in _SKIP]
        if not words:
            return None
        try:
            known = self._exact(words)
            corrections = {}
            for w in words:
                if w in known:
                    continue
                hit = self._fuzzy(w)
                if hit is None:
                    continue
                term, sim, df = hit
                if sim >= self._threshold and term != w and df >= self._min_df:
                    corrections[w] = term
        except Exception as exc:  # noqa: BLE001 — never fail a search on suggestions
            logger.warning(f"spell suggest degraded: {exc}")
            return None
        if not corrections:
            return None

        corrected = re.sub(
            _WORD_RE,
            lambda m: corrections.get(m.group(0).lower(), m.group(0)),
            query,
        )
        if corrected == query:
            return None
        return Suggestion(type="spelling", text=corrected)


def db_suggester() -> TrigramSuggester:
    from app.config import get_settings
    from app.db import get_pool

    def exact_lookup(words):
        with get_pool().connection() as conn:
            rows = conn.execute(
                "SELECT term FROM search_vocab WHERE term = ANY(%s)", (words,)
            ).fetchall()
        return {t for (t,) in rows}

    def fuzzy_lookup(word):
        with get_pool().connection() as conn:
            row = conn.execute(
                """SELECT term, similarity(term, %(w)s) AS sim, df
                   FROM search_vocab WHERE term %% %(w)s
                   ORDER BY sim DESC LIMIT 1""",
                {"w": word},
            ).fetchone()
        return (row[0], float(row[1]), int(row[2])) if row else None

    s = get_settings()
    return TrigramSuggester(
        exact_lookup, fuzzy_lookup, s.spell_suggest_similarity,
        min_df=s.spell_suggest_min_df,
    )
