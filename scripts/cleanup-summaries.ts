/**
 * Cleanup Script for Document Summaries
 *
 * Fixes existing summary quality issues in documents.csv:
 * 1. Strips "Synopsis", "Main Findings", "Key Messages" prefixes
 * 2. Trims whitespace
 * 3. Reports on empty summaries
 * 4. Backs up original CSV before making changes
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const BACKUP_PATH = path.join(process.cwd(), 'data', 'documents.csv.backup');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

/**
 * Clean a summary by removing prefixes and normalizing
 */
function cleanSummary(summary: string): string {
  if (!summary || !summary.trim()) {
    return '';
  }

  let cleaned = summary.trim();

  // Remove common prefixes (case-insensitive, handles no-space variants)
  const prefixPattern = /^(Synopsis|Main Findings|Key Messages?|Key Points?|Introduction|Chapter|Section)\s*/i;
  cleaned = cleaned.replace(prefixPattern, '');

  // Handle edge case where "Synopsis" has no space after it
  if (/^Synopsis[A-Z]/.test(summary)) {
    cleaned = summary.substring(8); // Remove exactly "Synopsis" (8 chars)
  }

  // Trim again after removal
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Update metadata JSON with cleaned summary
 */
function updateMetadataSummary(metadataJson: string, cleanedSummary: string): string {
  try {
    const metadata = JSON.parse(metadataJson);

    // Update summary in metadata if it exists
    if (metadata.summary) {
      metadata.summary = cleanedSummary;
    }

    return JSON.stringify(metadata);
  } catch (e) {
    console.error('Failed to parse metadata JSON:', e);
    return metadataJson; // Return original if parsing fails
  }
}

async function main() {
  console.log('🧹 Starting summary cleanup...\n');

  // 1. Backup original CSV
  console.log('📦 Creating backup...');
  await fs.copyFile(CSV_PATH, BACKUP_PATH);
  console.log(`✅ Backup created: ${BACKUP_PATH}\n`);

  // 2. Read CSV
  console.log('📖 Reading CSV...');
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];
  console.log(`✅ Read ${records.length} documents\n`);

  // 3. Clean summaries
  console.log('🧼 Cleaning summaries...');
  let cleanedCount = 0;
  let emptyCount = 0;
  const changes: Array<{ file: string; before: string; after: string }> = [];

  for (const record of records) {
    const original = record.summary || '';
    const cleaned = cleanSummary(original);

    if (!cleaned) {
      emptyCount++;
    }

    if (original !== cleaned) {
      cleanedCount++;
      changes.push({
        file: record.file_path,
        before: original.substring(0, 80) + '...',
        after: cleaned.substring(0, 80) + '...',
      });

      // Update both summary column and metadata JSON
      record.summary = cleaned;
      record.metadata = updateMetadataSummary(record.metadata, cleaned);
    }
  }

  console.log(`✅ Cleaned ${cleanedCount} summaries`);
  console.log(`⚠️  Found ${emptyCount} empty summaries (will need LLM generation)\n`);

  // 4. Show sample changes
  if (changes.length > 0) {
    console.log('📝 Sample changes (first 10):');
    changes.slice(0, 10).forEach((change, idx) => {
      console.log(`\n${idx + 1}. ${change.file}`);
      console.log(`   Before: "${change.before}"`);
      console.log(`   After:  "${change.after}"`);
    });
    console.log('');
  }

  // 5. Write cleaned CSV
  console.log('💾 Writing cleaned CSV...');
  const output = stringify(records, {
    header: true,
    columns: ['file_path', 'metadata', 'summary'],
  });
  await fs.writeFile(CSV_PATH, output, 'utf-8');
  console.log(`✅ Updated ${CSV_PATH}\n`);

  // 6. Report empty summaries
  if (emptyCount > 0) {
    console.log('📋 Documents with empty summaries (need LLM generation):');
    records
      .filter(r => !r.summary || !r.summary.trim())
      .slice(0, 15)
      .forEach(r => {
        try {
          const meta = JSON.parse(r.metadata);
          console.log(`   - ${r.file_path}: ${meta['Article Title'] || 'Untitled'}`);
        } catch (e) {
          console.log(`   - ${r.file_path}`);
        }
      });
    if (emptyCount > 15) {
      console.log(`   ... and ${emptyCount - 15} more`);
    }
  }

  console.log('\n✨ Cleanup complete!');
  console.log(`\nSummary:`);
  console.log(`  - Total documents: ${records.length}`);
  console.log(`  - Summaries cleaned: ${cleanedCount}`);
  console.log(`  - Empty summaries remaining: ${emptyCount}`);
  console.log(`  - Backup saved: ${BACKUP_PATH}`);
  console.log('\nNext steps:');
  console.log('  1. Review changes above');
  console.log('  2. Run: npm run dev (to see changes in UI)');
  console.log('  3. Generate summaries for empty ones using LLM generation');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
