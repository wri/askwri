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
  
  for (const [term, synonym] of Object.entries(synonymMap)) {
    if (modified.includes(term)) {
      modified = modified.replace(term, synonym);
      changed = true;
      break; // Only replace one term to keep variations distinct
    }
  }
  
  return changed ? modified : query;
}

/**
 * Execute queries in parallel for speed
 */
export async function executeParallelQueries(
  variations: QueryVariation[],
  mode: 'answer' | 'cite',
  queryFunc: QueryFunction
): Promise<DocMeta[][]> {
  
  console.log(`[Multi-Query] Executing ${variations.length} queries in parallel`);
  
  // Execute all queries in parallel
  const promises = variations.map(async (v, idx) => {
    console.log(`[Multi-Query] Query ${idx + 1}: "${v.query}" (type: ${v.type})`);
    try {
      const result = await queryFunc(v.query, { multiQuery: false }); // Prevent recursion
      return result.docs || [];
    } catch (error) {
      console.error(`[Multi-Query] Query ${idx + 1} failed:`, error);
      return [];
    }
  });
  
  const results = await Promise.all(promises);
  
  console.log(`[Multi-Query] Results: ${results.map(r => r.length).join(', ')} docs`);
  
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
    const weight = variations[setIdx].weight;
    
    results.forEach(doc => {
      const existingDoc = docMap.get(doc.doc_id);
      const weightedScore = (doc.score || 0.5) * weight;
      
      if (!existingDoc) {
        // First time seeing this document
        docMap.set(doc.doc_id, doc);
        docScores.set(doc.doc_id, weightedScore);
      } else {
        // Merge KPs from different queries
        const existingScore = docScores.get(doc.doc_id) || 0;
        
        // Keep the version with better metadata
        if (!existingDoc.url && doc.url) existingDoc.url = doc.url;
        if (!existingDoc.authors?.length && doc.authors?.length) existingDoc.authors = doc.authors;
        if (!existingDoc.year && doc.year) existingDoc.year = doc.year;
        
        // Merge unique KPs
        const existingKpIds = new Set(existingDoc.kps.map(kp => kp.passage_id));
        const newKps = doc.kps.filter(kp => !existingKpIds.has(kp.passage_id));
        existingDoc.kps.push(...newKps);
        
        // Update score (max of weighted scores)
        docScores.set(doc.doc_id, Math.max(existingScore, weightedScore));
      }
    });
  });
  
  // Sort KPs within each document and apply caps
  const mergedDocs = Array.from(docMap.values());
  mergedDocs.forEach(doc => {
    // Sort KPs by relevance
    doc.kps.sort((a, b) => b.kp_relevance - a.kp_relevance);
    // Cap KPs to avoid memory issues
    doc.kps = doc.kps.slice(0, 200);
    // Update document score from our tracking
    doc.score = docScores.get(doc.doc_id) || doc.score;
  });
  
  // Sort documents by score
  mergedDocs.sort((a, b) => (b.score || 0) - (a.score || 0));
  
  console.log(`[Multi-Query] Merged ${docMap.size} unique documents from ${resultSets.reduce((sum, r) => sum + r.length, 0)} total`);
  
  return mergedDocs;
}

/**
 * Main entry point for multi-query search
 */
export async function multiQuerySearch(
  query: string,
  mode: 'answer' | 'cite' = 'cite',
  maxQueries: number = 3,
  queryFunc: QueryFunction
): Promise<{ docs: DocMeta[]; queryCount: number; timing: number }> {
  const startTime = Date.now();
  
  // Generate variations (limited to maxQueries)
  const variations = generateQueryVariations(query, mode).slice(0, maxQueries);
  
  // Execute in parallel
  const resultSets = await executeParallelQueries(variations, mode, queryFunc);
  
  // Merge and deduplicate
  const docs = mergeResults(resultSets, variations);
  
  const timing = Date.now() - startTime;
  
  console.log(`[Multi-Query] Completed in ${timing}ms: ${docs.length} unique docs from ${variations.length} queries`);
  
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
  mode: 'answer' | 'cite' = 'cite',
  targetDocs: number = 10,
  queryFunc: QueryFunction
): Promise<{ docs: DocMeta[]; queryCount: number; timing: number }> {
  const startTime = Date.now();
  
  // Start with original query
  const firstResult = await queryFunc(query, { multiQuery: false });
  
  // If we already have enough unique docs, return early
  if (firstResult.docs.length >= targetDocs) {
    console.log(`[Smart Multi-Query] Got ${firstResult.docs.length} docs from first query, returning early`);
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