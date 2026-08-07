"""Parity tests for app.sparse_keyword against real bm25s behavior.

No DB required. Builds a small bm25s index exactly the way BM25Retriever
does, then checks that our tokenizer and weight math reproduce the stored
impact matrix and query scoring.
"""
import math

import bm25s
import numpy as np
import pytest
import Stemmer

from app.sparse_keyword import (
    B, K1, SPARSE_DIM, TOKEN_PATTERN, chunk_weights, lucene_idf, tokenize,
)

CORPUS = [
    "Urban land value capture in São Paulo and Addis Ababa",
    "Electric buses reduce emissions. Electric buses are quieter than diesel buses.",
    "Walkable streets make cities safer for children and pedestrians",
    "完整街道设计导则，提升城市道路安全。",   # zh: whole-run tokens, like production
    "value capture value capture value",      # repeated terms exercise tf math
]


def _reference_index():
    stemmer = Stemmer.Stemmer("english")
    corpus_tokens = bm25s.tokenize(
        CORPUS, stopwords="en", stemmer=stemmer,
        token_pattern=TOKEN_PATTERN, show_progress=False,
    )
    bm25 = bm25s.BM25()  # defaults: method='lucene', k1=1.5, b=0.75
    bm25.index(corpus_tokens, show_progress=False)
    return bm25, corpus_tokens


def test_tokenize_matches_bm25s_corpus_tokenization():
    bm25, corpus_tokens = _reference_index()
    id_to_token = {v: k for k, v in corpus_tokens.vocab.items()}
    for doc_idx, ids in enumerate(corpus_tokens.ids):
        assert tokenize(CORPUS[doc_idx]) == [id_to_token[i] for i in ids]


def test_chunk_weights_reproduce_bm25s_impact_matrix():
    bm25, corpus_tokens = _reference_index()
    import scipy.sparse as sp
    n_docs = int(bm25.scores["num_docs"])
    n_tokens = len(bm25.scores["indptr"]) - 1
    mat = sp.csc_matrix(
        (bm25.scores["data"], bm25.scores["indices"], bm25.scores["indptr"]),
        shape=(n_docs, n_tokens),
    ).tocsr()
    id_to_token = {v: k for k, v in corpus_tokens.vocab.items()}

    dls = [len(ids) for ids in corpus_tokens.ids]
    avgdl = sum(dls) / len(dls)
    # df over the tokenized corpus, idf via the lucene formula
    df = {}
    for ids in corpus_tokens.ids:
        for tid in set(ids):
            df[tid] = df.get(tid, 0) + 1
    idf_by_token = {id_to_token[tid]: lucene_idf(d, n_docs) for tid, d in df.items()}

    for doc_idx in range(n_docs):
        ours = chunk_weights(tokenize(CORPUS[doc_idx]), idf_by_token, avgdl)
        row = mat.getrow(doc_idx)
        theirs = {id_to_token[tid]: w for tid, w in zip(row.indices, row.data)}
        assert set(ours) == set(theirs)
        for token, w in ours.items():
            assert w == pytest.approx(theirs[token], abs=1e-5), token


def test_lucene_idf_formula():
    assert lucene_idf(1, 5) == pytest.approx(math.log(1 + (5 - 1 + 0.5) / 1.5))


def test_zh_query_tokens_are_whole_runs():
    toks = tokenize("完整街道设计导则，提升城市道路安全。")
    assert toks == ["完整街道设计导则", "提升城市道路安全"]


def test_sparse_dim_headroom():
    # Design note §4.6: corpus vocab is ~184k; dimension must dominate it.
    assert SPARSE_DIM == 1_000_000
