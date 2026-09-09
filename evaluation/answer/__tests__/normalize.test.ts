/** @jest-environment node */
import { langOf, normalize, snippetContained } from '../normalize'
import { extractPassage } from '../../../src/app/utils/passage'

// The 15-entry fold table of lookup_chunk_id.py's _FULLWIDTH_TO_HALFWIDTH,
// asserted pair-by-pair so a transcription typo in either column cannot hide.
const FULLWIDTH_PAIRS: Array<[string, string]> = [
  ['，', ','],
  ['。', '.'],
  ['：', ':'],
  ['；', ';'],
  ['！', '!'],
  ['？', '?'],
  ['（', '('],
  ['）', ')'],
  ['【', '['],
  ['】', ']'],
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"],
  ['—', '-'],
]

describe('normalize (TS mirror of lookup_chunk_id.py)', () => {
  it.each(FULLWIDTH_PAIRS)('folds full-width %s to half-width %s', (fw, hw) => {
    expect(normalize(fw)).toBe(hw)
  })

  it('makes the full-width and half-width variants of the observed OCR drift equal', () => {
    // The python tool observed the same zh sentence styled with "，" in some
    // places and ASCII "," in others; both must normalize identically.
    expect(normalize('新能源重卡，包括：')).toBe(normalize('新能源重卡,包括:'))
  })

  it('strips markdown image syntax — the serving pipeline deletes it from chunk text', () => {
    // Verified 2026-09-09: served = DB text minus image refs, so a quote
    // spanning one must strip it to ever be contained.
    const dbQuote =
      '成本回收期(区域运输场景,MY2024-2035)![img-7.jpeg](img-7.jpeg)驶向2035:中国研究'
    const served = '成本回收期(区域运输场景,MY2024-2035)驶向2035:中国研究'
    expect(snippetContained(dbQuote, served)).toBe(true)
  })

  it('preserves ordinary links while stripping image placeholders', () => {
    expect(normalize('see [the report](http://x) here')).toBe(
      'see[the report](http://x)here',
    )
    expect(normalize('a ![alt](u) b [l](v) c')).toBe('a b[l](v)c')
    expect(normalize('left ![wri logo]() right')).toBe('left right')
  })

  it.each([
    '中国![img-7.jpeg](img-7.jpeg)研究',
    'regional![img-7.jpeg](img-7.jpeg)delivery',
    '[img-7.jpeg](img-7.jpeg)研究',
  ])('matches served image whitespace for %s', (snippet) => {
    expect(snippetContained(snippet, extractPassage(snippet))).toBe(true)
  })

  it('strips markdown emphasis characters a copier might carry over', () => {
    expect(normalize('**bold** and `code`')).toBe(normalize('bold and code'))
    expect(normalize('# heading _under_')).toBe(normalize('heading under'))
  })

  it('collapses whitespace runs, including newlines', () => {
    expect(normalize('foo\nbar')).toBe(normalize('foo bar'))
    expect(normalize('a\tb')).toBe(normalize('a b'))
  })

  it('drops whitespace around punctuation (", " vs "," drift)', () => {
    expect(normalize('a, b')).toBe(normalize('a,b'))
    expect(normalize('a , b')).toBe(normalize('a,b'))
  })

  it('trims and lowercases', () => {
    expect(normalize('  Hello World  ')).toBe('hello world')
  })
})

describe('snippetContained', () => {
  it('does not equate different claims inside ordinary links', () => {
    expect(
      snippetContained(
        'See [electric trucks](https://wri.org/trucks) for details.',
        extractPassage('See [coal plants](https://wri.org/coal) for details.'),
      ),
    ).toBe(false)
    expect(
      snippetContained(
        '[Emissions fell by 40 percent](https://wri.org/report)',
        'unrelated text',
      ),
    ).toBe(false)
  })

  it.each(['', '  ', '**', '![img-7.jpeg](img-7.jpeg)'])(
    'rejects snippets with no normalized evidence: %s',
    (snippet) =>
      expect(snippetContained(snippet, 'unrelated text')).toBe(false),
  )
  const chunkA = 'alpha beta gamma'
  const chunkB = 'delta epsilon zeta'

  it('true when the normalized snippet sits inside the normalized chunk', () => {
    expect(snippetContained('Beta  gamma', `pre ${chunkA} post`)).toBe(true)
  })

  it('false when the snippet is absent', () => {
    expect(snippetContained('omega', chunkA)).toBe(false)
  })

  it('false for a snippet straddling two chunks (containment, not n-gram)', () => {
    // The harness scores exact normalized containment only; n-gram tolerance
    // is the python lookup tool's concern.
    const straddler = 'beta gamma delta'
    expect(snippetContained(straddler, chunkA)).toBe(false)
    expect(snippetContained(straddler, chunkB)).toBe(false)
  })
})

describe('langOf', () => {
  it("is 'zh' when the text contains CJK codepoints", () => {
    expect(langOf('在测算新能源重卡的成本回收期')).toBe('zh')
  })

  it("is 'latin' otherwise", () => {
    expect(langOf('plain english text')).toBe('latin')
  })
})
