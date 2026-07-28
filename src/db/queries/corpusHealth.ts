import { AppDataSource } from '../data-source'
import { getWorkerHealth, WorkerHealth } from './workerHealth'

export interface CorpusHealth {
  /** Documents grouped by status: { searchable: 171, withdrawn: 1, ... }. */
  statusCounts: Record<string, number>
  /** Documents grouped by primary language: { en: 139, es: 10, pt: 4, zh: 19, ... }. */
  languageCounts: Record<string, number>
  /** Documents at needs_review/error (the review-queue depth). */
  reviewQueueDepth: number
  /**
   * Non-English docs with NO document_summaries row in their own language.
   * After Wave 1 relabeled the 33 mislabeled summaries → en, these native
   * slots are empty (19 zh + 10 es + 4 pt). The worker regenerates them only
   * on re-ingest, so this gap is the live multilingual-renditions backlog.
   * Design §7.5/§10: every doc needs native + English summaries.
   */
  docsMissingNativeSummary: number
  /**
   * Non-English docs with title_en IS NULL. Wave 1 backfilled all 33, so this
   * is 0 today; the metric exists to catch future docs that slip through.
   * Design §6: title_en "always populated".
   */
  docsMissingTitleEn: number
  /** Docs with extraction_confidence < 0.7 (low-confidence, may need review). */
  lowConfidenceDocs: number
  /** Worker liveness + queue state (reuses getWorkerHealth). */
  worker: WorkerHealth
}

/**
 * Corpus-health dashboard data for the review page (design §11.317, surfaced
 * where the reviewer works). Surfaces the multilingual-renditions gaps
 * (missing native summaries, missing title_en) that are otherwise invisible.
 */
export async function getCorpusHealth(): Promise<CorpusHealth> {
  const statusRows: { status: string; count: string }[] =
    await AppDataSource.query(`
    SELECT status, count(*)::text AS count FROM documents GROUP BY status
  `)
  const statusCounts: Record<string, number> = {}
  for (const r of statusRows) statusCounts[r.status] = Number(r.count)

  const langRows: { language: string; count: string }[] =
    await AppDataSource.query(`
    SELECT language, count(*)::text AS count FROM documents GROUP BY language
  `)
  const languageCounts: Record<string, number> = {}
  for (const r of langRows)
    languageCounts[r.language ?? 'unknown'] = Number(r.count)

  const [qRow] = await AppDataSource.query(`
    SELECT
      count(*) FILTER (WHERE status IN ('needs_review','error'))::int AS "reviewQueueDepth",
      count(*) FILTER (WHERE language <> 'en' AND title_en IS NULL)::int AS "docsMissingTitleEn",
      count(*) FILTER (WHERE extraction_confidence IS NOT NULL AND extraction_confidence < 0.7)::int AS "lowConfidenceDocs"
    FROM documents
  `)
  const reviewQueueDepth: number = qRow?.reviewQueueDepth ?? 0
  const docsMissingTitleEn: number = qRow?.docsMissingTitleEn ?? 0
  const lowConfidenceDocs: number = qRow?.lowConfidenceDocs ?? 0

  // Non-English docs with no summary row in their own language (the native
  // rendition gap). NOT EXISTS is the precise check: the doc's language has
  // no matching document_summaries row.
  const [missingRow] = await AppDataSource.query(`
    SELECT count(*)::int AS n
    FROM documents d
    WHERE d.language <> 'en'
      AND NOT EXISTS (
        SELECT 1 FROM document_summaries ds
        WHERE ds.document_id = d.id AND ds.language = d.language
      )
  `)
  const docsMissingNativeSummary: number = missingRow?.n ?? 0

  const worker = await getWorkerHealth()

  return {
    statusCounts,
    languageCounts,
    reviewQueueDepth,
    docsMissingNativeSummary,
    docsMissingTitleEn,
    lowConfidenceDocs,
    worker,
  }
}
