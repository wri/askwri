import { languageLabel } from './utils'

describe('languageLabel', () => {
  it('returns empty for English or missing', () => {
    expect(languageLabel(undefined)).toBe('')
    expect(languageLabel({})).toBe('')
    expect(languageLabel({ languages: 'English' })).toBe('')
  })
  it('returns the label for non-English documents', () => {
    expect(languageLabel({ languages: 'Spanish' })).toBe('Spanish')
    expect(languageLabel({ languages: 'Chinese' })).toBe('Chinese')
  })
  it('keeps multi-language values that include English', () => {
    expect(languageLabel({ languages: 'English, Portuguese' })).toBe(
      'English, Portuguese',
    )
  })
})
