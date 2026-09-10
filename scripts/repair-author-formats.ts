import 'reflect-metadata'
import { AppDataSource } from '../src/db/data-source'
import { writeAudit } from '../src/db/queries/audit'
import {
  buildEvidenceIndex,
  planAuthorRepairs,
  type CandidateDoc,
  type EvidenceRow,
} from '../src/lib/authorFormat'

/**
 * One-off repair for mixed author name formats (issue #411; spec
 * docs/superpowers/specs/2026-09-09-author-name-format-design.md).
 *
 * Dry-run by default; pass --apply to commit. Idempotent: external docs
 * already flagged authors_format='unverified' and fully-comma'd docs are
 * never re-planned, so a rerun after --apply performs no writes.
 *
 * Ownership note: this script writes llm-provenanced authors — a deliberate,
 * bounded exception to one-owner-per-domain (evidence-gated flips only,
 * provenance left 'llm' so the worker can still supersede on re-ingest).
 * Every written doc gets an audit row recording that rationale.
 *
 * Run against an environment:
 *   ./scripts/with-remote-env.sh qa         npm run repair:author-formats
 *   ./scripts/with-remote-env.sh qa         npm run repair:author-formats -- --apply
 *   ./scripts/with-remote-env.sh production npm run repair:author-formats -- --apply
 */

const CANDIDATE_SQL = `
  SELECT DISTINCT d.id::text AS id, d.external_id, d.authors,
         d.metadata_source->>'authors' AS provenance
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND d.metadata_source->>'authors' IN ('external', 'llm')
    AND NOT EXISTS (
      SELECT 1 FROM ingestion_jobs j
      WHERE j.document_id = d.id AND j.status IN ('queued', 'running')
    )
    AND NOT (d.metadata_source ? 'authors_format')
    AND (
      position(',' in trim(u.nm)) = 0
      OR trim(u.nm) <> regexp_replace(regexp_replace(trim(u.nm), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ')
    )
`

const EVIDENCE_SQL = `
  SELECT d.metadata_source->>'authors' AS src, trim(u.nm) AS canonical
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND position(',' in trim(u.nm)) > 0
    AND trim(u.nm) <> ''
`

async function main() {
  const apply = process.argv.includes('--apply')
  await AppDataSource.initialize()
  try {
    const evidenceRows = (await AppDataSource.query(EVIDENCE_SQL)) as Array<{
      src: string | null
      canonical: string
    }>
    const evidence = buildEvidenceIndex(
      evidenceRows.map((r): EvidenceRow => ({
        src: r.src ?? 'llm',
        canonical: r.canonical,
      })),
    )

    const candidateRows = (await AppDataSource.query(CANDIDATE_SQL)) as Array<{
      id: string
      external_id: string
      authors: string
      provenance: 'external' | 'llm'
    }>
    const candidates: CandidateDoc[] = candidateRows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      authors: r.authors,
      provenance: r.provenance,
    }))

    const plans = planAuthorRepairs(candidates, evidence)

    const counts = { 'fix-spacing': 0, flip: 0, 'flag-unverified': 0 }
    for (const plan of plans) {
      for (const op of plan.ops) {
        if (op.type in counts) counts[op.type as keyof typeof counts]++
      }
    }

    console.log(`Author format repair — ${apply ? 'APPLY' : 'DRY RUN'}`)
    console.log(
      `Evidence keys: ${evidence.size} | Candidates: ${candidates.length} docs -> ${plans.length} planned`,
    )
    console.log(
      `Ops: fix-spacing=${counts['fix-spacing']} flip=${counts.flip} flag-unverified=${counts['flag-unverified']}`,
    )
    const untouchedLlm = candidates.filter(
      (c) =>
        c.provenance === 'llm' && !plans.some((p) => p.documentId === c.id),
    ).length
    if (untouchedLlm > 0) {
      console.log(
        `LLM no-op (comma-less, no verified sibling — untouched): ${untouchedLlm} docs`,
      )
    }
    for (const plan of plans) {
      const summary = plan.ops
        .filter((op) => op.type !== 'none')
        .map((op) =>
          op.before === op.after
            ? `${op.type}: '${op.before}'`
            : `${op.type}: '${op.before}' -> '${op.after}'`,
        )
        .join('; ')
      console.log(`  [${plan.provenance}] ${plan.externalId}: ${summary}`)
    }

    if (!apply) {
      console.log('Dry run — rerun with --apply to commit these changes.')
      return
    }

    let applied = 0
    let dropped = 0
    for (const plan of plans) {
      const flagJson = JSON.stringify(
        plan.provenance === 'external' && plan.stillUnverified
          ? { authors_format: 'unverified' }
          : {},
      )
      const result = await AppDataSource.transaction(async (tm) => {
        const updated =
          plan.provenance === 'external'
            ? await tm.query(
                `UPDATE documents
                 SET authors = $2,
                     metadata_source = (metadata_source - 'authors_format') || $3::jsonb
                 WHERE id = $1::uuid AND metadata_source->>'authors' = 'external'
                 RETURNING id`,
                [plan.documentId, plan.finalAuthors, flagJson],
              )
            : await tm.query(
                `UPDATE documents
                 SET authors = $2
                 WHERE id = $1::uuid AND metadata_source->>'authors' = 'llm'
                 RETURNING id`,
                [plan.documentId, plan.finalAuthors],
              )
        if (updated.length === 0) return false
        await writeAudit(
          {
            actorUserId: null,
            source: 'system',
            action: 'author_format_repair',
            entityType: 'documents',
            entityId: plan.documentId,
            before: { authors: plan.originalAuthors },
            after: {
              authors: plan.finalAuthors,
              provenance: plan.provenance,
              ops: plan.ops.filter((o) => o.type !== 'none').map((o) => o.type),
              rationale:
                'issue #411 one-off: evidence-gated author format repair; ' +
                'llm rows keep provenance so the worker may supersede on re-ingest',
            },
          },
          tm,
        )
        return true
      })
      if (result) {
        applied++
      } else {
        dropped++
        console.log(
          `  DROPPED (guard missed — provenance changed concurrently?): ${plan.externalId}`,
        )
      }
    }
    console.log(`Applied: ${applied} | Dropped: ${dropped}`)
  } finally {
    await AppDataSource.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
