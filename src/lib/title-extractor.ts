/**
 * LLM-based Title Extractor
 * Extracts proper document titles from PDF content when metadata is missing or filename-based
 */

import OpenAI from 'openai';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL_SUMMARY || 'gpt-4o-mini';

/**
 * Extract text from first 2 pages of PDF (where title usually is)
 */
async function extractPDFTitlePages(pdfPath: string): Promise<string> {
  try {
    const pythonCmd = `python3 -c "
from llama_index.readers.file import PDFReader
reader = PDFReader()
docs = reader.load_data('${pdfPath.replace(/'/g, "\\'")}')
# Get first 2 pages for title extraction
text = '\\n\\n'.join([d.text for d in docs[:2]])
print(text[:4000])  # First 4000 chars is enough for title
"`;

    const { stdout, stderr } = await execAsync(pythonCmd, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    });

    if (stderr && stderr.toLowerCase().includes('error')) {
      throw new Error(`Python PDF extraction error: ${stderr}`);
    }

    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to extract PDF text: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extract proper title using OpenAI
 */
async function callOpenAI(text: string, currentTitle: string): Promise<string> {
  const systemPrompt = `You are a document metadata expert. Your task is to extract the EXACT official title of a research document or publication from its PDF content.

Rules:
- Extract the main title as it appears on the document's title page or header
- Do NOT include author names, years, affiliations, or citations
- Do NOT include "Abstract", "Introduction", or other section headers
- Keep the original capitalization and punctuation
- Return ONLY the title, nothing else
- If you cannot find a clear title, return "UNKNOWN"`;

  const userPrompt = `Current title (possibly incorrect): "${currentTitle}"

Document content (first pages):
${text}

Extract the EXACT official title of this document. Return only the title, nothing else.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1, // Very low temperature for consistency
      max_tokens: 100, // Titles are usually short
    });

    const title = response.choices[0]?.message?.content?.trim() || '';

    if (!title || title === 'UNKNOWN') {
      throw new Error('Could not extract title from PDF');
    }

    // Clean up any quotes that GPT might add
    const cleaned = title.replace(/^["']|["']$/g, '').trim();

    return cleaned;
  } catch (error) {
    throw new Error(`OpenAI API call failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extract proper title from PDF
 */
export async function extractTitle(pdfPath: string, currentTitle: string): Promise<string> {
  // 1. Get PDF text
  const text = await extractPDFTitlePages(pdfPath);

  if (!text || text.length < 50) {
    throw new Error('PDF text too short for title extraction');
  }

  // 2. Extract title using LLM
  const title = await callOpenAI(text, currentTitle);

  return title;
}

/**
 * Check if a title needs extraction (heuristic)
 */
export function needsTitleExtraction(title: string): boolean {
  if (!title || title.length < 10) return true;

  // Pattern 1: Hyphenated lowercase words (filename slug format)
  // Examples: "accelerating-building-decarbonization", "future-mobility-calculator"
  if (/^[a-z]+(-[a-z]+)+$/.test(title)) {
    return true;
  }

  // Pattern 2: Multiple hyphens connecting short words (filename format)
  // Examples: "Future-Mobility-Calculator", "Costos-económicos-para-la-expansión"
  // But NOT: "zero-emission heavy-duty trucks" (compound adjectives in proper title)
  const hyphenCount = (title.match(/-/g) || []).length;
  if (hyphenCount >= 3) {
    // Check if it's slug-like: no spaces or only short words between hyphens
    const segments = title.split(/\s+/);
    const hasSlugFormat = segments.some(seg => seg.split('-').length >= 3);
    if (hasSlugFormat) {
      return true;
    }
  }

  // Pattern 3: CamelCase without spaces (concatenated filename)
  // Examples: "CitiesSaferByDesign", "FutureMobilityCalculator"
  if (/^[A-Z][a-z]+([A-Z][a-z]+){2,}$/.test(title) && !title.includes(' ')) {
    return true;
  }

  // Pattern 4: Underscores (filename artifacts)
  if (title.includes('_')) {
    return true;
  }

  // Pattern 5: Common filename keywords
  if (/\b(final|draft|abstract|v\d+|version)\b/i.test(title)) {
    return true;
  }

  // Pattern 6: Very short titles without punctuation (likely filename stubs)
  // But allow normal capitalized titles with spaces
  const hasProperSpacing = title.split(' ').length >= 3;
  const hasProperCapitalization = /^[A-Z][a-z]+ [A-Z]/.test(title);
  if (title.length < 20 && !title.includes(':') && !title.includes(',') &&
      !(hasProperSpacing && hasProperCapitalization)) {
    return true;
  }

  // Pattern 7: Ends with truncation
  if (title.endsWith('...')) {
    return true;
  }

  return false;
}
