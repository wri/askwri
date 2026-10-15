import { getCatalog } from '@/lib/catalog-cache'
import { languageNameFromCode } from '@/app/utils/utils'

export interface FilterOption {
  name: string
  value: string
  children: string
}

const normalizeOffice = (office: string): string =>
  office
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')

export async function getLanguageOptions(): Promise<FilterOption[]> {
  const { catalog } = await getCatalog()
  const byCode = new Map<string, string>()
  for (const row of catalog) {
    const code = String(row.language ?? '').trim().toLowerCase()
    if (!code) continue
    if (!byCode.has(code)) byCode.set(code, languageNameFromCode(code))
  }
  return [...byCode.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => ({
    // Value is the ISO code: the URL and the backend language column use
    // codes ('es'), while the checkbox label shows the full name ('Spanish').
    name: code,
    value: code,
    children: name,
  }))
}

export async function getOfficeOptions(): Promise<FilterOption[]> {
  const { catalog } = await getCatalog()
  const byKey = new Map<string, string>()
  for (const row of catalog) {
    const office = row.office
    if (!office) continue
    const key = normalizeOffice(office)
    if (!byKey.has(key)) byKey.set(key, office)
  }
  return [...byKey.values()].sort().map((office) => ({
    name: normalizeOffice(office).replace(/\s+/g, '-'),
    // Accent-free value: the URL and the query use "WRI Mexico" while the
    // server matches both "WRI México" and "WRI Mexico" in the corpus.
    value: normalizeOffice(office)
      .split(' ')
      .map((w) =>
        w === 'wri' ? 'WRI' : w.charAt(0).toUpperCase() + w.slice(1),
      )
      .join(' '),
    children: office
      .replace(/^WRI\s+/i, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
  }))
}
