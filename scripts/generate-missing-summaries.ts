/**
 * Generate Summaries for Documents with Empty Summaries
 *
 * Uses OpenAI to generate high-quality summaries for documents
 * that are missing summaries in the CSV.
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { generateSummary, batchGenerateSummaries } from '../src/lib/summary-generator';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const DOCS_DIR = path.join(process.cwd(), 'data', 'documents');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

interface DocumentToProcess {
  id: string;
  pdfPath: string;
  title: string;
  row: CSVRow;
  index: number;
}

async function main() {
  console.log('🤖 Starting LLM summary generation...\n');

  // Check OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY not found in environment');
    console.error('Please set it in your .env file');
    process.exit(1);
  }

  // 1. Read CSV
  console.log('📖 Reading CSV...');
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];
  console.log(`✅ Read ${records.length} documents\n`);

  // 2. Find documents with empty summaries
  console.log('🔍 Finding documents with empty summaries...');
  const emptyDocs: DocumentToProcess[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const summary = record.summary?.trim();

    if (!summary) {
      try {
        const metadata = JSON.parse(record.metadata);
        const title = metadata['Article Title'] || 'Untitled';
        const docId = record.file_path.replace('.pdf', '');
        const pdfPath = path.join(DOCS_DIR, record.file_path);

        // Check if PDF exists
        try {
          await fs.access(pdfPath);
          emptyDocs.push({
            id: docId,
            pdfPath,
            title,
            row: record,
            index: i,
          });
        } catch (e) {
          console.warn(`⚠️  PDF not found: ${pdfPath}`);
        }
      } catch (e) {
        console.warn(`⚠️  Failed to parse metadata for ${record.file_path}`);
      }
    }
  }

  console.log(`✅ Found ${emptyDocs.length} documents needing summaries\n`);

  if (emptyDocs.length === 0) {
    console.log('✨ All documents already have summaries!');
    return;
  }

  // 3. Show what we're about to do
  console.log('📋 Documents to process:');
  emptyDocs.slice(0, 10).forEach(doc => {
    console.log(`   - ${doc.id}: ${doc.title}`);
  });
  if (emptyDocs.length > 10) {
    console.log(`   ... and ${emptyDocs.length - 10} more`);
  }
  console.log('');

  // Estimate cost
  const estimatedCost = emptyDocs.length * 0.02; // ~$0.02 per document
  console.log(`💰 Estimated cost: ~$${estimatedCost.toFixed(2)} (using ${process.env.OPENAI_MODEL_SUMMARY || 'gpt-4o-mini'})\n`);

  // 4. Ask for confirmation (optional - comment out if you want auto-run)
  console.log('⏸️  Press Enter to continue or Ctrl+C to cancel...');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // 5. Generate summaries with progress tracking
  console.log('\n🚀 Generating summaries...\n');

  const results = await batchGenerateSummaries(
    emptyDocs.map(d => ({ pdfPath: d.pdfPath, title: d.title, id: d.id })),
    (current, total, id) => {
      const percent = ((current / total) * 100).toFixed(0);
      console.log(`[${current}/${total}] (${percent}%) Processing ${id}...`);
    }
  );

  // 6. Update CSV with generated summaries
  console.log('\n💾 Updating CSV...');
  let successCount = 0;
  let failCount = 0;

  for (const doc of emptyDocs) {
    const result = results.get(doc.id);

    if (result && result.summary && !result.error) {
      // Update both summary column and metadata JSON
      records[doc.index].summary = result.summary;

      try {
        const metadata = JSON.parse(records[doc.index].metadata);
        metadata.summary = result.summary;
        records[doc.index].metadata = JSON.stringify(metadata);
      } catch (e) {
        console.warn(`⚠️  Failed to update metadata for ${doc.id}`);
      }

      successCount++;
      console.log(`✅ ${doc.id}: ${result.summary.substring(0, 80)}...`);
    } else {
      failCount++;
      console.log(`❌ ${doc.id}: ${result?.error || 'Unknown error'}`);
    }
  }

  // 7. Write updated CSV
  const output = stringify(records, {
    header: true,
    columns: ['file_path', 'metadata', 'summary'],
  });
  await fs.writeFile(CSV_PATH, output, 'utf-8');
  console.log(`\n✅ Updated ${CSV_PATH}`);

  // 8. Summary
  console.log('\n✨ Summary generation complete!\n');
  console.log(`Results:`);
  console.log(`  - Successful: ${successCount}`);
  console.log(`  - Failed: ${failCount}`);
  console.log(`  - Total processed: ${emptyDocs.length}`);

  if (failCount > 0) {
    console.log('\n⚠️  Some summaries failed to generate.');
    console.log('   You may need to:');
    console.log('   - Check PDF file integrity');
    console.log('   - Verify OpenAI API key has credits');
    console.log('   - Manually review and add summaries');
  }

  console.log('\nNext steps:');
  console.log('  1. Review generated summaries in the CSV');
  console.log('  2. Restart hybrid service to rebuild index');
  console.log('  3. Test search quality in the UI');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
