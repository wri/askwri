# search-service/app/alias_expand.py
"""Alias-expansion lane source (design 2026-08-19 §4.1 deterministic tier,
§4.3 P2).

tag_aliases lookup for vocabulary expansion — the correct-mechanics
replacement for DOMAIN_EXPANSIONS OR-stuffing: expansions feed a SEPARATE
1x-weight sparse lane (Task 5) and never touch the original ranking.

Failure posture: expand() lets fetch errors propagate; the caller
(build_understanding) records `alias_expansion` in understanding.degraded
and the query proceeds without a lane (spec §5 — one attempt, no retry)."""
import logging
import re

logger = logging.getLogger(__name__)


class AliasExpander:
    """Deterministic by construction: longest matched phrase first,
    case-insensitive alphabetical order within a group, hard caps mirroring
    expand_query_conservative (3 groups x 2 terms) so what replaces the
    dictionary is auditable against it."""

    def __init__(self, fetch_groups, max_groups: int = 3, max_terms: int = 2):
        self._fetch_groups = fetch_groups  # () -> {value_id: [alias, ...]}
        self._max_groups = max_groups
        self._max_terms = max_terms

    def expand(self, query: str) -> list[str]:
        if not query or not query.strip():
            return []
        groups = self._fetch_groups() or {}
        q = query.lower()
        matches = []  # (matched_term, [expansion terms])
        for label, aliases in groups.items():
            terms = [label] + list(aliases)
            matched = None
            # Longest term first so a phrase beats its own substring.
            for t in sorted(terms, key=len, reverse=True):
                if len(t) < 3:
                    continue  # 'EV'-length terms over-match (design §4.1)
                pattern = (
                    r"(?<![a-z0-9])" + re.escape(t.lower()) + r"(?![a-z0-9])"
                )
                if re.search(pattern, q):
                    matched = t
                    break
            if matched is None:
                continue
            expansions = sorted(
                (t for t in terms if t.lower() != matched.lower()),
                key=str.lower,
            )[: self._max_terms]
            if expansions:
                matches.append((matched, expansions))
        # Longest matched phrase first (specific beats generic), then cap.
        matches.sort(key=lambda m: len(m[0]), reverse=True)
        out: list[str] = []
        seen = {q}
        for _, terms in matches[: self._max_groups]:
            for t in terms:
                if t.lower() not in seen:
                    seen.add(t.lower())
                    out.append(t)
        return out


def db_expander() -> AliasExpander:
    from app.config import get_settings
    from app.db import get_pool

    def fetch_groups():
        with get_pool().connection() as conn:
            rows = conn.execute(
                """SELECT t.value_id, a.alias
                   FROM tag_aliases a JOIN tags t ON t.id = a.tag_id"""
            ).fetchall()
        groups: dict[str, list[str]] = {}
        for value_id, alias in rows:
            groups.setdefault(value_id, []).append(alias)
        return groups

    s = get_settings()
    return AliasExpander(
        fetch_groups, s.alias_expand_max_groups, s.alias_expand_max_terms
    )
