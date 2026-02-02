/* eslint-disable no-param-reassign */
/* eslint-disable @typescript-eslint/naming-convention */
/**
 * Multi-query strategy to work around LlamaIndex Cloud's 6-chunk limit
 * Uses parallel execution and smart deduplication for performance
 */

import type { DocMeta, ChatResponse } from './llamacloud';

// We need to pass in the query function to avoid circular dependencies
type QueryFunction = (query: string, overrides?: any) => Promise<ChatResponse>;

interface QueryVariation {
  query: string;
  weight: number; // How much to weight results from this variation
  type: 'original' | 'synonym' | 'expanded' | 'focused';
}

/**
 * Apply common synonyms to expand query coverage
 */
function applySynonyms(query: string): string {
  const synonymMap: Record<string, string> = {
    'electric': 'battery',
    'bus': 'transit',
    'buses': 'transit',
    'transport': 'mobility',
    'transportation': 'mobility',
    'decarbonization': 'emissions reduction',
    'benefits': 'advantages',
    'challenges': 'barriers',
    'policy': 'regulation',
    'urban': 'city',
    'climate': 'carbon'
  };
  let modified = query.toLowerCase();
  let changed = false;
  Object.entries(synonymMap).some(([term, synonym]) => {
    if (modified.includes(term)) {
      modified = modified.replace(term, synonym);
      changed = true;
      return true;
    }
    return false;
  });
  return changed ? modified : query;
}

/**
 * Generate query variations for better coverage
 * Keep variations minimal to avoid long response times
 */
export function generateQueryVariations(originalQuery: string, mode: 'answer' | 'cite'): QueryVariation[] {
  const variations: QueryVariation[] = [
    { query: originalQuery, weight: 1.0, type: 'original' }
  ];

  // For Cite mode, add more variations since we need comprehensive results
  if (mode === 'cite') {
    // Add ONE synonym variation
    const synonymVariation = applySynonyms(originalQuery);
    if (synonymVariation !== originalQuery) {
      variations.push({ 
        query: synonymVariation, 
        weight: 0.8, 
        type: 'synonym' 
      });
    }

    // Add ONE focused variation (more specific)
    const terms = originalQuery.toLowerCase().split(/\s+/);
    if (terms.length > 2) {
      // Focus on key terms
      const focused = terms.filter(t => t.length > 4).join(' ');
      if (focused && focused !== originalQuery) {
        variations.push({ 
          query: focused, 
          weight: 0.7, 
          type: 'focused' 
        });
      }
    }
  }

  // Limit to 3 queries max to keep response time reasonable
  return variations.slice(0, 3);
}



/**
 * Execute queries in parallel for speed
 */
export async function executeParallelQueries(
  variations: QueryVariation[],
  mode: 'answer' | 'cite',
  queryFunc: QueryFunction
): Promise<DocMeta[][]> {
  
  // Execute all queries in parallel
  const promises = variations.map(async (v) => {
    try {
      const result = await queryFunc(v.query, { multiQuery: false }); // Prevent recursion
      return result.docs || [];
    } catch (_error) {
      return [];
    }
  });
  const results = await Promise.all(promises);
  return results;
}

/**
 * Merge and deduplicate results efficiently
 */
export function mergeResults(
  resultSets: DocMeta[][],
  variations: QueryVariation[]
): DocMeta[] {
  const docMap = new Map<string, DocMeta>();
  const docScores = new Map<string, number>();
  
  // Merge results, keeping the best version of each document
  resultSets.forEach((results, setIdx) => {
    const { weight } = variations[setIdx];
    results.forEach(docItem => {
      const { doc_id, score = 0.5, url, authors, year, kps } = docItem;
      const existingDoc = docMap.get(doc_id);
      const weightedScore = score * weight;
      if (!existingDoc) {
        // First time seeing this document
        docMap.set(doc_id, { ...docItem, kps: [...kps] });
        docScores.set(doc_id, weightedScore);
      } else {
        // Merge KPs from different queries
        const existingScore = docScores.get(doc_id) || 0;
        // Keep the version with better metadata
        if (!existingDoc.url && url) existingDoc.url = url;
        if (!existingDoc.authors?.length && authors?.length) existingDoc.authors = authors;
        if (!existingDoc.year && year) existingDoc.year = year;
        // Merge unique KPs
        const existingKpIds = new Set(existingDoc.kps.map(kp => kp.passage_id));
        const newKps = kps.filter(kp => !existingKpIds.has(kp.passage_id));
        existingDoc.kps = [...existingDoc.kps, ...newKps];
        // Update score (max of weighted scores)
        docScores.set(doc_id, Math.max(existingScore, weightedScore));
      }
    });
  });

  // Sort KPs within each document and apply caps
  const mergedDocs = Array.from(docMap.values());
  mergedDocs.forEach(doc => {

    doc.kps.sort((a, b) => b.kp_relevance - a.kp_relevance);

    doc.kps = doc.kps.slice(0, 200);

    doc.score = docScores.get(doc.doc_id) || doc.score;

  });

  mergedDocs.sort((a, b) => (b.score || 0) - (a.score || 0));

  return mergedDocs;
}

/**
 * Main entry point for multi-query search
 */
export async function multiQuerySearch(
  query: string,
  queryFunc: QueryFunction,
  mode: 'answer' | 'cite' = 'cite',
  maxQueries: number = 3
): Promise<{ docs: DocMeta[]; queryCount: number; timing: number }> {
  const startTime = Date.now();
  
  // Generate variations (limited to maxQueries)
  const variations = generateQueryVariations(query, mode).slice(0, maxQueries);
  
  // Execute in parallel
  const resultSets = await executeParallelQueries(variations, mode, queryFunc);
  
  // Merge and deduplicate
  const docs = mergeResults(resultSets, variations);
  
  const timing = Date.now() - startTime;

  return {
    docs,
    queryCount: variations.length,
    timing
  };
}

/**
 * Optimized version that stops early if we have enough results
 */
export async function smartMultiQuerySearch(
  query: string,
  queryFunc: QueryFunction,
  mode: 'answer' | 'cite' = 'cite',
  targetDocs: number = 10
): Promise<{ docs: DocMeta[]; queryCount: number; timing: number }> {
  const startTime = Date.now();
  
  // Start with original query
  const firstResult = await queryFunc(query, { multiQuery: false });
  
  // If we already have enough unique docs, return early
  if (firstResult.docs.length >= targetDocs) {

    return {
      docs: firstResult.docs,
      queryCount: 1,
      timing: Date.now() - startTime
    };
  }
  
  // Otherwise, run additional queries in parallel
  const variations = generateQueryVariations(query, mode).slice(1); // Skip original
  const additionalResults = await executeParallelQueries(variations, mode, queryFunc);
  
  // Merge all results
  const allResults = [firstResult.docs, ...additionalResults];
  const allVariations = [
    { query, weight: 1.0, type: 'original' as const },
    ...variations
  ];

  const docs = mergeResults(allResults, allVariations);
  return {
    docs,
    queryCount: allVariations.length,
    timing: Date.now() - startTime
  };
}