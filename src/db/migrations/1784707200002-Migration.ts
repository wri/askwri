import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Clears the DOI placeholder the CSV writes instead of an empty cell.
 *
 * The corpus load stored the column verbatim, so 80 of the 168 QA documents
 * carry the literal string 'No DOI listed' as their DOI and the admin UI
 * renders it as one. Same class of defect as the 'Pre-EM' junk titles that
 * migration 1781320000000 cleaned up.
 *
 * The provenance stamp is dropped alongside the value: a DOI left as
 * 'external' with a NULL column would stop worker/stages/parse.py ever
 * extracting the real DOI from the PDF.
 */
export class Migration1784707200002 implements MigrationInterface {
  name = 'Migration1784707200002'

  private static readonly PLACEHOLDERS = `('No DOI listed','Not available','N/A','none','None','')`

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE documents
       SET doi = NULL,
           metadata_source = metadata_source - 'doi'
       WHERE doi IN ${Migration1784707200002.PLACEHOLDERS}
         AND coalesce(metadata_source->>'doi', 'external') <> 'human'`,
    )
  }

  public async down(): Promise<void> {
    // One-way: the placeholder carried no information, and restoring it would
    // reinstate a string that renders as a real DOI.
  }
}
