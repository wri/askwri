import fs from 'fs';
import path from 'path';

interface FileSummary {
  file_path: string;
  metadata: string;
  summary: string;
}

interface ExpansionRule {
  term: string;
  synonyms: string[];
}

// Domain-specific synonym dictionary for transport decarbonization
const EXPANSION_RULES: ExpansionRule[] = [
  // Micromobility
  { term: 'micromobility', synonyms: ['e-scooter', 'e-bike', 'bike-sharing', 'scooter-sharing', 'dockless'] },
  { term: 'e-scooter', synonyms: ['electric scooter', 'scooter', 'micromobility'] },
  { term: 'bike-sharing', synonyms: ['bicycle sharing', 'bikeshare', 'cycle hire', 'bike share'] },

  // Transport modes
  { term: 'bus rapid transit', synonyms: ['BRT', 'rapid bus'] },
  { term: 'metro', synonyms: ['subway', 'underground', 'rapid transit', 'MRT'] },
  { term: 'light rail', synonyms: ['LRT', 'tram', 'streetcar'] },

  // Infrastructure
  { term: 'cycling infrastructure', synonyms: ['bike lane', 'bicycle path', 'cycle track'] },
  { term: 'pedestrian', synonyms: ['walking', 'walkability', 'sidewalk'] },
  { term: 'transit-oriented development', synonyms: ['TOD', 'transit village'] },

  // Financing
  { term: 'land value capture', synonyms: ['LVC', 'value capture', 'betterment levy', 'land monetization'] },
  { term: 'public-private partnership', synonyms: ['PPP', 'P3', 'concession'] },

  // Environmental
  { term: 'air pollution', synonyms: ['air quality', 'particulate matter', 'PM2.5', 'emissions'] },
  { term: 'climate change', synonyms: ['climate action', 'decarbonization', 'carbon reduction'] },
  { term: 'electrification', synonyms: ['electric vehicle', 'EV', 'zero emission'] },

  // Demographics
  { term: 'children', synonyms: ['kids', 'youth', 'students', 'school-age'] },
  { term: 'school bus', synonyms: ['school transport', 'student transport'] },

  // Geographic (Indian cities)
  { term: 'Bangalore', synonyms: ['Bengaluru'] },
  { term: 'Mumbai', synonyms: ['Bombay'] },
  { term: 'Delhi', synonyms: ['New Delhi', 'NCR'] },
];

let summariesCache: Map<string, string> | null = null;

export async function loadSummaries(): Promise<Map<string, string>> {
  if (summariesCache) return summariesCache;

  summariesCache = new Map();

  // Load unified document summaries from data/documents.csv (new unified format)
  // This CSV includes both migrated legacy documents and new user uploads
  try {
    const unifiedCsvPath = path.join(process.cwd(), 'data', 'documents.csv');
    if (fs.existsSync(unifiedCsvPath)) {
      const content = fs.readFileSync(unifiedCsvPath, 'utf-8');
      const lines = content.split('\n').slice(1); // Skip header

      for (const line of lines) {
        if (!line.trim()) continue;

        // CSV format: file_path,metadata,summary,source_type,imported_at,import_batch_id
        // We need to parse this carefully as metadata column contains JSON with quoted strings
        try {
          const parsed = parseSimpleCSV(line);
          if (parsed && parsed.filePath && parsed.summary) {
            const basename = path.basename(parsed.filePath).toLowerCase();
            summariesCache.set(basename, parsed.summary);
          }
        } catch (e) {
          console.warn(`[Query Expansion] Failed to parse line:`, e);
        }
      }
      console.log(`[Query Expansion] Loaded ${summariesCache.size} summaries from unified database`);
    }
  } catch (error) {
    console.error('[Query Expansion] Error loading unified summaries:', error);
  }

  // Fallback: Load from legacy CSV if unified database doesn't exist yet
  if (summariesCache.size === 0) {
    try {
      const legacyCsvPath = path.join(process.cwd(), 'public', 'TransportDecarb_llamacloud_metadata_with_summaries.csv');
      if (fs.existsSync(legacyCsvPath)) {
        const content = fs.readFileSync(legacyCsvPath, 'utf-8');
        const lines = content.split('\n').slice(1); // Skip header

        for (const line of lines) {
          if (!line.trim()) continue;

          // Simple CSV parsing for legacy format
          const parts = line.split(',');
          if (parts.length >= 3) {
            const filePath = parts[0].trim();
            const summary = parts.slice(2).join(',').replace(/^"|"$/g, '').trim();

            if (filePath && summary) {
              const basename = path.basename(filePath).toLowerCase();
              summariesCache.set(basename, summary);
            }
          }
        }
        console.log(`[Query Expansion] Loaded ${summariesCache.size} summaries from legacy database (fallback)`);
      }
    } catch (error) {
      console.error('[Query Expansion] Error loading legacy summaries:', error);
    }
  }

  return summariesCache;
}

/**
 * Parse a single CSV line from the unified document format
 * Format: file_path,metadata,summary,source_type,imported_at,import_batch_id
 * Note: metadata column contains JSON with escaped quotes
 */
function parseSimpleCSV(line: string): { filePath: string; summary: string } | null {
  let inQuotes = false;
  let current = '';
  const fields: string[] = [];

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());

  if (fields.length >= 3) {
    return {
      filePath: fields[0].replace(/^"|"$/g, ''),
      summary: fields[2].replace(/^"|"$/g, '')
    };
  }
  return null;
}

/**
 * Expands a query with domain-specific synonyms
 * @param query - Original query
 * @param maxExpansionTerms - Max number of synonyms to add (default: 3)
 */
export function expandQueryWithSynonyms(query: string, maxExpansionTerms: number = 3): string {
  const lowerQuery = query.toLowerCase();
  const expansionTerms = new Set<string>();

  for (const rule of EXPANSION_RULES) {
    const termRegex = new RegExp(`\\b${rule.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

    if (termRegex.test(query)) {
      // Add top synonyms
      rule.synonyms.slice(0, 2).forEach(syn => expansionTerms.add(syn));
    }
  }

  const limitedTerms = Array.from(expansionTerms).slice(0, maxExpansionTerms);

  if (limitedTerms.length === 0) {
    return query;
  }

  return `${query} ${limitedTerms.join(' ')}`;
}

export async function expandQueryWithSummaries(
  query: string,
  mode: 'answer' | 'cite' = 'cite',
  maxSummaries: number = 5
): Promise<string> {
  // CHANGED (Step 2): Disable expansion ONLY for Cite mode to improve precision
  // Query expansion was causing too many false positives in Cite mode
  // Answer mode was never using expansion anyway (see old code below)
  if (mode !== 'cite') {
    // Answer mode: no expansion (original behavior)
    return query;
  }

  // CITE MODE: Expansion disabled for precision testing
  // Re-enable if recall drops below 75%
  return query;
}