/**
 * Shared type definitions for AskWRI Answer mode evaluation.
 */

// --- Golden Dataset Schema ---

export interface ExpectedPassage {
  doc_id: string;
  chunk_id: string;
  page: number;
  text_snippet: string;
}

export interface AnswerTestCase {
  id: string;
  question: string;
  query_type: string;
  difficulty: string;
  retrieval_ground_truth: {
    expected_passages: ExpectedPassage[];
    expected_doc_ids: string[];
  };
  synthesis_ground_truth: {
    canonical_answer: string;
    key_facts: string[];
  };
}

export interface AnswerGoldenDataset {
  version: string;
  description: string;
  test_cases: AnswerTestCase[];
  metadata: Record<string, any>;
}

// --- Retrieval Eval Results ---

export interface RetrievalTestResult {
  test_case_id: string;
  question: string;
  // Chunk-level metrics (strict)
  chunk_precision: number;
  chunk_recall: number;
  chunk_f1: number;
  // Chunk-level metrics (with adjacent tolerance)
  chunk_precision_adjacent: number;
  chunk_recall_adjacent: number;
  chunk_f1_adjacent: number;
  // Doc-level metrics (coarse grain)
  doc_precision: number;
  doc_recall: number;
  doc_f1: number;
  // Details
  expected_chunk_ids: string[];
  retrieved_chunk_ids: string[];
  expected_doc_ids: string[];
  retrieved_doc_ids: string[];
  exact_matches: string[];
  adjacent_matches: string[];
  retrieved_chunks_detail: Array<{
    chunk_id: string;
    doc_id: string;
    title: string;
    snippet: string;
    score: number;
  }>;
  execution_time_ms: number;
  error?: string;
}

export interface RetrievalEvalReport {
  timestamp: string;
  test_cases_total: number;
  results: RetrievalTestResult[];
  aggregate: {
    chunk: { avg_precision: number; avg_recall: number; avg_f1: number };
    chunk_adjacent: { avg_precision: number; avg_recall: number; avg_f1: number };
    doc: { avg_precision: number; avg_recall: number; avg_f1: number };
  };
  summary_by_query_type: Record<string, any>;
}

// --- Metrics Common Shape ---

export interface MetricsResult {
  matched: string[];
  precision: number;
  recall: number;
  f1: number;
  false_positives: string[];
  false_negatives: string[];
}

export interface ChunkMetricsResult {
  exact_matches: string[];
  adjacent_matches: string[];
  precision: number;
  recall: number;
  f1: number;
  precision_with_adjacent: number;
  recall_with_adjacent: number;
  f1_with_adjacent: number;
}

// --- Synthesis Eval Types ---

export interface SynthesisScores {
  faithfulness: number;
  completeness: number;
  conciseness: number;
  coherence: number;
  citation_accuracy: number;
}

export interface FlaggedIssue {
  type: 'unsupported_claim' | 'missing_info' | 'verbatim_copy' | 'other';
  text: string;
  detail: string;
}

export interface CapturedPassage {
  doc_id: string;
  chunk_id: string;
  title: string;
  snippet: string;
  score: number;
  page: number;
}

export interface SynthesisCaptureEntry {
  test_case_id: string;
  question: string;
  retrieved_passages: CapturedPassage[];
  synthesis: {
    sentences: string[];
    full_text: string;
    warning?: string;
  };
  docs_sent_to_api: number;
  timestamp: string;
  model: string;
}

export interface SynthesisCaptureFile {
  captured_at: string;
  system_model: string;
  test_cases: SynthesisCaptureEntry[];
}

export interface LLMEvalEntry {
  test_case_id: string;
  scores: SynthesisScores;
  qualitative_feedback: string;
  flagged_issues: FlaggedIssue[];
  key_facts_extracted: string[];
  model: string;
  reasoning_tokens?: number;
}

export interface LLMEvalFile {
  evaluated_at: string;
  evaluator_model: string;
  test_cases: LLMEvalEntry[];
}

export interface HumanEval {
  scores: SynthesisScores;
  qualitative_feedback: string;
  key_facts_confirmed: string[];
  key_facts_added: string[];
  reviewed: boolean;
}

export interface SynthesisEvalFinalEntry {
  test_case_id: string;
  question: string;
  synthesis_text: string;
  passage_count: number;
  llm_eval: LLMEvalEntry;
  human_eval: HumanEval;
}

export interface SynthesisEvalFinalFile {
  evaluated_at: string;
  system_model: string;
  evaluator_model: string;
  test_cases: SynthesisEvalFinalEntry[];
}
