import { isEnglishText } from '@/lib/ensure-english'

describe('isEnglishText (issue #387 guards)', () => {
  it('flags the mirrored Chinese relates/why strings from issue #387', () => {
    expect(
      isEnglishText(
        '關鍵提到深圳的Yantian Port Group和電動支線卡車，但與Yantian-Pinghunan railway無明確關聯。',
      ),
    ).toBe(false)
    expect(
      isEnglishText(
        '概述城市與淨零政策，未提及Yantian-Pinghunan railway或具體鐵路項目。',
      ),
    ).toBe(false)
  })

  it('accepts English explanations', () => {
    expect(
      isEnglishText(
        "Key mentions include Shenzhen's Yantian Port Group and electric feeder trucks, but there is no clear link to the Yantian-Pinghunan railway.",
      ),
    ).toBe(true)
    expect(
      isEnglishText(
        'Provides an overview of cities and net-zero policies; makes no mention of the Yantian-Pinghunan railway.',
      ),
    ).toBe(true)
    expect(isEnglishText(42)).toBe(true)
  })

  it('flags other non-English scripts (Hebrew, Greek, Cyrillic)', () => {
    expect(isEnglishText('שלום')).toBe(false)
    expect(isEnglishText('Η συνάντηση ξεκίνησε')).toBe(false)
    expect(isEnglishText('модель углеродного рынка')).toBe(false)
  })

  it('pins the accepted tradeoffs: mixed-script is nuked, empty string passes', () => {
    // English sentence quoting a CJK title — intended false (documented ceiling).
    expect(
      isEnglishText('The passage cites 《深圳低碳政策》 on transport.'),
    ).toBe(false)
    // Empty string passes through; consumer-side || fallback covers it.
    expect(isEnglishText('')).toBe(true)
  })
})
