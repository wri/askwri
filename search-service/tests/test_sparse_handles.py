"""Unit tests for the English-handle injection helpers (spec §3.1).

Pure functions — the DB-shaped input is a plain dict. DB-gated coverage of
the two write sites lives in test_build_sparse_script.py / test_worker_stages.py.
"""
from app.sparse_handles import handle_text


def _h(indexed_title="", title_en="", en_summary=""):
    return {"indexed_title": indexed_title, "title_en": title_en, "en_summary": en_summary}


def test_no_handle_for_missing_title_en():
    assert handle_text(_h(indexed_title="Título nativo"), is_summary_chunk=False) == ""


def test_title_en_appended_when_different():
    out = handle_text(
        _h(indexed_title="Índice de Desigualdad Urbana",
           title_en="Urban Inequality Index - UII"),
        is_summary_chunk=False,
    )
    assert out == "Urban Inequality Index - UII"


def test_title_en_skipped_when_equal_after_normalization():
    # casefold + whitespace normalization (spec §3.1) — most zh docs, whose
    # indexed catalog title IS the English title.
    out = handle_text(
        _h(indexed_title="Zhuzhou  Complete Street Design Manual",
           title_en="zhuzhou complete street design manual"),
        is_summary_chunk=False,
    )
    assert out == ""


def test_summary_chunk_gets_english_summary_too():
    out = handle_text(
        _h(indexed_title="Título", title_en="Title EN", en_summary="An English abstract."),
        is_summary_chunk=True,
    )
    assert out == "Title EN\nAn English abstract."


def test_text_chunk_never_gets_summary():
    out = handle_text(
        _h(indexed_title="Título", title_en="Title EN", en_summary="An English abstract."),
        is_summary_chunk=False,
    )
    assert out == "Title EN"
