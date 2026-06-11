"""Offline parity check: BM25-as-sparse-vector vs the live bm25s lane.

Evidence for the keyword-lane design note (option b). Builds the exact
BM25Retriever the service builds at boot, then verifies that representing each
chunk as a sparse vector of bm25s impact weights and scoring queries as a
sparse inner product (doc_weights . query_token_counts) reproduces bm25s
scores and rankings exactly. Also reports sparsevec feasibility numbers
(vocab size, nnz distribution vs pgvector limits).

Run: cd search-service && ./venv/bin/python -m scripts.sparse_parity_check
(requires DATABASE_URL; read-only)
"""
import sys
import time

import numpy as np

QUERIES = [
    # eval:cite golden-set questions (question text only, matching runner usage)
    "What have we published on land value capture?",
    "What have we published on Bangalore?",
    "What research do we have on children and air pollution?",
    "What have we published about climate adaptation in Brazil?",
    "What have we published on micromobility?",
    "Do we have anything on school buses and health?",
    "What can be done to solve the housing crisis in Jakarta?",
    "Have we published any papers or reports on hydrogen?",
    "Give me all the papers that were published as part of the cities World Resources Report?",
    "Have we published anything to do with urban finance since 2020?",
    # non-English smoke queries
    "株洲完整街道设计指南",
    "电动公交车运营挑战",
    "北京零排放货运",
    "出行即服务平台商业模式",
    "深圳港集装箱运输脱碳",
    "轨道交通站点安全可达性设计",
    "广东道路交通深度减排路径",
    "el costo de la expansión urbana en México",
    "las mujeres y el transporte en Bogotá",
    "entornos caminables seguros",
    "ciencia participativa para un aire limpio",
    "índice de desigualdad urbana",
    "ruas completas no Brasil",
    "medindo PM2.5 com sensores de baixo custo",
    "pesquisa de satisfação QualiÔnibus",
    "expansão vertical e horizontal em cidades brasileiras",
]


def main():
    import bm25s
    import scipy.sparse as sp
    from app import pg_store
    from llama_index.retrievers.bm25 import BM25Retriever

    t0 = time.time()
    nodes = pg_store.load_nodes()
    print(f"loaded {len(nodes)} chunks in {time.time() - t0:.1f}s")

    t0 = time.time()
    retriever = BM25Retriever.from_defaults(nodes=nodes, similarity_top_k=1000)
    print(f"built BM25 index in {time.time() - t0:.1f}s")

    bm25 = retriever.bm25
    scores = bm25.scores
    n_docs = int(scores["num_docs"])
    n_tokens = len(scores["indptr"]) - 1
    # bm25s stores the impact matrix token-major (CSC over tokens); transpose to
    # doc-major rows = the sparsevec each chunk would store.
    mat = sp.csc_matrix(
        (scores["data"], scores["indices"], scores["indptr"]),
        shape=(n_docs, n_tokens),
    )
    doc_rows = mat.tocsr()
    nnz_per_doc = np.diff(doc_rows.indptr)
    print(f"vocab size (sparsevec dimension): {n_tokens}")
    print(f"nnz/chunk: max {nnz_per_doc.max()}, mean {nnz_per_doc.mean():.0f} "
          f"(pgvector sparsevec limit 16k store / 1k HNSW)")

    vocab = bm25.vocab_dict  # token string -> column id

    failures = 0
    for q in QUERIES:
        # Reference: the EXACT production path — BM25Retriever._retrieve
        # tokenizes and passes the Tokenized object to bm25.retrieve(), which
        # remaps token strings to corpus-vocab ids internally.
        tokenized = bm25s.tokenize(
            q, stemmer=retriever.stemmer, token_pattern=retriever.token_pattern,
            show_progress=False,
        )
        idxs, scs = bm25.retrieve(tokenized, k=n_docs, show_progress=False)
        ref = np.zeros(n_docs, dtype=np.float64)
        ref[idxs[0]] = scs[0]

        # Candidate: sparse inner product against a query token-count vector,
        # replicating tokenization independently (as the SQL path would).
        toks = bm25s.tokenize(
            q, stemmer=retriever.stemmer, token_pattern=retriever.token_pattern,
            return_ids=False, show_progress=False,
        )[0]
        qvec = np.zeros(n_tokens, dtype=np.float32)
        matched = 0
        for t in toks:
            col = vocab.get(t)
            if col is not None:
                qvec[col] += 1.0
                matched += 1
        cand = np.asarray(doc_rows @ qvec, dtype=np.float64)

        # Score-vector equality is the claim; SQL reproduces ranking from it
        # via ORDER BY score DESC, corpus_order (bm25s breaks ties by corpus
        # position too, so tie order is reproducible — not asserted here).
        score_ok = np.allclose(ref, cand, atol=1e-3)
        nonzero_ref = int((ref > 1e-9).sum())
        nonzero_cand = int((cand > 1e-9).sum())
        status = "OK " if score_ok else "FAIL"
        if not score_ok:
            failures += 1
            diff = np.abs(ref - cand).max()
            print(f"{status} {q[:50]!r} max|Δscore|={diff:.6f} "
                  f"nonzero ref/cand={nonzero_ref}/{nonzero_cand} qtokens_matched={matched}")
        else:
            print(f"{status} {q[:50]!r} top1={ref.max():.4f} "
                  f"nonzero={nonzero_ref} qtokens_matched={matched}")

        if "--db" in sys.argv:
            # End-to-end: SQL sparse lane (backfilled vectors + vocab) vs the
            # in-memory production path, positive-score prefix only. Zero-score
            # tails differ by construction: bm25s pads top-k with arbitrary
            # zero-score docs, SQL orders them by corpus_order — both are
            # "no match" noise below RRF.
            #
            # Tie-aware comparison: bm25s orders EQUAL scores arbitrarily
            # (argpartition is unstable) while SQL uses corpus_order, so we
            # compare ordered tie GROUPS (descending score buckets at 1e-4)
            # rather than exact positions. At the k=1000 truncation boundary
            # the final tie group may be cut differently — both truncations
            # are arbitrary members of the same score class, so the last
            # (possibly clipped) group is compared by score only.
            from llama_index.core.schema import QueryBundle

            from app.pg_store import SparseKeywordRetriever

            sql_lane = SparseKeywordRetriever(similarity_top_k=1000)
            sql_out = sql_lane._retrieve(QueryBundle(query_str=q))
            mem_out = retriever._retrieve(QueryBundle(query_str=q))
            sql_pos = [(n.node.node_id, n.score) for n in sql_out if n.score > 1e-9]
            mem_pos = [(n.node.node_id, n.score) for n in mem_out if n.score > 1e-9]

            def tie_groups(pairs):
                groups = []
                for cid, s in pairs:
                    key = round(s, 4)
                    if groups and groups[-1][0] == key:
                        groups[-1][1].add(cid)
                    else:
                        groups.append((key, {cid}))
                return groups

            gs, gm = tie_groups(sql_pos), tie_groups(mem_pos)
            ok = len(gs) == len(gm)
            if ok:
                for gi, ((ks, ids_s), (km, ids_m)) in enumerate(zip(gs, gm)):
                    if abs(ks - km) > 1e-3:
                        ok = False
                        break
                    last = gi == len(gs) - 1
                    truncated = len(sql_pos) == 1000 or len(mem_pos) == 1000
                    if ids_s != ids_m and not (last and truncated):
                        ok = False
                        break
            if not ok:
                failures += 1
                print(f"DB-FAIL {q[:50]!r} sql={len(sql_pos)} mem={len(mem_pos)} "
                      f"groups={len(gs)}/{len(gm)}")
            else:
                print(f"DB-OK  {q[:50]!r} positive={len(sql_pos)} tie_groups={len(gs)}")

    print(f"\n{len(QUERIES) - failures}/{len(QUERIES)} queries score-identical")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
