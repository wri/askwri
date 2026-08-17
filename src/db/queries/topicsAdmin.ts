import { AppDataSource } from '../data-source'
import { writeAudit } from './audit'
import type { AdminIdentity } from '../../lib/auth/identity'
import { auditActor } from '../../lib/auth/identity'

export interface TopicRow {
  id: string
  facet: string
  valueId: string
  taxonomyVersion: string
  parentTagId: string | null
  description: string | null
  aliases: string[]
  acceptedCount: number
  suggestedCount: number
}

export interface TopicDetail extends TopicRow {}

/**
 * List all topic-facet tags with document counts and aliases.
 * Topic-scoped: filters facet='topic' AND taxonomy_version='v1'.
 * Aliases via a correlated subquery with COALESCE to return [] not null.
 */
export async function listTopicsWithCounts(): Promise<TopicRow[]> {
  return AppDataSource.query(`
    SELECT t.id, t.facet, t.value_id AS "valueId", t.taxonomy_version AS "taxonomyVersion",
           t.parent_tag_id AS "parentTagId", t.description,
           COALESCE(
             (SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
             '{}'::text[]
           ) AS aliases,
           count(*) FILTER (WHERE dt.status = 'accepted')::int  AS "acceptedCount",
           count(*) FILTER (WHERE dt.status = 'suggested')::int AS "suggestedCount"
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    WHERE t.facet = 'topic' AND t.taxonomy_version = 'v1'
    GROUP BY t.id
    ORDER BY t.value_id
  `)
}

/**
 * Get a single topic tag by id, with aliases and document counts.
 * Returns null if the tag doesn't exist.
 */
export async function getTopic(id: string): Promise<TopicDetail | null> {
  const [row] = await AppDataSource.query(
    `SELECT t.id, t.facet, t.value_id AS "valueId", t.taxonomy_version AS "taxonomyVersion",
            t.parent_tag_id AS "parentTagId", t.description,
            COALESCE(
              (SELECT array_agg(a.alias) FROM tag_aliases a WHERE a.tag_id = t.id),
              '{}'::text[]
            ) AS aliases,
            count(*) FILTER (WHERE dt.status = 'accepted')::int  AS "acceptedCount",
            count(*) FILTER (WHERE dt.status = 'suggested')::int AS "suggestedCount"
     FROM tags t
     LEFT JOIN document_tags dt ON dt.tag_id = t.id
     WHERE t.id = $1
     GROUP BY t.id`,
    [id],
  )
  return row ?? null
}
