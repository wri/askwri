"""THE facet application point — post-fusion, pre-rerank (design §4.5).

One code path for parser-detected, user-chip, and legacy-param facets.
Only action='hard' facets exclude (Invariant 1: every one of these is
rendered as a removable chip by the UI; Invariant 2: all hard facet types
are human-verifiable metadata)."""
from typing import List

import unicodedata

from app.understanding import Facet


def _normalize_office(s: str) -> str:
    # Case-, accent- and whitespace-insensitive: the UI canonicalizes values
    # ("WRI US" → "WRI Us", all accents stripped) while the corpus keeps its
    # own spelling ("WRI México", "WRI US", stray double spaces).
    stripped = "".join(
        ch
        for ch in unicodedata.normalize("NFD", s.casefold())
        if not unicodedata.combining(ch)
    )
    return " ".join(stripped.split())


def legacy_request_facets(request) -> List[Facet]:
    out: List[Facet] = []
    if getattr(request, "min_year", None):
        out.append(Facet(facet="year_min", value=str(request.min_year),
                         confidence=1.0, source="user", action="hard"))
    if getattr(request, "max_year", None):
        out.append(Facet(facet="year_max", value=str(request.max_year),
                         confidence=1.0, source="user", action="hard"))
    if getattr(request, "required_program", None):
        out.append(Facet(facet="program", value=request.required_program,
                         confidence=1.0, source="user", action="hard"))
    for kw in (getattr(request, "excluded_keywords", None) or []):
        out.append(Facet(facet="excluded_keyword", value=kw,
                         confidence=1.0, source="user", action="hard"))
    return out


def apply_facet_filters(nodes, facets: List[Facet], docs_meta: dict):
    year_min = year_max = None
    program = None
    languages = []
    offices = []
    excluded = []
    for f in facets:
        if f.action != "hard":
            continue
        if f.facet == "year_min":
            try:
                year_min = int(f.value)
            except (ValueError, TypeError):
                continue  # invalid chip value: drop the facet, never a 500
        elif f.facet == "year_max":
            try:
                year_max = int(f.value)
            except (ValueError, TypeError):
                continue  # invalid chip value: drop the facet, never a 500
        elif f.facet == "language":
            languages.append(f.value.casefold())
        elif f.facet == "program":
            program = f.value
        elif f.facet == "office":
            offices.append(f.value)
        elif f.facet == "excluded_keyword":
            excluded.append(f.value.lower())

    if year_min is None and year_max is None and program is None and not languages and not offices and not excluded:
        return nodes

    out = []
    for nws in nodes:
        md = nws.node.metadata or {}
        doc = docs_meta.get(md.get("doc_id")) or {}

        if year_min is not None or year_max is not None:
            year = doc.get("year_int")
            if year is None:
                raw = md.get("year")
                if raw is not None:
                    try:
                        year = int(raw)
                    except (ValueError, TypeError):
                        continue  # present-but-unparseable year is excluded (legacy semantics)
            # year still None ⇒ no year metadata at all: KEPT, matching
            # apply_metadata_filters (main.py:361 falls through on None).
            if year is not None:
                if year_min is not None and year < year_min:
                    continue
                if year_max is not None and year > year_max:
                    continue

        # Language is only hydrated on the postgres backend; a doc with
        # unknown language is KEPT (exclude only on a positive mismatch).
        # Multiple language facets are OR (the FilterPanel is multi-select);
        # values are ISO codes, compared case-insensitively. Matching is
        # WORK-level: a bilingual work (es original + en translation) is two
        # document rows, and either row matches when either language is
        # selected — mirroring the versions the doc card shows.
        if languages:
            doc_language = doc.get("language")
            work_languages = doc.get("work_languages") or frozenset()
            doc_matches = doc_language is not None and (
                doc_language.casefold() in languages
                or any(l.casefold() in languages for l in work_languages)
            )
            if doc_language is not None and not doc_matches:
                continue

        if program is not None and md.get("program_series", "") != program:
            continue

        # Office lives in raw_metadata (wri_primary_office); a doc with unknown
        # office is KEPT (exclude only on a positive mismatch), like language.
        # Comparison is accent-, case- and whitespace-insensitive: the corpus
        # mixes "WRI México"/"WRI Mexico" and "WRI US"/"WRI Us".
        # Multiple office facets are OR: keep docs matching any of them.
        if offices:
            doc_office = doc.get("office")
            if doc_office is not None and not any(
                _normalize_office(doc_office) == _normalize_office(o) for o in offices
            ):
                continue

        if excluded:
            title = (md.get("title") or "").lower()
            text = nws.node.text.lower()
            if any(kw in title or kw in text for kw in excluded):
                continue

        out.append(nws)
    return out
