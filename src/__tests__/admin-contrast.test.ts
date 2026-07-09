import { actionButton, dangerButton } from '@/app/admin/lib/buttonStyles'
import { STATUS_META } from '@/app/admin/components/StatusChip'
import { PROVENANCE_BADGE } from '@/app/admin/lib/provenance'

// WCAG 2.x relative luminance + contrast ratio.
const channel = (v: number) => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  let h = hex.replace('#', '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrast = (fg: string, bg: string) => {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const AA = 4.5

describe('admin colour contrast meets WCAG AA (>= 4.5:1)', () => {
  it('shared button text on white', () => {
    expect(
      contrast(actionButton.color as string, '#fff'),
    ).toBeGreaterThanOrEqual(AA)
    expect(
      contrast(dangerButton.color as string, '#fff'),
    ).toBeGreaterThanOrEqual(AA)
  })

  it('secondary text colour on white', () => {
    expect(contrast('#595959', '#fff')).toBeGreaterThanOrEqual(AA)
  })

  it.each(Object.entries(STATUS_META))('StatusChip %s', (_status, meta) => {
    expect(contrast(meta.color, meta.bg)).toBeGreaterThanOrEqual(AA)
  })

  it.each(Object.entries(PROVENANCE_BADGE))(
    'provenance badge %s',
    (_src, badge) => {
      expect(contrast(badge.color, badge.bg)).toBeGreaterThanOrEqual(AA)
    },
  )
})
