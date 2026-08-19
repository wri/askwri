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

_RANGE_RE = re.compile(
    rf"\b(?:between\s+|from\s+)?{_Y}\s*(?:-|–|\bto\b|\band\b)\s*{_Y}\b", re.I
)
_SINCE_RE = re.compile(rf"\b(?:since|after)\s+{_Y}\b", re.I)
_BEFORE_RE = re.compile(rf"\b(?:before|until|up to|prior to)\s+{_Y}\b", re.I)
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
_LANG_RE = re.compile(
    r"(?:\bin\s+(spanish|portuguese|chinese|mandarin|english|indonesian)\b"
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
        lo, hi = sorted((int(m.group(1)), int(m.group(2))))
        if hi <= today_year:
            facets.append(_facet("year_min", str(lo)))
            facets.append(_facet("year_max", str(hi)))
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

    if not any(f.facet == "year_max" for f in facets):
        m = _BEFORE_RE.search(remaining)
        if m and int(m.group(1)) <= today_year:
            facets.append(_facet("year_max", m.group(1)))
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
