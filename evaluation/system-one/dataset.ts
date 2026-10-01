/**
 * Document data shared by the System One harness scripts.
 *
 * Kept separate from run.ts because consensus.ts needs the identical document
 * basis and candidate sets — two consumers, one definition.
 */
import { Pool } from 'pg'
import type { Candidate } from './systems'

// Same SSL contract as src/db/data-source.ts: DATABASE_SSL=false for a local
// docker database, DATABASE_SSL_REJECT_UNAUTHORIZED=false to match what libpq's
// `require` does against RDS (encrypt, don't verify).
export const pool = new Pool({
  ssl:
    process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' },
})

export type Row = {
  document_id: string
  title: string
  basis: string
  gold: string | null
  candidates: Candidate[]
}

/** The gold label per document: WRI's own imported metadata, one value each. */
export async function loadGold(facet: string): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT dt.document_id, t.value_id AS gold
       FROM document_tags dt
       JOIN tags t ON t.id = dt.tag_id
      WHERE dt.source = 'external' AND t.facet = $1`,
    [facet],
  )
  return new Map(rows.map((r) => [r.document_id, r.gold]))
}

/**
 * Refuse a facet whose "gold" is a single constant.
 *
 * `topic` and `program` are exactly that on this corpus — one portfolio stamp
 * smeared across an import batch — so every model scores near zero against a
 * target that says nothing about the document. Refusing beats reporting a
 * number someone later reads as a broken model.
 */
export function assertUsableGold(facet: string, gold: Map<string, string>): void {
  if (!gold.size) {
    throw new Error(`no source='external' gold rows for facet '${facet}' — measure office or doc_type`)
  }
  const distinct = new Set(gold.values())
  if (distinct.size < 3) {
    throw new Error(
      `facet '${facet}' has only ${distinct.size} distinct external value(s) ` +
        `(${[...distinct].join(', ')}) — that is a batch stamp, not a label set, and no model ` +
        `can score above chance against it.\nMeasurable facets on this corpus: office (9 values), doc_type (7 values).`,
    )
  }
}

/**
 * Whether a facet has tag embeddings. Only the embedded facets (`topic`,
 * `geography`) do; production classifies everything else against the full
 * vocabulary, so the loaders fall back to enumerating every value.
 */
export async function facetHasEmbeddings(facet: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM tag_embeddings te
       JOIN tags t ON t.id = te.tag_id
      WHERE t.facet = $1 AND t.taxonomy_version = 'v1'
        AND te.embedding_model = 'cohere-embed-v4'
      LIMIT 1`,
    [facet],
  )
  return rows.length > 0
}

/** The document basis, exactly as worker/stages/classify.py builds it. */
async function loadBasis(documentId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT COALESCE(
              (SELECT text FROM document_summaries
                WHERE document_id = $1 AND language = 'en' AND kind = 'long'),
              (SELECT left(full_text, 8000) FROM document_texts WHERE document_id = $1)
            ) AS basis`,
    [documentId],
  )
  return rows[0]?.basis ?? null
}

/**
 * Candidate tags for a document.
 *
 * Embedded facets: the top-N tags by cosine distance from the stored
 * summary-chunk embedding (cohere-embed-v4, the same model that built
 * `tag_embeddings`), mirroring the worker's retrieve-then-classify. The
 * document vector is read from the summary chunk rather than re-embedded,
 * which keeps Bedrock out of the harness.
 *
 * Non-embedded facets: the whole v1 vocabulary, which is what production does
 * for them. `distance` is meaningless there and stays 0.
 */
async function loadCandidates(
  documentId: string,
  facet: string,
  topN: number,
  embedded: boolean,
): Promise<Candidate[]> {
  if (!embedded) {
    const { rows } = await pool.query(
      `SELECT t.value_id AS label, t.description,
              COALESCE((SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
                       '{}'::text[]) AS aliases
         FROM tags t
        WHERE t.facet = $1 AND t.taxonomy_version = 'v1'
        ORDER BY t.value_id
        LIMIT $2`,
      [facet, topN],
    )
    return rows.map((r) => ({ label: r.label, description: r.description, aliases: r.aliases ?? [], distance: 0 }))
  }

  const { rows } = await pool.query(
    `WITH dv AS (
       SELECT embedding FROM document_chunks
        WHERE document_id = $1
          AND unit_type = 'summary'
          AND embedding_model = 'cohere-embed-v4'
        LIMIT 1
     )
     SELECT t.value_id AS label,
            t.description,
            COALESCE((SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
                     '{}'::text[]) AS aliases,
            te.embedding <=> (SELECT embedding FROM dv) AS distance
       FROM tag_embeddings te
       JOIN tags t ON t.id = te.tag_id
      WHERE t.facet = $2
        AND t.taxonomy_version = 'v1'
        AND te.embedding_model = 'cohere-embed-v4'
      ORDER BY distance
      LIMIT $3`,
    [documentId, facet, topN],
  )
  return rows.map((r) => ({
    label: r.label,
    description: r.description,
    aliases: r.aliases ?? [],
    distance: Number(r.distance),
  }))
}

/**
 * Every document with a usable basis and candidate set.
 *
 * `onlyWithGold` restricts to documents that have an `external` tag for the
 * facet. Leave it false to label a facet that has no gold at all — the whole
 * point of the consensus path for `topic`.
 */
export async function loadRows(opts: {
  facet: string
  topN: number
  limit?: number | null
  onlyWithGold: boolean
}): Promise<Row[]> {
  const { facet, topN, limit, onlyWithGold } = opts
  const embedded = await facetHasEmbeddings(facet)
  const gold = onlyWithGold ? await loadGold(facet) : new Map<string, string>()

  const { rows: ids } = onlyWithGold
    ? await pool.query(
        `SELECT d.id FROM documents d
           JOIN document_tags dt ON dt.document_id = d.id
           JOIN tags t ON t.id = dt.tag_id
          WHERE t.facet = $1 AND dt.source = 'external'
          ORDER BY d.id`,
        [facet],
      )
    : await pool.query('SELECT id FROM documents ORDER BY id')

  const selected = limit ? ids.slice(0, limit) : ids

  const out: Row[] = []
  for (const { id } of selected) {
    const [basis, candidates] = await Promise.all([
      loadBasis(id),
      loadCandidates(id, facet, topN, embedded),
    ])
    if (!basis || !candidates.length) {
      console.warn(`skip ${id}: ${!basis ? 'no basis' : 'no candidates'}`)
      continue
    }
    const title = (await pool.query('SELECT title FROM documents WHERE id = $1', [id])).rows[0]?.title ?? ''
    out.push({ document_id: id, title, basis, gold: gold.get(id) ?? null, candidates })
  }
  return out
}
