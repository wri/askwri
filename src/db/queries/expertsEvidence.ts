import { AppDataSource } from '../data-source'
import type { WorkRow } from '../../lib/experts/types'

/** Office spelling drift on the documents column (WRI México vs WRI Mexico).
 *  Normalized on read; the stored value is left alone (editors own it). */
export function normalizeOffice(office: string | null): string | null {
  if (!office) return null
  const trimmed = office.replace(/\s+/g, ' ').trim()
  if (/^wri m[ée]xico$/i.test(trimmed)) return 'WRI Mexico'
  return trimmed
}

/** Authors are `;`-separated (see parseAuthors in src/app/utils/utils.tsx —
 *  commas belong to the name). */
function splitAuthors(s: string | null): string[] {
  return (s || '')
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean)
}

// One row per WORK. A confirmed translation whose original is also searchable
// folds into the original; a translation whose original is withdrawn stands
// alone. Tags are the accepted union across the work's rows.
const WORKS_SQL = `
  WITH tr AS (
    SELECT r.related_document_id AS original_id, r.document_id AS translation_id
    FROM document_relations r
    JOIN documents t ON t.id = r.document_id AND t.status = 'searchable'
    JOIN documents o ON o.id = r.related_document_id AND o.status = 'searchable'
    WHERE r.status = 'confirmed' AND r.relation_type = 'translation_of'
  ),
  originals AS (
    SELECT d.* FROM documents d
    WHERE d.status = 'searchable'
      AND NOT EXISTS (SELECT 1 FROM tr WHERE tr.translation_id = d.id)
  ),
  members AS (
    SELECT o.id AS work_id, o.id AS doc_id FROM originals o
    UNION ALL
    SELECT tr.original_id AS work_id, tr.translation_id AS doc_id FROM tr
  )
  SELECT o.external_id AS "docId",
         COALESCE(o.title_en, o.title, '') AS title,
         o.year_published AS year,
         o.article_type AS type,
         o.wri_primary_office AS office,
         o.url,
         o.authors AS "authorsOriginal",
         COALESCE((SELECT array_agg(t.external_id ORDER BY t.external_id)
                   FROM tr JOIN documents t ON t.id = tr.translation_id
                   WHERE tr.original_id = o.id), '{}') AS translations,
         COALESCE((SELECT array_agg(t.authors ORDER BY t.external_id)
                   FROM tr JOIN documents t ON t.id = tr.translation_id
                   WHERE tr.original_id = o.id AND t.authors IS NOT NULL), '{}') AS "authorsTranslations",
         COALESCE((SELECT array_agg(DISTINCT tg.value_id)
                   FROM members m JOIN document_tags dt ON dt.document_id = m.doc_id AND dt.status = 'accepted'
                   JOIN tags tg ON tg.id = dt.tag_id AND tg.facet = 'topic'
                   WHERE m.work_id = o.id), '{}') AS topics,
         COALESCE((SELECT array_agg(DISTINCT tg.value_id)
                   FROM members m JOIN document_tags dt ON dt.document_id = m.doc_id AND dt.status = 'accepted'
                   JOIN tags tg ON tg.id = dt.tag_id AND tg.facet = 'geography'
                   WHERE m.work_id = o.id), '{}') AS geographies
  FROM originals o
  ORDER BY o.external_id
`

interface RawWork {
  docId: string
  title: string
  year: number | null
  type: string | null
  office: string | null
  url: string | null
  authorsOriginal: string | null
  translations: string[]
  authorsTranslations: string[]
  topics: string[]
  geographies: string[]
}

export async function loadSearchableWorks(): Promise<WorkRow[]> {
  const rows: RawWork[] = await AppDataSource.query(WORKS_SQL)
  return rows.map((r) => {
    const authors = splitAuthors(r.authorsOriginal)
    const seen = new Set(authors)
    for (const extra of r.authorsTranslations) {
      for (const a of splitAuthors(extra)) {
        if (!seen.has(a)) {
          seen.add(a)
          authors.push(a)
        }
      }
    }
    return {
      docId: r.docId,
      translations: r.translations,
      title: r.title,
      year: r.year,
      type: r.type,
      office: normalizeOffice(r.office),
      url: r.url,
      authorsRaw: authors,
      topics: r.topics,
      geographies: r.geographies,
    }
  })
}
