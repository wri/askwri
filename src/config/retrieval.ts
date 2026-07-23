export type RetrievalParams = {
  retrievalMode?: 'chunks' | 'docs' | 'hybrid'
  denseTopK?: number
  sparseTopK?: number
  alpha?: number
  rerank?: boolean
  rerankTopN?: number
  maxResults?: number
  fusionTopK?: number
}

export const ANSWER_PRESET: RetrievalParams = {
  retrievalMode: 'hybrid',
  denseTopK: 150,
  sparseTopK: 150,
  alpha: 0.65, // Favor semantic search — sweep showed P@8 improves 0.611→0.639
  rerank: true,
  rerankTopN: 20, // Sweep showed no P@8 gain from reranking more candidates
  maxResults: 15, // Return top 15 (down from 20) — tighter precision
  fusionTopK: 100, // RRF fusion limit for answer mode
}

export const CITE_PRESET: RetrievalParams = {
  retrievalMode: 'hybrid',
  denseTopK: 500, // 203-doc corpus — 500 is ample coverage
  sparseTopK: 500,
  alpha: 0.5, // Balanced dense/sparse fusion
  rerank: true,
  rerankTopN: 500, // Must be >= fusionTopK so logit floor is the sole quality gate
  maxResults: 25, // Re-derived 2026-07-23 on the all-Mistral / all-cohere qa
  // corpus (docs/research/2026-07-23-cite-floor-rederivation.md). The UI
  // renders every returned doc — results/page.tsx pageDocs = supporting, no
  // slice — so this cap, not the logit floor, is what bounds list length.
  // At 100 the floor left lists ranging from a handful to 46 docs.
  // Capping at 25 is a Pareto improvement: recall is IDENTICAL (83.3 macro,
  // 90.2 excluding q11) because every expected doc already ranks inside the
  // top 25, while precision rises 29.2 -> 32.0 and F1 43.3 -> 46.2. The tail
  // it discards contained no relevant documents. Recall plateaus at top-30
  // (90.7), whose ceiling is set by 7 expected docs that never reach the
  // reranker at all — a fusion/vocabulary gap, not a truncation one.
  fusionTopK: 500, // RRF fusion limit. Re-derived on the cohere-embed-v4 corpus
  // (2026-07-23): the old 200 was tuned for text-embedding-3-small
  // (where 200-vs-500 really was ~0.6%); embed-v4 spreads expected
  // docs into the 200-500 fused band, so 200 cost ~15pp cite recall
  // (deployed sweep: 66.9 @200 -> 82.3 @500, plateau by 400).
  // Latency is flat — rerank is capped at rerank_candidates=100
  // regardless of fusion depth — so this is recall-for-free.
  // 500 == rerankTopN keeps the "rerankTopN >= fusionTopK" invariant
  // AND matches the eval harness default so evals == what users get.
}
