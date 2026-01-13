/**
 * LLM-based Summary Generator
 * Generates high-quality document summaries from PDF content
 *
 * Uses Python subprocess to parse PDFs with the SAME LlamaIndex reader
 * that the hybrid service uses (llama_index.readers.file.PDFReader),
 * ensuring parsing consistency across the system.
 *
 * Summaries are domain-agnostic and focus on key findings, methods,
 * and implications regardless of subject matter.
 */

import OpenAI from 'openai';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL_SUMMARY || 'gpt-4o-mini';

interface SummaryOptions {
  maxTokens?: number;
  pdfPath?: string;
  pdfText?: string;
  title?: string;
  focusArea?: string;
}

/**
 * Extract text from PDF file using Python's LlamaIndex PDFReader
 * This uses the SAME parser as the hybrid service (llama_index.readers.file.PDFReader)
 * for consistency in how PDFs are parsed and indexed.
 */
async function extractPDFText(pdfPath: string, maxPages: number = 10): Promise<string> {
  try {
    // Use Python one-liner to extract PDF text with the same reader as hybrid service
    // This ensures consistency: summaries are generated from the same text that gets indexed
    const pythonCmd = `python3 -c "
from llama_index.readers.file import PDFReader
reader = PDFReader()
docs = reader.load_data('${pdfPath.replace(/'/g, "\\'")}')
text = '\\n\\n'.join([d.text for d in docs[:${maxPages}]])
print(text[:16000] if len(text) > 16000 else text)
"`;

    const { stdout, stderr } = await execAsync(pythonCmd, {
      maxBuffer: 20 * 1024 * 1024, // 20MB buffer for large PDFs
      timeout: 30000, // 30 second timeout
    });

    if (stderr && stderr.toLowerCase().includes('error')) {
      throw new Error(`Python PDF extraction error: ${stderr}`);
    }

    if (!stdout || stdout.trim().length < 100) {
      throw new Error('PDF extraction returned insufficient text (< 100 chars)');
    }

    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to extract PDF text: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Generate summary using OpenAI
 * Produces 4-5 sentence summaries focused on key research contributions
 */
async function callOpenAI(text: string, title: string, focusArea: string): Promise<string> {
  const systemPrompt = `You are a research librarian. Your task is to write clear, informative summaries of research documents and publications.

Guidelines:
- Length: EXACTLY 4-5 sentences (300-500 characters)
- Focus on: ${focusArea}
- Avoid: Starting with "This document", "This paper", "Synopsis", or other meta-language
- Include: Key findings, methods, implications, or recommendations
- Style: Direct and informative, as if describing the research to a colleague
- Start immediately with the substance (e.g., "Urban resilience requires..." not "This study examines...")`;

  const userPrompt = `Document Title: "${title}"

Document Content:
${text}

Write a concise 4-5 sentence summary focusing on the key findings, methods, and implications.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3, // Lower temperature for consistency
      max_tokens: 200, // ~75-100 words for 4-5 sentences
    });

    const summary = response.choices[0]?.message?.content?.trim() || '';

    if (!summary) {
      throw new Error('OpenAI returned empty summary');
    }

    // Validate length (should be 4-5 sentences, roughly 300-600 chars)
    if (summary.length < 200) {
      console.warn(`Summary too short (${summary.length} chars): ${summary.substring(0, 50)}...`);
    }

    return summary;
  } catch (error) {
    throw new Error(`OpenAI API call failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Generate summary from PDF file or text
 */
export async function generateSummary(options: SummaryOptions): Promise<string> {
  const {
    pdfPath,
    pdfText,
    title = 'Untitled Document',
    focusArea = 'the document\'s key contributions, findings, and implications',
  } = options;

  // 1. Get text content
  let text: string;
  if (pdfText) {
    text = pdfText;
  } else if (pdfPath) {
    text = await extractPDFText(pdfPath);
  } else {
    throw new Error('Either pdfPath or pdfText must be provided');
  }

  // 2. Validate we have content
  if (!text || text.trim().length < 100) {
    throw new Error('PDF content too short or empty (< 100 chars)');
  }

  // 3. Generate summary
  const summary = await callOpenAI(text, title, focusArea);

  return summary;
}

/**
 * Batch generate summaries for multiple documents
 */
export async function batchGenerateSummaries(
  documents: Array<{ pdfPath: string; title: string; id: string }>,
  onProgress?: (current: number, total: number, id: string) => void
): Promise<Map<string, { summary: string; error?: string }>> {
  const results = new Map<string, { summary: string; error?: string }>();

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];

    try {
      onProgress?.(i + 1, documents.length, doc.id);

      const summary = await generateSummary({
        pdfPath: doc.pdfPath,
        title: doc.title,
      });

      results.set(doc.id, { summary });

      // Rate limiting: wait 500ms between requests to avoid OpenAI rate limits
      if (i < documents.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to generate summary for ${doc.id}:`, errorMsg);
      results.set(doc.id, {
        summary: '',
        error: errorMsg,
      });
    }
  }

  return results;
}

/**
 * Check if a summary needs regeneration
 */
export function needsSummaryGeneration(summary: string | undefined): boolean {
  if (!summary || !summary.trim()) {
    return true;
  }

  // Check if too short
  if (summary.length < 50) {
    return true;
  }

  // Check if it has problematic patterns
  const problematicPatterns = [
    /^(Synopsis|Main Findings|Key Messages|Introduction|Chapter)/i,
    /^\.\.\./,  // Starts with ellipsis
    /^Contents/i,  // Table of contents
  ];

  return problematicPatterns.some(pattern => pattern.test(summary));
}
