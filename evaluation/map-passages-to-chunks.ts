/**
 * Map text passages to chunk IDs in the hybrid service index.
 *
 * This script bridges the gap between human-validated text passages
 * and the chunk_ids used by the retrieval eval. It reads a golden set
 * file (with or without chunk_ids), queries the hybrid service to find
 * matching chunks, and outputs an updated golden set with chunk_ids populated.
 *
 * Usage:
 *   npx tsx evaluation/map-passages-to-chunks.ts [--input path] [--output path] [--remap]
 *
 * Modes:
 *   Default:  Map passages that are missing chunk_ids
 *   --remap:  Re-map ALL passages (use after chunking params change)
 *
 * Input format: answer-golden-dataset.json (text_snippet required, chunk_id optional)
 * Output: same format with chunk_ids populated/updated
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPythonService, callPythonService, PYTHON_SERVICE_URL } from './lib/service-client';
import type { AnswerGoldenDataset, ExpectedPassage } from './lib/types';

// --- Text overlap matching ---

/**
 * Calculate the longest common substring ratio between two texts.
 * Returns a score in [0, 1] where 1 = perfect overlap.
 */
function textOverlapScore(a: string, b: string): number {
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();

  if (!aLower || !bLower) return 0;

  // For short texts, use simple inclusion check
  if (aLower.length < 50 || bLower.length < 50) {
    if (aLower.includes(bLower) || bLower.includes(aLower)) return 1.0;
  }

  // Calculate word-level overlap (Jaccard-like)
  const aWords = new Set(aLower.split(/\s+/).filter(w => w.length > 2));
  const bWords = new Set(bLower.split(/\s+/).filter(w => w.length > 2));

  if (aWords.size === 0 || bWords.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection++;
  }

  const union = aWords.size + bWords.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;

  // Also check for substring containment (handles partial chunks)
  const shorter = aLower.length < bLower.length ? aLower : bLower;
  const longer = aLower.length < bLower.length ? bLower : aLower;
  const containment = longer.includes(shorter) ? 1.0 : 0;

  // Return the better of the two scores
  return Math.max(jaccard, containment);
}

// --- Chunk matching ---

interface ChunkMatch {
  chunk_id: string;
  doc_id: string;
  page: number;
  chunk_text: string;
  overlap_score: number;
}

/**
 * Find the best matching chunk(s) for a text snippet within a specific document.
 *
 * Strategy:
 * 1. Query the hybrid service with the snippet as the query
 * 2. Filter to chunks from the target doc_id
 * 3. Score each by text overlap with the snippet
 * 4. Return the best match(es)
 */
async function findMatchingChunks(
  textSnippet: string,
  docId: string,
  topK: number = 3,
): Promise<ChunkMatch[]> {
  // Query with the snippet text to find relevant chunks
  const rawDocs = await callPythonService(textSnippet, 'answer', {
    vector_top_k: 200,   // Cast wide net
    bm25_top_k: 200,
    rerank_top_n: 50,
    max_results: 100,
  });

  // Filter to chunks from the target document
  const docChunks = rawDocs.filter(d => d.doc_id === docId);

  if (docChunks.length === 0) {
    // Try a broader search with cite mode
    const citeDocs = await callPythonService(textSnippet, 'cite', {
      vector_top_k: 500,
      bm25_top_k: 500,
      rerank_top_n: 100,
      max_results: 200,
    });
    const citeDocChunks = citeDocs.filter(d => d.doc_id === docId);

    if (citeDocChunks.length === 0) {
      return [];
    }

    return scoreAndRank(citeDocChunks, textSnippet, topK);
  }

  return scoreAndRank(docChunks, textSnippet, topK);
}

function scoreAndRank(
  chunks: { doc_id: string; content: string; metadata: Record<string, any>; page?: number }[],
  textSnippet: string,
  topK: number,
): ChunkMatch[] {
  const scored = chunks.map(chunk => ({
    chunk_id: chunk.metadata?.chunk_id || 'unknown',
    doc_id: chunk.doc_id,
    page: chunk.page || chunk.metadata?.page || 1,
    chunk_text: chunk.content,
    overlap_score: textOverlapScore(textSnippet, chunk.content),
  }));

  // Sort by overlap score descending
  scored.sort((a, b) => b.overlap_score - a.overlap_score);

  return scored.slice(0, topK);
}

// --- Main mapping logic ---

async function mapPassagesToChunks(
  inputPath: string,
  outputPath: string,
  remap: boolean,
): Promise<void> {
  // Load golden set
  const golden: AnswerGoldenDataset = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  console.log(`Loaded ${golden.test_cases.length} test cases from ${inputPath}`);
  console.log(`Mode: ${remap ? 'REMAP all passages' : 'Map unmapped passages only'}\n`);

  let mapped = 0;
  let skipped = 0;
  let failed = 0;

  for (const tc of golden.test_cases) {
    console.log(`\n--- ${tc.id}: ${tc.question.slice(0, 60)}... ---`);

    for (let i = 0; i < tc.retrieval_ground_truth.expected_passages.length; i++) {
      const passage = tc.retrieval_ground_truth.expected_passages[i];

      // Skip if already has chunk_id and not in remap mode
      if (passage.chunk_id && !remap) {
        console.log(`  [${i}] Already mapped: ${passage.chunk_id} (score N/A)`);
        skipped++;
        continue;
      }

      if (!passage.text_snippet || passage.text_snippet === 'STUB') {
        console.log(`  [${i}] No text_snippet to match, skipping`);
        skipped++;
        continue;
      }

      // Find matching chunks
      const matches = await findMatchingChunks(passage.text_snippet, passage.doc_id);

      if (matches.length === 0) {
        console.log(`  [${i}] No chunks found for doc ${passage.doc_id}`);
        failed++;
        continue;
      }

      const best = matches[0];
      console.log(`  [${i}] Best match: ${best.chunk_id} (overlap: ${(best.overlap_score * 100).toFixed(1)}%)`);

      if (best.overlap_score < 0.3) {
        console.log(`  [${i}] WARNING: Low overlap score. Review manually.`);
        console.log(`    Snippet: "${passage.text_snippet.slice(0, 80)}..."`);
        console.log(`    Chunk:   "${best.chunk_text.slice(0, 80)}..."`);
      }

      // Update the passage with the matched chunk_id
      passage.chunk_id = best.chunk_id;
      if (!passage.page || remap) {
        passage.page = best.page;
      }

      mapped++;

      // Show alternatives if close
      if (matches.length > 1 && matches[1].overlap_score > 0.5) {
        console.log(`    Alt: ${matches[1].chunk_id} (overlap: ${(matches[1].overlap_score * 100).toFixed(1)}%)`);
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Write output
  fs.writeFileSync(outputPath, JSON.stringify(golden, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('PASSAGE-TO-CHUNK MAPPING COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Mapped:  ${mapped}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`\n  Output: ${outputPath}`);

  if (failed > 0) {
    console.log(`\n  WARNING: ${failed} passages could not be mapped.`);
    console.log('  These may need manual chunk_id assignment.');
  }
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  const inputIdx = args.indexOf('--input');
  const outputIdx = args.indexOf('--output');
  const remap = args.includes('--remap');

  const defaultPath = path.join(__dirname, 'answer-golden-dataset.json');
  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : defaultPath;
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : inputPath; // overwrite by default

  // Check service
  console.log(`Checking hybrid service at ${PYTHON_SERVICE_URL}...`);
  const available = await checkPythonService();
  if (!available) {
    console.error(`Hybrid service not available at ${PYTHON_SERVICE_URL}`);
    console.error('Start with: npm run start:all');
    process.exit(1);
  }
  console.log('Service is running\n');

  await mapPassagesToChunks(inputPath, outputPath, remap);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
