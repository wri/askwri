import { buildCatalogIndex, normalizeCatalogRow } from '@/app/utils/utils'

type CatalogResult = {
  catalog: any[]
  index: ReturnType<typeof buildCatalogIndex> | null
}

let cached: Promise<CatalogResult> | null = null

export function getCatalog(): Promise<CatalogResult> {
  if (cached) return cached

  cached = fetch('/api/catalog')
    .then(async (res) => {
      if (!res.ok) return { catalog: [], index: null }
      const j = await res.json()
      const catalog = (j.items as any[]).map(normalizeCatalogRow)
      return { catalog, index: buildCatalogIndex(catalog) }
    })
    .catch(() => {
      cached = null
      return { catalog: [], index: null }
    })

  return cached
}

export function _resetForTests() {
  cached = null
}
