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
  retrievalMode: "hybrid", // Use hybrid mode for balanced precision/recall
  denseTopK: 150,    // Precision: high-quality results from 203-doc corpus
  sparseTopK: 150,   // Precision: focused keyword matching
  alpha: 0.5,        // Balanced dense/sparse for precision
  rerank: true,      // Enable reranking to filter noisy results
  rerankTopN: 20,    // Top 20 snippets → ~10-15 unique docs for synthesis
  maxResults: 20,
};

export const CITE_PRESET: RetrievalParams = {
  retrievalMode: "hybrid", // hybrid mode for comprehensive recall
  denseTopK: 500,    // Retrieve 500 candidates from vector search
  sparseTopK: 500,   // Retrieve 500 candidates from BM25
  alpha: 0.5,        // Balanced dense/sparse fusion
  rerank: true,      // Cross-encoder reranking for quality
  rerankTopN: 40,    // Return top 40 after reranking (83% recall, 14.4% precision, ~37 docs avg)
};
