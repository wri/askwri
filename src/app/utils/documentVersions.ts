import { languageNameFromCode } from './utils'

export type DocumentVersion = {
  language: string
  url: string
  externalId?: string
  isOriginal?: boolean
  description?: string
}

export const ORIGINAL_LANGUAGE_NOTE =
  "This is the source publication's original language."
export const TRANSLATION_LANGUAGE_NOTE =
  'Official translation published by the author.'

export function getDocumentVersionFallback(
  rowData: any,
  currentLanguageLabel: string,
): DocumentVersion[] {
  const url =
    rowData.download_url || rowData.fullDoc._url || rowData.fullDoc.url
  if (!url) return []

  return [
    {
      language: currentLanguageLabel || 'Document',
      url,
    },
  ]
}

export async function fetchDocumentVersions(
  rowData: any,
  currentLanguageLabel: string,
): Promise<DocumentVersion[]> {
  const fallback = getDocumentVersionFallback(rowData, currentLanguageLabel)

  try {
    const res = await fetch(
      `/api/documents/${encodeURIComponent(String(rowData.id))}/versions`,
    )
    if (!res.ok) throw new Error('versions unavailable')

    const payload = await res.json()
    const versions = Array.isArray(payload?.versions)
      ? payload.versions
          .filter((v: any) => v?.url)
          .map((v: any) => ({
            language: languageNameFromCode(v.language) || 'Document',
            url: v.url,
            externalId: v.externalId,
            isOriginal: !!v.isOriginal,
          }))
      : []

    if (versions.length > 1) {
      for (const v of versions) {
        v.description = v.isOriginal
          ? ORIGINAL_LANGUAGE_NOTE
          : TRANSLATION_LANGUAGE_NOTE
      }
    }

    return versions.length ? versions : fallback
  } catch {
    return fallback
  }
}
