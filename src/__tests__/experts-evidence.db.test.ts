/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { loadSearchableWorks } from '@/db/queries/expertsEvidence'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('loadSearchableWorks', () => {
  const stamp = Date.now()
  const origExt = `experts_orig_${stamp}`
  const trExt = `experts_tr_${stamp}`
  const withdrawnExt = `experts_withdrawn_${stamp}`
  let origId: string
  let trId: string
  let withdrawnId: string
  let topicId: string
  let geoId: string

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
    const ins = async (
      ext: string,
      status: string,
      authors: string,
      office: string,
    ) => {
      const [r] = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, title_en, status, authors, year_published, article_type, wri_primary_office)
         VALUES ($1, $2, 'T', 'T en', $3, $4, 2024, 'Report', $5) RETURNING id`,
        [ext, `documents/${ext}.pdf`, status, authors, office],
      )
      return r.id as string
    }
    origId = await ins(
      origExt,
      'searchable',
      'Xue, Lulu; Chen, Ke',
      'WRI México',
    )
    trId = await ins(
      trExt,
      'searchable',
      'Xue, Lulu; Traductor, Ana',
      'WRI México',
    )
    withdrawnId = await ins(
      withdrawnExt,
      'withdrawn',
      'Ghost, Casper',
      'WRI Global',
    )
    await AppDataSource.query(
      `INSERT INTO document_relations (document_id, related_document_id, relation_type, status, source)
       VALUES ($1, $2, 'translation_of', 'confirmed', 'human')`,
      [trId, origId],
    )
    const [t] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('topic', '__experts_topic__', 'v1') RETURNING id`,
    )
    topicId = t.id
    const [g] = await AppDataSource.query(
      `INSERT INTO tags (facet, value_id, taxonomy_version) VALUES ('geography', '__experts_geo__', 'v1') RETURNING id`,
    )
    geoId = g.id
    // topic on the TRANSLATION only, geography on the original, one rejected topic on original
    await AppDataSource.query(
      `INSERT INTO document_tags (document_id, tag_id, source, status) VALUES ($1, $2, 'llm', 'accepted'), ($3, $4, 'llm', 'accepted'), ($3, $2, 'llm', 'rejected')`,
      [trId, topicId, origId, geoId],
    )
  })

  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM document_relations WHERE document_id = $1`,
      [trId],
    )
    await AppDataSource.query(
      `DELETE FROM document_tags WHERE document_id = ANY($1)`,
      [[origId, trId]],
    )
    await AppDataSource.query(`DELETE FROM documents WHERE id = ANY($1)`, [
      [origId, trId, withdrawnId],
    ])
    await AppDataSource.query(`DELETE FROM tags WHERE id = ANY($1)`, [
      [topicId, geoId],
    ])
    await AppDataSource.destroy()
  })

  it('collapses a confirmed translation into its original work', async () => {
    const works = await loadSearchableWorks()
    const ids = works.map((w) => w.docId)
    expect(ids).toContain(origExt)
    expect(ids).not.toContain(trExt)
    expect(ids).not.toContain(withdrawnExt)
    const w = works.find((x) => x.docId === origExt)!
    expect(w.translations).toEqual([trExt])
    expect(w.authorsRaw).toEqual(['Xue, Lulu', 'Chen, Ke', 'Traductor, Ana'])
    expect(w.topics).toEqual(['__experts_topic__']) // accepted, from the translation; rejected excluded
    expect(w.geographies).toEqual(['__experts_geo__'])
    expect(w.office).toBe('WRI Mexico')
    expect(w.title).toBe('T en')
    expect(w.year).toBe(2024)
  })
})
