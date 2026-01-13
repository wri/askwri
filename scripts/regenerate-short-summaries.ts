/**
 * Regenerate Short Summaries
 *
 * Finds documents with summaries < 150 characters and regenerates them
 * using OpenAI to create proper 4-5 sentence summaries.
 *
 * Usage:
 *   npx tsx scripts/regenerate-short-summaries.ts
 *   npx tsx scripts/regenerate-short-summaries.ts --dry-run  # Preview only
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { generateSummary } from '../src/lib/summary-generator';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const DOCS_DIR = path.join(process.cwd(), 'data', 'documents');
const MIN_SUMMARY_LENGTH = 150;

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('🔄 Regenerate Short Summaries');
  console.log('============================');
  if (dryRun) {
    console.log('🔍 DRY RUN MODE - no changes will be made\n');
  }
  console.log();

  // Check OpenAI API key
  if (!process.env.OPENAI_API_KEY && !dryRun) {
    console.error('❌ Error: OPENAI_API_KEY not found in environment');
    console.error('Please set it in your .env file');
    process.exit(1);
  }

  // Read CSV
  console.log('📖 Reading CSV...');
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];
  console.log(`✅ Found ${records.length} documents\n`);

  // Find short summaries
  console.log(`🔍 Finding summaries shorter than ${MIN_SUMMARY_LENGTH} characters...`);
  const shortSummaries: Array<{ index: number; row: CSVRow; title: string }> = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const summary = record.summary?.trim() || '';

    if (summary.length > 0 && summary.length < MIN_SUMMARY_LENGTH) {
      try {
        const metadata = JSON.parse(record.metadata);
        const title = metadata['Article Title'] || 'Untitled';
        shortSummaries.push({ index: i, row: record, title });
      } catch (e) {
        console.warn(`⚠️ Failed to parse metadata for ${record.file_path}`);
      }
    }
  }

  console.log(`✅ Found ${shortSummaries.length} documents with short summaries\n`);

  if (shortSummaries.length === 0) {
    console.log('✨ All summaries are already sufficient length!');
    return;
  }

  // Show what we'll process
  console.log('📋 Documents to regenerate:');
  for (const item of shortSummaries) {
    console.log(`  Line ${item.index + 2}: ${item.title.substring(0, 60)}`);
    console.log(`    Current (${item.row.summary.length} chars): ${item.row.summary.substring(0, 60)}...`);
  }
  console.log();

  if (dryRun) {
    console.log('🔍 DRY RUN complete - no changes made');
    return;
  }

  // Estimate cost
  const estimatedCost = shortSummaries.length * 0.02;
  console.log(`💰 Estimated cost: ~$${estimatedCost.toFixed(2)} (using ${process.env.OPENAI_MODEL_SUMMARY || 'gpt-4o-mini'})\n`);

  // Ask for confirmation
  console.log('⏸️ Press Enter to continue or Ctrl+C to cancel...');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // Process each document
  console.log('\n🚀 Regenerating summaries...\n');
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < shortSummaries.length; i++) {
    const item = shortSummaries[i];
    const pdfPath = path.join(DOCS_DIR, item.row.file_path);

    console.log(`[${i + 1}/${shortSummaries.length}] Processing ${item.row.file_path}...`);

    try {
      // Check if PDF exists
      await fs.access(pdfPath);

      // Generate new summary
      const newSummary = await generateSummary({
        pdfPath,
        title: item.title,
      });

      if (newSummary && newSummary.length >= MIN_SUMMARY_LENGTH) {
        // Update record
        records[item.index].summary = newSummary;

        // Also update metadata JSON
        try {
          const metadata = JSON.parse(records[item.index].metadata);
          metadata.summary = newSummary;
          records[item.index].metadata = JSON.stringify(metadata);
        } catch (e) {
          console.warn(`  ⚠️ Failed to update metadata JSON`);
        }

        console.log(`  ✅ Generated (${newSummary.length} chars): ${newSummary.substring(0, 60)}...`);
        successCount++;
      } else {
        console.log(`  ⚠️ Generated summary too short, keeping original`);
        failCount++;
      }

      // Rate limiting
      if (i < shortSummaries.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ❌ Error: ${errorMsg}`);
      failCount++;
    }
  }

  // Write updated CSV
  console.log('\n💾 Saving updated CSV...');
  const output = stringify(records, {
    header: true,
    columns: ['file_path', 'metadata', 'summary'],
  });
  await fs.writeFile(CSV_PATH, output, 'utf-8');
  console.log(`✅ Updated ${CSV_PATH}`);

  // Summary
  console.log('\n✨ Regeneration complete!');
  console.log(`\nResults:`);
  console.log(`  ✅ Successful: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  📊 Total processed: ${shortSummaries.length}`);
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
