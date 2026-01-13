/**
 * Sync Summary Fields
 * Copies summary from column to metadata.summary for out-of-sync documents
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const BACKUP_PATH = path.join(process.cwd(), 'data', 'documents.csv.backup-sync');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

async function main() {
  console.log('🔄 Syncing summary fields...\n');

  // 1. Backup
  console.log('📦 Creating backup...');
  await fs.copyFile(CSV_PATH, BACKUP_PATH);
  console.log(`✅ Backup created: ${BACKUP_PATH}\n`);

  // 2. Read CSV
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];

  console.log(`📖 Processing ${records.length} documents\n`);

  let syncedCount = 0;
  const synced: string[] = [];

  // 3. Sync summaries
  for (const record of records) {
    const columnSummary = (record.summary || '').trim();

    try {
      const metadata = JSON.parse(record.metadata);
      const metadataSummary = (metadata.summary || '').trim();

      // Only sync if column has content but metadata doesn't, or they differ
      if (columnSummary && (!metadataSummary || metadataSummary !== columnSummary)) {
        metadata.summary = columnSummary;
        record.metadata = JSON.stringify(metadata);
        syncedCount++;
        synced.push(record.file_path);
      }
    } catch (e) {
      console.warn(`⚠️  Skipping ${record.file_path}: Invalid metadata JSON`);
    }
  }

  // 4. Write updated CSV
  if (syncedCount > 0) {
    console.log('💾 Writing updated CSV...');
    const output = stringify(records, {
      header: true,
      columns: ['file_path', 'metadata', 'summary'],
    });
    await fs.writeFile(CSV_PATH, output, 'utf-8');
    console.log(`✅ Updated ${CSV_PATH}\n`);
  }

  // 5. Report
  console.log('✨ Synchronization complete!\n');
  console.log(`Summary:`);
  console.log(`  - Total documents: ${records.length}`);
  console.log(`  - Synced: ${syncedCount}`);
  console.log(`  - Skipped (already in sync): ${records.length - syncedCount}`);

  if (syncedCount > 0) {
    console.log('\n📋 Synced documents (first 10):');
    synced.slice(0, 10).forEach((doc, idx) => {
      console.log(`  ${idx + 1}. ${doc}`);
    });
    if (synced.length > 10) {
      console.log(`  ... and ${synced.length - 10} more`);
    }

    console.log('\n✅ All summaries are now in sync!');
    console.log('\nNext steps:');
    console.log('  1. Run verify-summary-sync.ts to confirm');
    console.log('  2. Restart hybrid service to rebuild index');
  } else {
    console.log('\n✅ All summaries were already in sync!');
  }
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
