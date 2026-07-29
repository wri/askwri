import { extractPassage } from '@/app/utils/passage'

// Real `/query` payloads. `content` is a passage WINDOW: ~150 chars of preceding
// document text, the retrieved chunk inside `**[ ... ]**`, then trailing text.
describe('extractPassage', () => {
  it('keeps only the marked chunk, dropping the leading context window', () => {
    const window =
      'subsidies on charging facilities CAPEX and/or O&M | ' +
      '**[no less than 80% of annual newly added or replaced buses should be NEVs]**' +
      ' Further, if radical strategies are adopted'
    expect(extractPassage(window)).toBe(
      'no less than 80% of annual newly added or replaced buses should be NEVs',
    )
  })

  it('drops the running header and table tail that precede a Chinese passage', () => {
    // Verbatim shape of the excerpt reported in #309 (Citation 1.2, page 10):
    // the window opened on a numeric table and the PDF running header, so the
    // reader saw the document title again instead of the cited passage.
    const window =
      '55%  |\n|  **激进情景**  |   |   |   |   |\n|  新能源乘用车保有量(万辆) | 124 (22%) | 673 (100%)  |\n\n' +
      '数据来源：本研究计算\n\n8\n\n' +
      'Quantifying the Grid Impacts from Large Adoption of Electric Vehicles in China\n\n' +
      '**[当城市新能源汽车数量增长加速，2035年城市电网峰值负荷的增幅在10%~11%左右。]**' +
      ' 因此，各城市需要结合自身发展路径。'
    const out = extractPassage(window)
    expect(out).toBe(
      '当城市新能源汽车数量增长加速，2035年城市电网峰值负荷的增幅在10%~11%左右。',
    )
    expect(out).not.toContain('Quantifying the Grid Impacts')
    expect(out).not.toContain('数据来源')
  })

  it('never leaks the marker syntax or bold runs into the excerpt', () => {
    const out = extractPassage('lead **[a **bold** claim]** trail')
    expect(out).toBe('a bold claim')
    expect(out).not.toMatch(/\*\*/)
    expect(out).not.toContain('[')
  })

  it('drops image placeholders left by the PDF parser', () => {
    expect(
      extractPassage(
        '**[分布情况  ● 中国 ● 国际  ![img-20.jpeg](img-20.jpeg)  排名前十的城市]**',
      ),
    ).toBe('分布情况 ● 中国 ● 国际 排名前十的城市')
  })

  it('strips an image placeholder orphaned by the chunk boundary', () => {
    // Observed on qa: the chunk begins right after the `!`, so the `!` stays in
    // the discarded context and the span opens on `[img-2.jpeg](img-2.jpeg)`.
    expect(
      extractPassage(
        '图 ES-5 !**[[img-2.jpeg](img-2.jpeg) 数据来源：本研究计算]**',
      ),
    ).toBe('数据来源：本研究计算')
  })

  it('strips a placeholder the chunk boundary cut in half at the end', () => {
    // Observed on deployed qa: the chunk ends mid-placeholder, so the closing
    // `)` never arrives and the reader sees `![img-105.jpeg](img-105.`
    expect(
      extractPassage(
        '**[Electric Vehicles in China ![img-105.jpeg](img-105.]**',
      ),
    ).toBe('Electric Vehicles in China')
  })

  it('strips a lone trailing `!` left by a placeholder cut before its bracket', () => {
    expect(
      extractPassage('**[(Charging power: 7kW, Coincidence factor: 21%) !]**'),
    ).toBe('(Charging power: 7kW, Coincidence factor: 21%)')
  })

  it('keeps real prose that ends in an exclamation mark', () => {
    expect(extractPassage('**[Cities must act now!]**')).toBe(
      'Cities must act now!',
    )
  })

  it('keeps ordinary markdown links, which are not placeholders', () => {
    expect(
      extractPassage('**[see [the guidebook](https://wri.org/x) for more]**'),
    ).toBe('see [the guidebook](https://wri.org/x) for more')
  })

  it('strips the search service context-match-failed marker', () => {
    expect(extractPassage('**[the chunk]** (context match failed)')).toBe(
      'the chunk',
    )
  })

  it('returns the tidied whole string when no markers are present', () => {
    // Guards a future search-service change that stops windowing.
    expect(extractPassage('a plain   chunk\nof text')).toBe(
      'a plain chunk of text',
    )
  })

  it('falls back to everything after an unclosed marker', () => {
    expect(extractPassage('lead **[truncated passage')).toBe(
      'truncated passage',
    )
  })

  it('handles empty, whitespace, null and undefined input', () => {
    expect(extractPassage('')).toBe('')
    expect(extractPassage('   \n ')).toBe('')
    expect(extractPassage(null)).toBe('')
    expect(extractPassage(undefined)).toBe('')
  })
})
