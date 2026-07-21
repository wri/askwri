import { PROVENANCE_KEY, PROVENANCE_LABEL } from '../lib/metadataProvenance'

describe('metadataProvenance', () => {
  it('maps every editable entity property to its snake_case column', () => {
    expect(PROVENANCE_KEY.title).toBe('title')
    expect(PROVENANCE_KEY.titleEn).toBe('title_en')
    expect(PROVENANCE_KEY.yearPublished).toBe('year_published')
    expect(PROVENANCE_KEY.publicationTitle).toBe('publication_title')
    expect(PROVENANCE_KEY.articleType).toBe('article_type')
    expect(PROVENANCE_KEY.wriPrimaryOffice).toBe('wri_primary_office')
    expect(PROVENANCE_KEY.datePublished).toBe('date_published')
    expect(PROVENANCE_KEY.languages).toBe('languages')
  })

  it('has a plain-language label for every provenance source', () => {
    expect(PROVENANCE_LABEL.human).toMatch(/person/i)
    expect(PROVENANCE_LABEL.external).toMatch(/import/i)
    expect(PROVENANCE_LABEL.llm).toMatch(/AI/)
  })
})
