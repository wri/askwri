/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getCorpusHealth } from '@/db/queries/corpusHealth'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('getCorpusHealth (DB integration)', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    await AppDataSource.destroy()
  })

  it('returns statusCounts keyed by document status', async () => {
    const h = await getCorpusHealth()
    expect(h.statusCounts).toBeTruthy()
    expect(typeof h.statusCounts).toBe('object')
    // The live corpus has searchable + withdrawn (at minimum).
    expect(h.statusCounts).toHaveProperty('searchable')
    expect(typeof h.statusCounts.searchable).toBe('number')
    expect(h.statusCounts.searchable).toBeGreaterThan(0)
  })

  it('returns languageCounts keyed by ISO language code', async () => {
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

  it('surfaces docsMissingNativeSummary (the multilingual gap: closed after the native-summary regen)', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.docsMissingNativeSummary).toBe('number')
    // Wave 1 relabeled the 33 mislabeled summaries zh/es/pt → en (emptying the
    // native slots), then a re-summarize batch regenerated the native zh/es/pt
    // long+short summaries. The gap is now 0 (19 zh + 10 es + 4 pt all have
    // native summaries). Assert 0 to lock the closed gap; if a future doc is
    // added without a native summary, this metric (and this test) will surface it.
    expect(h.docsMissingNativeSummary).toBe(0)
  })

  it('returns docsMissingTitleEn (should be 0 after Wave 1 backfill)', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.docsMissingTitleEn).toBe('number')
    expect(h.docsMissingTitleEn).toBeGreaterThanOrEqual(0)
    // Wave 1 backfilled title_en = title for all 33 non-English docs.
    expect(h.docsMissingTitleEn).toBe(0)
  })

  it('returns lowConfidenceDocs (extraction_confidence < 0.7) as a non-negative number', async () => {
    const h = await getCorpusHealth()
    expect(typeof h.lowConfidenceDocs).toBe('number')
    expect(h.lowConfidenceDocs).toBeGreaterThanOrEqual(0)
  })

  it('includes worker health (reuses getWorkerHealth)', async () => {
    const h = await getCorpusHealth()
    expect(h.worker).toBeTruthy()
    expect(h.worker).toHaveProperty('status')
    expect(['idle', 'processing', 'stale']).toContain(h.worker.status)
    expect(h.worker).toHaveProperty('queueDepth')
    expect(h.worker).toHaveProperty('intakeBacklog')
  })
})
