/**
 * Document-Level Retrieval Analysis
 *
 * Identifies which documents are systematically hard to retrieve:
 * - Documents missing from multiple queries
 * - Document characteristics (length, metadata quality, chunk count)
 * - Chunk-level analysis (which chunks are retrieved vs missed)
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

interface DocumentInfo {
  title: string;
  queriesMissedIn: string[];
  queriesFoundIn: string[];
  totalQueries: number;
  retrievalRate: number;
  avgVectorRank?: number;
  avgBM25Rank?: number;
  avgFusionRank?: number;
  avgRerankScore?: number;
}

interface ChunkAnalysis {
  docTitle: string;
  totalChunks: number;
  chunksRetrieved: number;
  chunkRetrievalRate: number;
  exampleChunks: Array<{
    text: string;
    retrieved: boolean;
    rank?: number;
    score?: number;
  }>;
}

async function loadCatalog(): Promise<any[]> {
  const catalogPath = '/Users/zunix/Documents/GitHub/askwri/mockups/askwri/data/documents.csv';
  const csvContent = fs.readFileSync(catalogPath, 'utf-8');
  const lines = csvContent.split('\n').filter(line => line.trim());
  const headers = lines[0].split(',');

  const docs = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const doc: any = {};
    headers.forEach((header, idx) => {
      doc[header] = values[idx];
    });
    docs.push(doc);
  }
  return docs;
}

async function analyzeDocumentRetrievability(
  docTitle: string,
  queries: string[]
): Promise<DocumentInfo> {
  const queriesMissedIn: string[] = [];
  const queriesFoundIn: string[] = [];
  const vectorRanks: number[] = [];
  const bm25Ranks: number[] = [];
  const fusionRanks: number[] = [];
  const rerankScores: number[] = [];

  for (const query of queries) {
    try {
      const response = await axios.post(
        'http://127.0.0.1:8002/query',
        {
          query_str: query,
          dense_top_k: 500,
          sparse_top_k: 500,
          similarity_top_k: 60,
          return_intermediate_results: true,
        },
        { timeout: 60000 }
      );

      const data = response.data;
      const rerankResults = data.results || data.reranked_results || [];

      let found = false;
      for (let i = 0; i < rerankResults.length; i++) {
        const resultTitle = rerankResults[i].doc_title || rerankResults[i].metadata?.title || '';
        if (normalizeTitle(resultTitle) === normalizeTitle(docTitle)) {
          found = true;
          queriesFoundIn.push(query);
          rerankScores.push(rerankResults[i].score || 0);

          // Check ranks in earlier stages
          const vectorResults = data.vector_results || [];
          const bm25Results = data.bm25_results || [];
          const fusionResults = data.fusion_results || [];

          const vectorRank = findRank(docTitle, vectorResults);
          const bm25Rank = findRank(docTitle, bm25Results);
          const fusionRank = findRank(docTitle, fusionResults);

          if (vectorRank) vectorRanks.push(vectorRank);
          if (bm25Rank) bm25Ranks.push(bm25Rank);
          if (fusionRank) fusionRanks.push(fusionRank);

          break;
        }
      }

      if (!found) {
        queriesMissedIn.push(query);
      }
    } catch (error) {
      console.error(`Error querying for "${query}":`, error);
    }
  }

  return {
    title: docTitle,
    queriesMissedIn,
    queriesFoundIn,
    totalQueries: queries.length,
    retrievalRate: queriesFoundIn.length / queries.length,
    avgVectorRank: vectorRanks.length > 0 ? vectorRanks.reduce((a, b) => a + b, 0) / vectorRanks.length : undefined,
    avgBM25Rank: bm25Ranks.length > 0 ? bm25Ranks.reduce((a, b) => a + b, 0) / bm25Ranks.length : undefined,
    avgFusionRank: fusionRanks.length > 0 ? fusionRanks.reduce((a, b) => a + b, 0) / fusionRanks.length : undefined,
    avgRerankScore: rerankScores.length > 0 ? rerankScores.reduce((a, b) => a + b, 0) / rerankScores.length : undefined,
  };
}

function findRank(docTitle: string, results: any[]): number | null {
  for (let i = 0; i < results.length; i++) {
    const resultTitle = results[i].doc_title || results[i].metadata?.title || '';
    if (normalizeTitle(resultTitle) === normalizeTitle(docTitle)) {
      return i + 1;
    }
  }
  return null;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/[^\w\s]/g, '');
}

async function analyzeChunkRetrievability(
  docTitle: string,
  query: string
): Promise<ChunkAnalysis> {
  // This would require access to the hybrid service's chunk data
  // For now, return a placeholder
  return {
    docTitle,
    totalChunks: 0,
    chunksRetrieved: 0,
    chunkRetrievalRate: 0,
    exampleChunks: [],
  };
}

async function main() {
  console.log('🔍 Document-Level Retrieval Analysis\n');

  // Critical missing documents from eval results
  const criticalDocs = [
    'Driving Forward: Clean Ride for Kids',
    'Improving School Infrastructure',
    'Ahmedabad Town Planning Schemes',
    'Rail+Property Development China',
    'Bangalore Metro System Report',
    'Bangalore Traffic Management',
  ];

  // Representative queries
  const testQueries = [
    'land value capture transport infrastructure',
    'Bangalore transportation urban mobility',
    'children air pollution health impacts school',
    'climate change adaptation Brazil urban transport',
    'micromobility e-scooters bike-sharing dockless',
    'school bus health benefits air quality children',
  ];

  console.log('Analyzing critical missing documents...\n');

  const results: DocumentInfo[] = [];

  for (const doc of criticalDocs) {
    console.log(`📄 Analyzing: ${doc}`);
    const info = await analyzeDocumentRetrievability(doc, testQueries);
    results.push(info);
    console.log(`   Retrieval rate: ${(info.retrievalRate * 100).toFixed(0)}%`);
    console.log(`   Found in: ${info.queriesFoundIn.length}/${info.totalQueries} queries`);
    if (info.avgVectorRank) console.log(`   Avg vector rank: ${info.avgVectorRank.toFixed(0)}`);
    if (info.avgBM25Rank) console.log(`   Avg BM25 rank: ${info.avgBM25Rank.toFixed(0)}`);
    if (info.avgFusionRank) console.log(`   Avg fusion rank: ${info.avgFusionRank.toFixed(0)}`);
    console.log('');
  }

  // Summary
  console.log('\n📊 SUMMARY');
  console.log('='.repeat(80));

  const sortedByRetrievability = results.sort((a, b) => a.retrievalRate - b.retrievalRate);

  console.log('\n🔴 HARDEST TO RETRIEVE (lowest retrieval rate):');
  sortedByRetrievability.slice(0, 3).forEach(doc => {
    console.log(`   ${doc.title}: ${(doc.retrievalRate * 100).toFixed(0)}%`);
    if (doc.queriesMissedIn.length > 0) {
      console.log(`      Missed in: ${doc.queriesMissedIn.slice(0, 2).join(', ')}...`);
    }
  });

  console.log('\n🟢 EASIEST TO RETRIEVE (highest retrieval rate):');
  sortedByRetrievability.slice(-3).forEach(doc => {
    console.log(`   ${doc.title}: ${(doc.retrievalRate * 100).toFixed(0)}%`);
  });

  // Save results
  const outputPath = `/Users/zunix/Documents/GitHub/askwri/mockups/askwri/evaluation/results/document-analysis-${Date.now()}.json`;
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${outputPath}`);
}

main().catch(console.error);
