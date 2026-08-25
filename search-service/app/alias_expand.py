# search-service/app/alias_expand.py
"""Alias-expansion diagnostic source (design 2026-08-19 §4.1, §4.3 P2;
retired as a retrieval lane by P2.5 — see app/topic_retrieval.py).

tag_aliases lookup for vocabulary expansion. As of P2.5 the alias LANE is
retired (the semantic topic_dense lane replaces it); this module now only
populates the diagnostic `alias_expansions` field on QueryUnderstanding.
Failure posture: expand() lets fetch errors propagate; the caller
(build_understanding) records `alias_expansion` in understanding.degraded
and the query proceeds without the diagnostic field (spec §5 — one attempt,
no retry)."""
import logging
import re

logger = logging.getLogger(__name__)


class AliasExpander:
    """Deterministic by construction: longest matched phrase first, CURATED
    order within a group (the stored alias order — seed arrays lead with the
    strongest synonyms; alphabetical selection shipped "costs, economic"
    over "financing, funding", investigation 2026-08-20 §M2), hard caps
    mirroring expand_query_conservative (3 groups x 2 terms) so what
    replaces the dictionary is auditable against it. The tag label
    participates in matching but is never emitted as an expansion."""

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
            expansions = [
                t for t in aliases if t.lower() != matched.lower()
            ][: self._max_terms]
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
            # created_at is insertion order — the seed script inserts one
            # row per statement in curated array order. Alias tie-break only
            # matters if timestamps ever collide (bulk insert in one txn).
            rows = conn.execute(
                """SELECT t.value_id, a.alias
                   FROM tag_aliases a JOIN tags t ON t.id = a.tag_id
                   ORDER BY a.created_at, a.alias"""
            ).fetchall()
        groups: dict[str, list[str]] = {}
        for value_id, alias in rows:
            groups.setdefault(value_id, []).append(alias)
        return groups

    s = get_settings()
    return AliasExpander(
        fetch_groups, s.alias_expand_max_groups, s.alias_expand_max_terms
    )
