/**
 * Replace TOC Summaries
 * Finds documents with table-of-contents text as summaries and regenerates them from PDFs
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { generateSummary } from '../src/lib/summary-generator';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const BACKUP_PATH = path.join(process.cwd(), 'data', 'documents.csv.backup-toc-fix');
const DOCS_DIR = path.join(process.cwd(), 'data', 'documents');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

// Detect if summary is TOC/header/cover page text (lenient - flag anything suspicious)
function isTOCSummary(summary: string): boolean {
  const first200 = summary.substring(0, 200);
  const first500 = summary.substring(0, 500);

  const checks = [
    /EXECUTIVE SUMMARY/i.test(first200), // Heading, not prose
    /ABOUT THE AUTHORS?/i.test(first500), // Author bios
    /Version \d+/i.test(first200), // Version indicators
    /CONTENTS|Table of Contents/i.test(first200), // TOC
    /WRI.*\.ORG|WRIROSSCITIES/i.test(first200), // Website headers
    summary.split('\n')[0].length < 20 && summary.length > 100, // Short first line
    (summary.match(/[A-Z]{4,}/g) || []).length > 3, // Many all-caps words
    /Citation.*Suggest/i.test(summary.substring(summary.length - 100)), // Citation footer
    summary.trim().length < 50, // Too short
  ];

  return checks.filter(Boolean).length > 0; // Any flag = regenerate
}

// Process documents in batches with rate limiting
async function batchGenerateSummaries(
  docs: Array<{ pdfPath: string; title: string; id: string }>,
  onProgress?: (current: number, total: number, id: string) => void
): Promise<Map<string, { summary?: string; error?: string }>> {
  const results = new Map<string, { summary?: string; error?: string }>();

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];

    if (onProgress) {
      onProgress(i + 1, docs.length, doc.id);
    }

    try {
      const summary = await generateSummary({
        pdfPath: doc.pdfPath,
        title: doc.title,
      });

      results.set(doc.id, { summary });

      // Rate limit
      if (i < docs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error: any) {
      results.set(doc.id, { error: error.message });
    }
  }

  return results;
}

async function main() {
  console.log('🔧 Replacing TOC summaries with proper summaries...\n');

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY not found');
    process.exit(1);
  }

  // 1. Backup
  console.log('📦 Creating backup...');
  await fs.copyFile(CSV_PATH, BACKUP_PATH);
  console.log(`✅ Backup: ${BACKUP_PATH}\n`);

  // 2. Read CSV
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];

  console.log(`📖 Read ${records.length} documents\n`);

  // 3. Find TOC summaries
  const tocDocs: Array<{ index: number; id: string; pdfPath: string; title: string }> = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    if (!isTOCSummary(row.summary)) continue;

    // Check if PDF exists
    const pdfPath = path.join(DOCS_DIR, row.file_path);
    try {
      await fs.access(pdfPath);

      try {
        const metadata = JSON.parse(row.metadata);
        const docId = row.file_path.replace('.pdf', '');
        tocDocs.push({
          index: i,
          id: docId,
          pdfPath,
          title: metadata['Article Title'] || 'Untitled',
        });
      } catch (e) {
        console.warn(`⚠️  Skipping ${row.file_path}: Invalid metadata`);
      }
    } catch {
      // PDF doesn't exist, skip
    }
  }

  console.log(`🔍 Found ${tocDocs.length} documents with TOC summaries\n`);

  if (tocDocs.length === 0) {
    console.log('✨ No TOC summaries found!');
    return;
  }

  // Show list
  console.log('📋 Documents to fix:');
  tocDocs.slice(0, 10).forEach((doc, idx) => {
    console.log(`  ${idx + 1}. ${doc.id} - "${doc.title.substring(0, 60)}..."`);
  });
  if (tocDocs.length > 10) {
    console.log(`  ... and ${tocDocs.length - 10} more`);
  }

  const estimatedCost = tocDocs.length * 0.02; // ~$0.02 per summary
  console.log(`\n💰 Estimated cost: ~$${estimatedCost.toFixed(2)} (gpt-4o-mini)\n`);

  // 4. Generate summaries
  console.log('🚀 Generating summaries...\n');

  const results = await batchGenerateSummaries(
    tocDocs.map(d => ({ pdfPath: d.pdfPath, title: d.title, id: d.id })),
    (current, total, id) => {
      const percent = ((current / total) * 100).toFixed(0);
      console.log(`[${current}/${total}] (${percent}%) Processing ${id}...`);
    }
  );

  // 5. Update CSV
  console.log('\n💾 Updating CSV...');
  let successCount = 0;
  let failCount = 0;

  for (const doc of tocDocs) {
    const result = results.get(doc.id);

    if (result && result.summary && !result.error) {
      // Update both column and metadata
      records[doc.index].summary = result.summary;

      try {
        const metadata = JSON.parse(records[doc.index].metadata);
        metadata.summary = result.summary;
        records[doc.index].metadata = JSON.stringify(metadata);
      } catch (e) {
        console.warn(`⚠️  Failed to update metadata for ${doc.id}`);
      }

      successCount++;
      console.log(`✅ ${doc.id}: ${result.summary.substring(0, 70)}...`);
    } else {
      failCount++;
      console.log(`❌ ${doc.id}: ${result?.error || 'Unknown error'}`);
    }
  }

  // 6. Write updated CSV
  const output = stringify(records, {
    header: true,
    columns: ['file_path', 'metadata', 'summary'],
  });
  await fs.writeFile(CSV_PATH, output, 'utf-8');
  console.log(`\n✅ Updated ${CSV_PATH}\n`);

  // 7. Summary
  console.log('✨ TOC summary replacement complete!\n');
  console.log(`Results:`);
  console.log(`  - Successful: ${successCount}`);
  console.log(`  - Failed: ${failCount}`);
  console.log(`  - Total: ${tocDocs.length}`);

  console.log('\nNext steps:');
  console.log('  1. Restart hybrid service to rebuild index');
  console.log('  2. Verify search quality');
  console.log('  3. Run verify-summary-sync.ts to confirm sync');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
