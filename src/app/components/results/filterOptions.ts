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
  const names = new Set<string>()
  for (const row of catalog) {
    const name = languageNameFromCode(row.language)
    if (name) names.add(name)
  }
  return [...names].sort().map((name) => ({
    name: name.toLowerCase().replace(/\s+/g, '-'),
    value: name.toLowerCase(),
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
