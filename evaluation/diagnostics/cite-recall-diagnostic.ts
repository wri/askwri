/**
 * Stage-by-Stage Recall Diagnostic Tool
 *
 * Tracks where each expected document is lost in the retrieval pipeline:
 * Stage 1: Vector search (top-500)
 * Stage 2: BM25 search (top-500)
 * Stage 3: RRF fusion (top-500)
 * Stage 4: Reranking (top-60)
 */

// Using built-in fetch instead of axios

interface DiagnosticResult {
  queryId: string;
  query: string;
  expectedDocs: string[];
  stageRecall: {
    vector: { recall: number; found: string[]; missing: string[] };
    bm25: { recall: number; found: string[]; missing: string[] };
    fusion: { recall: number; found: string[]; missing: string[] };
    rerank: { recall: number; found: string[]; missing: string[] };
  };
  documentAnalysis: Array<{
    docTitle: string;
    foundInVector: boolean;
    foundInBM25: boolean;
    foundInFusion: boolean;
    foundInRerank: boolean;
    vectorRank?: number;
    bm25Rank?: number;
    fusionRank?: number;
    rerankRank?: number;
    vectorScore?: number;
    bm25Score?: number;
    fusionScore?: number;
    rerankScore?: number;
  }>;
}

interface TestCase {
  id: string;
  query: string;
  expectedDocuments: string[];
  description: string;
}

const TEST_CASES: TestCase[] = [
  {
    id: 'q1',
    query: 'land value capture transport infrastructure',
    expectedDocuments: [
      'Financing Sustainable Urban Transport',
      'Business Models for Sustainable Mobility',
      'Ahmedabad Town Planning Schemes',
      'Rail+Property Development China',
    ],
    description: 'Topic area (land value capture)',
  },
  {
    id: 'q2',
    query: 'Bangalore transportation urban mobility',
    expectedDocuments: [
      'Bangalore Cycling Action Plan',
      'Bangalore Metro System Report',
      'Karnataka Urban Transport Study',
      'Bangalore Traffic Management',
      'Bangalore Bus Rapid Transit',
      'Bangalore Road Safety Assessment',
    ],
    description: 'Geography (Bangalore)',
  },
  {
    id: 'q3',
    query: 'children air pollution health impacts school',
    expectedDocuments: [
      'Children Air Quality School Study',
      'Driving Forward: Clean Ride for Kids',
      'Improving School Infrastructure',
    ],
    description: 'Thematic intersection (children+pollution)',
  },
  {
    id: 'q4',
    query: 'climate change adaptation Brazil urban transport',
    expectedDocuments: [
      'Brazil Climate Action Transport',
      'Rio de Janeiro Resilience Strategy',
      'São Paulo Low Carbon Transport',
    ],
    description: 'Thematic+geo (climate+Brazil)',
  },
  {
    id: 'q5',
    query: 'micromobility e-scooters bike-sharing dockless',
    expectedDocuments: [
      'Shared Micromobility Policy Toolkit',
      'E-Scooter Safety Guidelines',
      'Bike-Sharing System Design',
      'Dockless Mobility Regulation',
      'Micromobility Urban Integration',
      'E-Bike Infrastructure Planning',
      'Shared Mobility Market Analysis',
      'Micromobility Environmental Impact',
    ],
    description: 'Fuzzy topic (micromobility)',
  },
  {
    id: 'q6',
    query: 'school bus health benefits air quality children',
    expectedDocuments: [
      'School Bus Electrification Study',
      'Driving Forward: Clean Ride for Kids',
      'Improving School Infrastructure',
    ],
    description: 'Intervention impact (school bus health)',
  },
  {
    id: 'q7',
    query: 'affordable housing transit-oriented development Jakarta',
    expectedDocuments: [
      // Note: Original test case shows 0 expected docs, but 14 false positives
      // Need to verify if this is a test case error or a legitimate zero-result query
    ],
    description: 'Solution-focused (Jakarta housing)',
  },
];

async function queryHybridServiceWithStages(
  query: string,
  returnIntermediateResults: boolean = true
): Promise<any> {
  const response = await fetch(
    'http://127.0.0.1:8000/query',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query,
        mode: 'cite',
        vector_top_k: 500,
        bm25_top_k: 500,
        rerank_top_n: 200,
        max_results: 200,
        return_intermediate_results: returnIntermediateResults,
      }),
    }
  );
  return await response.json();
}

function calculateRecall(found: string[], expected: string[]): number {
  if (expected.length === 0) return 1.0;
  const foundSet = new Set(found.map(normalizeTitle));
  const foundCount = expected.filter(exp => foundSet.has(normalizeTitle(exp))).length;
  return foundCount / expected.length;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/[^\w\s]/g, '');
}

function findDocInResults(docTitle: string, results: any[]): { found: boolean; rank?: number; score?: number } {
  const normalized = normalizeTitle(docTitle);
  for (let i = 0; i < results.length; i++) {
    const resultTitle = results[i].doc_title || results[i].metadata?.title || '';
    if (normalizeTitle(resultTitle) === normalized) {
      return {
        found: true,
        rank: i + 1,
        score: results[i].score || results[i].similarity_score,
      };
    }
  }
  return { found: false };
}

async function runDiagnostic(testCase: TestCase): Promise<DiagnosticResult> {
  console.log(`\n🔍 Running diagnostic for: ${testCase.id} - ${testCase.description}`);
  console.log(`   Query: "${testCase.query}"`);

  const response = await queryHybridServiceWithStages(testCase.query, true);

  // Extract stage results
  const vectorResults = response.vector_results || [];
  const bm25Results = response.bm25_results || [];
  const fusionResults = response.fusion_results || [];
  const rerankResults = response.results || response.reranked_results || [];

  // Calculate stage-by-stage recall
  const getFoundDocs = (results: any[]) => testCase.expectedDocuments.filter(expected => {
      const { found } = findDocInResults(expected, results);
      return found;
    });

  const vectorFound = getFoundDocs(vectorResults);
  const bm25Found = getFoundDocs(bm25Results);
  const fusionFound = getFoundDocs(fusionResults);
  const rerankFound = getFoundDocs(rerankResults);

  const stageRecall = {
    vector: {
      recall: calculateRecall(vectorFound, testCase.expectedDocuments),
      found: vectorFound,
      missing: testCase.expectedDocuments.filter(d => !vectorFound.includes(d)),
    },
    bm25: {
      recall: calculateRecall(bm25Found, testCase.expectedDocuments),
      found: bm25Found,
      missing: testCase.expectedDocuments.filter(d => !bm25Found.includes(d)),
    },
    fusion: {
      recall: calculateRecall(fusionFound, testCase.expectedDocuments),
      found: fusionFound,
      missing: testCase.expectedDocuments.filter(d => !fusionFound.includes(d)),
    },
    rerank: {
      recall: calculateRecall(rerankFound, testCase.expectedDocuments),
      found: rerankFound,
      missing: testCase.expectedDocuments.filter(d => !rerankFound.includes(d)),
    },
  };

  // Document-level analysis
  const documentAnalysis = testCase.expectedDocuments.map(docTitle => {
    const vectorMatch = findDocInResults(docTitle, vectorResults);
    const bm25Match = findDocInResults(docTitle, bm25Results);
    const fusionMatch = findDocInResults(docTitle, fusionResults);
    const rerankMatch = findDocInResults(docTitle, rerankResults);

    return {
      docTitle,
      foundInVector: vectorMatch.found,
      foundInBM25: bm25Match.found,
      foundInFusion: fusionMatch.found,
      foundInRerank: rerankMatch.found,
      vectorRank: vectorMatch.rank,
      bm25Rank: bm25Match.rank,
      fusionRank: fusionMatch.rank,
      rerankRank: rerankMatch.rank,
      vectorScore: vectorMatch.score,
      bm25Score: bm25Match.score,
      fusionScore: fusionMatch.score,
      rerankScore: rerankMatch.score,
    };
  });

  return {
    queryId: testCase.id,
    query: testCase.query,
    expectedDocs: testCase.expectedDocuments,
    stageRecall,
    documentAnalysis,
  };
}

function printDiagnosticReport(results: DiagnosticResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('STAGE-BY-STAGE RECALL DIAGNOSTIC REPORT');
  console.log('='.repeat(80));

  // Overall stage recall
  const avgRecall = {
    vector: results.reduce((sum, r) => sum + r.stageRecall.vector.recall, 0) / results.length,
    bm25: results.reduce((sum, r) => sum + r.stageRecall.bm25.recall, 0) / results.length,
    fusion: results.reduce((sum, r) => sum + r.stageRecall.fusion.recall, 0) / results.length,
    rerank: results.reduce((sum, r) => sum + r.stageRecall.rerank.recall, 0) / results.length,
  };

  console.log('\n📊 AVERAGE RECALL BY STAGE:');
  console.log(`   Vector (top-500):  ${(avgRecall.vector * 100).toFixed(1)}%`);
  console.log(`   BM25 (top-500):    ${(avgRecall.bm25 * 100).toFixed(1)}%`);
  console.log(`   Fusion (top-500):  ${(avgRecall.fusion * 100).toFixed(1)}%`);
  console.log(`   Rerank (top-60):   ${(avgRecall.rerank * 100).toFixed(1)}%`);

  // Identify recall drop stages
  const vectorToBM25Drop = avgRecall.vector - avgRecall.bm25;
  const bm25ToFusionDrop = avgRecall.bm25 - avgRecall.fusion;
  const fusionToRerankDrop = avgRecall.fusion - avgRecall.rerank;

  console.log('\n📉 RECALL DROPS BETWEEN STAGES:');
  console.log(`   Vector → BM25:     ${(vectorToBM25Drop * 100).toFixed(1)}pp`);
  console.log(`   BM25 → Fusion:     ${(bm25ToFusionDrop * 100).toFixed(1)}pp`);
  console.log(`   Fusion → Rerank:   ${(fusionToRerankDrop * 100).toFixed(1)}pp`);

  // Per-query breakdown
  console.log('\n📝 PER-QUERY STAGE RECALL:');
  results.forEach(result => {
    console.log(`\n   ${result.queryId}: ${result.query.substring(0, 50)}...`);
    console.log(`      Vector:  ${(result.stageRecall.vector.recall * 100).toFixed(0)}% (${result.stageRecall.vector.found.length}/${result.expectedDocs.length})`);
    console.log(`      BM25:    ${(result.stageRecall.bm25.recall * 100).toFixed(0)}% (${result.stageRecall.bm25.found.length}/${result.expectedDocs.length})`);
    console.log(`      Fusion:  ${(result.stageRecall.fusion.recall * 100).toFixed(0)}% (${result.stageRecall.fusion.found.length}/${result.expectedDocs.length})`);
    console.log(`      Rerank:  ${(result.stageRecall.rerank.recall * 100).toFixed(0)}% (${result.stageRecall.rerank.found.length}/${result.expectedDocs.length})`);
  });

  // Document-level failures
  console.log('\n🔴 DOCUMENTS NEVER RETRIEVED (absent from Vector AND BM25):');
  const neverRetrieved = new Map<string, number>();
  results.forEach(result => {
    result.documentAnalysis.forEach(doc => {
      if (!doc.foundInVector && !doc.foundInBM25) {
        neverRetrieved.set(doc.docTitle, (neverRetrieved.get(doc.docTitle) || 0) + 1);
      }
    });
  });
  if (neverRetrieved.size > 0) {
    Array.from(neverRetrieved.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([doc, count]) => {
        console.log(`   - ${doc} (${count} queries)`);
      });
  } else {
    console.log('   None! All docs appear in at least one index.');
  }

  // Lost in fusion
  console.log('\n🟡 DOCUMENTS LOST IN FUSION (in Vector OR BM25, but not Fusion):');
  const lostInFusion = new Map<string, number>();
  results.forEach(result => {
    result.documentAnalysis.forEach(doc => {
      if ((doc.foundInVector || doc.foundInBM25) && !doc.foundInFusion) {
        lostInFusion.set(doc.docTitle, (lostInFusion.get(doc.docTitle) || 0) + 1);
      }
    });
  });
  if (lostInFusion.size > 0) {
    Array.from(lostInFusion.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([doc, count]) => {
        console.log(`   - ${doc} (${count} queries)`);
      });
  } else {
    console.log('   None! Fusion preserves all single-index hits.');
  }

  // Lost in reranking
  console.log('\n🟠 DOCUMENTS LOST IN RERANKING (in Fusion, but not Rerank):');
  const lostInRerank = new Map<string, number>();
  results.forEach(result => {
    result.documentAnalysis.forEach(doc => {
      if (doc.foundInFusion && !doc.foundInRerank) {
        lostInRerank.set(
          `${doc.docTitle} (fusion rank: ${doc.fusionRank})`,
          (lostInRerank.get(doc.docTitle) || 0) + 1
        );
      }
    });
  });
  if (lostInRerank.size > 0) {
    Array.from(lostInRerank.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([doc, _count]) => {
        console.log(`   - ${doc}`);
      });
  } else {
    console.log('   None! Reranking preserves all fusion results.');
  }

  console.log('\n' + '='.repeat(80));
}

async function main() {
  console.log('Starting Cite Mode Recall Diagnostic...');
  console.log('This will analyze where each expected document is lost in the pipeline.\n');

  const allResults: DiagnosticResult[] = [];

  for (const testCase of TEST_CASES) {
    if (testCase.expectedDocuments.length === 0) {
      console.log(`⏭️  Skipping ${testCase.id} (no expected documents)`);
      continue;
    }

    try {
      const result = await runDiagnostic(testCase);
      allResults.push(result);
    } catch (error) {
      console.error(`❌ Error running ${testCase.id}:`, error);
    }
  }

  printDiagnosticReport(allResults);

  // Save detailed results
  const fs = await import('fs');
  const path = await import('path');
  const configuredOutputPath = process.argv[2] || process.env.DIAGNOSTIC_OUTPUT_PATH;
  const outputPath = configuredOutputPath || path.join(
    process.cwd(),
    'evaluation',
    'results',
    `diagnostic-${Date.now()}.json`,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
  console.log(`\n💾 Detailed results saved to: ${outputPath}`);
}

main().catch(console.error);
