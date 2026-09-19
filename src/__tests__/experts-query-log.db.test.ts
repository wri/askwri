/** @jest-environment node */
import { AppDataSource } from '@/db/data-source'
import { insertExpertsModeQueryLog } from '@/db/queries/insertExpertsModeQueryLog'

const hasDb = !!process.env.DATABASE_URL
const d = hasDb ? describe : describe.skip

d('experts_mode_query_logs', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  })
  afterAll(async () => {
    await AppDataSource.query(
      `DELETE FROM experts_mode_query_logs WHERE query LIKE '__test_experts_%'`,
    )
    await AppDataSource.destroy()
  })

  it('inserts a row with mode and top ten people', async () => {
    const row = await insertExpertsModeQueryLog({
      query: '__test_experts_electric buses',
      mode: 'evidence',
      topTenPeople: JSON.stringify(['Xue, Lulu']),
    })
    expect(row.id).toBeGreaterThan(0)
    const [back] = await AppDataSource.query(
      `SELECT query, mode, top_ten_people AS "topTenPeople" FROM experts_mode_query_logs WHERE id = $1`,
      [row.id],
    )
    expect(back).toEqual({
      query: '__test_experts_electric buses',
      mode: 'evidence',
      topTenPeople: '["Xue, Lulu"]',
    })
  })
})
