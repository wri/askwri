/**
 * Shared vocabulary for the answer-eval harness. Artifact shapes are the
 * contract between the capture, judge, score, and compare stages — change
 * them only alongside a plan update (docs/superpowers/plans/
 * 2026-09-03-answer-eval-harness-pr2.md).
 */

export interface ExpectedPassage {
  doc_id: string
  chunk_id: string
  page?: number
  text_snippet: string
  text_snippet_translation_en?: string
  supports_key_fact?: string
}

export interface FixtureCase {
  id: string
  question: string
  query_type?: string
  difficulty?: string
  source_language?: string
  note?: string
  retrieval_ground_truth?: {
    expected_external_ids?: string[]
    expected_document_ids?: string[]
    expected_passages?: ExpectedPassage[]
  }
  synthesis_ground_truth?: {
    canonical_answer?: string
    key_facts?: string[]
  }
  /** absent = draft */
  review_status?: 'draft' | 'expert_approved' | 'rejected'
}

export interface Evalset {
  name: string
  version?: string
  test_cases: FixtureCase[]
  twins?: [string, string][]
}

export interface RetrievedChunk {
  rank: number
  doc_id: string
  chunk_id: string | null
  text: string
  score?: number
}

export interface PassageSent {
  id: number
  doc_id: string
  chunk_id: string
  page: number
  text: string
}

export interface PassCapture {
  pass: number
  retrieval: {
    chunks: RetrievedChunk[]
    likely_off_topic: boolean
    service_ms: number | null
    cost_usd: number | null
    wall_ms: number
    error?: string
  }
  answer: {
    knobs: Record<string, unknown>
    passages_sent: PassageSent[]
    sentences: string[]
    cites: number[][]
    raw_model_json: string
    source_relevance?: Array<{ doc_id: string; tier: string }>
    warning?: string
    low_coverage: boolean
    invalid_cites: number
    fallback_reason?: string
    wall_ms: number
    error?: string
  }
}

export interface CaseCapture {
  case_id: string
  fixture_case: FixtureCase
  passes: PassCapture[]
}

export interface Provenance {
  fixture: { path: string; name: string; commit: string } // submodule SHA
  target: {
    mode: 'gateway' | 'direct'
    urls: string[]
    config: Record<string, unknown> | null
  }
  knobs: {
    retrieval: Record<string, unknown>
    synthesis: Record<string, unknown>
  }
  synthesis: {
    model: string
    base_url: string
    prompt_hashes: Record<string, string>
  }
  judge?: {
    model: string
    base_url: string
    prompt_hashes: Record<string, string>
  }
  passes: number
  harness_sha: string
  timestamp: string
  node_version: string
}

export interface PreflightReport {
  corpus_ok: boolean
  missing_docs: string[]
  snippet_failures: Array<{ case_id: string; doc_id: string; reason: string }>
  twins_ok: boolean
  synthesis_probe_ok: boolean
  judge_probe_ok: boolean
  approved: number
  draft: number
  rejected: number
  estimated_calls: { retrieval: number; synthesis: number; judge: number }
}

export interface CaptureArtifact {
  schema: 'answer-eval/capture@1'
  provenance: Provenance
  /** The pure scorer's only source of corpus-attainability. */
  preflight: PreflightReport
  cases: CaseCapture[]
}

export interface JudgedItemBase {
  prompt_hash: string
  judge_model: string
  unjudged?: { reason: string; raw: string }
}

export interface FactRecallVerdicts extends JudgedItemBase {
  kind: 'fact_recall'
  verdicts: Array<{
    fact_index: number
    verdict: 'stated' | 'partial' | 'absent'
    evidence: string
  }>
}

export interface SentenceSupportVerdict extends JudgedItemBase {
  kind: 'sentence_support'
  sentence_index: number
  verdict: 'supported' | 'unsupported'
  span: string
}

export interface UnsupportedClaimsVerdict extends JudgedItemBase {
  kind: 'unsupported_claims'
  unsupported_sentence_indices: number[]
  reasons: string[]
}

export type JudgedItem =
  FactRecallVerdicts | SentenceSupportVerdict | UnsupportedClaimsVerdict

/** key: `${caseId}|${pass}|${kind}:${index}` */
export interface JudgedArtifact {
  schema: 'answer-eval/judged@1'
  provenance: Provenance
  /** sha256 over the capture's cases. A resume against a different capture
   * (same label, re-captured) is refused so stale keys never stand in for
   * new answers. */
  capture_fingerprint?: string
  items: Record<string, JudgedItem>
  /** Accumulated judge token usage across runs (a resume adds to it);
   * optional so pre-existing artifacts without it stay valid. */
  usage?: JudgeUsageTotal
}

export interface JudgeUsageTotal {
  prompt_tokens: number
  completion_tokens: number
  calls: number
}

export interface Report {
  schema: 'answer-eval/report@1'
  provenance: Provenance
  header: Record<string, unknown>
  headline: Record<string, unknown>
  draft_block: Record<string, unknown>
  per_case: Array<Record<string, unknown>>
}

// -------------------------------------------------------------------------
// Human labels (§4.5) — produced by the eval-review notebook, consumed by
// evaluation/answer/labels.ts. Schema `answer-eval/human-labels@1`.
// -------------------------------------------------------------------------

export interface HumanFactVerdict {
  fact_index: number
  verdict: 'stated' | 'partial' | 'absent'
  evidence?: string
}

export interface HumanSentenceVerdict {
  sentence_index: number
  verdict: 'supported' | 'unsupported'
  span?: string
  note?: string
}

export interface HumanLabels {
  schema: 'answer-eval/human-labels@1'
  capture_file: string
  capture_fingerprint: string
  case_id: string
  pass: number
  reviewer: string
  question?: string
  key_facts?: string[]
  fact_verdicts: HumanFactVerdict[]
  sentence_verdicts: HumanSentenceVerdict[]
  overall_note?: string
}

/** One verdict type's judge-vs-human tally. `either` is the symmetric
 * denominator (positions where at least one side said v); `excluded` counts
 * human verdicts whose judged counterpart is missing or unjudged. */
export interface VerdictTally {
  agree: Record<string, number>
  either: Record<string, number>
  excluded: number
}

export interface JudgeAgreement {
  fact_recall: Record<'stated' | 'partial' | 'absent', VerdictTally>
  sentence_support: Record<'supported' | 'unsupported', VerdictTally>
  unsupported_claims: { agree: number; compared: number }
  labels: number
  reviewers: string[]
}
