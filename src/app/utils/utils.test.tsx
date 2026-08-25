import type { DocMeta } from '@/lib/llamacloud'
import {
  languageLabel,
  normalizeCatalogRow,
  buildCatalogIndex,
  matchCatalogRow,
  titleFrom,
  authorsFrom,
  yearFrom,
  publisherFrom,
  chicagoFull,
} from './utils'

const zhItem = {
  file_id: '',
  file_name: '2011_chengdu.pdf',
  external_file_id: '',
  meta: {
    file_path: '2011_chengdu.pdf',
    // Stale CSV payload: bilingual title, no authors, wrong language.
    metadata: JSON.stringify({
      'Publication Title':
        '成都市小汽车拥有与使用政策战略研究 (Smart Strategies)',
      languages: 'English',
    }),
    summary: 'Legacy CSV summary.',
    dms: {
      doc_id: '2011_chengdu_0001',
      title: '成都市小汽车拥有与使用政策战略研究',
      title_en: 'Smart Strategies for Private Vehicle Ownership in Chengdu',
      authors: 'Qiu, Shiyong; Liu, Daizong',
      year_published: 2011,
      wri_primary_office: 'WRI China',
      language: 'zh',
      languages: ['zh'],
      summary_en: 'Long English summary.',
      short_summary_en: 'Short English summary.',
    },
  },
}

const doc = (overrides: Partial<DocMeta> = {}): DocMeta =>
  ({
    doc_id: '2011_chengdu_0001',
    ref: 'r',
    title: '成都市小汽车拥有与使用政策战略研究 (Smart Strategies)',
    kps: [],
    ...overrides,
  }) as DocMeta

describe('languageLabel', () => {
  it('returns empty for English or missing', () => {
    expect(languageLabel(undefined)).toBe('')
    expect(languageLabel({})).toBe('')
    expect(languageLabel({ language: 'en' })).toBe('')
  })
  it('names the document language for non-English documents', () => {
    expect(languageLabel({ language: 'es' })).toBe('Spanish')
    expect(languageLabel({ language: 'zh' })).toBe('Chinese')
    expect(languageLabel({ language: 'pt' })).toBe('Portuguese')
  })
  it('ignores the stale CSV languages field', () => {
    // Three English docs in the corpus carry languages='Chinese' in the CSV,
    // which is what made English-only docs render a Chinese badge (#306).
    expect(
      languageLabel({ language: 'en', raw: { languages: 'Chinese' } }),
    ).toBe('')
  })
  it('falls back to the uppercased code for unmapped languages', () => {
    expect(languageLabel({ language: 'sw' })).toBe('SW')
  })
})

describe('normalizeCatalogRow with document-management fields', () => {
  it('prefers the DMS columns over the legacy CSV metadata', () => {
    const row = normalizeCatalogRow(zhItem)
    expect(row.titleEn).toBe(
      'Smart Strategies for Private Vehicle Ownership in Chengdu',
    )
    expect(row.nativeTitle).toBe('成都市小汽车拥有与使用政策战略研究')
    expect(row.allAuthors).toBe('Qiu, Shiyong; Liu, Daizong')
    expect(row.yearAccepted).toBe(2011)
    expect(row.office).toBe('WRI China')
    expect(row.language).toBe('zh')
    expect(row.summary).toBe('Long English summary.')
    expect(row.shortSummary).toBe('Short English summary.')
    expect(row.docId).toBe('2011_chengdu_0001')
  })

  it('still reads the legacy CSV shape when no dms block is present', () => {
    const row = normalizeCatalogRow({
      file_id: '',
      file_name: 'legacy.pdf',
      external_file_id: '',
      meta: {
        file_path: 'legacy.pdf',
        metadata: JSON.stringify({
          'Publication Title': 'A Legacy Report',
          'All authors': 'Smith, John',
          'year accepted': '2019',
        }),
        summary: 'CSV summary.',
      },
    })
    expect(row.publicationTitle).toBe('A Legacy Report')
    expect(row.allAuthors).toBe('Smith, John')
    expect(row.yearAccepted).toBe(2019)
    expect(row.summary).toBe('CSV summary.')
    expect(row.language).toBeUndefined()
  })
})

describe('matchCatalogRow', () => {
  it('matches on doc_id exactly', () => {
    const index = buildCatalogIndex([normalizeCatalogRow(zhItem)])
    // No filename or title overlap — only doc_id can match this.
    const matched = matchCatalogRow(
      doc({ title: 'unrelated', _url: 'unrelated.pdf' }),
      index,
    )
    expect(matched?.titleEn).toBe(
      'Smart Strategies for Private Vehicle Ownership in Chengdu',
    )
  })
})

describe('field accessors', () => {
  const row = normalizeCatalogRow(zhItem)

  it('titleFrom returns the English title, not the bilingual chunk title', () => {
    expect(titleFrom(doc(), row)).toBe(
      'Smart Strategies for Private Vehicle Ownership in Chengdu',
    )
  })

  it('authorsFrom returns transliterated authors when chunk metadata has none', () => {
    expect(authorsFrom(doc(), row)).toEqual(['Qiu, Shiyong', 'Liu, Daizong'])
  })

  it('yearFrom prefers the DMS year over stale chunk metadata', () => {
    expect(yearFrom(doc({ year: 1999 }), row)).toBe(2011)
  })

  it('publisherFrom uses the WRI office, falling back to Washington, DC', () => {
    expect(publisherFrom(row)).toBe('WRI China')
    expect(publisherFrom({})).toBe('Washington, DC: WRI')
    expect(publisherFrom({ office: 'WRI Global' })).toBe('Washington, DC: WRI')
  })

  it('chicagoFull carries authors, English title, office and year', () => {
    expect(chicagoFull(doc(), row)).toBe(
      'Qiu, Shiyong; Liu, Daizong. "Smart Strategies for Private Vehicle Ownership in Chengdu". WRI China, 2011.',
    )
  })
})
