// Three validated colorblind-safe hues (dataviz palette slots 1-3, all-pairs
// pass) for the three offices that are 80% of the corpus; everything else is
// one neutral. The exact office is always in text beside the color (spec §8).
export const OFFICE_COLORS: Record<string, string> = {
  'WRI Global': '#2a78d6',
  'WRI China': '#eb6834',
  'WRI India': '#1baf7a',
}
export const OTHER_OFFICE_COLOR = '#8A877E'
export const ACCENT = '#B8800A'
export const ACCENT_WASH = 'rgba(240, 171, 0, 0.34)'
export const INK = '#1b1a17'

export function officeColor(office: string | null): string {
  return (office && OFFICE_COLORS[office]) || OTHER_OFFICE_COLOR
}
