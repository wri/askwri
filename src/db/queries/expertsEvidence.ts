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

// One row per WORK: the ROOT of a confirmed-translation chain, plus every
// searchable doc that reaches it. `document_relations` only records a direct
// original, and chains occur (leaf -> mid -> root), so the root is resolved by
// walking the edges rather than by "is not anybody's translation" — filing the
// leaf under a mid that is itself not an original dropped the leaf from the
// corpus entirely and silently shrank N. A doc has at most one confirmed
// original (partial unique index UQ_document_relations_confirmed), so the walk
// is a function; the path guard is there only because a cycle of length >= 3
// is not forbidden by that index and would otherwise never terminate. A
// translation whose original is withdrawn has no edge here, so it stands alone
// as its own work. Tags are the accepted union across the work's rows.
const WORKS_SQL = `
  WITH RECURSIVE pairs AS (
    SELECT r.document_id AS translation_id, r.related_document_id AS original_id
    FROM document_relations r
    JOIN documents t ON t.id = r.document_id AND t.status = 'searchable'
    JOIN documents o ON o.id = r.related_document_id AND o.status = 'searchable'
    WHERE r.status = 'confirmed' AND r.relation_type = 'translation_of'
  ),
  walk AS (
    SELECT d.id AS doc_id, d.id AS cur, ARRAY[d.id] AS path
    FROM documents d
    WHERE d.status = 'searchable'
    UNION ALL
    SELECT w.doc_id, p.original_id, w.path || p.original_id
    FROM walk w
    JOIN pairs p ON p.translation_id = w.cur
    WHERE NOT (p.original_id = ANY(w.path))
  ),
  members AS (
    SELECT DISTINCT ON (doc_id) doc_id, cur AS work_id
    FROM walk
    ORDER BY doc_id, array_length(path, 1) DESC
  ),
  originals AS (
    SELECT d.* FROM documents d
    JOIN members m ON m.doc_id = d.id AND m.work_id = d.id
  )
  SELECT o.external_id AS "docId",
         COALESCE(o.title_en, o.title, '') AS title,
         o.year_published AS year,
         o.article_type AS type,
         o.wri_primary_office AS office,
         o.url,
         o.authors AS "authorsOriginal",
         COALESCE((SELECT array_agg(t.external_id ORDER BY t.external_id)
                   FROM members m JOIN documents t ON t.id = m.doc_id
                   WHERE m.work_id = o.id AND m.doc_id <> o.id), '{}') AS translations,
         COALESCE((SELECT array_agg(t.authors ORDER BY t.external_id)
                   FROM members m JOIN documents t ON t.id = m.doc_id
                   WHERE m.work_id = o.id AND m.doc_id <> o.id AND t.authors IS NOT NULL), '{}') AS "authorsTranslations",
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
