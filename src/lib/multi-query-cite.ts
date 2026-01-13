/**
 * Multi-query implementation specifically for Cite mode
 * Avoids circular dependencies by making direct API calls
 */

export interface DocMeta {
  doc_id: string;
  document_id?: string;
  ref: string;
  title: string;
  url?: string;
  _url?: string;
  host?: string;
  authors?: string[];
  year?: number;
  source?: string;
  summary?: string;
  score?: number;
  kps: any[];
  meta?: any;
}

interface QueryVariation {
  query: string;
  weight: number;
  type: 'original' | 'synonym' | 'focused';
}

/**
 * Generate query variations for better coverage
 */
function generateQueryVariations(originalQuery: string): QueryVariation[] {
  const variations: QueryVariation[] = [
    { query: originalQuery, weight: 1.0, type: 'original' }
  ];
  
  // Synonym variations
  const synonymMap: Record<string, string> = {
    'electric': 'battery',
    'buses': 'transit',
    'bus': 'transit',
    'transport': 'mobility',
    'transportation': 'mobility',
    'decarbonization': 'emissions reduction',
    'decarbonisation': 'emissions reduction',
    'benefits': 'advantages',
    'challenges': 'barriers',
    'policy': 'regulation',
    'policies': 'regulations',
    'urban': 'city',
    'cities': 'urban areas',
    'climate': 'carbon'
  };
  
  // Try to create one good synonym variation
  let modified = originalQuery.toLowerCase();
  let changed = false;
  
  for (const [term, synonym] of Object.entries(synonymMap)) {
    if (modified.includes(term) && !modified.includes(synonym)) {
      modified = modified.replace(term, synonym);
      changed = true;
      break;
    }
  }
  
  if (changed) {
    variations.push({ 
      query: modified, 
      weight: 0.8, 
      type: 'synonym' 
    });
  }
  
  // Create a focused variation (key terms only)
  const terms = originalQuery.toLowerCase().split(/\s+/);
  const keyTerms = terms.filter(t => t.length > 4 && !['about', 'their', 'which', 'where', 'these'].includes(t));
  
  if (keyTerms.length >= 2 && keyTerms.length < terms.length) {
    variations.push({ 
      query: keyTerms.join(' '), 
      weight: 0.7, 
      type: 'focused' 
    });
  }
  
  // Limit to 3 queries maximum
  return variations.slice(0, 3);
}

/**
 * Execute a single query against the API
 */
async function executeSingleQuery(query: string): Promise<any> {
  const response = await fetch('/api/llama/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      mode: 'cite',
      retrievalMode: 'hybrid',
      denseTopK: 1500,
      sparseTopK: 1500,
      alpha: 0.3,
      rerank: false
    })
  });
  
  if (!response.ok) {
    throw new Error(`API call failed: ${response.status}`);
  }
  
  return response.json();
}

/**
 * Merge results from multiple queries
 */
function mergeResults(resultSets: any[][], variations: QueryVariation[]): DocMeta[] {
  const docMap = new Map<string, DocMeta>();
  const docScores = new Map<string, number>();
  
  resultSets.forEach((docs, idx) => {
    const weight = variations[idx].weight;
    
    docs.forEach((doc, docIdx) => {
      const existingDoc = docMap.get(doc.doc_id);
      
      // Use the doc's actual score if available, otherwise use position-based score
      // Scores from the API are typically between 0 and 1
      const baseScore = doc.score !== undefined && doc.score !== null ? doc.score : (1.0 - (docIdx * 0.05));
      
      // Apply weight boost for original query (weight = 1.0) vs variations (weight < 1.0)
      // Also boost by appearance in multiple queries
      const appearanceBoost = existingDoc ? 0.1 : 0; // Bonus for appearing in multiple queries
      const finalScore = (baseScore * weight) + appearanceBoost;
      
      if (!existingDoc) {
        docMap.set(doc.doc_id, doc);
        docScores.set(doc.doc_id, finalScore);
      } else {
        // Merge metadata
        if (!existingDoc.url && doc.url) existingDoc.url = doc.url;
        if (!existingDoc.authors?.length && doc.authors?.length) existingDoc.authors = doc.authors;
        if (!existingDoc.year && doc.year) existingDoc.year = doc.year;
        if (!existingDoc.summary && doc.summary) existingDoc.summary = doc.summary;
        if (!existingDoc.title && doc.title) existingDoc.title = doc.title; // Ensure title is merged
        
        // Merge KPs (avoiding duplicates)
        const existingKpIds = new Set(existingDoc.kps.map((kp: any) => kp.passage_id));
        const newKps = doc.kps.filter((kp: any) => !existingKpIds.has(kp.passage_id));
        existingDoc.kps.push(...newKps);
        
        // Update score - take the maximum score seen
        const currentScore = docScores.get(doc.doc_id) || 0;
        docScores.set(doc.doc_id, Math.max(currentScore, finalScore));
      }
    });
  });
  
  // Apply final processing
  const mergedDocs = Array.from(docMap.values());
  mergedDocs.forEach(doc => {
    // Sort and cap KPs
    doc.kps.sort((a: any, b: any) => (b.kp_relevance || 0) - (a.kp_relevance || 0));
    doc.kps = doc.kps.slice(0, 200);
    // Update score
    doc.score = docScores.get(doc.doc_id) || doc.score;
  });
  
  // Sort by score (descending) - ensure numeric comparison
  mergedDocs.sort((a, b) => {
    const scoreA = typeof a.score === 'number' ? a.score : 0;
    const scoreB = typeof b.score === 'number' ? b.score : 0;
    return scoreB - scoreA;
  });
  
  // Log the final scoring for debugging
  console.log(`[Multi-Query Cite] Merged ${mergedDocs.length} docs with scores:`, 
    mergedDocs.map(d => ({
      title: (d.title || d._url || 'Unknown').slice(0, 50),
      score: typeof d.score === 'number' ? d.score.toFixed(3) : 'N/A',
      hasTitle: !!d.title,
      hasUrl: !!d.url || !!d._url
    }))
  );
  
  return mergedDocs;
}

/**
 * Main multi-query search function for Cite mode
 */
export async function multiQueryCiteSearch(query: string): Promise<{
  docs: DocMeta[];
  message: string;
  usage?: any;
  debug?: any;
}> {
  const startTime = Date.now();
  
  try {
    // Generate query variations
    const variations = generateQueryVariations(query);
    console.log(`[Multi-Query Cite] Running ${variations.length} queries:`, variations.map(v => v.query));
    
    // Execute all queries in parallel
    const promises = variations.map(v => 
      executeSingleQuery(v.query).catch(err => {
        console.error(`[Multi-Query Cite] Query failed: "${v.query}"`, err);
        return { docs: [] };
      })
    );
    
    const results = await Promise.all(promises);
    const resultDocs = results.map(r => r.docs || []);
    
    // Merge results
    const mergedDocs = mergeResults(resultDocs, variations);
    
    const timing = Date.now() - startTime;
    
    console.log(`[Multi-Query Cite] Completed in ${timing}ms: ${mergedDocs.length} unique docs from ${variations.length} queries`);
    
    // Calculate rough usage estimate
    const totalChunks = resultDocs.reduce((sum, docs) => sum + docs.length * 3, 0); // Estimate 3 chunks per doc
    
    return {
      docs: mergedDocs,
      message: '',
      usage: {
        total_tokens: totalChunks * 200, // Rough estimate
        prompt_tokens: variations.length * 100,
        completion_tokens: 0
      },
      debug: {
        multiQuery: true,
        queryCount: variations.length,
        queries: variations.map(v => v.query),
        timing,
        uniqueDocsCount: mergedDocs.length,
        totalSourceDocs: resultDocs.reduce((sum, docs) => sum + docs.length, 0)
      }
    };
  } catch (error) {
    console.error('[Multi-Query Cite] Fatal error:', error);
    // Fallback to single query
    const result = await executeSingleQuery(query);
    return result;
  }
}