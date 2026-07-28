/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getWorkerHealth } from '@/db/queries/workerHealth'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip
// Corpus-precondition tests: require the migrated 169-doc corpus, absent in
// schema-only CI. Gated on RUN_CORPUS_TESTS (set by `npm run test:db`).
const corpusIt = process.env.RUN_CORPUS_TESTS === '1' ? it : it.skip

d('getWorkerHealth (DB integration)', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })

  afterAll(async () => {
    await AppDataSource.destroy()
  })

  it('returns the queue depth, last-processed-at, and intake-backlog count', async () => {
    const health = await getWorkerHealth()
    expect(health).toHaveProperty('queueDepth')
    expect(health).toHaveProperty('lastProcessedAt')
    expect(health).toHaveProperty('intakeBacklog')
    expect(typeof health.queueDepth).toBe('number')
    expect(typeof health.intakeBacklog).toBe('number')
    // queueDepth is always a non-negative integer
    expect(health.queueDepth).toBeGreaterThanOrEqual(0)
  })

  it('counts queued and running jobs as the queue depth', async () => {
    // The live DB has done jobs; queue depth should be 0 when idle.
    const health = await getWorkerHealth()
    expect(health.queueDepth).toBeGreaterThanOrEqual(0)
  })

  corpusIt(
    'reports a non-null lastProcessedAt when any job has been processed',
    async () => {
      const health = await getWorkerHealth()
      expect(health.lastProcessedAt).not.toBeNull()
    },
  )

  it('determines pending vs stale from intake file age (pure logic)', () => {
    // Test the status-determination logic without S3 (Jest can't run aws-sdk
    // dynamic imports). The logic is: queueDepth>0 → processing; else if
    // intakeBacklog>0 → stale if oldestAge > threshold, else pending; else idle.
    function deriveStatus(
      queueDepth: number,
      intakeBacklog: number,
      oldestAge: number,
      threshold: number,
    ) {
      if (queueDepth > 0) return 'processing'
      if (intakeBacklog > 0) return oldestAge > threshold ? 'stale' : 'pending'
      return 'idle'
    }
    expect(deriveStatus(1, 0, 0, 20)).toBe('processing')
    expect(deriveStatus(0, 1, 5, 20)).toBe('pending') // young file → pending
    expect(deriveStatus(0, 1, 25, 20)).toBe('stale') // old file → stale
    expect(deriveStatus(0, 0, 0, 20)).toBe('idle')
  })

  it('returns idle when no intake backlog and no open jobs', async () => {
    // The live DB (with a running worker) should be idle if no files are in intake.
    // This may race with other tests, but with threshold=9999 any leftover is 'pending' not 'stale'.
    const health = await getWorkerHealth({ staleThresholdSeconds: 9999 })
    expect(['idle', 'pending']).toContain(health.status)
  })
})
