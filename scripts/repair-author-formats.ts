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
 * Dry-run by default; pass --apply to commit. Idempotent by SHAPE, not by
 * flag: an already-flagged external doc is still queried, but planned only if
 * its authors actually change — so a rerun after --apply performs no writes,
 * while a doc whose name gains a verified sibling later can still be repaired.
 * Writes are guarded on the planned authors value as well as provenance, so a
 * concurrent worker or import write is dropped, never clobbered.
 *
 * Ownership note: this script writes llm-provenanced authors — a deliberate,
 * bounded exception to one-owner-per-domain (evidence-gated flips and per-name
 * comma spacing only, never separator cosmetics; provenance left 'llm' so the
 * worker can still supersede on re-ingest). Every written doc gets an audit
 * row recording that rationale.
 *
 * Run against an environment:
 *   ./scripts/with-remote-env.sh qa         npm run repair:author-formats
 *   ./scripts/with-remote-env.sh qa         npm run repair:author-formats -- --apply
 *   ./scripts/with-remote-env.sh production npm run repair:author-formats -- --apply
 */

const CANDIDATE_SQL = `
  SELECT DISTINCT d.id::text AS id, d.external_id, d.authors,
         d.metadata_source->>'authors' AS provenance,
         jsonb_exists(d.metadata_source, 'authors_format') AS already_flagged
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND d.metadata_source->>'authors' IN ('external', 'llm')
    AND NOT EXISTS (
      SELECT 1 FROM ingestion_jobs j
      WHERE j.document_id = d.id AND j.status IN ('queued', 'running')
    )
    AND (
      position(',' in trim(u.nm)) = 0
      OR trim(u.nm) <> regexp_replace(regexp_replace(trim(u.nm), '\\s+', ' ', 'g'), '\\s*,\\s*', ', ')
    )
  ORDER BY d.external_id
`

const EVIDENCE_SQL = `
  SELECT d.metadata_source->>'authors' AS src, trim(u.nm) AS canonical
  FROM documents d
  CROSS JOIN LATERAL unnest(string_to_array(d.authors, ';')) AS u(nm)
  WHERE d.authors IS NOT NULL
    AND position(',' in trim(u.nm)) > 0
    AND trim(u.nm) <> ''
  ORDER BY d.metadata_source->>'authors', trim(u.nm)
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
      already_flagged: boolean
    }>
    const candidates: CandidateDoc[] = candidateRows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      authors: r.authors,
      provenance: r.provenance,
      alreadyFlagged: r.already_flagged,
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
    const plannedIds = new Set(plans.map((p) => p.documentId))
    const untouchedLlm = candidates.filter(
      (c) => c.provenance === 'llm' && !plannedIds.has(c.id),
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
        // The provenance guard alone is not enough. The worker writes authors
        // under exactly the condition it checks —
        // search-service/worker/stages/parse.py:681 updates WHERE
        // metadata_source->>'authors' IS NULL OR = 'llm' — so a parse that
        // lands between the candidate query and this transaction is invisible
        // to a provenance-only guard and gets clobbered by our stale plan. The
        // open-job exclusion in CANDIDATE_SQL closes the window only at query
        // time. Guarding on the value we planned from closes it at write time.
        const updated =
          plan.provenance === 'external'
            ? await tm.query(
                `UPDATE documents
                 SET authors = $2,
                     metadata_source = (metadata_source - 'authors_format') || $3::jsonb
                 WHERE id = $1::uuid
                   AND metadata_source->>'authors' = 'external'
                   AND authors IS NOT DISTINCT FROM $4
                 RETURNING id`,
                [
                  plan.documentId,
                  plan.finalAuthors,
                  flagJson,
                  plan.originalAuthors,
                ],
              )
            : await tm.query(
                `UPDATE documents
                 SET authors = $2
                 WHERE id = $1::uuid
                   AND metadata_source->>'authors' = 'llm'
                   AND authors IS NOT DISTINCT FROM $3
                 RETURNING id`,
                [plan.documentId, plan.finalAuthors, plan.originalAuthors],
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
              authorsFormat:
                plan.provenance !== 'external'
                  ? 'unchanged'
                  : plan.stillUnverified
                    ? 'set'
                    : 'cleared',
              rationale:
                'issue #411 one-off: evidence-gated flips plus per-name comma ' +
                'spacing repair; llm rows keep provenance so the worker may ' +
                'supersede on re-ingest',
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
          `  DROPPED (guard missed — authors or provenance changed since the plan): ${plan.externalId}`,
        )
      }
    }
    console.log(`Applied: ${applied} | Dropped: ${dropped}`)
    if (dropped > 0) {
      console.log('Re-run the dry run to re-plan the dropped documents.')
      process.exitCode = 1
    }
  } finally {
    await AppDataSource.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
