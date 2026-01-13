/**
 * Zotero CSV Export Parser with Resilient Matching
 * Converts Zotero export CSV to document metadata matching our schema
 * Supports 3-tier matching: exact, fuzzy, and manual override
 */

export interface ZoteroRow {
  Key: string;
  "Item Type": string;
  "Publication Year": string;
  Author: string;
  Title: string;
  "Publication Title": string;
  DOI: string;
  Url: string;
  "Abstract Note": string;
  "File Attachments": string;
  [key: string]: string;
}

export interface ParsedZoteroDocument {
  filename: string;
  zoteroKey: string;
  metadata: {
    "Article Title": string;
    "All authors": string;
    "YEAR accepted": string | number;
    "Attribution URL"?: string;
    "Sub-tag": string;
    summary?: string;
  };
  errors?: string[];
}

export interface TitleVerification {
  verified: boolean;
  confidence: number;
  extractedTitle?: string;
  details: string;
}

export interface MatchedItem {
  document: ParsedZoteroDocument;
  pdfFile?: File;
  matchType: "exact" | "fuzzy" | "manual" | "stub";
  confidence: number; // 0-1, 1.0 = exact match
  titleVerification?: TitleVerification; // Result of PDF title verification
}

export interface MatchResult {
  matched: MatchedItem[];
  unmatchedDocuments: ParsedZoteroDocument[];
  unmatchedFiles: File[];
}

export interface ZoteroParseResult {
  documents: ParsedZoteroDocument[];
  errors: string[];
}

/**
 * Extract filename from Zotero File Attachments path
 * Input: /home/aman/Zotero/storage/NNNNNNN/Document Name.pdf
 * Output: Document Name.pdf
 */
function extractFilename(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;

  // Get the last part after the final /
  const parts = filePath.split("/");
  const lastPart = parts[parts.length - 1];

  // Make sure it looks like a PDF
  if (lastPart && lastPart.toLowerCase().endsWith(".pdf")) {
    return lastPart;
  }

  return null;
}

/**
 * Normalize filename for matching
 * Removes version numbers, duplicate markers, normalizes spaces/underscores
 * Input: "Document_v2 (1).pdf" → Output: "document.pdf"
 */
function normalizeFilename(filename: string): string {
  let normalized = filename.toLowerCase();

  // Remove .pdf extension for processing
  if (normalized.endsWith(".pdf")) {
    normalized = normalized.slice(0, -4);
  }

  // Remove version markers: _v1, _v2, _0, etc.
  normalized = normalized.replace(/_v\d+/gi, "");
  normalized = normalized.replace(/_\d+$/g, "");

  // Remove duplicate markers: (1), (2), [1], etc.
  normalized = normalized.replace(/\s*[\(\[]?\d+[\)\]]?$/g, "");

  // Normalize whitespace and underscores to single space
  normalized = normalized.replace(/[_\-\s]+/g, " ");

  // Remove extra spaces
  normalized = normalized.trim();

  return normalized;
}

/**
 * Calculate edit distance (Levenshtein distance) for fuzzy matching
 */
function editDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score (0-1, 1.0 = identical)
 */
function calculateSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const distance = editDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * Extract title with intelligent fallbacks
 * Tries: Title → Short Title → Publication Title → "Untitled"
 */
function extractTitle(row: ZoteroRow): string {
  const title = row["Title"]?.trim();
  if (title) return title;

  const shortTitle = row["Short Title"]?.trim();
  if (shortTitle) return shortTitle;

  const pubTitle = row["Publication Title"]?.trim();
  if (pubTitle) return pubTitle;

  return "Untitled";
}

/**
 * Extract authors with intelligent formatting
 * Tries: Author field, falls back to Editor if present
 */
function extractAuthors(row: ZoteroRow): string {
  const author = row["Author"]?.trim();
  if (author) return author;

  // Fallback to editor if no author listed
  const editor = row["Editor"]?.trim();
  if (editor) return editor;

  return "";
}

/**
 * Extract year with intelligent fallbacks
 * Tries: Publication Year → Date (extract year) → current year
 */
function extractYear(row: ZoteroRow): string | number {
  const pubYear = row["Publication Year"]?.trim();
  if (pubYear && /^\d{4}$/.test(pubYear)) {
    return parseInt(pubYear);
  }

  // Try to extract year from Date field (format: YYYY-MM-DD)
  const date = row["Date"]?.trim();
  if (date) {
    const yearMatch = date.match(/^(\d{4})/);
    if (yearMatch) {
      return parseInt(yearMatch[1]);
    }
  }

  // Fallback to current year
  return new Date().getFullYear();
}

/**
 * Extract summary with intelligent fallbacks
 * Tries: Abstract Note → Notes (first 500 chars) → ""
 * Removes common prefixes like "Synopsis", "Main Findings", etc.
 */
function extractSummary(row: ZoteroRow): string {
  let abstractNote = row["Abstract Note"]?.trim();
  if (abstractNote) {
    // Remove common prefixes (case-insensitive, handles both spaced and non-spaced variants)
    // Patterns: "Synopsis", "SynopsisThe...", "Main Findings ", "Key Messages", etc.
    const prefixPattern = /^(Synopsis|Main Findings|Key Messages?|Key Points?|Introduction|Chapter|Section)\s*/i;
    abstractNote = abstractNote.replace(prefixPattern, '');

    // Handle edge case where "Synopsis" has no space after it (e.g., "SynopsisThe...")
    if (/^Synopsis[A-Z]/.test(row["Abstract Note"] || '')) {
      abstractNote = (row["Abstract Note"] || '').substring(8).trim();
    }

    return abstractNote.trim();
  }

  // Fallback to notes field, truncated
  const notes = row["Notes"]?.trim();
  if (notes) {
    // Also clean prefixes from notes
    let cleanedNotes = notes.replace(/^(Synopsis|Main Findings|Key Messages?|Key Points?)\s*/i, '');
    return cleanedNotes.substring(0, 500).trim();
  }

  return "";
}

/**
 * Parse CSV line (handles quoted fields with commas)
 * RFC 4180 compliant CSV parser
 */
function parseCSVLine(line: string, headers: string[]): ZoteroRow {
  const result: ZoteroRow = {} as ZoteroRow;
  const fields: string[] = [];

  let current = "";
  let inQuotes = false;
  let fieldStart = true; // Track if we're at the start of a field

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote: "" becomes "
        current += '"';
        i++; // Skip next quote
      } else if (fieldStart && !inQuotes) {
        // Opening quote of field
        inQuotes = true;
        fieldStart = false;
      } else if (inQuotes && (nextChar === "," || nextChar === undefined)) {
        // Closing quote of field
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === "," && !inQuotes) {
      // End of field
      fields.push(current);
      current = "";
      fieldStart = true;
    } else {
      current += char;
      fieldStart = false;
    }
  }

  // Last field
  fields.push(current);

  // Map fields to headers
  headers.forEach((header, index) => {
    result[header] = fields[index] || "";
  });

  return result;
}

/**
 * Parse header line using RFC 4180 compliant parser
 */
function parseHeaderLine(line: string): string[] {
  const headers: string[] = [];
  let current = "";
  let inQuotes = false;
  let fieldStart = true;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else if (fieldStart && !inQuotes) {
        // Opening quote
        inQuotes = true;
        fieldStart = false;
      } else if (inQuotes && (nextChar === "," || nextChar === undefined)) {
        // Closing quote
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === "," && !inQuotes) {
      // End of field
      headers.push(current);
      current = "";
      fieldStart = true;
    } else {
      current += char;
      fieldStart = false;
    }
  }

  // Last field
  headers.push(current);
  return headers;
}

/**
 * Detect if CSV is in bibliography format instead of proper metadata format
 * Bibliography exports have titles in citation format: "Author et al. - Year - Title"
 */
function detectBibliographyFormat(rows: ZoteroRow[]): { isBibliography: boolean; evidence: string[] } {
  if (rows.length === 0) {
    return { isBibliography: false, evidence: [] };
  }

  const evidence: string[] = [];
  let citationFormatCount = 0;

  // Sample first 10 rows (or all if less than 10)
  const sampleSize = Math.min(10, rows.length);
  const sampleRows = rows.slice(0, sampleSize);

  for (const row of sampleRows) {
    const title = row["Title"]?.trim();
    if (!title) continue;

    // Pattern: "Author(s) - Year - Title" or "Author et al. - Year - Title"
    const citationPattern = /^(.+?)\s+-\s+(19|20)\d{2}\s+-\s+(.+)$/;
    const match = title.match(citationPattern);

    if (match) {
      const authors = match[1];
      // Only count if it looks like authors (has "and", "et al", or semicolons)
      if (/\bet al\b|;|,\s+and\b/i.test(authors)) {
        citationFormatCount++;
        if (evidence.length < 3) {
          // Show first 3 examples
          evidence.push(`"${title.substring(0, 80)}${title.length > 80 ? '...' : ''}"`);
        }
      }
    }
  }

  // If more than 50% of sampled titles are in citation format, it's likely a bibliography export
  const isBibliography = citationFormatCount / sampleSize > 0.5;

  return { isBibliography, evidence };
}

/**
 * Parse Zotero CSV export
 */
export function parseZoteroCSV(csvContent: string): ZoteroParseResult {
  const lines = csvContent.split("\n").filter(line => line.trim());

  if (lines.length === 0) {
    return {
      documents: [],
      errors: ["CSV file is empty"]
    };
  }

  // Parse header
  const headerLine = lines[0];
  const headers = parseHeaderLine(headerLine);

  const documents: ParsedZoteroDocument[] = [];
  const errors: string[] = [];

  // First pass: Parse all rows for bibliography format detection
  const allRows: ZoteroRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const row = parseCSVLine(lines[i], headers);
      allRows.push(row);
    } catch (error) {
      errors.push(`Row ${i + 1}: Failed to parse - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Detect bibliography format
  const { isBibliography, evidence } = detectBibliographyFormat(allRows);
  if (isBibliography) {
    return {
      documents: [],
      errors: [
        "❌ BIBLIOGRAPHY EXPORT DETECTED",
        "",
        "This CSV appears to be a bibliography export with titles in citation format:",
        ...evidence,
        "",
        "📋 How to fix:",
        "1. In Zotero, select your documents",
        "2. File → Export Library (or Export Items)",
        "3. Choose format: 'CSV' (NOT 'Bibliography' or 'Citation')",
        "4. In export options, ensure 'Export Files' is checked",
        "5. Re-upload the exported CSV",
        "",
        "The CSV should have separate columns for Title, Author, and Year - not combined into citation format."
      ]
    };
  }

  // Parse data rows
  for (let i = 0; i < allRows.length; i++) {
    try {
      const row = allRows[i];
      const rowNumber = i + 2; // +1 for 0-index, +1 for header row

      // Skip rows without file attachments
      if (!row["File Attachments"]) {
        continue;
      }

      // Extract filename
      const filename = extractFilename(row["File Attachments"]);
      if (!filename) {
        errors.push(`Row ${rowNumber}: Could not extract valid PDF filename from File Attachments`);
        continue;
      }

      // Extract metadata with intelligent fallbacks
      const title = extractTitle(row);
      const authors = extractAuthors(row);
      const year = extractYear(row);
      const summary = extractSummary(row);
      const doi = row["DOI"] || "";
      const publicationTitle = row["Publication Title"] || "";

      // Track per-document warnings
      const docErrors: string[] = [];

      // Warn if authors are missing (common data quality issue)
      if (!authors || authors.trim() === "") {
        const truncatedTitle = title.length > 50 ? title.substring(0, 50) + "..." : title;
        docErrors.push(`Missing author for: "${truncatedTitle}"`);
      }

      documents.push({
        filename,
        zoteroKey: row["Key"] || `row_${rowNumber}`,
        metadata: {
          "Article Title": title,
          "All authors": authors,
          "YEAR accepted": year,
          "Sub-tag": "",
          ...(summary && { summary }),
          // Additional fields for enriched metadata (stored but not currently used in UI)
          ...(doi && { "DOI": doi }),
          ...(publicationTitle && { "Publication Title": publicationTitle }),
          ...(row["Publisher"] && { "Publisher": row["Publisher"] }),
          ...(row["Url"] && { "URL": row["Url"] }),
          ...(row["Notes"] && { "Notes": row["Notes"] }),
        },
        ...(docErrors.length > 0 && { errors: docErrors }),
      });
    } catch (error) {
      errors.push(`Row ${i + 2}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { documents, errors };
}

/**
 * 3-tier matching: exact → fuzzy → unmatched
 * FUZZY_THRESHOLD: 0.85 = 85% similarity required for fuzzy match
 */
const FUZZY_THRESHOLD = 0.85;

export function matchDocumentsToFiles(
  documents: ParsedZoteroDocument[],
  pdfFiles: File[]
): MatchResult {
  const matched: MatchedItem[] = [];
  const unmatchedDocuments: ParsedZoteroDocument[] = [];
  const unmatchedFiles = [...pdfFiles];

  // Build normalized filename map for PDFs
  const pdfByNormalized = new Map<string, { file: File; index: number }>();
  for (let i = 0; i < pdfFiles.length; i++) {
    const normalized = normalizeFilename(pdfFiles[i].name);
    pdfByNormalized.set(normalized, { file: pdfFiles[i], index: i });
  }

  // Tier 1: Exact match (case-insensitive)
  const tier1Matched = new Set<number>();
  for (const doc of documents) {
    const normalized = normalizeFilename(doc.filename);
    const pdfMatch = pdfByNormalized.get(normalized);

    if (pdfMatch && !tier1Matched.has(pdfMatch.index)) {
      matched.push({
        document: doc,
        pdfFile: pdfMatch.file,
        matchType: "exact",
        confidence: 1.0
      });
      tier1Matched.add(pdfMatch.index);
    }
  }

  // Remaining unmatched documents for fuzzy matching
  const unmatched = documents.filter(
    doc => !matched.some(m => m.document.zoteroKey === doc.zoteroKey)
  );

  // Tier 2: Fuzzy match
  const tier2Matched = new Set<number>();
  for (const doc of unmatched) {
    const docNormalized = normalizeFilename(doc.filename);
    let bestMatch: { file: File; index: number; score: number } | null = null;

    for (const [pdfNormalized, pdfMatch] of pdfByNormalized.entries()) {
      if (tier1Matched.has(pdfMatch.index) || tier2Matched.has(pdfMatch.index)) {
        continue;
      }

      const similarity = calculateSimilarity(docNormalized, pdfNormalized);

      if (similarity >= FUZZY_THRESHOLD) {
        if (!bestMatch || similarity > bestMatch.score) {
          bestMatch = { ...pdfMatch, score: similarity };
        }
      }
    }

    if (bestMatch) {
      matched.push({
        document: doc,
        pdfFile: bestMatch.file,
        matchType: "fuzzy",
        confidence: bestMatch.score
      });
      tier2Matched.add(bestMatch.index);
    }
  }

  // Collect unmatched documents and files
  for (const doc of documents) {
    if (!matched.some(m => m.document.zoteroKey === doc.zoteroKey)) {
      unmatchedDocuments.push(doc);
    }
  }

  const matchedFileIndices = new Set([...tier1Matched, ...tier2Matched]);
  for (let i = 0; i < pdfFiles.length; i++) {
    if (!matchedFileIndices.has(i)) {
      unmatchedFiles.splice(unmatchedFiles.length - (i - Array.from(matchedFileIndices).filter(idx => idx > i).length), 1);
    }
  }

  // Rebuild unmatchedFiles correctly
  const actualUnmatchedFiles = pdfFiles.filter((_, i) => !matchedFileIndices.has(i));

  return {
    matched,
    unmatchedDocuments,
    unmatchedFiles: actualUnmatchedFiles
  };
}
