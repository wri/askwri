/**
 * Answer mode logit threshold calibration.
 *
 * Sweeps floor thresholds against the answer golden set using LLM labels
 * as proxy ground truth. Optimizes for precision (answer mode needs clean
 * synthesis input). Also sweeps rerankTopN and reports page-1 demotion impact.
 *
 * Prerequisites: search service running on :8000
 * Usage: npx tsx --env-file-if-exists=.env evaluation/calibrate-answer-thresholds.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkPythonService, PYTHON_SERVICE_URL } from './lib/service-client';

// --- Types ---

interface LabeledChunk {
  chunk_id: string;
  doc_id: string;
  label: 'relevant' | 'partially_relevant' | 'not_relevant';
  confidence: string;
  human_override: string | null;
  score: number;
}

interface LabeledQuestion {
  id: string;
  question: string;
  query_type: string;
  difficulty: string;
  chunks: LabeledChunk[];
}

interface LabelsFile {
  labeled_at: string;
  questions: LabeledQuestion[];
}

interface ScoredChunk {
  query_id: string;
  chunk_id: string;
  doc_id: string;
  raw_score: number;
  chunk_index: number;
  is_relevant: boolean;  // relevant or partially_relevant
  label: string;
}

interface SweepPoint {
  threshold: number;
  recall: number;
  precision: number;
  f1: number;
  chunks_retained: number;
  chunks_dropped: number;
  true_positives: number;
  false_positives: number;
  false_negatives: number;
}

interface RerankSweepResult {
  rerank_top_n: number;
  total_chunks: number;
  relevant_chunks_found: number;
  best_precision_floor: SweepPoint & { threshold: number };
  f1_optimal: SweepPoint & { threshold: number };
  sweep_data: SweepPoint[];
}

interface DemotionReport {
  total_page1_chunks: number;
  relevant_page1_chunks: number;
  irrelevant_page1_chunks: number;
  scores_before_demotion: { relevant: number[]; irrelevant: number[] };
  scores_after_demotion: { relevant: number[]; irrelevant: number[] };
  verdict: string;
}

interface CalibrationReport {
  timestamp: string;
  mode: 'answer';
  golden_queries: number;
  total_labeled_chunks: number;
  total_relevant_labeled: number;
  proxy_ground_truth: 'llm_labels';
  statistical_note: string;
  primary_sweep: {
    rerank_top_n: number;
    recommended: {
      floor: number;
      floor_precision: number;
      floor_recall: number;
      floor_f1: number;
      strong_threshold: number;
      partial_threshold: number;
    };
    f1_optimal: {
      floor: number;
      precision: number;
      recall: number;
      f1: number;
    };
    sweep_data: SweepPoint[];
    score_distribution: {
      relevant: { min: number; max: number; median: number; p25: number; p75: number; count: number };
      not_relevant: { min: number; max: number; median: number; p25: number; p75: number; count: number };
    };
  };
  rerank_sweep: RerankSweepResult[];
  demotion_report: DemotionReport;
  per_query_summary: Array<{
    query_id: string;
    question: string;
    chunks_retrieved: number;
    relevant_found: number;
    relevant_total: number;
  }>;
  raw_chunks: ScoredChunk[];
}

// --- Helpers ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function isRelevantLabel(chunk: LabeledChunk): boolean {
  const effectiveLabel = chunk.human_override || chunk.label;
  return effectiveLabel === 'relevant' || effectiveLabel === 'partially_relevant';
}

function evaluateThreshold(chunks: ScoredChunk[], threshold: number, totalRelevant: number): SweepPoint {
  let tp = 0, fp = 0, fn = 0;
  let retained = 0, dropped = 0;

  for (const chunk of chunks) {
    if (chunk.raw_score >= threshold) {
      retained++;
      if (chunk.is_relevant) tp++;
      else fp++;
    } else {
      dropped++;
      if (chunk.is_relevant) fn++;
    }
  }

  // Use totalRelevant (from labels) for recall denominator, not just matched chunks
  const recall = totalRelevant > 0 ? tp / totalRelevant : 0;
  const precision = retained > 0 ? tp / retained : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  return {
    threshold,
    recall,
    precision,
    f1,
    chunks_retained: retained,
    chunks_dropped: dropped,
    true_positives: tp,
    false_positives: fp,
    false_negatives: fn,
  };
}

function runFloorSweep(chunks: ScoredChunk[], totalRelevant: number): SweepPoint[] {
  const allScores = chunks.map(c => c.raw_score).sort((a, b) => a - b);
  if (allScores.length === 0) return [];

  const minScore = allScores[0];
  const maxScore = allScores[allScores.length - 1];

  // Coarse sweep: 0.25 increments
  const coarseCandidates: number[] = [];
  for (let t = Math.floor(minScore); t <= Math.ceil(maxScore); t += 0.25) {
    coarseCandidates.push(t);
  }

  const coarseResults = coarseCandidates.map(t => evaluateThreshold(chunks, t, totalRelevant));

  // Find region of interest: around where precision crosses 80%
  const precisionTarget = 0.80;
  let bestCoarse = coarseResults[0];
  for (const r of coarseResults) {
    if (r.precision >= precisionTarget && r.threshold > bestCoarse.threshold) {
      bestCoarse = r;
    }
  }

  // Fine sweep: 0.1 increments around the best coarse point
  const fineCandidates: number[] = [];
  for (let t = bestCoarse.threshold - 2; t <= bestCoarse.threshold + 2; t += 0.1) {
    fineCandidates.push(Math.round(t * 10) / 10);
  }

  const fineResults = fineCandidates.map(t => evaluateThreshold(chunks, t, totalRelevant));

  // Combine, dedupe, sort
  return [...coarseResults, ...fineResults]
    .sort((a, b) => a.threshold - b.threshold)
    .filter((v, i, arr) => i === 0 || Math.abs(v.threshold - arr[i - 1].threshold) > 0.01);
}

// --- Main ---

async function main() {
  const healthy = await checkPythonService();
  if (!healthy) {
    console.error('ERROR: Search service not available at', PYTHON_SERVICE_URL);
    process.exit(1);
  }

  // Load LLM labels
  const labelsPath = path.join(__dirname, 'answer-labels-review.json');
  const labelsData: LabelsFile = JSON.parse(fs.readFileSync(labelsPath, 'utf-8'));

  // Build label lookup: chunk_id → is_relevant
  const labelLookup = new Map<string, { is_relevant: boolean; label: string }>();
  let totalRelevantLabeled = 0;
  for (const q of labelsData.questions) {
    for (const chunk of q.chunks) {
      const relevant = isRelevantLabel(chunk);
      labelLookup.set(chunk.chunk_id, {
        is_relevant: relevant,
        label: chunk.human_override || chunk.label,
      });
      if (relevant) totalRelevantLabeled++;
    }
  }

  console.log(`\nAnswer Threshold Calibration`);
  console.log(`============================`);
  console.log(`Golden set: ${labelsData.questions.length} queries`);
  console.log(`Labeled chunks: ${labelLookup.size} (${totalRelevantLabeled} relevant/partial)\n`);

  // --- Sweep 1: Primary logit floor sweep at current rerankTopN=20 ---
  console.log(`--- Sweep 1: Logit floor (rerankTopN=20) ---\n`);

  const allChunks: ScoredChunk[] = [];
  const perQuerySummary: CalibrationReport['per_query_summary'] = [];
  let relevantFoundTotal = 0;

  for (const q of labelsData.questions) {
    process.stdout.write(`  ${q.id}... `);

    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q.question,
        mode: 'answer',
        max_results: 100,
        rerank: true,
        rerank_top_n: 20,
        vector_top_k: 150,
        bm25_top_k: 150,
        include_metadata: true,
      }),
    });

    if (!response.ok) {
      console.error(`FAILED (${response.status})`);
      continue;
    }

    const data = await response.json();
    const docs = data.docs || [];

    let relevantFound = 0;
    const relevantTotal = q.chunks.filter(c => isRelevantLabel(c)).length;

    for (const doc of docs) {
      const chunkId = doc.metadata?.chunk_id || doc.doc_id;
      const rawScore = doc.metadata?.raw_score ?? doc.score;
      const chunkIndex = doc.metadata?.chunk_index ?? 0;

      const labelInfo = labelLookup.get(chunkId);
      const isRelevant = labelInfo?.is_relevant ?? false;
      if (isRelevant) relevantFound++;

      allChunks.push({
        query_id: q.id,
        chunk_id: chunkId,
        doc_id: doc.doc_id,
        raw_score: rawScore,
        chunk_index: chunkIndex,
        is_relevant: isRelevant,
        label: labelInfo?.label ?? 'unlabeled',
      });
    }

    relevantFoundTotal += relevantFound;
    perQuerySummary.push({
      query_id: q.id,
      question: q.question,
      chunks_retrieved: docs.length,
      relevant_found: relevantFound,
      relevant_total: relevantTotal,
    });

    console.log(`${docs.length} chunks, ${relevantFound}/${relevantTotal} relevant found`);
  }

  // Score distributions
  const relevantScores = allChunks.filter(c => c.is_relevant).map(c => c.raw_score).sort((a, b) => a - b);
  const irrelevantScores = allChunks.filter(c => !c.is_relevant).map(c => c.raw_score).sort((a, b) => a - b);

  console.log(`\nScore distributions:`);
  console.log(`  Relevant (${relevantScores.length}): min=${relevantScores[0]?.toFixed(2)}, median=${percentile(relevantScores, 50).toFixed(2)}, max=${relevantScores[relevantScores.length - 1]?.toFixed(2)}`);
  console.log(`  Irrelevant (${irrelevantScores.length}): min=${irrelevantScores[0]?.toFixed(2)}, median=${percentile(irrelevantScores, 50).toFixed(2)}, max=${irrelevantScores[irrelevantScores.length - 1]?.toFixed(2)}`);

  // Run floor sweep
  const sweepData = runFloorSweep(allChunks, relevantFoundTotal);

  // Recommended floor: most aggressive threshold with precision >= 80%
  const precisionTarget = 0.80;
  const passingPoints = sweepData.filter(p => p.precision >= precisionTarget);
  const recommendedFloor = passingPoints.length > 0
    ? passingPoints.reduce((best, p) => p.threshold > best.threshold ? p : best)
    : sweepData[0];

  // F1-optimal
  const f1Optimal = sweepData.reduce((best, p) => p.f1 > best.f1 ? p : best);

  // Tier thresholds
  const strongThreshold = relevantScores.length > 0 ? percentile(relevantScores, 70) : 3.0;
  const partialThreshold = relevantScores.length > 0 ? percentile(relevantScores, 25) : 0.0;

  // Print sweep results
  console.log(`\n--- Sweep Results ---\n`);
  console.log(`${'Threshold'.padStart(10)} ${'Precision'.padStart(10)} ${'Recall'.padStart(8)} ${'F1'.padStart(8)} ${'Retained'.padStart(10)} ${'Dropped'.padStart(9)}`);
  console.log('-'.repeat(60));
  for (const p of sweepData) {
    const marker = Math.abs(p.threshold - recommendedFloor.threshold) < 0.01 ? ' ← FLOOR'
      : Math.abs(p.threshold - f1Optimal.threshold) < 0.01 ? ' ← F1-OPT'
      : '';
    console.log(
      `${p.threshold.toFixed(1).padStart(10)} ${(p.precision * 100).toFixed(1).padStart(9)}% ${(p.recall * 100).toFixed(1).padStart(7)}% ${(p.f1 * 100).toFixed(1).padStart(7)}% ${String(p.chunks_retained).padStart(10)} ${String(p.chunks_dropped).padStart(9)}${marker}`
    );
  }

  console.log(`\n--- Recommendations ---\n`);
  console.log(`  Floor (precision >= 80%): ${recommendedFloor.threshold.toFixed(2)} → precision=${(recommendedFloor.precision * 100).toFixed(1)}%, recall=${(recommendedFloor.recall * 100).toFixed(1)}%`);
  console.log(`  F1-optimal:              ${f1Optimal.threshold.toFixed(2)} → precision=${(f1Optimal.precision * 100).toFixed(1)}%, recall=${(f1Optimal.recall * 100).toFixed(1)}%, F1=${(f1Optimal.f1 * 100).toFixed(1)}%`);
  console.log(`  Strong threshold:        ${strongThreshold.toFixed(2)} (p70 of relevant scores)`);
  console.log(`  Partial threshold:       ${partialThreshold.toFixed(2)} (p25 of relevant scores)`);

  // --- Sweep 2: rerankTopN ---
  console.log(`\n--- Sweep 2: rerankTopN ---\n`);

  const rerankValues = [10, 15, 20, 30, 40];
  const rerankResults: RerankSweepResult[] = [];

  for (const rerankTopN of rerankValues) {
    if (rerankTopN === 20) {
      // Already have this data from Sweep 1
      const bestPrecision = passingPoints.length > 0
        ? passingPoints.reduce((best, p) => p.threshold > best.threshold ? p : best)
        : sweepData[0];
      rerankResults.push({
        rerank_top_n: 20,
        total_chunks: allChunks.length,
        relevant_chunks_found: relevantFoundTotal,
        best_precision_floor: { ...bestPrecision, threshold: bestPrecision.threshold },
        f1_optimal: { ...f1Optimal, threshold: f1Optimal.threshold },
        sweep_data: sweepData,
      });
      console.log(`  rerankTopN=${rerankTopN}: (from Sweep 1) floor=${bestPrecision.threshold.toFixed(2)}, precision=${(bestPrecision.precision * 100).toFixed(1)}%, recall=${(bestPrecision.recall * 100).toFixed(1)}%`);
      continue;
    }

    process.stdout.write(`  rerankTopN=${rerankTopN}... `);

    const chunks: ScoredChunk[] = [];
    let relevantFound = 0;

    for (const q of labelsData.questions) {
      const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q.question,
          mode: 'answer',
          max_results: 100,
          rerank: true,
          rerank_top_n: rerankTopN,
          vector_top_k: 150,
          bm25_top_k: 150,
          include_metadata: true,
        }),
      });

      if (!response.ok) continue;
      const data = await response.json();

      for (const doc of (data.docs || [])) {
        const chunkId = doc.metadata?.chunk_id || doc.doc_id;
        const rawScore = doc.metadata?.raw_score ?? doc.score;
        const chunkIndex = doc.metadata?.chunk_index ?? 0;
        const labelInfo = labelLookup.get(chunkId);
        const isRelevant = labelInfo?.is_relevant ?? false;
        if (isRelevant) relevantFound++;

        chunks.push({
          query_id: q.id,
          chunk_id: chunkId,
          doc_id: doc.doc_id,
          raw_score: rawScore,
          chunk_index: chunkIndex,
          is_relevant: isRelevant,
          label: labelInfo?.label ?? 'unlabeled',
        });
      }
    }

    const sweep = runFloorSweep(chunks, relevantFound);
    const passing = sweep.filter(p => p.precision >= precisionTarget);
    const bestFloor = passing.length > 0
      ? passing.reduce((best, p) => p.threshold > best.threshold ? p : best)
      : sweep[0];
    const bestF1 = sweep.reduce((best, p) => p.f1 > best.f1 ? p : best);

    rerankResults.push({
      rerank_top_n: rerankTopN,
      total_chunks: chunks.length,
      relevant_chunks_found: relevantFound,
      best_precision_floor: { ...bestFloor, threshold: bestFloor.threshold },
      f1_optimal: { ...bestF1, threshold: bestF1.threshold },
      sweep_data: sweep,
    });

    console.log(`${chunks.length} chunks, floor=${bestFloor.threshold.toFixed(2)}, precision=${(bestFloor.precision * 100).toFixed(1)}%, recall=${(bestFloor.recall * 100).toFixed(1)}%`);
  }

  // Print rerankTopN comparison
  console.log(`\n${'rerankTopN'.padStart(12)} ${'Floor'.padStart(8)} ${'Precision'.padStart(10)} ${'Recall'.padStart(8)} ${'F1-opt'.padStart(8)} ${'Chunks'.padStart(8)}`);
  console.log('-'.repeat(58));
  for (const r of rerankResults) {
    const bp = r.best_precision_floor;
    console.log(
      `${String(r.rerank_top_n).padStart(12)} ${bp.threshold.toFixed(1).padStart(8)} ${(bp.precision * 100).toFixed(1).padStart(9)}% ${(bp.recall * 100).toFixed(1).padStart(7)}% ${(r.f1_optimal.f1 * 100).toFixed(1).padStart(7)}% ${String(r.total_chunks).padStart(8)}`
    );
  }

  // --- Sweep 3: Page-1 demotion impact ---
  console.log(`\n--- Sweep 3: Page-1 demotion impact ---\n`);

  const page1Chunks = allChunks.filter(c => c.chunk_index === 0);
  const page1Relevant = page1Chunks.filter(c => c.is_relevant);
  const page1Irrelevant = page1Chunks.filter(c => !c.is_relevant);

  // The raw_score from the service is AFTER demotion (score * 0.5 for chunk_index=0).
  // Pre-demotion score = raw_score / 0.5 = raw_score * 2
  const demotionReport: DemotionReport = {
    total_page1_chunks: page1Chunks.length,
    relevant_page1_chunks: page1Relevant.length,
    irrelevant_page1_chunks: page1Irrelevant.length,
    scores_before_demotion: {
      relevant: page1Relevant.map(c => c.raw_score * 2).sort((a, b) => a - b),
      irrelevant: page1Irrelevant.map(c => c.raw_score * 2).sort((a, b) => a - b),
    },
    scores_after_demotion: {
      relevant: page1Relevant.map(c => c.raw_score).sort((a, b) => a - b),
      irrelevant: page1Irrelevant.map(c => c.raw_score).sort((a, b) => a - b),
    },
    verdict: '',
  };

  // Analyze: for negative scores, demotion (× 0.5) makes them LESS negative = promotes them
  const negativeRelevant = page1Relevant.filter(c => c.raw_score < 0);
  const negativeIrrelevant = page1Irrelevant.filter(c => c.raw_score < 0);

  if (negativeIrrelevant.length > 0) {
    const promoted = negativeIrrelevant.filter(c => {
      const preDemotion = c.raw_score * 2;
      // Would the pre-demotion score have been below the recommended floor
      // but the post-demotion score survives?
      return preDemotion < recommendedFloor.threshold && c.raw_score >= recommendedFloor.threshold;
    });
    if (promoted.length > 0) {
      demotionReport.verdict = `BUG CONFIRMED: ${promoted.length} irrelevant page-1 chunks are promoted above the floor by the 0.5x multiplier on negative scores. Recommend applying floor BEFORE demotion or using an additive penalty.`;
    } else {
      demotionReport.verdict = `Demotion does not cause irrelevant page-1 chunks to cross the floor threshold at the recommended floor (${recommendedFloor.threshold.toFixed(2)}). However, the inverted semantics remain — consider fixing for correctness.`;
    }
  } else {
    demotionReport.verdict = 'No negative-score page-1 chunks observed. Demotion semantics are correct for positive scores.';
  }

  console.log(`  Page-1 chunks: ${page1Chunks.length} total (${page1Relevant.length} relevant, ${page1Irrelevant.length} irrelevant)`);
  console.log(`  Negative-score page-1: ${negativeRelevant.length} relevant, ${negativeIrrelevant.length} irrelevant`);
  console.log(`  Verdict: ${demotionReport.verdict}`);

  if (page1Relevant.length > 0) {
    const before = demotionReport.scores_before_demotion.relevant;
    const after = demotionReport.scores_after_demotion.relevant;
    console.log(`  Relevant page-1 scores — before demotion: [${before[0]?.toFixed(2)}..${before[before.length-1]?.toFixed(2)}], after: [${after[0]?.toFixed(2)}..${after[after.length-1]?.toFixed(2)}]`);
  }
  if (page1Irrelevant.length > 0) {
    const before = demotionReport.scores_before_demotion.irrelevant;
    const after = demotionReport.scores_after_demotion.irrelevant;
    console.log(`  Irrelevant page-1 scores — before demotion: [${before[0]?.toFixed(2)}..${before[before.length-1]?.toFixed(2)}], after: [${after[0]?.toFixed(2)}..${after[after.length-1]?.toFixed(2)}]`);
  }

  // --- Save report ---
  const report: CalibrationReport = {
    timestamp: new Date().toISOString(),
    mode: 'answer',
    golden_queries: labelsData.questions.length,
    total_labeled_chunks: labelLookup.size,
    total_relevant_labeled: totalRelevantLabeled,
    proxy_ground_truth: 'llm_labels',
    statistical_note: 'Thresholds calibrated against LLM labels (no human validation). With 9 queries and ~28 positives per query, per-query estimates have wide confidence intervals. Treat thresholds as provisional.',
    primary_sweep: {
      rerank_top_n: 20,
      recommended: {
        floor: Math.round(recommendedFloor.threshold * 100) / 100,
        floor_precision: Math.round(recommendedFloor.precision * 1000) / 1000,
        floor_recall: Math.round(recommendedFloor.recall * 1000) / 1000,
        floor_f1: Math.round(recommendedFloor.f1 * 1000) / 1000,
        strong_threshold: Math.round(strongThreshold * 100) / 100,
        partial_threshold: Math.round(partialThreshold * 100) / 100,
      },
      f1_optimal: {
        floor: Math.round(f1Optimal.threshold * 100) / 100,
        precision: Math.round(f1Optimal.precision * 1000) / 1000,
        recall: Math.round(f1Optimal.recall * 1000) / 1000,
        f1: Math.round(f1Optimal.f1 * 1000) / 1000,
      },
      sweep_data: sweepData,
      score_distribution: {
        relevant: {
          min: relevantScores[0] ?? 0,
          max: relevantScores[relevantScores.length - 1] ?? 0,
          median: percentile(relevantScores, 50),
          p25: percentile(relevantScores, 25),
          p75: percentile(relevantScores, 75),
          count: relevantScores.length,
        },
        not_relevant: {
          min: irrelevantScores[0] ?? 0,
          max: irrelevantScores[irrelevantScores.length - 1] ?? 0,
          median: percentile(irrelevantScores, 50),
          p25: percentile(irrelevantScores, 25),
          p75: percentile(irrelevantScores, 75),
          count: irrelevantScores.length,
        },
      },
    },
    rerank_sweep: rerankResults,
    demotion_report: demotionReport,
    per_query_summary: perQuerySummary,
    raw_chunks: allChunks,
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(resultsDir, `answer-threshold-calibration-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);
}

main().catch(err => {
  console.error('Calibration failed:', err);
  process.exit(1);
});
