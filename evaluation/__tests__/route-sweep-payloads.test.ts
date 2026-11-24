/** @jest-environment node */
import { buildCatalogIndex, normalizeCatalogRow } from '@/app/utils/utils'
import { buildPayloads, fetchCatalogIndex } from '../route-sweep/payloads'
import type { FrozenCase } from '../route-sweep/types'

const TARGET = 'https://qa.askwrimvp.test'

// The citation-shaped document `/api/llamaindex` returns for cite mode: one
// kp per doc, its snippet the passage the UI shows in the Sources panel.
const doc = (
  docId: string,
  title: string,
  snippet: string,
  relevance_tier?: string,
) => ({
  doc_id: docId,
  ref: docId,
  title,
  authors: ['Surname, Given'],
  year: 2019,
  score: 0.7,
  relevance_tier,
  kps: [{ kp_relevance: 0.7, snippet, passage_id: `${docId}_chunk_1` }],
  meta: { raw: {} },
})

const frozenCase = (
  docs: any[],
  question = 'why does it matter?',
): FrozenCase => ({
  id: 'q1',
  question,
  docs,
  doc_count: docs.length,
})

/** A catalog item in the shape `/api/catalog` serves, as `normalizeCatalogRow`
 * expects it. */
const catalogItem = (docId: string, fields: Record<string, unknown>): any => ({
  file_id: `file-${docId}`,
  external_file_id: docId,
  file_name: `${docId}.pdf`,
  meta: { dms: { doc_id: docId, ...fields } },
})

const catalogIndex = () =>
  buildCatalogIndex(
    [
      catalogItem('doc-a', {
        title_en: 'Report A',
        authors: 'Qiu, Shiyong; Liu, Daizong',
        year_published: 2023,
        language: 'zh',
      }),
      catalogItem('doc-b', {
        title_en: 'Report B',
        authors: 'Lazer, Leah',
        year_published: 2021,
        language: 'en',
      }),
    ].map(normalizeCatalogRow),
  )

const docsAB = () => [
  doc('doc-a', 'title a (native)', 'snippet from A', 'strong'),
  doc('doc-b', 'title b (native)', 'snippet from B', 'partial'),
]

describe('fetchCatalogIndex', () => {
  const jsonResponse = (
    body: unknown,
    init: { ok?: boolean; status?: number } = {},
  ) =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: () => Promise.resolve(body),
    }) as unknown as Response

  it('fetch /api/catalog on the target and indexes it by doc id', async () => {
    const urls: string[] = []
    const fetchImpl = ((url: string) => {
      urls.push(url)
      return Promise.resolve(
        jsonResponse({
          ok: true,
          items: [
            catalogItem('doc-a', {
              title_en: 'Report A',
              authors: 'Qiu, Shiyong',
              year_published: 2023,
              language: 'es',
            }),
          ],
        }),
      )
    }) as unknown as typeof fetch

    const index = await fetchCatalogIndex(`${TARGET}/`, fetchImpl)

    expect(urls).toEqual([`${TARGET}/api/catalog`])
    expect(index?.byDocId?.get('doc-a')?.titleEn).toBe('Report A')
    expect(index?.byDocId?.get('doc-a')?.language).toBe('es')
  })

  it('returns null on a non-2xx catalog response', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse({}, { ok: false, status: 503 }),
      )) as unknown as typeof fetch

    expect(await fetchCatalogIndex(TARGET, fetchImpl)).toBeNull()
  })

  it('returns null when the catalog body is not JSON', async () => {
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      })) as unknown as typeof fetch

    expect(await fetchCatalogIndex(TARGET, fetchImpl)).toBeNull()
  })

  it('returns null when the catalog fetch rejects', async () => {
    const fetchImpl = (() =>
      Promise.reject(new Error('network down'))) as unknown as typeof fetch

    expect(await fetchCatalogIndex(TARGET, fetchImpl)).toBeNull()
  })
})

describe('buildPayloads', () => {
  it('builds {query, mode, passages:[{docTitle, snippet}]} for batch-why', () => {
    const c = frozenCase(docsAB())

    const why = buildPayloads(c, catalogIndex())['batch-why'] as any

    expect(Object.keys(why).sort()).toEqual(['mode', 'passages', 'query'])
    expect(why.mode).toBe('answer')
    expect(why.passages).toEqual([
      { docTitle: 'Report A', snippet: 'snippet from A' },
      { docTitle: 'Report B', snippet: 'snippet from B' },
    ])
    // Without a catalog row the title falls back to the chunk metadata, which
    // is why the index is worth fetching even though it is optional.
    const withoutCatalog = buildPayloads(c, null)['batch-why'] as any
    expect(withoutCatalog.passages).toEqual([
      { docTitle: 'title a (native)', snippet: 'snippet from A' },
      { docTitle: 'title b (native)', snippet: 'snippet from B' },
    ])
  })

  it('builds {query, docs:[{title, authors, year, snippet}]} for batch-relates', () => {
    const c = frozenCase(docsAB())

    const relates = buildPayloads(c, catalogIndex())['batch-relates'] as any

    expect(Object.keys(relates).sort()).toEqual(['docs', 'query'])
    expect(relates.query).toBe('why does it matter?')
    expect(relates.docs).toEqual([
      {
        title: 'Report A',
        authors: ['Qiu, Shiyong', 'Liu, Daizong'],
        year: 2023,
        snippet: 'snippet from A',
      },
      {
        title: 'Report B',
        authors: ['Lazer, Leah'],
        year: 2021,
        snippet: 'snippet from B',
      },
    ])
  })

  it('builds {query, resultsSummary} for alignment with the catalog index', () => {
    const c = frozenCase(docsAB())

    const withIndex = buildPayloads(c, catalogIndex()).alignment as any
    const withoutIndex = buildPayloads(c, null).alignment as any

    expect(Object.keys(withIndex).sort()).toEqual(['query', 'resultsSummary'])
    expect(withIndex.query).toBe('why does it matter?')
    expect(withIndex.resultsSummary).toContain(
      'Query: why does it matter?. Results: 2. Strong: 1. Partial: 1. Weak: 0.',
    )
    // The index is what puts the non-English languages in the summary; a
    // sweep without one silently loses them, which is why it is fetched.
    expect(withIndex.resultsSummary).toContain(
      'Languages among the results: Chinese.',
    )
    expect(withoutIndex.resultsSummary).not.toContain('Languages among')
    expect(withoutIndex.resultsSummary).toContain(
      'Sample passages: 1. title a (native)',
    )
    expect(withoutIndex.resultsSummary).toContain('excerpt: "snippet from A"')
  })

  it('builds {text} for translate from the first non-English snippet', () => {
    const c = frozenCase([
      doc('doc-a', 'a', 'plain english snippet'),
      doc('doc-b', 'b', '在测算新能源重卡的成本回收期'),
      doc('doc-c', 'c', 'otro texto en español'),
    ])

    const translate = buildPayloads(c, catalogIndex()).translate as any

    expect(Object.keys(translate)).toEqual(['text'])
    expect(translate.text).toBe('在测算新能源重卡的成本回收期')
  })

  it('falls back to the first snippet when no snippet is non-ASCII', () => {
    const c = frozenCase([
      doc('doc-a', 'a', 'first english snippet'),
      doc('doc-b', 'b', 'second english snippet'),
    ])

    const translate = buildPayloads(c, null).translate as any

    expect(translate.text).toBe('first english snippet')
  })

  it('uses the real question, not the UI placeholder "answer"', () => {
    const c = frozenCase(docsAB(), 'What is the projected penetration rate?')

    const payloads = buildPayloads(c, catalogIndex())

    expect((payloads['batch-why'] as any).query).toBe(
      'What is the projected penetration rate?',
    )
    expect((payloads['batch-relates'] as any).query).toBe(
      'What is the projected penetration rate?',
    )
    expect((payloads.alignment as any).query).toBe(
      'What is the projected penetration rate?',
    )
    // Pin the shipped UI's placeholder so this divergence stays deliberate:
    // if SupportingCitations.tsx stops sending 'answer', this test should be
    // revisited rather than silently kept.
    expect((payloads['batch-why'] as any).query).not.toBe('answer')
  })
})
