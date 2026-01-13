/**
 * Title Verification Script
 *
 * Compares CSV titles against actual PDF content to detect mismatches.
 * Uses LlamaIndex PDFReader (same as hybrid service) to extract PDF text,
 * then checks if the CSV title appears in the first few pages.
 *
 * Usage:
 *   npx tsx scripts/verify-titles.ts
 *   npx tsx scripts/verify-titles.ts --fix  # Generate fix suggestions
 *
 * Output:
 *   - Console report of all documents
 *   - JSON report at data/title-verification-report.json
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const DOCS_DIR = path.join(process.cwd(), 'data', 'documents');
const REPORT_PATH = path.join(process.cwd(), 'data', 'title-verification-report.json');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

interface VerificationResult {
  line: number;
  file_path: string;
  csv_title: string;
  pdf_extracted_title: string | null;
  status: 'match' | 'mismatch' | 'uncertain' | 'error';
  confidence: number;
  details: string;
}

interface Report {
  generated_at: string;
  total_documents: number;
  matches: number;
  mismatches: number;
  uncertain: number;
  errors: number;
  results: VerificationResult[];
}

/**
 * Extract potential title from PDF using Python LlamaIndex
 */
async function extractPdfTitle(pdfPath: string): Promise<{ title: string; firstPage: string } | null> {
  try {
    const pythonCmd = `python3 -c "
from llama_index.readers.file import PDFReader
reader = PDFReader()
docs = reader.load_data('${pdfPath.replace(/'/g, "\\'")}')
if docs:
    text = docs[0].text[:3000]
    print(text)
"`;

    const { stdout, stderr } = await execAsync(pythonCmd, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    if (!stdout || stdout.trim().length < 50) {
      return null;
    }

    const firstPage = stdout.trim();

    // Try to extract title from first page
    // Look for lines that look like titles (uppercase, short, at start)
    const lines = firstPage.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 5 && l.length < 200);

    // Heuristic: title is usually one of the first non-trivial lines
    // Skip common headers like "WORKING PAPER", "TECHNICAL NOTE", etc.
    const skipPatterns = [
      /^working paper/i,
      /^technical note/i,
      /^research paper/i,
      /^wri\b/i,
      /^world resources/i,
      /^\d+$/,
      /^contents$/i,
      /^table of contents/i,
      /^version/i,
      /^january|february|march|april|may|june|july|august|september|october|november|december/i,
    ];

    let potentialTitle = '';
    for (const line of lines.slice(0, 15)) {
      if (skipPatterns.some(p => p.test(line))) continue;
      if (line.length > 10) {
        potentialTitle = line;
        break;
      }
    }

    return { title: potentialTitle, firstPage };
  } catch (error) {
    return null;
  }
}

/**
 * Calculate similarity between two strings (case-insensitive)
 */
function calculateSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase().replace(/[^\w\s]/g, '');
  const bLower = b.toLowerCase().replace(/[^\w\s]/g, '');

  // Word overlap method
  const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 3));
  const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 3));

  if (aWords.size === 0 || bWords.size === 0) return 0;

  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap++;
  }

  // Jaccard similarity
  const union = new Set([...aWords, ...bWords]);
  return overlap / union.size;
}

/**
 * Check if CSV title appears in PDF first page
 */
function checkTitleInPdf(csvTitle: string, pdfFirstPage: string): { found: boolean; confidence: number } {
  const titleLower = csvTitle.toLowerCase();
  const pageLower = pdfFirstPage.toLowerCase();

  // Direct substring match
  if (pageLower.includes(titleLower)) {
    return { found: true, confidence: 1.0 };
  }

  // Check if most title words appear in first page
  const titleWords = titleLower.split(/\s+/).filter(w => w.length > 3);
  const matchedWords = titleWords.filter(w => pageLower.includes(w));
  const wordMatchRatio = matchedWords.length / titleWords.length;

  if (wordMatchRatio >= 0.7) {
    return { found: true, confidence: wordMatchRatio };
  }

  return { found: false, confidence: wordMatchRatio };
}

async function main() {
  console.log('📋 Title Verification Script');
  console.log('============================\n');

  const generateFix = process.argv.includes('--fix');

  // Read CSV
  console.log('📖 Reading CSV...');
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];
  console.log(`✅ Found ${records.length} documents\n`);

  const results: VerificationResult[] = [];
  let matches = 0;
  let mismatches = 0;
  let uncertain = 0;
  let errors = 0;

  console.log('🔍 Verifying titles against PDF content...\n');

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const lineNum = i + 2; // +1 for 0-index, +1 for header

    let metadata: any = {};
    try {
      metadata = JSON.parse(record.metadata);
    } catch (e) {
      results.push({
        line: lineNum,
        file_path: record.file_path,
        csv_title: '(invalid metadata)',
        pdf_extracted_title: null,
        status: 'error',
        confidence: 0,
        details: 'Failed to parse metadata JSON',
      });
      errors++;
      continue;
    }

    const csvTitle = metadata['Article Title'] || '';
    const pdfPath = path.join(DOCS_DIR, record.file_path);

    // Check if PDF exists
    try {
      await fs.access(pdfPath);
    } catch (e) {
      results.push({
        line: lineNum,
        file_path: record.file_path,
        csv_title: csvTitle,
        pdf_extracted_title: null,
        status: 'error',
        confidence: 0,
        details: 'PDF file not found',
      });
      errors++;
      continue;
    }

    // Extract PDF content
    const pdfData = await extractPdfTitle(pdfPath);

    if (!pdfData) {
      results.push({
        line: lineNum,
        file_path: record.file_path,
        csv_title: csvTitle,
        pdf_extracted_title: null,
        status: 'error',
        confidence: 0,
        details: 'Failed to extract PDF content',
      });
      errors++;
      continue;
    }

    // Check if title matches
    const { found, confidence } = checkTitleInPdf(csvTitle, pdfData.firstPage);

    let status: 'match' | 'mismatch' | 'uncertain';
    let details: string;

    if (found && confidence >= 0.7) {
      status = 'match';
      details = `Title words found in PDF (${(confidence * 100).toFixed(0)}% match)`;
      matches++;
    } else if (confidence >= 0.4) {
      status = 'uncertain';
      details = `Partial match (${(confidence * 100).toFixed(0)}%) - manual review recommended`;
      uncertain++;
    } else {
      status = 'mismatch';
      details = `Title not found in PDF (${(confidence * 100).toFixed(0)}% match)`;
      mismatches++;
    }

    results.push({
      line: lineNum,
      file_path: record.file_path,
      csv_title: csvTitle.substring(0, 80),
      pdf_extracted_title: pdfData.title.substring(0, 80),
      status,
      confidence,
      details,
    });

    // Progress indicator
    if ((i + 1) % 20 === 0) {
      console.log(`  Processed ${i + 1}/${records.length}...`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('VERIFICATION RESULTS');
  console.log('='.repeat(60));

  console.log(`\n📊 Summary:`);
  console.log(`  Total: ${records.length}`);
  console.log(`  ✅ Matches: ${matches}`);
  console.log(`  ❌ Mismatches: ${mismatches}`);
  console.log(`  ⚠️  Uncertain: ${uncertain}`);
  console.log(`  💥 Errors: ${errors}`);

  // Show mismatches
  const mismatchResults = results.filter(r => r.status === 'mismatch');
  if (mismatchResults.length > 0) {
    console.log(`\n❌ MISMATCHES (${mismatchResults.length}):`);
    for (const r of mismatchResults) {
      console.log(`\n  Line ${r.line}: ${r.file_path}`);
      console.log(`    CSV Title: "${r.csv_title}"`);
      console.log(`    PDF Title: "${r.pdf_extracted_title || '(not extracted)'}"`);
      console.log(`    ${r.details}`);
    }
  }

  // Show uncertain
  const uncertainResults = results.filter(r => r.status === 'uncertain');
  if (uncertainResults.length > 0) {
    console.log(`\n⚠️  UNCERTAIN (${uncertainResults.length}):`);
    for (const r of uncertainResults.slice(0, 10)) {
      console.log(`\n  Line ${r.line}: ${r.file_path}`);
      console.log(`    CSV Title: "${r.csv_title}"`);
      console.log(`    PDF Title: "${r.pdf_extracted_title || '(not extracted)'}"`);
      console.log(`    ${r.details}`);
    }
    if (uncertainResults.length > 10) {
      console.log(`\n  ... and ${uncertainResults.length - 10} more (see JSON report)`);
    }
  }

  // Generate report
  const report: Report = {
    generated_at: new Date().toISOString(),
    total_documents: records.length,
    matches,
    mismatches,
    uncertain,
    errors,
    results,
  };

  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n📄 Full report saved to: ${REPORT_PATH}`);

  console.log('\n✨ Verification complete!');

  if (mismatches > 0 || uncertain > 0) {
    console.log('\n📋 Next steps:');
    console.log('  1. Review mismatches and uncertain results');
    console.log('  2. For confirmed mismatches, update CSV titles manually');
    console.log('  3. Re-run this script to verify fixes');
  }
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
