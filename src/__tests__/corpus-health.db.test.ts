/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getCorpusHealth } from '@/db/queries/corpusHealth'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
// Corpus-precondition tests: require the migrated 169-doc corpus, absent in
// schema-only CI. Gated on RUN_CORPUS_TESTS (set by `npm run test:db`).
const corpusIt = process.env.RUN_CORPUS_TESTS === '1' ? it : it.skip

d('getCorpusHealth (DB integration)', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    await AppDataSource.destroy()
  })

  corpusIt('returns statusCounts keyed by document status', async () => {
    const h = await getCorpusHealth()
    expect(h.statusCounts).toBeTruthy()
    expect(typeof h.statusCounts).toBe('object')
    // The live corpus has searchable + withdrawn (at minimum).
    expect(h.statusCounts).toHaveProperty('searchable')
    expect(typeof h.statusCounts.searchable).toBe('number')
    expect(h.statusCounts.searchable).toBeGreaterThan(0)
  })

  corpusIt('returns languageCounts keyed by ISO language code', async () => {
    const h = await getCorpusHealth()
    expect(h.languageCounts).toBeTruthy()
    // The multilingual corpus has en, es, pt, zh.
    expect(h.languageCounts).toHaveProperty('en')
    expect(h.languageCounts).toHaveProperty('es')
    expect(h.languageCounts).toHaveProperty('pt')
    expect(h.languageCounts).toHaveProperty('zh')
    expect(h.languageCounts.en).toBeGreaterThan(0)
  })

  it('returns reviewQueueDepth as a non-negative number', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.reviewQueueDepth).toBe('number')
    expect(h.reviewQueueDepth).toBeGreaterThanOrEqual(0)
  })

  it('surfaces docsMissingNativeSummary as a non-negative number', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.docsMissingNativeSummary).toBe('number')
    expect(h.docsMissingNativeSummary).toBeGreaterThanOrEqual(0)
  })

  // Corpus-state lock, gated to the serial `npm run test:db` run: under
  // parallel `npm test`, other suites transiently seed non-en docs (before
  // their summary/title_en rows land), making a corpus-wide 0 unassertable.
  corpusIt(
    'docsMissingNativeSummary is 0 (multilingual gap closed by the native-summary regen)',
    async () => {
      const h = await getCorpusHealth()
      // Wave 1 relabeled the 33 mislabeled summaries zh/es/pt → en (emptying the
      // native slots), then a re-summarize batch regenerated the native zh/es/pt
      // long+short summaries. The gap is now 0 (19 zh + 10 es + 4 pt all have
      // native summaries). Assert 0 to lock the closed gap; if a future doc is
      // added without a native summary, this metric (and this test) will surface it.
      expect(h.docsMissingNativeSummary).toBe(0)
    },
  )

  it('returns docsMissingTitleEn as a non-negative number', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.docsMissingTitleEn).toBe('number')
    expect(h.docsMissingTitleEn).toBeGreaterThanOrEqual(0)
  })

  corpusIt(
    'docsMissingTitleEn is 0 (Wave 1 backfilled title_en for all 33 non-English docs)',
    async () => {
      const h = await getCorpusHealth()
      expect(h.docsMissingTitleEn).toBe(0)
    },
  )

  it('returns lowConfidenceDocs (extraction_confidence < 0.7) as a non-negative number', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.lowConfidenceDocs).toBe('number')
    expect(h.lowConfidenceDocs).toBeGreaterThanOrEqual(0)
  })

  it('includes worker health (reuses getWorkerHealth)', async () => {
    const h = await getCorpusHealth()
    expect(h.worker).toBeTruthy()
    expect(h.worker).toHaveProperty('status')
    expect(['idle', 'processing', 'pending', 'stale']).toContain(
      h.worker.status,
    )
    expect(h.worker).toHaveProperty('queueDepth')
    expect(h.worker).toHaveProperty('intakeBacklog')
  })

  // Translation-pair counts (issue #325): seeded fixture relations so the
  // assertions don't depend on the live corpus state.
  describe('translation-pair counts (issue #325)', () => {
    const ext = `corpusrel_test_${Date.now()}`
    let docA: string
    let docB: string
    let docC: string
    let docD: string

    beforeAll(async () => {
      const rows = await AppDataSource.query(
        `INSERT INTO documents (external_id, s3_key, title, status) VALUES
           ($1, $2, 'Corpus Rel A', 'searchable'),
           ($3, $4, 'Corpus Rel B', 'searchable'),
           ($5, $6, 'Corpus Rel C', 'searchable'),
           ($7, $8, 'Corpus Rel D', 'searchable') RETURNING id`,
        [
          `${ext}_a`, `documents/${ext}_a.pdf`,
          `${ext}_b`, `documents/${ext}_b.pdf`,
          `${ext}_c`, `documents/${ext}_c.pdf`,
          `${ext}_d`, `documents/${ext}_d.pdf`,
        ],
      )
      docA = rows[0].id
      docB = rows[1].id
      docC = rows[2].id
      docD = rows[3].id
      await AppDataSource.query(
        `INSERT INTO document_relations (document_id, related_document_id, source, status, signals) VALUES
           ($1, $2, 'system', 'suggested', '{}'),
           ($3, $4, 'human', 'confirmed', '{}')`,
        [docA, docB, docC, docD],
      )
    })

    afterAll(async () => {
      await AppDataSource.query(
        `DELETE FROM document_relations WHERE document_id IN ($1, $2, $3, $4) OR related_document_id IN ($1, $2, $3, $4)`,
        [docA, docB, docC, docD],
      )
      await AppDataSource.query(
        `DELETE FROM documents WHERE id IN ($1, $2, $3, $4)`,
        [docA, docB, docC, docD],
      )
    })

    it('counts pending suggestions and confirmed translation pairs', async () => {
      const h = await getCorpusHealth()
      expect(typeof h.pendingRelationSuggestions).toBe('number')
      expect(typeof h.confirmedTranslationPairs).toBe('number')
      expect(h.pendingRelationSuggestions).toBeGreaterThanOrEqual(1)
      expect(h.confirmedTranslationPairs).toBeGreaterThanOrEqual(1)
    })
  })
})
