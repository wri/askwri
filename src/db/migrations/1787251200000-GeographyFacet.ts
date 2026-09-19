import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Geography facet: continents (root tags) + UN member states (children).
 *
 * Same tag machinery as the topic facet — no new tables, no new columns.
 * Continents are root tags (parent_tag_id NULL); countries are children of
 * their continent via parent_tag_id. All seeded with needs_reembed=true so the
 * worker's embed_tags sweep builds cohere-embed-v4 rows for retrieve-then-
 * classify (see classify.py / embed_tags.py). taxonomy_version='v1', same as
 * topics.
 *
 * Idempotent: ON CONFLICT (facet, value_id, taxonomy_version) DO UPDATE re-
 * asserts parent_tag_id and needs_reembed, so re-running repairs the tree and
 * re-queues embeddings. Country→continent mapping follows the UN geoscheme
 * (Russia in Europe; Turkey/Cyprus/Caucasus in Asia).
 *
 * English short names per ISO 3166. 7 continents + 195 countries.
 */
export class Migration1787251200000 implements MigrationInterface {
  name = 'Migration1787251200000'

  public async up(q: QueryRunner): Promise<void> {
    // -- Continents (root tags)
    await q.query(`
      INSERT INTO tags (facet, value_id, taxonomy_version, parent_tag_id, needs_reembed)
      VALUES
        ('geography', 'Africa',          'v1', NULL, true),
        ('geography', 'Antarctica',      'v1', NULL, true),
        ('geography', 'Asia',            'v1', NULL, true),
        ('geography', 'Europe',          'v1', NULL, true),
        ('geography', 'North America',   'v1', NULL, true),
        ('geography', 'Oceania',         'v1', NULL, true),
        ('geography', 'South America',   'v1', NULL, true)
      ON CONFLICT (facet, value_id, taxonomy_version) DO UPDATE
        SET needs_reembed = true`)

    // -- Countries (children of their continent). Parent resolved by subquery
    //    so the migration does not depend on generated UUIDs.
    await q.query(`
      INSERT INTO tags (facet, value_id, taxonomy_version, parent_tag_id, needs_reembed)
      SELECT 'geography', v.country, 'v1',
             (SELECT t.id FROM tags t
              WHERE t.facet = 'geography' AND t.value_id = v.continent
                AND t.taxonomy_version = 'v1'),
             true
      FROM (VALUES
        -- Africa
          ('Africa','Algeria'), ('Africa','Angola'), ('Africa','Benin'),
          ('Africa','Botswana'), ('Africa','Burkina Faso'), ('Africa','Burundi'),
          ('Africa','Cabo Verde'), ('Africa','Cameroon'),
          ('Africa','Central African Republic'), ('Africa','Chad'),
          ('Africa','Comoros'), ('Africa','Congo'), ('Africa','Côte d''Ivoire'),
          ('Africa','Democratic Republic of the Congo'), ('Africa','Djibouti'),
          ('Africa','Egypt'), ('Africa','Equatorial Guinea'), ('Africa','Eritrea'),
          ('Africa','Eswatini'), ('Africa','Ethiopia'), ('Africa','Gabon'),
          ('Africa','Gambia'), ('Africa','Ghana'), ('Africa','Guinea'),
          ('Africa','Guinea-Bissau'), ('Africa','Kenya'), ('Africa','Lesotho'),
          ('Africa','Liberia'), ('Africa','Libya'), ('Africa','Madagascar'),
          ('Africa','Malawi'), ('Africa','Mali'), ('Africa','Mauritania'),
          ('Africa','Mauritius'), ('Africa','Morocco'), ('Africa','Mozambique'),
          ('Africa','Namibia'), ('Africa','Niger'), ('Africa','Nigeria'),
          ('Africa','Rwanda'), ('Africa','Sao Tome and Principe'),
          ('Africa','Senegal'), ('Africa','Seychelles'), ('Africa','Sierra Leone'),
          ('Africa','Somalia'), ('Africa','South Africa'), ('Africa','South Sudan'),
          ('Africa','Sudan'), ('Africa','Tanzania'), ('Africa','Togo'),
          ('Africa','Tunisia'), ('Africa','Uganda'), ('Africa','Zambia'),
          ('Africa','Zimbabwe'),
        -- Asia
          ('Asia','Afghanistan'), ('Asia','Armenia'), ('Asia','Azerbaijan'),
          ('Asia','Bahrain'), ('Asia','Bangladesh'), ('Asia','Bhutan'),
          ('Asia','Brunei Darussalam'), ('Asia','Cambodia'), ('Asia','China'),
          ('Asia','Cyprus'), ('Asia','Georgia'), ('Asia','India'),
          ('Asia','Indonesia'), ('Asia','Iran'), ('Asia','Iraq'), ('Asia','Israel'),
          ('Asia','Japan'), ('Asia','Jordan'), ('Asia','Kazakhstan'),
          ('Asia','Kuwait'), ('Asia','Kyrgyzstan'), ('Asia','Lao People''s Democratic Republic'),
          ('Asia','Lebanon'), ('Asia','Malaysia'), ('Asia','Maldives'),
          ('Asia','Mongolia'), ('Asia','Myanmar'), ('Asia','Nepal'),
          ('Asia','North Korea'), ('Asia','Oman'), ('Asia','Pakistan'),
          ('Asia','Palestine'), ('Asia','Philippines'), ('Asia','Qatar'),
          ('Asia','Saudi Arabia'), ('Asia','Singapore'),
          ('Asia','South Korea'), ('Asia','Sri Lanka'), ('Asia','Syrian Arab Republic'),
          ('Asia','Tajikistan'), ('Asia','Thailand'), ('Asia','Timor-Leste'),
          ('Asia','Turkey'), ('Asia','Turkmenistan'), ('Asia','United Arab Emirates'),
          ('Asia','Uzbekistan'), ('Asia','Vietnam'), ('Asia','Yemen'),
        -- Europe
          ('Europe','Albania'), ('Europe','Andorra'), ('Europe','Austria'),
          ('Europe','Belarus'), ('Europe','Belgium'),
          ('Europe','Bosnia and Herzegovina'), ('Europe','Bulgaria'),
          ('Europe','Croatia'), ('Europe','Czechia'), ('Europe','Denmark'),
          ('Europe','Estonia'), ('Europe','Finland'), ('Europe','France'),
          ('Europe','Germany'), ('Europe','Greece'), ('Europe','Hungary'),
          ('Europe','Iceland'), ('Europe','Ireland'), ('Europe','Italy'),
          ('Europe','Latvia'), ('Europe','Liechtenstein'), ('Europe','Lithuania'),
          ('Europe','Luxembourg'), ('Europe','Malta'), ('Europe','Moldova'),
          ('Europe','Monaco'), ('Europe','Montenegro'), ('Europe','Netherlands'),
          ('Europe','North Macedonia'), ('Europe','Norway'), ('Europe','Poland'),
          ('Europe','Portugal'), ('Europe','Romania'), ('Europe','San Marino'),
          ('Europe','Serbia'), ('Europe','Slovakia'), ('Europe','Slovenia'),
          ('Europe','Spain'), ('Europe','Sweden'), ('Europe','Switzerland'),
          ('Europe','Russia'), ('Europe','Ukraine'), ('Europe','United Kingdom'),
        -- North America
          ('North America','Antigua and Barbuda'), ('North America','Bahamas'),
          ('North America','Barbados'), ('North America','Belize'),
          ('North America','Canada'), ('North America','Costa Rica'),
          ('North America','Cuba'), ('North America','Dominica'),
          ('North America','Dominican Republic'), ('North America','El Salvador'),
          ('North America','Grenada'), ('North America','Guatemala'),
          ('North America','Haiti'), ('North America','Honduras'),
          ('North America','Jamaica'), ('North America','Mexico'),
          ('North America','Nicaragua'), ('North America','Panama'),
          ('North America','Saint Kitts and Nevis'),
          ('North America','Saint Lucia'),
          ('North America','Saint Vincent and the Grenadines'),
          ('North America','Trinidad and Tobago'),
          ('North America','United States'),
        -- South America
          ('South America','Argentina'), ('South America','Bolivia'),
          ('South America','Brazil'), ('South America','Chile'),
          ('South America','Colombia'), ('South America','Ecuador'),
          ('South America','Guyana'), ('South America','Paraguay'),
          ('South America','Peru'), ('South America','Suriname'),
          ('South America','Uruguay'), ('South America','Venezuela'),
        -- Oceania
          ('Oceania','Australia'), ('Oceania','Fiji'), ('Oceania','Kiribati'),
          ('Oceania','Marshall Islands'),
          ('Oceania','Micronesia (Federated States of)'), ('Oceania','Nauru'),
          ('Oceania','New Zealand'), ('Oceania','Palau'),
          ('Oceania','Papua New Guinea'), ('Oceania','Samoa'),
          ('Oceania','Solomon Islands'), ('Oceania','Tonga'),
          ('Oceania','Tuvalu'), ('Oceania','Vanuatu')
      ) AS v(continent, country)
      ON CONFLICT (facet, value_id, taxonomy_version) DO UPDATE
        SET parent_tag_id = EXCLUDED.parent_tag_id,
            needs_reembed = true`)
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DELETE FROM tags WHERE facet = 'geography' AND taxonomy_version = 'v1'`)
  }
}
