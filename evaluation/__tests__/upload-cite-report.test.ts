/** @jest-environment node */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findLatestCiteReport, uploadCiteReport } from '../upload-cite-report'

const tmpResults = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'cite-results-'))

describe('findLatestCiteReport', () => {
  it('picks the newest eval-report-*.json by name (timestamped) and ignores other files', () => {
    const dir = tmpResults()
    for (const f of [
      'eval-report-2026-08-01T00-00-00.json',
      'eval-report-2026-09-01T00-00-00.json',
      'eval-report-2026-09-01T00-00-00.html',
      'answer-retrieval-2026-09-02.json',
    ]) {
      fs.writeFileSync(path.join(dir, f), '{}')
    }
    expect(findLatestCiteReport(dir)).toBe(
      path.join(dir, 'eval-report-2026-09-01T00-00-00.json'),
    )
  })

  it('returns null when there is no report (or no results dir)', () => {
    expect(findLatestCiteReport(tmpResults())).toBeNull()
    expect(
      findLatestCiteReport(path.join(os.tmpdir(), 'nope-' + Date.now())),
    ).toBeNull()
  })
})

describe('uploadCiteReport', () => {
  it('puts the latest report at <prefix>cite-report-latest.json with a JSON content type', async () => {
    const dir = tmpResults()
    fs.writeFileSync(
      path.join(dir, 'eval-report-2026-09-01T00-00-00.json'),
      '{"overall_recall":0.8}',
    )
    const puts: any[] = []
    const key = await uploadCiteReport({
      resultsDir: dir,
      bucket: 'my-bucket',
      prefix: 'eval-data/',
      put: async (p) => {
        puts.push(p)
      },
    })
    expect(key).toBe('eval-data/cite-report-latest.json')
    expect(puts).toEqual([
      {
        Bucket: 'my-bucket',
        Key: 'eval-data/cite-report-latest.json',
        Body: '{"overall_recall":0.8}',
        ContentType: 'application/json',
      },
    ])
  })

  it('throws (uploads nothing) when no report exists', async () => {
    const puts: any[] = []
    await expect(
      uploadCiteReport({
        resultsDir: tmpResults(),
        bucket: 'b',
        prefix: 'p/',
        put: async (p) => {
          puts.push(p)
        },
      }),
    ).rejects.toThrow(/no eval-report-\*\.json/)
    expect(puts).toEqual([])
  })
})
