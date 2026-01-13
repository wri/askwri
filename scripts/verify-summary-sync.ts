/**
 * Verify Summary Synchronization
 * Checks that summary column and metadata.summary are in sync for all documents
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

async function main() {
  console.log('🔍 Verifying summary synchronization...\n');

  // Read CSV
  const csvContent = await fs.readFile(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  }) as CSVRow[];

  console.log(`📖 Checking ${records.length} documents\n`);

  let inSyncCount = 0;
  let outOfSyncCount = 0;
  let metadataOnlyCount = 0;
  let columnOnlyCount = 0;
  let bothEmptyCount = 0;
  let bothPresentCount = 0;

  const issues: Array<{
    doc: string;
    issue: string;
    columnSummary: string;
    metadataSummary: string;
  }> = [];

  for (const record of records) {
    const doc = record.file_path;
    const columnSummary = (record.summary || '').trim();

    let metadataSummary = '';
    try {
      const metadata = JSON.parse(record.metadata);
      metadataSummary = (metadata.summary || '').trim();
    } catch (e) {
      issues.push({
        doc,
        issue: 'Invalid metadata JSON',
        columnSummary,
        metadataSummary: 'N/A'
      });
      outOfSyncCount++;
      continue;
    }

    // Check various sync states
    const hasColumn = columnSummary.length > 0;
    const hasMetadata = metadataSummary.length > 0;

    if (!hasColumn && !hasMetadata) {
      // Both empty - technically in sync
      bothEmptyCount++;
      inSyncCount++;
    } else if (hasColumn && hasMetadata) {
      // Both present - check if identical
      if (columnSummary === metadataSummary) {
        bothPresentCount++;
        inSyncCount++;
      } else {
        // Out of sync - different values
        issues.push({
          doc,
          issue: 'Different values',
          columnSummary: columnSummary.substring(0, 100),
          metadataSummary: metadataSummary.substring(0, 100)
        });
        outOfSyncCount++;
      }
    } else if (hasColumn && !hasMetadata) {
      // Only in column
      issues.push({
        doc,
        issue: 'Column has summary, metadata missing',
        columnSummary: columnSummary.substring(0, 100),
        metadataSummary: '(empty)'
      });
      columnOnlyCount++;
      outOfSyncCount++;
    } else if (!hasColumn && hasMetadata) {
      // Only in metadata
      issues.push({
        doc,
        issue: 'Metadata has summary, column missing',
        columnSummary: '(empty)',
        metadataSummary: metadataSummary.substring(0, 100)
      });
      metadataOnlyCount++;
      outOfSyncCount++;
    }
  }

  // Report results
  console.log('📊 Summary Synchronization Report\n');
  console.log(`✅ In Sync: ${inSyncCount}/${records.length} (${((inSyncCount/records.length)*100).toFixed(1)}%)`);
  console.log(`   - Both empty: ${bothEmptyCount}`);
  console.log(`   - Both present and identical: ${bothPresentCount}`);
  console.log('');
  console.log(`❌ Out of Sync: ${outOfSyncCount}/${records.length} (${((outOfSyncCount/records.length)*100).toFixed(1)}%)`);
  console.log(`   - Column only (metadata missing): ${columnOnlyCount}`);
  console.log(`   - Metadata only (column missing): ${metadataOnlyCount}`);
  console.log(`   - Different values: ${outOfSyncCount - columnOnlyCount - metadataOnlyCount}`);
  console.log('');

  if (issues.length > 0) {
    console.log('⚠️  Issues Found:\n');

    // Show first 10 issues
    issues.slice(0, 10).forEach((issue, idx) => {
      console.log(`${idx + 1}. ${issue.doc}`);
      console.log(`   Issue: ${issue.issue}`);
      console.log(`   Column:   "${issue.columnSummary}${issue.columnSummary.length >= 100 ? '...' : ''}"`);
      console.log(`   Metadata: "${issue.metadataSummary}${issue.metadataSummary.length >= 100 ? '...' : ''}"`);
      console.log('');
    });

    if (issues.length > 10) {
      console.log(`   ... and ${issues.length - 10} more issues\n`);
    }

    // Save detailed report
    const reportPath = path.join(process.cwd(), 'summary-sync-issues.json');
    await fs.writeFile(reportPath, JSON.stringify(issues, null, 2), 'utf-8');
    console.log(`📄 Detailed report saved to: ${reportPath}\n`);

    console.log('🔧 Recommendation:');
    if (columnOnlyCount > 0 || metadataOnlyCount > 0 || (outOfSyncCount - columnOnlyCount - metadataOnlyCount) > 0) {
      console.log('   Run sync script to fix out-of-sync summaries');
    }
  } else {
    console.log('✨ All summaries are in sync!');
  }

  console.log('');
  console.log('📌 Note: Hybrid service uses the SEPARATE summary column (not metadata.summary)');
  console.log('   So as long as the column has content, retrieval will work correctly.');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
