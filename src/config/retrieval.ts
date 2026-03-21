export type RetrievalParams = {
  retrievalMode?: "chunks" | "docs" | "hybrid";
  denseTopK?: number;
  sparseTopK?: number;
  alpha?: number;
  rerank?: boolean;
  rerankTopN?: number;
  maxResults?: number;
};

export const ANSWER_PRESET: RetrievalParams = {
  retrievalMode: "hybrid",
  denseTopK: 150,
  sparseTopK: 150,
  alpha: 0.5,         // Will be updated after alpha sweep (Task 3)
  rerank: true,
  rerankTopN: 50,     // Rerank 50 candidates (up from 20) for better pool
  maxResults: 15,     // Return top 15 (down from 20) — tighter
};

export const CITE_PRESET: RetrievalParams = {
  retrievalMode: "hybrid", // hybrid mode for comprehensive recall
  denseTopK: 500,    // Retrieve 500 candidates from vector search
  sparseTopK: 500,   // Retrieve 500 candidates from BM25
  alpha: 0.5,        // Balanced dense/sparse fusion
  rerank: true,      // Cross-encoder reranking for quality
  rerankTopN: 40,    // Return top 40 after reranking (83% recall, 14.4% precision, ~37 docs avg)
};
