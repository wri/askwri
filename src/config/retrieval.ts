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
  maxResults: 100, // Return up to 100 docs (filtered by logit floor)
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
