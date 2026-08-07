import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1785916800000 implements MigrationInterface {
  name = 'Migration1785916800000'

  public async up(q: QueryRunner): Promise<void> {
    // Issue #310: "WRI primary office" must be a geographic office, not a
    // programmatic unit. The admin dropdown is built from DISTINCT values in
    // use, so remapping the rows is the only way to retire these two options.
    // metadata_source is left untouched: an 'llm'-sourced office stays
    // re-extractable by the (now unit-excluding) parse prompt on re-ingest.
    await q.query(`
      UPDATE documents
      SET wri_primary_office = 'WRI Global', updated_at = now()
      WHERE wri_primary_office IN
        ('WRI Ross Center', 'WRI Ross Center for Sustainable Cities')`)
  }

  public async down(): Promise<void> {
    // Irreversible data repair: the original per-row values are not retained.
  }
}
