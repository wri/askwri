-- Taxonomy defect audit — read-only.
--
-- Run against an environment:
--   ./scripts/with-remote-env.sh qa psql -X -P pager=off -f evaluation/diagnostics/audit-taxonomy.sql
--
-- Written 2026-10-01 before relabeling the corpus: a classifier asked to choose
-- among these tags inherits every defect here, so they are worth fixing first.
--
-- Findings are ordered by how much they damage labeling.

\echo
\echo '=== 1. Facet inventory ==============================================='
\echo 'A facet with one value cannot discriminate anything.'
SELECT facet,
       count(*)                                        AS tags,
       count(DISTINCT value_id)                        AS distinct_values,
       count(*) FILTER (WHERE parent_tag_id IS NOT NULL) AS with_parent
  FROM tags
 WHERE taxonomy_version = 'v1'
 GROUP BY facet
 ORDER BY tags DESC;

\echo
\echo '=== 2. Encoding damage (U+FFFD — character lost, unrecoverable) ======'
SELECT facet, value_id, length(value_id) AS chars
  FROM tags
 WHERE value_id ~ '[^[:print:]]' OR value_id ~ '\ufffd'
 ORDER BY facet, value_id;

\echo
\echo '=== 3. Whitespace and trailing punctuation =========================='
SELECT facet, value_id, 'whitespace' AS issue
  FROM tags
 WHERE value_id <> btrim(value_id) OR value_id ~ '\s\s'
UNION ALL
SELECT facet, value_id, 'trailing punctuation'
  FROM tags
 WHERE value_id ~ '[.,;:]\s*$'
 ORDER BY 1, 3, 2;

\echo
\echo '=== 4. Case-only duplicates ========================================='
SELECT facet, lower(value_id) AS folded, count(*) AS n, string_agg(value_id, ' / ' ORDER BY value_id) AS values
  FROM tags
 WHERE taxonomy_version = 'v1'
 GROUP BY facet, lower(value_id)
HAVING count(*) > 1
 ORDER BY facet, folded;

\echo
\echo '=== 5. Near-duplicate pairs by cosine (topic) ======================='
\echo 'Only 9 pairs exceed 0.85 across 286,146 — near-duplication is NOT the'
\echo 'main problem; these are acronym and spelling variants.'
WITH p AS (
  SELECT ta.value_id AS a, tb.value_id AS b, 1 - (ea.embedding <=> eb.embedding) AS cos
    FROM tag_embeddings ea
    JOIN tags ta ON ta.id = ea.tag_id AND ta.facet = 'topic' AND ta.taxonomy_version = 'v1'
    JOIN tag_embeddings eb ON eb.tag_id > ea.tag_id AND eb.embedding_model = 'cohere-embed-v4'
    JOIN tags tb ON tb.id = eb.tag_id AND tb.facet = 'topic' AND tb.taxonomy_version = 'v1'
   WHERE ea.embedding_model = 'cohere-embed-v4'
)
SELECT round(cos::numeric, 3) AS cosine, a, b
  FROM p
 WHERE cos >= 0.80
 ORDER BY cos DESC;

\echo
\echo '=== 6. Alias collisions (one alias naming several tags) ============='
SELECT lower(a.alias) AS alias, count(DISTINCT t.id) AS tags,
       string_agg(DISTINCT t.value_id, ' / ' ORDER BY t.value_id) AS on_tags
  FROM tag_aliases a
  JOIN tags t ON t.id = a.tag_id
 WHERE t.taxonomy_version = 'v1'
 GROUP BY lower(a.alias)
HAVING count(DISTINCT t.id) > 1
 ORDER BY tags DESC, alias
 LIMIT 30;

\echo
\echo '=== 7. Alias that collides with another tag name ==================='
SELECT ta.facet, ta.value_id AS tag, a.alias AS alias_is_also_a_tag, tb.value_id AS other_tag
  FROM tag_aliases a
  JOIN tags ta ON ta.id = a.tag_id
  JOIN tags tb ON tb.taxonomy_version = ta.taxonomy_version
               AND tb.facet = ta.facet
               AND lower(tb.value_id) = lower(a.alias)
               AND tb.id <> ta.id
 WHERE ta.taxonomy_version = 'v1'
 ORDER BY ta.facet, ta.value_id
 LIMIT 30;

\echo
\echo '=== 8. Tags with no description or aliases ========================='
\echo 'Retrieval embeds label + aliases + description; a bare label is thinner.'
SELECT facet,
       count(*)                                                              AS tags,
       count(*) FILTER (WHERE description IS NULL OR btrim(description) = '') AS no_description,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tag_aliases a WHERE a.tag_id = t.id)) AS no_aliases
  FROM tags t
 WHERE taxonomy_version = 'v1'
 GROUP BY facet
 ORDER BY tags DESC;

\echo
\echo '=== 9. Tags never attached to any document ========================='
SELECT t.facet, count(*) AS unused_tags,
       (SELECT count(*) FROM tags t2 WHERE t2.taxonomy_version='v1' AND t2.facet=t.facet) AS facet_total
  FROM tags t
 WHERE t.taxonomy_version = 'v1'
   AND NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.tag_id = t.id)
 GROUP BY t.facet
 ORDER BY unused_tags DESC;

\echo
\echo '=== 10. Capitalisation styles in one facet (inconsistency) ========='
SELECT count(*) FILTER (WHERE value_id = upper(value_id) AND value_id ~ '[A-Z]') AS all_caps,
       count(*) FILTER (WHERE value_id ~ '^[A-Z]' AND value_id ~ '[a-z]')        AS title_style,
       count(*) FILTER (WHERE value_id = lower(value_id) AND value_id ~ '[a-z]') AS all_lower,
       count(*)                                                                  AS total
  FROM tags
 WHERE facet = 'topic' AND taxonomy_version = 'v1';

\echo
\echo '=== 11. Very short tags (acronyms needing disambiguation) =========='
SELECT facet, string_agg(value_id, ', ' ORDER BY value_id) AS short_tags
  FROM tags
 WHERE taxonomy_version = 'v1' AND length(value_id) <= 4
 GROUP BY facet
 ORDER BY facet;
