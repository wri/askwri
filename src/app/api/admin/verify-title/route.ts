import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

/**
 * POST /api/admin/verify-title
 *
 * Verifies if a given title matches the content of a PDF file.
 * Used during import to detect potential metadata mismatches.
 *
 * Request body:
 * - pdfFile: File (multipart form data) OR
 * - pdfPath: string (path to existing PDF)
 * - title: string (title to verify)
 *
 * Response:
 * - matches: boolean
 * - confidence: number (0-1)
 * - extractedTitle: string (title found in PDF)
 * - details: string
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const title = formData.get('title') as string;
    const pdfFile = formData.get('pdfFile') as File | null;

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    let pdfText = '';
    let tempFilePath = '';

    if (pdfFile) {
      // Save file temporarily for PDF parsing
      const bytes = await pdfFile.arrayBuffer();
      const buffer = Buffer.from(bytes);

      const tempDir = path.join(process.cwd(), 'data', 'temp');
      tempFilePath = path.join(tempDir, `verify_${Date.now()}.pdf`);

      // Ensure temp directory exists
      const fs = await import('fs/promises');
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(tempFilePath, buffer);

      try {
        pdfText = await extractPdfText(tempFilePath);
      } finally {
        // Clean up temp file
        await fs.unlink(tempFilePath).catch(() => {});
      }
    } else {
      return NextResponse.json({ error: 'PDF file is required' }, { status: 400 });
    }

    if (!pdfText || pdfText.length < 100) {
      return NextResponse.json({
        matches: false,
        confidence: 0,
        extractedTitle: '',
        details: 'Could not extract text from PDF'
      });
    }

    // Check if title matches PDF content
    const result = verifyTitleMatch(title, pdfText);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Verify Title] Error:', error);
    return NextResponse.json(
      { error: 'Failed to verify title', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * Extract text from PDF using Python LlamaIndex
 */
async function extractPdfText(pdfPath: string): Promise<string> {
  const pythonCmd = `python3 -c "
from llama_index.readers.file import PDFReader
reader = PDFReader()
docs = reader.load_data('${pdfPath.replace(/'/g, "\\'")}')
if docs:
    text = docs[0].text[:3000]
    print(text)
"`;

  const { stdout } = await execAsync(pythonCmd, {
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30000,
  });

  return stdout.trim();
}

/**
 * Verify if title matches PDF content
 */
function verifyTitleMatch(title: string, pdfText: string): {
  matches: boolean;
  confidence: number;
  extractedTitle: string;
  details: string;
} {
  const titleLower = title.toLowerCase();
  const pdfLower = pdfText.toLowerCase();

  // Extract potential title from first page
  const lines = pdfText.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 10 && l.length < 200);

  // Skip common headers
  const skipPatterns = [
    /^working paper/i,
    /^technical note/i,
    /^practice note/i,
    /^wri\b/i,
    /^contents$/i,
    /^\d+$/,
  ];

  let extractedTitle = '';
  for (const line of lines.slice(0, 15)) {
    if (skipPatterns.some(p => p.test(line))) continue;
    if (line.length > 15) {
      extractedTitle = line;
      break;
    }
  }

  // Check for direct substring match
  if (pdfLower.includes(titleLower)) {
    return {
      matches: true,
      confidence: 1.0,
      extractedTitle,
      details: 'Title found directly in PDF content'
    };
  }

  // Check word overlap
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 3);
  const matchedWords = titleWords.filter(w => pdfLower.includes(w));
  const wordMatchRatio = matchedWords.length / titleWords.length;

  if (wordMatchRatio >= 0.7) {
    return {
      matches: true,
      confidence: wordMatchRatio,
      extractedTitle,
      details: `${matchedWords.length}/${titleWords.length} title words found in PDF (${(wordMatchRatio * 100).toFixed(0)}%)`
    };
  }

  if (wordMatchRatio >= 0.4) {
    return {
      matches: false,
      confidence: wordMatchRatio,
      extractedTitle,
      details: `Only ${matchedWords.length}/${titleWords.length} title words found - possible mismatch`
    };
  }

  return {
    matches: false,
    confidence: wordMatchRatio,
    extractedTitle,
    details: `Title does not match PDF content (${(wordMatchRatio * 100).toFixed(0)}% overlap)`
  };
}
