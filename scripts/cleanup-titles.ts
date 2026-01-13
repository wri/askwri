/**
 * Title Cleanup Script
 *
 * Fixes common title quality issues:
 * 1. Citation format: "Author et al. - Year - Title" → "Title"
 * 2. Filename artifacts: underscores, extensions
 * 3. Truncated titles
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const BACKUP_PATH = path.join(process.cwd(), 'data', 'documents.csv.backup-titles');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

/**
 * Clean a title using pattern-based rules
 */
function cleanTitle(title: string): { cleaned: string; method: string; needsLLM: boolean } {
  if (!title || !title.trim()) {
    return { cleaned: title, method: 'empty', needsLLM: true };
  }

  let cleaned = title.trim();
  let method = 'none';
  let needsLLM = false;

  // Pattern 1: Citation format "Author(s) et al. - Year - Title"
  // Example: "Bahadur and Tanner - 2014 - Transformational resilience thinking..."
  const citationPattern = /^(.+?)\s+-\s+(19|20)\d{2}\s+-\s+(.+)$/;
  const citationMatch = cleaned.match(citationPattern);
  if (citationMatch) {
    const authors = citationMatch[1];
    const titlePart = citationMatch[3];

    // Only clean if it looks like authors (has "and", "et al", or semicolons)
    if (/\bet al\b|;|\band\b/.test(authors)) {
      cleaned = titlePart.trim();
      method = 'citation-format';
    }
  }

  // Pattern 2: Underscores (filename artifacts)
  // Example: "Future_Mobility_Calculator_Abstract"
  if (cleaned.includes('_')) {
    cleaned = cleaned.replace(/_/g, ' ');
    method = method === 'none' ? 'underscore' : method + '+underscore';
  }

  // Pattern 3: Remove "_final", "_v1", etc. suffixes
  cleaned = cleaned.replace(/\s*_?(final|draft|v\d+|version\d+)\s*$/i, '');

  // Pattern 4: Truncated titles (ends with "...")
  if (cleaned.endsWith('...')) {
    needsLLM = true;
    method = method === 'none' ? 'truncated' : method + '+truncated';
  }

  // Pattern 5: Very short titles (likely filename stubs)
  if (cleaned.length < 15 && !cleaned.includes(':')) {
    needsLLM = true;
    method = method === 'none' ? 'too-short' : method;
  }

  // Pattern 6: Title proper capitalization for ALL CAPS (but skip Chinese/non-Latin)
  if (cleaned === cleaned.toUpperCase() && /^[A-Z\s:]+$/.test(cleaned) && cleaned.length > 20) {
    cleaned = cleaned.toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
    method = method === 'none' ? 'caps-fix' : method + '+caps-fix';
  }

  return { cleaned, method, needsLLM };
}

async function main() {
  console.log('🧹 Starting title cleanup...\n');

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

  // 3. Clean titles
  console.log('🧼 Cleaning titles...');
  let cleanedCount = 0;
  let needsLLMCount = 0;
  const changes: Array<{ file: string; before: string; after: string; method: string }> = [];
  const needsLLM: Array<{ file: string; title: string; reason: string }> = [];

  for (const record of records) {
    try {
      const metadata = JSON.parse(record.metadata);
      const originalTitle = metadata['Article Title'] || '';

      const { cleaned, method, needsLLM: requiresLLM } = cleanTitle(originalTitle);

      if (originalTitle !== cleaned) {
        cleanedCount++;
        changes.push({
          file: record.file_path,
          before: originalTitle.substring(0, 80),
          after: cleaned.substring(0, 80),
          method,
        });

        // Update metadata
        metadata['Article Title'] = cleaned;
        record.metadata = JSON.stringify(metadata);
      }

      if (requiresLLM) {
        needsLLMCount++;
        needsLLM.push({
          file: record.file_path,
          title: cleaned || originalTitle,
          reason: method || 'ambiguous',
        });
      }
    } catch (error) {
      console.error(`Error processing ${record.file_path}:`, error);
    }
  }

  console.log(`✅ Cleaned ${cleanedCount} titles via pattern matching`);
  console.log(`⚠️  Found ${needsLLMCount} titles needing LLM extraction\n`);

  // 4. Show sample changes
  if (changes.length > 0) {
    console.log('📝 Pattern-based changes (first 10):');
    changes.slice(0, 10).forEach((change, idx) => {
      console.log(`\n${idx + 1}. ${change.file} [Method: ${change.method}]`);
      console.log(`   Before: "${change.before}${change.before.length >= 80 ? '...' : ''}"`);
      console.log(`   After:  "${change.after}${change.after.length >= 80 ? '...' : ''}"`);
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

  // 6. Report titles needing LLM extraction
  if (needsLLM.length > 0) {
    console.log('📋 Titles needing LLM extraction:');
    needsLLM.slice(0, 10).forEach((item, idx) => {
      console.log(`${idx + 1}. ${item.file}`);
      console.log(`   Current: "${item.title.substring(0, 70)}${item.title.length > 70 ? '...' : ''}"`);
      console.log(`   Reason: ${item.reason}`);
    });
    if (needsLLM.length > 10) {
      console.log(`   ... and ${needsLLM.length - 10} more`);
    }
    console.log('');
  }

  console.log('✨ Pattern-based cleanup complete!\n');
  console.log(`Summary:`);
  console.log(`  - Total documents: ${records.length}`);
  console.log(`  - Titles cleaned (pattern): ${cleanedCount}`);
  console.log(`  - Titles needing LLM: ${needsLLMCount}`);
  console.log(`  - Backup saved: ${BACKUP_PATH}`);
  console.log('\nNext step: Run LLM extraction for remaining titles');
}

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
