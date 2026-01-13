# Scripts Directory

Utility scripts for document management, data quality, and system maintenance.

## Active Maintenance Scripts

### Data Quality & Synchronization

**`verify-summary-sync.ts`**
- **Purpose**: Verify that summary column and metadata.summary are in sync
- **Usage**: `npx tsx scripts/verify-summary-sync.ts`
- **Output**: Report showing sync status, saves issues to `summary-sync-issues.json`
- **When to use**: After bulk imports or manual CSV edits

**`sync-summaries.ts`**
- **Purpose**: Sync summary column → metadata.summary for out-of-sync documents
- **Usage**: `npx tsx scripts/sync-summaries.ts`
- **Backup**: Creates `data/documents.csv.backup-sync`
- **When to use**: When verify-summary-sync reports out-of-sync documents

### One-Time Data Fixes (Completed)

**`cleanup-summaries.ts`**
- **Purpose**: Pattern-based cleanup (removed "Synopsis" prefixes, etc.)
- **Status**: ✅ Completed Nov 25, 2025 (39 summaries cleaned)
- **Backup**: Created `data/documents.csv.backup`

**`cleanup-titles.ts`**
- **Purpose**: Pattern-based title cleanup (citation format, underscores, etc.)
- **Status**: ✅ Completed Nov 25, 2025 (15 titles cleaned)
- **Backup**: Created `data/documents.csv.backup-titles`

**`extract-titles-llm.ts`**
- **Purpose**: LLM-based title extraction from PDFs for ambiguous cases
- **Status**: ✅ Completed Nov 25, 2025 (9/10 titles extracted)
- **Cost**: ~$0.09 (gpt-4o-mini)

**`generate-missing-summaries.ts`**
- **Purpose**: Generate summaries for documents with empty summary field
- **Status**: ✅ Completed Nov 25, 2025 (22 summaries generated)
- **Cost**: ~$0.44 (gpt-4o-mini)

### System Maintenance

**`migrate-catalog.ts`**
- **Purpose**: Migrate legacy CSV format to unified catalog format
- **Usage**: `npx tsx scripts/migrate-catalog.ts`
- **When to use**: When upgrading from old CSV schema

**`add-wrr-metadata.ts`**
- **Purpose**: Add WRI Ross Center program metadata to documents
- **Usage**: `npx tsx scripts/add-wrr-metadata.ts`
- **When to use**: Bulk metadata updates for categorization

### Evaluation & Testing

**`validate-eval-urls.ts`**
- **Purpose**: Validate that all evaluation ground truth documents exist
- **Usage**: `npx tsx scripts/validate-eval-urls.ts`
- **When to use**: Before running evaluation suite

## Script Categories

### 🔄 Regular Use
- `verify-summary-sync.ts` - Check data quality
- `sync-summaries.ts` - Fix sync issues
- `validate-eval-urls.ts` - Pre-evaluation checks

### 🏗️ Setup/Migration
- `migrate-catalog.ts` - One-time migration
- `add-wrr-metadata.ts` - Bulk metadata updates

### 🛠️ Data Quality (Historical)
- `cleanup-summaries.ts` - Already run
- `cleanup-titles.ts` - Already run
- `extract-titles-llm.ts` - Already run
- `generate-missing-summaries.ts` - Already run

## Best Practices

1. **Always verify before bulk changes**
   ```bash
   npx tsx scripts/verify-summary-sync.ts
   ```

2. **Scripts create backups automatically**
   - Look for `data/documents.csv.backup-*` files
   - Keep most recent backup, delete old timestamped ones

3. **Check hybrid service after changes**
   ```bash
   # Restart to rebuild index
   bash stop.sh && bash start.sh
   ```

4. **Cost-aware LLM usage**
   - Summary generation: ~$0.02/doc (gpt-4o-mini)
   - Title extraction: ~$0.01/doc (gpt-4o-mini)
   - Always shows estimated cost before running

## Related Documentation

- Data quality improvements: `../IMPORT_IMPROVEMENTS.md`
- Document management: `../DOCUMENT_MANAGEMENT.md`
- Architecture: `../ARCHITECTURE.md`
