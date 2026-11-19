import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * One Mexico office, unaccented: "WRI Mexico".
 *
 * Two spellings had drifted apart, and the admin document editor's office
 * dropdown is `SELECT DISTINCT wri_primary_office FROM documents`
 * (documentsAdmin.listDocumentFieldValues) — so the corpus rendered both as
 * separate options:
 *   - 'WRI México' — the CSV-seeded column value (12 docs) and the single
 *     facet='office' tag row (20 document_tags, external/human/llm);
 *   - 'WRI Mexico'  — values the parse stage's PDF extraction wrote (3 docs).
 *
 * Renaming the tag IS the retag: every document_tags row already points at
 * that tag id, so nothing is rewritten and no source/status precedence changes
 * hands. Leaving the accented tag in place would keep re-creating the variant,
 * because classify's full-enum office call reads the tag vocabulary.
 *
 * No tag_embeddings work: topic and geography are the embedded facets, office
 * is full-enum. Safe to run with the worker up.
 */
export class Migration1795105785000 implements MigrationInterface {
  name = 'Migration1795105785000'

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE tags SET value_id = 'WRI Mexico'
       WHERE facet = 'office' AND taxonomy_version = 'v1' AND value_id = 'WRI México'`,
    )
    await q.query(
      `UPDATE documents SET wri_primary_office = 'WRI Mexico'
       WHERE wri_primary_office = 'WRI México'`,
    )
  }

  public async down(q: QueryRunner): Promise<void> {
    // Approximate: the pre-fix column carried two provenances under two
    // spellings, so this also flips the rows 'llm' had already spelled without
    // the accent. The tag rename is exactly reversible.
    await q.query(
      `UPDATE tags SET value_id = 'WRI México'
       WHERE facet = 'office' AND taxonomy_version = 'v1' AND value_id = 'WRI Mexico'`,
    )
    await q.query(
      `UPDATE documents SET wri_primary_office = 'WRI México'
       WHERE wri_primary_office = 'WRI Mexico'`,
    )
  }
}
