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
    # Reverse map: `pairs` maps translation → original, so a matching
    # original also needs its translations — excluding a topic excludes the
    # work in every language, in both directions.
    translations_of: dict = {}
    for tid, pair in pairs.items():
        original = pair.get("original")
        if original:
            translations_of.setdefault(original, []).append(tid)

    def _add_with_pairs(doc_id):
        out.add(doc_id)
        pair = pairs.get(doc_id) or {}
        original = pair.get("original")
        if original:
            out.add(original)
            # The original's other translations are this doc's siblings: an
            # excluded work is excluded in every language.
            out.update(translations_of.get(original, ()))
        else:
            # doc_id is the original: exclude its translations.
            out.update(translations_of.get(doc_id, ()))

    out: Set[str] = set()
    for nws in nodes:
        md = nws.node.metadata or {}
        doc_id = md.get("doc_id")
        if doc_id is None:
            # A doc-less node has nothing to exclude; a None in the set would
            # drop every doc-less node in apply_facet_filters and make
            # sorted(excluded) raise in the debug payload.
            continue
        pair = pairs.get(doc_id) or {}
        title = md.get("title") or docs_meta.get(doc_id, {}).get("title") or ""
        fields = [title, nws.node.text]
        if pair.get("original_title"):
            fields.append(pair["original_title"])
        # Each field normalized and scanned separately, so a phrase can't
        # false-match across a title/text boundary.
        if any(p.search(_normalize_meta(v)) for v in fields for p in patterns):
            _add_with_pairs(doc_id)
    return out


def _facet_constraints(facets: List[Facet]) -> dict:
    """Parse the positive constraint facets once per request.

    Invalid values are dropped, never raised: a bad chip value must not 500.
    Negations are not constraints — `excluded_doc_ids` owns them.
    """
    c = {"year_min": None, "year_max": None, "date_min": None, "date_max": None,
         "program": None, "languages": [], "offices": []}
    for f in facets:
        if f.action != "hard":
            continue
        mode = FACET_MODES.get(f.facet)
        if mode is None:
            logger.warning("facet_filter: no policy mode for facet %r; skipping", f.facet)
            continue
        if mode == "negate":
            continue  # handled document-level by excluded_doc_ids
        if f.facet in ("year_min", "year_max"):
            try:
                bound = int(f.value)
            except (ValueError, TypeError):
                continue  # invalid chip value: drop the facet, never a 500
            # Bounds only ever narrow: duplicates intersect, never override
            # (a chip and a legacy param can arrive in the same request).
            current = c[f.facet]
            if current is None:
                c[f.facet] = bound
            else:
                c[f.facet] = max(current, bound) if f.facet == "year_min" else min(current, bound)
        elif f.facet in ("date_min", "date_max"):
            try:
                bound = date.fromisoformat(f.value)
            except (ValueError, TypeError):
                continue
            current = c[f.facet]
            if current is None:
                c[f.facet] = bound
            else:
                c[f.facet] = max(current, bound) if f.facet == "date_min" else min(current, bound)
        elif f.facet == "language":
            c["languages"].append(f.value.casefold())
        elif f.facet == "program":
            c["program"] = f.value
        elif f.facet == "office":
            c["offices"].append(f.value)
    return c


def _has_constraints(c: dict) -> bool:
    return (c["year_min"] is not None or c["year_max"] is not None
            or c["date_min"] is not None or c["date_max"] is not None
            or c["program"] is not None or bool(c["languages"]) or bool(c["offices"]))


def _matches(nws, doc: dict, md: dict, c: dict, unknown_matches: bool = True) -> bool:
    """One node against the positive constraints: the single test shared by the
    filter (drop the mismatches) and the boost (reward the matches).

    `unknown_matches` is the one place the two callers disagree. A filter must
    KEEP a document whose metadata cannot be verified (it cannot exclude what
    it cannot see), so it passes True. A boost must reward only verified
    matches, so it passes False: an unknown office is not evidence for the
    office the user asked for, and rewarding it would turn the boost arm into
    "boost everything".
    """
    year_min, year_max = c["year_min"], c["year_max"]
    date_min, date_max = c["date_min"], c["date_max"]
    program, languages, offices = c["program"], c["languages"], c["offices"]
    unknown = False

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
        if earliest is None:
            unknown = True
        elif date_min is not None and latest < date_min:
            return False
        elif date_max is not None and earliest > date_max:
            return False

    if year_min is not None or year_max is not None:
        year = doc.get("year_int")
        if year is None:
            raw = md.get("year")
            if raw is not None:
                try:
                    year = int(raw)
                except (ValueError, TypeError):
                    return False  # present-but-unparseable year is excluded
        # year still None ⇒ no year metadata at all: KEPT, never dropped.
        if year is None:
            unknown = True
        elif year_min is not None and year < year_min:
            return False
        elif year_max is not None and year > year_max:
            return False

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
        if doc_language is None:
            unknown = True
        elif not doc_matches:
            return False

    # Case-, accent-, dash- and whitespace-insensitive like office:
    # the UI canonicalizes chip values while the corpus keeps its own
    # spelling for the same program series. `or ""`: an explicit
    # program_series: None is a mismatch, never a crash.
    if program is not None and _normalize_meta(md.get("program_series") or "") != _normalize_meta(program):
        return False

    # Office lives in raw_metadata (wri_primary_office); a doc with unknown
    # office is KEPT (exclude only on a positive mismatch), like language.
    # Comparison is accent-, case- and whitespace-insensitive: the corpus
    # mixes "WRI México"/"WRI Mexico" and "WRI US"/"WRI Us".
    # Multiple office facets are OR: keep docs matching any of them.
    if offices:
        doc_office = doc.get("office")
        if doc_office is None:
            unknown = True
        elif not any(_normalize_meta(doc_office) == _normalize_meta(o) for o in offices):
            return False

    return unknown_matches or not unknown


def apply_facet_filters(
    nodes, facets: List[Facet], docs_meta: dict,
    translation_pairs: Optional[dict] = None, excluded_ids: Optional[Set[str]] = None,
):
    c = _facet_constraints(facets)
    if excluded_ids is not None:
        excluded = excluded_ids
    else:
        excluded = excluded_doc_ids(nodes, facets, docs_meta, translation_pairs)
    if not excluded and not _has_constraints(c):
        return nodes

    out = []
    for nws in nodes:
        md = nws.node.metadata or {}
        if md.get("doc_id") in excluded:
            continue
        doc = docs_meta.get(md.get("doc_id")) or {}
        if _matches(nws, doc, md, c):
            out.append(nws)
    return out


def boost_facet_matches(
    nodes, facets: List[Facet], docs_meta: dict, weight: float,
):
    """Reward facet matches instead of removing the mismatches (#522).

    Same predicate as the filter, opposite sign: every node is kept and a
    matching one gains one RRF vote at rank 1 (`weight / (60 + 1)`), the unit
    the fusion loop in `main.py` already uses. Applied pre-rerank, so this
    changes which documents reach the rerank window — pool admission, not
    ranking.

    Returns `(nodes re-sorted by score, boosted doc ids)`. A non-positive
    weight, or no positive constraint at all, returns `nodes` itself: a
    misconfigured arm must not quietly reorder results.
    """
    c = _facet_constraints(facets)
    if weight <= 0 or not _has_constraints(c):
        return nodes, set()

    bonus = weight / (60 + 1)
    boosted: Set[str] = set()
    for nws in nodes:
        md = nws.node.metadata or {}
        doc = docs_meta.get(md.get("doc_id")) or {}
        if _matches(nws, doc, md, c, unknown_matches=False):
            nws.score = (nws.score or 0.0) + bonus
            if md.get("doc_id") is not None:
                boosted.add(md["doc_id"])
    return sorted(nodes, key=lambda n: n.score or 0.0, reverse=True), boosted
