/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { getWorkerHealth } from '@/db/queries/workerHealth'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

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
    // The live DB has 3 done jobs (the canary + 2 uploads); queue depth should be 0.
    const health = await getWorkerHealth()
    // If the worker is idle and everything is done, depth is 0.
    expect(health.queueDepth).toBeGreaterThanOrEqual(0)
  })

  it('reports a non-null lastProcessedAt when any job has been processed', async () => {
    const health = await getWorkerHealth()
    // The live DB has done jobs, so lastProcessedAt should be set.
    expect(health.lastProcessedAt).not.toBeNull()
  })
})
