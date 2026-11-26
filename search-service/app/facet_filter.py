"""THE facet application point — post-fusion, pre-rerank (design §4.5).

One code path for parser-detected, user-chip, and legacy-param facets.
Only action='hard' facets exclude (Invariant 1: every one of these is
rendered as a removable chip by the UI; Invariant 2: all hard facet types
are human-verifiable metadata)."""
from typing import List, Optional, Set
from datetime import date
import logging
import re

import unicodedata

from app.understanding import FACET_MODES, Facet

logger = logging.getLogger(__name__)


def _normalize_meta(s: str) -> str:
    # Case-, accent-, dash- and whitespace-insensitive: the UI canonicalizes
    # values ("WRI US" → "WRI Us", all accents stripped) while the corpus
    # keeps its own spelling ("WRI México", "WRI US", stray double spaces,
    # hyphen/en-dash joins like "zero–emission").
    stripped = "".join(
        (" " if unicodedata.category(ch) == "Pd" else ch)
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


def _exclusion_patterns(facets: List[Facet]):
    # Each term compiled once per request as whole normalized words:
    # "coal" must not match "coalition", "zero–emission" must match
    # "ZERO EMISSION". A term with no tokens (blank value) never matches.
    terms = set()
    for f in facets:
        if f.action != "hard" or FACET_MODES.get(f.facet) != "negate":
            continue
        tokens = _normalize_meta(f.value).split()
        if tokens:
            terms.add(r"(?<!\w)" + r"\s+".join(re.escape(t) for t in tokens) + r"(?!\w)")
    return [re.compile(t) for t in terms]


def excluded_doc_ids(
    nodes, facets: List[Facet], docs_meta: dict, translation_pairs: Optional[dict] = None,
) -> Set[str]:
    patterns = _exclusion_patterns(facets)
    if not patterns:
        return set()
    pairs = translation_pairs or {}
    out: Set[str] = set()
    for nws in nodes:
        md = nws.node.metadata or {}
        doc_id = md.get("doc_id")
        pair = pairs.get(doc_id) or {}
        title = md.get("title") or docs_meta.get(doc_id, {}).get("title") or ""
        fields = [title, nws.node.text]
        if pair.get("original_title"):
            fields.append(pair["original_title"])
        # Each field normalized and scanned separately, so a phrase can't
        # false-match across a title/text boundary.
        if any(p.search(_normalize_meta(v)) for v in fields for p in patterns):
            out.add(doc_id)
            if pair.get("original"):
                out.add(pair["original"])
    return out


def apply_facet_filters(
    nodes, facets: List[Facet], docs_meta: dict,
    translation_pairs: Optional[dict] = None, excluded_ids: Optional[Set[str]] = None,
):
    year_min = year_max = None
    date_min = date_max = None
    program = None
    languages = []
    offices = []
    for f in facets:
        if f.action != "hard":
            continue
        mode = FACET_MODES.get(f.facet)
        if mode is None:
            logger.warning("facet_filter: no policy mode for facet %r; skipping", f.facet)
            continue
        if mode == "negate":
            continue  # handled document-level by excluded_doc_ids
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
        elif f.facet in ("date_min", "date_max"):
            try:
                bound = date.fromisoformat(f.value)
            except (ValueError, TypeError):
                continue
            if f.facet == "date_min":
                date_min = bound
            else:
                date_max = bound
        elif f.facet == "language":
            languages.append(f.value.casefold())
        elif f.facet == "program":
            program = f.value
        elif f.facet == "office":
            offices.append(f.value)

    if excluded_ids is not None:
        excluded = excluded_ids
    else:
        excluded = excluded_doc_ids(nodes, facets, docs_meta, translation_pairs)
    if year_min is None and year_max is None and date_min is None and date_max is None and program is None and not languages and not offices and not excluded:
        return nodes

    out = []
    for nws in nodes:
        md = nws.node.metadata or {}
        doc = docs_meta.get(md.get("doc_id")) or {}

        if date_min is not None or date_max is not None:
            published = doc.get("date_published")
            if published is not None:
                earliest = latest = published
            else:
                # year_int (postgres) or year (legacy CSV) — a doc with no
                # year metadata at all stays undated and is KEPT.
                try:
                    y = int(doc.get("year_int") or doc.get("year"))
                    earliest = date(y, 1, 1)
                    latest = date(y, 12, 31)
                except (ValueError, TypeError):
                    earliest = latest = None
            if earliest is not None:
                if date_min is not None and latest < date_min:
                    continue
                if date_max is not None and earliest > date_max:
                    continue

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

        # Case-, accent-, dash- and whitespace-insensitive like office:
        # the UI canonicalizes chip values while the corpus keeps its own
        # spelling for the same program series. `or ""`: an explicit
        # program_series: None is a mismatch, never a crash.
        if program is not None and _normalize_meta(md.get("program_series") or "") != _normalize_meta(program):
            continue

        # Office lives in raw_metadata (wri_primary_office); a doc with unknown
        # office is KEPT (exclude only on a positive mismatch), like language.
        # Comparison is accent-, case- and whitespace-insensitive: the corpus
        # mixes "WRI México"/"WRI Mexico" and "WRI US"/"WRI Us".
        # Multiple office facets are OR: keep docs matching any of them.
        if offices:
            doc_office = doc.get("office")
            if doc_office is not None and not any(
                _normalize_meta(doc_office) == _normalize_meta(o) for o in offices
            ):
                continue

        if md.get("doc_id") in excluded:
            continue

        out.append(nws)
    return out
