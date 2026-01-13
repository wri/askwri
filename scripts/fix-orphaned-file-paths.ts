/**
 * Fix Orphaned File Path References
 * Updates CSV file_path column for doc_X.pdf entries to point to actual PDF filenames
 * Downloads missing PDFs where needed
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import https from 'https';
import { createWriteStream } from 'fs';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const BACKUP_PATH = path.join(process.cwd(), 'data', 'documents.csv.backup-filepath-fix');
const DOCS_DIR = path.join(process.cwd(), 'data', 'documents');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

async function downloadPDF(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        if (response.headers.location) {
          downloadPDF(response.headers.location, destPath).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath).catch(() => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('🔧 Fixing orphaned file path references...\n');

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

  console.log(`📖 Processing ${records.length} documents\n`);

  // 3. Find and fix orphaned entries
  let fixedCount = 0;
  let downloadedCount = 0;
  const fixes: Array<{ old: string; new: string; status: string }> = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];

    // Only process orphaned doc_X.pdf entries
    if (!row.file_path.match(/^doc_\d{1,2}\.pdf$/)) continue;

    try {
      const metadata = JSON.parse(row.metadata);
      const url = metadata['Source URL'] || metadata['URL'] || '';

      if (!url) {
        fixes.push({ old: row.file_path, new: row.file_path, status: '⚠️  No URL' });
        continue;
      }

      // Extract filename from URL
      const urlFilename = url.split('/').pop()?.split('?')[0] || '';
      if (!urlFilename) {
        fixes.push({ old: row.file_path, new: row.file_path, status: '⚠️  Invalid URL' });
        continue;
      }

      const actualPath = path.join(DOCS_DIR, urlFilename);

      // Check if PDF exists
      try {
        await fs.access(actualPath);
        // PDF exists, update CSV reference
        records[i].file_path = urlFilename;
        fixedCount++;
        fixes.push({ old: row.file_path, new: urlFilename, status: '✅ Fixed' });
      } catch {
        // PDF doesn't exist, try to download
        console.log(`📥 Downloading ${urlFilename}...`);
        try {
          await downloadPDF(url, actualPath);
          records[i].file_path = urlFilename;
          fixedCount++;
          downloadedCount++;
          fixes.push({ old: row.file_path, new: urlFilename, status: '✅ Downloaded' });
          console.log(`   ✅ Success\n`);

          // Rate limit downloads
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err: any) {
          fixes.push({ old: row.file_path, new: urlFilename, status: `❌ Download failed: ${err.message}` });
          console.log(`   ❌ Failed: ${err.message}\n`);
        }
      }
    } catch (err) {
      fixes.push({ old: row.file_path, new: row.file_path, status: '❌ Parse error' });
    }
  }

  // 4. Show results
  console.log('\n📋 File path fixes:\n');
  fixes.forEach((fix, idx) => {
    console.log(`${idx + 1}. ${fix.old}`);
    console.log(`   → ${fix.new}`);
    console.log(`   ${fix.status}`);
    console.log();
  });

  // 5. Write updated CSV
  if (fixedCount > 0) {
    console.log('💾 Writing updated CSV...');
    const output = stringify(records, {
      header: true,
      columns: ['file_path', 'metadata', 'summary'],
    });
    await fs.writeFile(CSV_PATH, output, 'utf-8');
    console.log(`✅ Updated ${CSV_PATH}\n`);
  }

  // 6. Summary
  console.log('✨ File path fix complete!\n');
  console.log(`Summary:`);
  console.log(`  - Fixed: ${fixedCount}`);
  console.log(`  - Downloaded: ${downloadedCount}`);
  console.log(`  - Failed: ${fixes.filter(f => f.status.startsWith('❌')).length}`);

  if (fixedCount > 0) {
    console.log('\nNext steps:');
    console.log('  1. Generate proper summaries for these documents');
    console.log('  2. Restart hybrid service to rebuild index');
    console.log('  3. Verify search quality');
  }
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
