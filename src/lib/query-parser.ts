/**
 * Query Parser - Extract filters and constraints from natural language queries
 *
 * Automatically detects:
 * - Temporal constraints: "since 2020", "after 2019", "before 2022"
 * - Exclusions: "excluding X", "without X", "not X"
 * - Program requirements: "World Resources Report", "WRR"
 *
 * Usage:
 *   const parsed = parseQuery("urban finance since 2020 excluding electric buses")
 *   // { query: "urban finance", minYear: 2020, excludedKeywords: ["electric bus"] }
 */

export interface ParsedQuery {
  /** Cleaned query text (original query with filters removed) */
  query: string;
  /** Minimum publication year (inclusive) */
  minYear?: number;
  /** Maximum publication year (inclusive) */
  maxYear?: number;
  /** Keywords to exclude from results */
  excludedKeywords?: string[];
  /** Required program series */
  requiredProgram?: string;
}

/**
 * Parse natural language query to extract filters and constraints
 */
export function parseQuery(rawQuery: string): ParsedQuery {
  let cleanedQuery = rawQuery;
  const result: ParsedQuery = { query: rawQuery };

  // 1. Extract temporal constraints
  const yearPatterns = [
    // "since YYYY" or "after YYYY"
    { pattern: /\b(?:since|after|from)\s+(\d{4})\b/gi, type: 'min' },
    // "before YYYY" or "until YYYY"
    { pattern: /\b(?:before|until|prior to)\s+(\d{4})\b/gi, type: 'max' },
    // "in YYYY" (both min and max to that year)
    { pattern: /\b(?:in|during)\s+(\d{4})\b/gi, type: 'exact' },
  ];

  for (const { pattern, type } of yearPatterns) {
    const matches = Array.from(cleanedQuery.matchAll(pattern));
    for (const match of matches) {
      const year = parseInt(match[1], 10);
      if (year >= 1900 && year <= 2100) {
        if (type === 'min') {
          result.minYear = year;
        } else if (type === 'max') {
          result.maxYear = year;
        } else if (type === 'exact') {
          result.minYear = year;
          result.maxYear = year;
        }
        // Remove the temporal phrase from query
        cleanedQuery = cleanedQuery.replace(match[0], '');
      }
    }
  }

  // 2. Extract exclusions
  // Only match explicit exclusions in the question, not in task descriptions
  const exclusionPatterns = [
    // "excluding X", "without X", "except X" (but not part of task instructions)
    /\b(?:excluding|without|except)\s+(?:anything\s+(?:to\s+do\s+with\s+)?)?([a-z\s-]+?)(?=\s*(?:\?|$))/gi,
    // "please exclude X"
    /\bplease\s+exclude\s+([^,\.;]+?)(?=\s*(?:and|or|but|\.|,|;|$))/gi,
  ];

  const excludedKeywords: string[] = [];
  for (const pattern of exclusionPatterns) {
    const matches = Array.from(cleanedQuery.matchAll(pattern));
    for (const match of matches) {
      const excluded = match[1].trim();
      if (excluded.length > 0) {
        excludedKeywords.push(excluded);
        // Remove the exclusion phrase from query
        cleanedQuery = cleanedQuery.replace(match[0], '');
      }
    }
  }

  if (excludedKeywords.length > 0) {
    result.excludedKeywords = excludedKeywords;
  }

  // 3. Extract program requirements
  const programPatterns = [
    { pattern: /\b(?:world resources report|WRR)\b/gi, program: 'World Resources Report' },
  ];

  for (const { pattern, program } of programPatterns) {
    if (pattern.test(cleanedQuery)) {
      result.requiredProgram = program;
      // Remove program name from query
      cleanedQuery = cleanedQuery.replace(pattern, '');
    }
  }

  // IMPORTANT: Return the ORIGINAL query, not cleanedQuery
  // Stripping terms hurts semantic search (embeddings + BM25)
  // Filters are applied post-retrieval instead
  result.query = rawQuery;
  return result;
}

/**
 * Expand query with synonyms and related terms for better recall
 * Useful for niche technologies and amorphous concepts
 */
export function expandQuery(query: string): string[] {
  const expansions: string[] = [query];

  // Niche technology expansions
  const techExpansions: Record<string, string[]> = {
    'hydrogen': ['hydrogen', 'H2', 'green hydrogen', 'hydrogen fuel', 'hydrogen energy', 'fuel cell'],
    'micromobility': ['micromobility', 'bike sharing', 'bicycle', 'e-bike', 'scooter', 'auto-rickshaw', 'autorickshaw', 'rickshaw'],
    'electric bus': ['electric bus', 'e-bus', 'battery bus', 'zero emission bus', 'BEB'],
    'BRT': ['BRT', 'bus rapid transit', 'rapid bus', 'rapid transit'],
  };

  // Geography expansions
  const geoExpansions: Record<string, string[]> = {
    'bangalore': ['Bangalore', 'Bengaluru'],
    'bengaluru': ['Bangalore', 'Bengaluru'],
  };

  const queryLower = query.toLowerCase();

  // Check if query contains any expandable terms
  for (const [term, synonyms] of Object.entries({ ...techExpansions, ...geoExpansions })) {
    if (queryLower.includes(term.toLowerCase())) {
      // Add all synonyms as alternative queries
      for (const synonym of synonyms) {
        const expanded = query.replace(new RegExp(term, 'gi'), synonym);
        if (expanded !== query && !expansions.includes(expanded)) {
          expansions.push(expanded);
        }
      }
      break;  // Only expand the first matched term to avoid explosion
    }
  }

  return expansions;
}
