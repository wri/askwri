"""Deterministic facet parsers — year ranges and language (design §4.1).

CONSERVATIVE BY CONSTRUCTION. This corpus is full of target years ("net zero
by 2050", "2030 targets") that are not publication-year constraints, and of
nationality adjectives ("spanish cities") that are not language constraints.
Every pattern here requires an explicit constraint word, and every matched
year must be <= today_year. The trap cases in
tests/fixtures/facet_queries.json are load-bearing: a pattern change that
breaks one is wrong.
"""
import re

from app.understanding import Facet

_Y = r"(19[5-9]\d|20\d\d)"

# Prose connectors ("to"/"and") require a constraint word — bare
# "2019 and 2021" in a sentence describes subject matter, not a publication
# window. The compact numeric forms "2021-2024"/"2021–2024" are themselves
# explicit range notation and fire bare.
_RANGE_RE = re.compile(
    rf"\b(?:(?:between|from)\s+{_Y}\s*(?:-|–|\bto\b|\band\b)\s*{_Y}"
    rf"|{_Y}\s*[-–]\s*{_Y})\b",
    re.I,
)
_SINCE_RE = re.compile(rf"\b(?:since|after)\s+{_Y}\b", re.I)
# Open-ended floor ("between 2023 and now", "2023 to now", "from 2023
# onward", "2021-present"). The range rule above needs two literal years, so
# these matched nothing and the only facet on offer was the LLM's suggest-tier
# one, which never renders as a chip and never filters. Same result as
# "since 2023": year_min alone, no ceiling.
_OPEN_MIN_RE = re.compile(
    rf"\b(?:(?:between|from)\s+)?{_Y}\s*(?:-|–|\bto\b|\band\b)\s*"
    rf"(?:now|present|today|date)\b"
    rf"|\b(?:from\s+)?{_Y}\s*(?:onward|onwards|and\s+later|or\s+later)\b",
    re.I,
)
_BEFORE_RE = re.compile(
    rf"\b(?:(?:before|until|up to|prior to|pre[-\s])\s*{_Y}"
    rf"|{_Y}\s+and\s+(?:earlier|before))\b",
    re.I,
)
# Bare floor: "reports from 2020", "post-2018 studies". "from" is a
# constraint word of the same family as since/after, which the design already
# accepts ("lessons from 2018 floods" is the accepted cost: one wrong year chip,
# removable in one click). The lookahead keeps range phrasings for the range
# rule above, so a rejected target window ("from 2023 to 2035") stays empty
# rather than collapsing to its floor.
_FLOOR_RE = re.compile(
    rf"\b(?:from\s+|post[-\s])\s*{_Y}\b"
    rf"(?!\s*(?:-|–|\bto\b|\band\b)\s*{_Y})",
    re.I,
)
_PUBLISHED_IN_RE = re.compile(rf"\bpublished\s+in\s+{_Y}\b", re.I)
_LAST_N_RE = re.compile(r"\b(?:last|past)\s+(\d{1,2})\s+years?\b", re.I)

_LANGUAGES = {
    "spanish": "es",
    "portuguese": "pt",
    "chinese": "zh",
    "mandarin": "zh",
    "english": "en",
    "indonesian": "id",
}
# Constraint phrasings only — a bare adjective ("spanish cities") never fires.
# "in <lang>" fires only if followed by a preposition (about/on/for/...),
# punctuation, or end-of-string — so "in chinese cities" (geography) does
# NOT fire, but "reports in chinese on freight" (language) does. The
# trailing-noun case is the d2 trap: "Chinese cities" read as language=zh
# silently filtered the EN golden docs pre-rerank.
_LANG_RE = re.compile(
    r"(?:\bin\s+(spanish|portuguese|chinese|mandarin|english|indonesian)\b"
    r"(?=\s+(?:about|on|for|regarding|concerning)\b|[^\w\s]|$)"
    r"|\b(spanish|portuguese|chinese|mandarin|english|indonesian)[-\s]language\b)",
    re.I,
)


def _facet(name: str, value: str) -> Facet:
    return Facet(facet=name, value=value, confidence=0.9, source="parser", action="hard")


def parse_facets(query: str, today_year: int) -> list[Facet]:
    facets: list[Facet] = []
    remaining = query

    m = _RANGE_RE.search(remaining)
    if m:
        lo, hi = sorted(int(g) for g in m.groups() if g is not None)
        if hi <= today_year:
            facets.append(_facet("year_min", str(lo)))
            facets.append(_facet("year_max", str(hi)))
            remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet == "year_min" for f in facets):
        m = _OPEN_MIN_RE.search(remaining)
        if m:
            year = int(next(g for g in m.groups() if g is not None))
            if year <= today_year:
                facets.append(_facet("year_min", str(year)))
                remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet == "year_min" for f in facets):
        m = _SINCE_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_min", m.group(1)))
            remaining = remaining[: m.start()] + remaining[m.end():]
        else:
            m = _LAST_N_RE.search(remaining)
            if m:
                facets.append(_facet("year_min", str(today_year - int(m.group(1)))))
                remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet == "year_min" for f in facets):
        m = _FLOOR_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_min", m.group(1)))
            remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet == "year_max" for f in facets):
        m = _BEFORE_RE.search(remaining)
        year = int(next(g for g in m.groups() if g is not None)) if m else None
        if year is not None and year <= today_year:
            facets.append(_facet("year_max", str(year)))
            remaining = remaining[: m.start()] + remaining[m.end():]

    if not any(f.facet in ("year_min", "year_max") for f in facets):
        m = _PUBLISHED_IN_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_min", m.group(1)))
            facets.append(_facet("year_max", m.group(1)))

    m = _LANG_RE.search(query)
    if m:
        lang_word = (m.group(1) or m.group(2)).lower()
        facets.append(_facet("language", _LANGUAGES[lang_word]))

    return facets
