"""Shared helpers for the Postgres-resident BM25 keyword lane (KEYWORD_BACKEND=sparse).

Replicates bm25s 0.3.0 exactly (method='lucene', k1=1.5, b=0.75, English
stopwords, English Snowball stemmer, token pattern (?u)\\b\\w\\w+\\b):

- tokenize() is the index- AND query-side tokenization BM25Retriever uses
- chunk_weights() is the per-chunk impact weight bm25s precomputes:
      weight(t, d) = idf(t) * tf / (tf + k1*((1-b) + b*dl/avgdl))
  (lucene tf component, scoring.py:_score_tfc_lucene)
- lucene_idf() is scoring.py:_score_idf_lucene

sparsevec convention: DB token_id is 1-based (= sparsevec text index);
pgvector.psycopg's SparseVector takes 0-based dict keys, so subtract 1 there.
Fixed dimension SPARSE_DIM gives vocab growth headroom without per-row
re-dimensioning (pgvector requires equal dims for <#>).
"""
import math
from collections import Counter
from typing import Dict, List

import bm25s
import Stemmer

SPARSE_DIM = 1_000_000
K1 = 1.5
B = 0.75
TOKEN_PATTERN = r"(?u)\b\w\w+\b"

_stemmer = Stemmer.Stemmer("english")


def tokenize(text: str) -> List[str]:
    """Tokenize one string exactly like BM25Retriever (both sides)."""
    return bm25s.tokenize(
        text,
        stemmer=_stemmer,
        token_pattern=TOKEN_PATTERN,
        return_ids=False,
        show_progress=False,
    )[0]


def lucene_idf(df: int, n_chunks: int) -> float:
    return math.log(1 + (n_chunks - df + 0.5) / (df + 0.5))


def chunk_weights(
    tokens: List[str], idf_by_token: Dict[str, float], avgdl: float
) -> Dict[str, float]:
    """{token: impact weight} for one chunk under frozen corpus stats.

    Tokens missing from idf_by_token are skipped — callers upsert vocab rows
    first and pass a complete map, so a miss means deliberate exclusion.
    """
    dl = len(tokens)
    weights = {}
    for token, tf in Counter(tokens).items():
        idf = idf_by_token.get(token)
        if idf is None:
            continue
        weights[token] = idf * (tf / (tf + K1 * ((1 - B) + B * dl / avgdl)))
    return weights
