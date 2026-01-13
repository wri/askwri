/**
 * LLM Title Extraction Script
 * Uses OpenAI to extract proper titles from PDFs with filename-based titles
 */

import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { extractTitle, needsTitleExtraction } from '../src/lib/title-extractor';

const CSV_PATH = path.join(process.cwd(), 'data', 'documents.csv');
const DOCS_DIR = path.join(process.cwd(), 'data', 'documents');

interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

async function main() {
  console.log('🤖 Starting LLM title extraction...\n');

  // Check OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY not found in environment');
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

  // 2. Find documents with problematic titles
  console.log('🔍 Finding documents needing title extraction...');
  const needsExtraction: Array<{
    index: number;
    file: string;
    pdfPath: string;
    currentTitle: string;
    row: CSVRow;
  }> = [];

  for (let i = 0; i < records.length; i++) {
    try {
      const metadata = JSON.parse(records[i].metadata);
      const title = metadata['Article Title'] || '';

      if (needsTitleExtraction(title)) {
        const pdfPath = path.join(DOCS_DIR, records[i].file_path);

        // Check if PDF exists
        try {
          await fs.access(pdfPath);
          needsExtraction.push({
            index: i,
            file: records[i].file_path,
            pdfPath,
            currentTitle: title,
            row: records[i],
          });
        } catch (e) {
          console.warn(`⚠️  PDF not found: ${pdfPath}`);
        }
      }
    } catch (e) {
      console.warn(`⚠️  Failed to parse metadata for ${records[i].file_path}`);
    }
  }

  console.log(`✅ Found ${needsExtraction.length} documents needing title extraction\n`);

  if (needsExtraction.length === 0) {
    console.log('✨ All titles look good!');
    return;
  }

  // 3. Show what we're about to process
  console.log('📋 Documents to process:');
  needsExtraction.forEach((doc, idx) => {
    console.log(`${idx + 1}. ${doc.file}`);
    console.log(`   Current: "${doc.currentTitle}"`);
  });
  console.log('');

  // Estimate cost
  const estimatedCost = needsExtraction.length * 0.01; // ~$0.01 per extraction
  console.log(`💰 Estimated cost: ~$${estimatedCost.toFixed(2)} (using ${MODEL})\n`);

  // 4. Ask for confirmation
  console.log('⏸️  Press Enter to continue or Ctrl+C to cancel...');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });

  // 5. Extract titles
  console.log('\n🚀 Extracting titles...\n');

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < needsExtraction.length; i++) {
    const doc = needsExtraction[i];
    const progress = `[${i + 1}/${needsExtraction.length}] (${Math.round((i + 1) / needsExtraction.length * 100)}%)`;

    console.log(`${progress} Processing ${doc.file}...`);

    try {
      const newTitle = await extractTitle(doc.pdfPath, doc.currentTitle);

      // Update metadata
      const metadata = JSON.parse(records[doc.index].metadata);
      metadata['Article Title'] = newTitle;
      records[doc.index].metadata = JSON.stringify(metadata);

      successCount++;
      console.log(`✅ "${newTitle.substring(0, 70)}${newTitle.length > 70 ? '...' : ''}"`);

      // Rate limiting
      if (i < needsExtraction.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error: any) {
      failCount++;
      console.log(`❌ Failed: ${error.message}`);
    }
  }

  // 6. Write updated CSV
  console.log('\n💾 Updating CSV...');
  const output = stringify(records, {
    header: true,
    columns: ['file_path', 'metadata', 'summary'],
  });
  await fs.writeFile(CSV_PATH, output, 'utf-8');
  console.log(`✅ Updated ${CSV_PATH}`);

  // 7. Summary
  console.log('\n✨ Title extraction complete!\n');
  console.log(`Results:`);
  console.log(`  - Successful: ${successCount}`);
  console.log(`  - Failed: ${failCount}`);
  console.log(`  - Total processed: ${needsExtraction.length}`);

  console.log('\nNext steps:');
  console.log('  1. Review extracted titles in the CSV');
  console.log('  2. Restart hybrid service to rebuild index');
}

const MODEL = process.env.OPENAI_MODEL_SUMMARY || 'gpt-4o-mini';

main().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
