# title_en repairs — qa leg EXECUTED 2026-07-26 (~20:15 UTC)

> **EXECUTED.** All THREE repairs were applied to qa RDS (provenance
> `human`), verified by SELECT. The pre-flight below proved its worth: qa
> still had all three Spanish `title_en` values (matching findings §2.3),
> including `_2276`, which the local mirror had already repaired — the
> "no change needed for `_2276`" call recorded below was a local-mirror
> artifact, and `_2276` received the English title on qa. Historical
> content kept below unchanged.

# (original note) title_en repairs — qa leg DEFERRED (2026-07-26)

Task 9 of `2026-07-26-sparse-lane-english-handles-plan.md`. The LOCAL mirror
(docker `askwri-pg`, db `qa`) was repaired 2026-07-26 with user-approved
values; the REAL qa RDS was unreachable (no AWS session). Run the SQL below
against qa before (or with) the flag-on deploy.

Pre-flight (state moved between 2026-07-24 and 2026-07-26 — findings §2.3
listed THREE Spanish `title_en` rows, but the local mirror showed `_2276`
already repaired): verify current values and provenance first, and skip any
row whose provenance is no longer `llm`:

```sql
SELECT external_id, title_en, metadata_source->>'title_en' AS provenance
FROM documents
WHERE external_id IN ('2025_aire-limpio-en-barrios-vitales_9425',
                      '2020_las-mujeres-y-el-transporte-en-bogota-las-cuentas_3254',
                      '2023_base-de-datos-ajustada-de-la-encuesta-origen_2276');
```

User-approved repairs (guarded — no-op if provenance is not `llm`):

```sql
UPDATE documents
SET title_en = 'Clean Air in Vital Neighborhoods: Air Quality Impact Indicators',
    metadata_source = jsonb_set(COALESCE(metadata_source,'{}'::jsonb), '{title_en}', '"human"')
WHERE external_id = '2025_aire-limpio-en-barrios-vitales_9425'
  AND metadata_source->>'title_en' = 'llm';

UPDATE documents
SET title_en = 'Women and Transport in Bogotá: The Numbers',
    metadata_source = jsonb_set(COALESCE(metadata_source,'{}'::jsonb), '{title_en}', '"human"')
WHERE external_id = '2020_las-mujeres-y-el-transporte-en-bogota-las-cuentas_3254'
  AND metadata_source->>'title_en' = 'llm';
```

`_2276` needs no change (already a faithful English title). `title_en` only
reaches retrieval through `SPARSE_EN_HANDLES` injection, so running these
repairs before the flag-on `build_sparse_keyword.py` rebuild is sufficient;
no separate reindex step.
