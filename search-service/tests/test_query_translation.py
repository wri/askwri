"""Query-side translation for the SPARSE lane only.

Motivation (probe, 2026-07-24): the Postgres BM25 lane is English-only by
construction — English Snowball stemmer, English stopwords, (?u)\\b\\w\\w+\\b.
That is not a structural inability to retrieve non-English documents: stemming
Spanish with an English stemmer is *wrong* but *deterministic*, so it matches
identically on both index and query sides. The lane was only ever missing a
query in the right language. Measured on 10 known-item pairs, translating the
query moved bm25 rank 93->1, 61->2, 43->1, and turned 3 outright misses into
rank 1 — 10/10 improved, 0/10 worse.

The same probe on 12 competitive topical queries showed why the translation
must NOT reach the whole pipeline: appending translations to `request.query`
improved 13/17 non-English targets but displaced 4 English competitors and cut
result-list length ~40%, because the reranker scored the multilingual jumble as
a worse query and more documents fell under the cite floor.

So translation belongs exactly where `expand_query_conservative` already lives:
main.py:216 feeds the expanded bundle to the sparse lane ONLY, while dense and
rerank keep the original query. Dense is already multilingual (cohere-embed-v4)
and needs no help.
"""
import pytest

from app.query_expansion import (
    build_sparse_query,
    expand_query_conservative,
)


class _FakeTranslator:
    """Records calls; returns deterministic pseudo-translations."""

    def __init__(self, mapping=None, fail=False):
        self.calls = []
        self.mapping = mapping or {}
        self.fail = fail

    def __call__(self, query, languages):
        self.calls.append((query, tuple(languages)))
        if self.fail:
            raise RuntimeError("translation backend unavailable")
        return {lang: self.mapping.get(lang, f"[{lang}]{query}") for lang in languages}


def test_disabled_by_default_is_byte_identical_to_todays_behaviour():
    """The flag off must reproduce expand_query_conservative exactly — this is
    what makes the change safe to deploy dark."""
    q = "What have we published on urban finance since 2020?"
    assert build_sparse_query(q, translate=None) == expand_query_conservative(q)


def test_translations_are_appended_to_the_domain_expansion():
    q = "safe walkable neighborhoods"
    tr = _FakeTranslator({"es": "barrios caminables seguros"})
    out = build_sparse_query(q, translate=tr, languages=("es",))
    assert q in out
    assert "barrios caminables seguros" in out
    assert tr.calls == [(q, ("es",))]


def test_all_configured_languages_are_requested_in_one_call():
    """One backend call per query, not one per language — this sits in the
    request path and latency is the binding constraint."""
    tr = _FakeTranslator()
    build_sparse_query("urban sprawl", translate=tr, languages=("es", "pt", "zh"))
    assert len(tr.calls) == 1
    assert tr.calls[0][1] == ("es", "pt", "zh")


def test_translation_failure_degrades_to_the_untranslated_query():
    """A translation outage must never fail a search. Same posture as the
    dense-lane degradation (main.py:244): serve something, do not 500."""
    q = "urban inequality index"
    tr = _FakeTranslator(fail=True)
    out = build_sparse_query(q, translate=tr, languages=("es",))
    assert out == expand_query_conservative(q)


def test_empty_and_whitespace_queries_are_not_sent_to_the_backend():
    tr = _FakeTranslator()
    for q in ("", "   "):
        build_sparse_query(q, translate=tr, languages=("es",))
    assert tr.calls == []


def test_blank_translations_are_dropped_not_concatenated():
    """A backend returning '' for a language must not inject empty OR terms,
    which would change tokenization for no benefit."""
    q = "urban sprawl"
    tr = _FakeTranslator({"es": "", "pt": "   ", "zh": "城市扩张"})
    out = build_sparse_query(q, translate=tr, languages=("es", "pt", "zh"))
    assert "城市扩张" in out
    assert " OR  OR " not in out
    assert not out.rstrip().endswith("OR")


def test_translation_identical_to_query_is_not_duplicated():
    """Proper nouns often translate to themselves; duplicating them would
    inflate their BM25 term frequency and distort scoring."""
    q = "QualiOnibus"
    tr = _FakeTranslator({"es": "QualiOnibus", "pt": "QualiOnibus"})
    out = build_sparse_query(q, translate=tr, languages=("es", "pt"))
    assert out.lower().count("qualionibus") == 1


def test_dense_lane_query_is_never_touched():
    """Guards the whole design: dense is already multilingual and the reranker
    must not see the jumble. build_sparse_query is the ONLY consumer."""
    import inspect

    from app import main

    src = inspect.getsource(main.HybridFusionRetriever._retrieve)
    # the expanded/translated bundle goes to bm25 only
    assert "expanded_bundle" in src
    assert "self.bm25_retriever.retrieve" in src
    dense_call = [ln for ln in src.splitlines()
                  if "vector_retriever.retrieve" in ln]
    assert dense_call, "dense retrieve call not found — test needs updating"
    assert all("expanded" not in ln for ln in dense_call), (
        "dense lane is receiving the expanded/translated bundle; translations "
        "must stay sparse-only (see module docstring)"
    )


@pytest.mark.parametrize("languages", [(), None])
def test_no_languages_configured_skips_translation(languages):
    tr = _FakeTranslator()
    q = "urban sprawl"
    assert build_sparse_query(q, translate=tr, languages=languages) == \
        expand_query_conservative(q)
    assert tr.calls == []
