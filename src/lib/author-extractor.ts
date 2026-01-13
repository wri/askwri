/**
 * LLM-based Author Extractor
 * Extracts author names from PDF content when metadata is missing
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
 * Extract text from first 2 pages of PDF (where authors usually are)
 */
async function extractPDFAuthorPages(pdfPath: string): Promise<string> {
  try {
    const pythonCmd = `python3 -c "
from llama_index.readers.file import PDFReader
reader = PDFReader()
docs = reader.load_data('${pdfPath.replace(/'/g, "\\'")}')
# Get first 2 pages for author extraction
text = '\\n\\n'.join([d.text for d in docs[:2]])
print(text[:6000])  # First 6000 chars should contain author info
"`;

    const { stdout, stderr } = await execAsync(pythonCmd, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
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
 * Extract authors using OpenAI
 */
async function callOpenAI(text: string): Promise<string> {
  const systemPrompt = `You are a document metadata expert. Your task is to extract the author names from a research document or publication.

Rules:
- Look for author names on the title page, front matter, or document header
- Return names in format: "FirstName LastName; FirstName LastName" (semicolon-separated)
- Keep the original name format and spelling as it appears in the document
- Do NOT include organization names (like "World Resources Institute", "Coalition for Urban Transitions") unless they are explicitly listed as the author
- Do NOT include editors, reviewers, or acknowledgments - only authors
- If multiple authors are listed with affiliations, extract just the names
- If you cannot find clear author names, return "UNKNOWN"
- Return ONLY the author names, nothing else`;

  const userPrompt = `Document content (first pages):
${text}

Extract the author name(s) from this document. Return only the names, nothing else.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 300,
    });

    const authors = response.choices[0]?.message?.content?.trim() || '';

    if (!authors || authors === 'UNKNOWN') {
      throw new Error('Could not extract authors from PDF');
    }

    // Clean up any quotes that GPT might add
    const cleaned = authors.replace(/^["']|["']$/g, '').trim();

    return cleaned;
  } catch (error) {
    throw new Error(`OpenAI API call failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extract authors from PDF
 */
export async function extractAuthors(pdfPath: string): Promise<string> {
  // 1. Get PDF text
  const text = await extractPDFAuthorPages(pdfPath);

  if (!text || text.length < 50) {
    throw new Error('PDF text too short for author extraction');
  }

  // 2. Extract authors using LLM
  const authors = await callOpenAI(text);

  return authors;
}
