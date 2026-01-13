/**
 * LLM-Based Post-Retrieval Relevance Filtering
 *
 * Uses gpt-4o-mini to judge whether retrieved documents are truly relevant
 * to a query (primary focus) vs tangentially related (mentions in passing).
 *
 * This addresses the limitation where cross-encoder rerankers cannot
 * distinguish semantic nuance at document level.
 */

import OpenAI from 'openai';
import type { DocMeta } from './llamacloud';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Model selection - set via env var for easy testing
// gpt-4o-mini: $0.15/1M input tokens (fast, cheap, baseline)
// gpt-4o: $2.50/1M input tokens (17x cost, better reasoning)
const RELEVANCE_MODEL = process.env.OPENAI_MODEL_RELEVANCE || 'gpt-4o-mini';

interface RelevanceJudgment {
  doc_num: number;
  relevant: boolean;
  confidence: number;
  reason: string;
}

interface BatchJudgmentResult {
  judgments: RelevanceJudgment[];
}

export type RelevanceMode = 'strict' | 'moderate';

/**
 * Judge relevance of a batch of documents using LLM
 */
async function judgeBatch(
  query: string,
  docs: DocMeta[],
  mode: RelevanceMode,
  batchStartIndex: number
): Promise<RelevanceJudgment[]> {
  const prompt = `You are a research librarian helping filter search results for sustainable transport and urban planning research.

User Query: "${query}"

Task: Judge if each document is TRULY RELEVANT or just TANGENTIALLY RELATED.

Strictness Level: ${mode === 'strict'
  ? 'STRICT - Only documents where the query topic is the PRIMARY focus or a MAJOR theme (≥30% of content)'
  : 'MODERATE - Documents where the query topic is a significant theme (≥15% of content)'
}

IMPORTANT: Each document was retrieved because the search system found semantic similarity. The "Retrieved passage" shows the ACTUAL TEXT that matched the query - use this to understand the connection between query terminology and document content.

Guidelines:
- TRULY RELEVANT: The document's main purpose addresses this topic OR the retrieved passage shows substantial relevant content
- TANGENTIALLY RELATED: Brief mention only (e.g., one paragraph in a long document, literature review citation)
- PAY ATTENTION TO: The retrieved passage may use domain-specific terms that are semantically related to the query (e.g., "transit financing" for "urban finance" query, "charging infrastructure" for "electric vehicles")

Documents to evaluate:
${docs.map((doc, i) => {
  const summary = doc.summary?.slice(0, 200) || 'No summary available';
  const relevantPassage = doc.kps?.[0]?.snippet?.slice(0, 400) || '';

  return `
${i + 1}. "${doc.title}"
   Year: ${doc.year || 'Unknown'}
   Summary: ${summary}${doc.summary && doc.summary.length > 200 ? '...' : ''}
   ${relevantPassage ? `Retrieved passage (WHY this matched): "${relevantPassage}${relevantPassage.length >= 400 ? '...' : ''}"` : 'No passage available'}
`;
}).join('\n')}

Respond with valid JSON only (no markdown, no code blocks):
{
  "judgments": [
    {"doc_num": 1, "relevant": true/false, "confidence": 0.0-1.0, "reason": "one sentence"},
    ...
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: RELEVANCE_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const result: BatchJudgmentResult = JSON.parse(content);

    // Validate response structure
    if (!result.judgments || !Array.isArray(result.judgments)) {
      console.error('[LLM Filter] Invalid response structure:', result);
      throw new Error('Invalid response structure from LLM');
    }

    return result.judgments;
  } catch (error) {
    console.error('[LLM Filter] Error judging batch:', error);
    // On error, mark all as relevant (fail open to preserve recall)
    return docs.map((_, i) => ({
      doc_num: i + 1,
      relevant: true,
      confidence: 0.5,
      reason: 'Error during judgment, defaulting to relevant'
    }));
  }
}

/**
 * Filter documents using LLM-based relevance judgment
 *
 * @param query - User query
 * @param docs - Retrieved documents to filter
 * @param mode - 'strict' for high precision, 'moderate' for balanced
 * @param confidenceThreshold - Minimum confidence to keep (0-1)
 * @param batchSize - Number of docs to judge per API call (default: 10)
 * @returns Filtered documents with added judgment metadata
 */
export async function filterByLLMRelevance(
  query: string,
  docs: DocMeta[],
  mode: RelevanceMode = 'moderate',
  confidenceThreshold: number = 0.6,
  batchSize: number = 50  // Increased from 30 for faster evals (fewer API calls)
): Promise<DocMeta[]> {
  if (docs.length === 0) {
    return [];
  }

  console.log(`[LLM Filter] Filtering ${docs.length} documents (mode: ${mode}, threshold: ${confidenceThreshold})`);
  const startTime = Date.now();

  // Split into batches
  const batches: DocMeta[][] = [];
  for (let i = 0; i < docs.length; i += batchSize) {
    batches.push(docs.slice(i, i + batchSize));
  }

  // Process batches in parallel (OpenAI tier limits allow concurrent requests)
  const allJudgments: Map<string, { relevant: boolean; confidence: number; reason: string }> = new Map();

  const batchPromises = batches.map((batch, batchIdx) =>
    judgeBatch(query, batch, mode, batchIdx * batchSize)
      .then(judgments => ({ batch, judgments }))
  );

  const batchResults = await Promise.all(batchPromises);

  // Map judgments back to doc_ids
  batchResults.forEach(({ batch, judgments }) => {
    batch.forEach((doc, i) => {
      const judgment = judgments.find(j => j.doc_num === i + 1);
      if (judgment) {
        allJudgments.set(doc.doc_id || doc.document_id || '', {
          relevant: judgment.relevant,
          confidence: judgment.confidence,
          reason: judgment.reason
        });
      }
    });
  });

  // Filter documents based on judgments
  const filteredDocs = docs.filter(doc => {
    const docId = doc.doc_id || doc.document_id || '';
    const judgment = allJudgments.get(docId);

    if (!judgment) {
      // If no judgment (shouldn't happen), keep the doc (fail open)
      return true;
    }

    // Keep if relevant AND confidence meets threshold
    return judgment.relevant && judgment.confidence >= confidenceThreshold;
  });

  const elapsed = Date.now() - startTime;
  const kept = filteredDocs.length;
  const removed = docs.length - kept;

  console.log(`[LLM Filter] Complete in ${elapsed}ms: kept ${kept}/${docs.length} docs (removed ${removed})`);
  console.log(`[LLM Filter] Precision boost: ${((kept / docs.length) * 100).toFixed(1)}% of docs passed filter`);

  // Add judgment metadata to filtered docs
  filteredDocs.forEach(doc => {
    const judgment = allJudgments.get(doc.doc_id || doc.document_id || '');
    if (judgment && doc.meta) {
      doc.meta.llm_judgment = judgment;
    }
  });

  return filteredDocs;
}

/**
 * Get statistics about LLM filtering results
 */
export function getFilterStats(docs: DocMeta[]): {
  total: number;
  with_judgment: number;
  avg_confidence: number;
  relevant_count: number;
} {
  const withJudgment = docs.filter(doc => doc.meta?.llm_judgment);
  const relevantCount = withJudgment.filter(doc => doc.meta?.llm_judgment?.relevant).length;
  const avgConfidence = withJudgment.length > 0
    ? withJudgment.reduce((sum, doc) => sum + (doc.meta?.llm_judgment?.confidence || 0), 0) / withJudgment.length
    : 0;

  return {
    total: docs.length,
    with_judgment: withJudgment.length,
    avg_confidence: avgConfidence,
    relevant_count: relevantCount
  };
}
