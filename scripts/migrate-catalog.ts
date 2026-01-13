#!/usr/bin/env ts-node
/**
 * Migration script: Convert old catalog CSV to unified format
 *
 * Usage:
 *   npx ts-node scripts/migrate-catalog.ts
 *
 * This script:
 * 1. Reads old CSV from public/TransportDecarb_llamacloud_metadata250904.csv
 * 2. Converts to new unified schema with doc IDs
 * 3. Writes to data/documents.csv
 * 4. Logs migration results
 */

import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

interface OldRow {
  file_path: string;
  metadata: string;
}

interface NewRow {
  file_path: string;
  metadata: string;
  summary: string;
  source_type: string;
  imported_at: string;
  import_batch_id: string;
}

async function migrate() {
  console.log("🔄 Starting catalog migration...\n");

  try {
    // Paths
    const oldCsvPath = path.join(process.cwd(), "public", "TransportDecarb_llamacloud_metadata250904.csv");
    const dataDir = path.join(process.cwd(), "data");
    const newCsvPath = path.join(dataDir, "documents.csv");

    // Check old CSV exists
    try {
      await fs.access(oldCsvPath);
    } catch {
      throw new Error(`Old CSV not found: ${oldCsvPath}`);
    }

    console.log(`📖 Reading old CSV: ${oldCsvPath}`);
    let oldContent = await fs.readFile(oldCsvPath, "utf-8");

    // Remove BOM character if present
    if (oldContent.charCodeAt(0) === 0xFEFF) {
      oldContent = oldContent.slice(1);
    }

    // Parse old CSV using csv-parse for proper handling
    const parsed = parse(oldContent, {
      columns: true,
      skip_empty_lines: true,
    });

    const oldRows: OldRow[] = [];
    for (const row of parsed) {
      const typedRow = row as any;
      const file_path = typedRow.file_path?.trim();
      const metadata = typedRow.metadata?.trim();

      if (file_path && metadata) {
        oldRows.push({ file_path, metadata });
      }
    }

    console.log(`✓ Parsed ${oldRows.length} rows from old CSV\n`);

    // Convert to new format
    const newRows: NewRow[] = [];
    const now = new Date().toISOString();
    const batchId = "initial_migration";

    for (let i = 0; i < oldRows.length; i++) {
      const oldRow = oldRows[i];
      const docId = `doc_${String(i + 1).padStart(6, "0")}`;

      // Parse metadata JSON
      let metadata: any = {};
      try {
        metadata = JSON.parse(oldRow.metadata);
      } catch (e) {
        console.warn(`⚠️  Row ${i + 1}: Failed to parse metadata JSON`);
        metadata = { "Article Title": oldRow.file_path };
      }

      // Extract summary if present
      let summary = "";
      if (metadata.summary) {
        summary = metadata.summary;
        delete metadata.summary;
      }

      newRows.push({
        file_path: docId + ".pdf",
        metadata: JSON.stringify(metadata),
        summary: summary,
        source_type: "imported",
        imported_at: now,
        import_batch_id: batchId,
      });
    }

    console.log(`✓ Converted ${newRows.length} rows to new format\n`);

    // Ensure data directory exists
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (e) {
      // Directory might already exist
    }

    // Write CSV header
    const headers_new = [
      "file_path",
      "metadata",
      "summary",
      "source_type",
      "imported_at",
      "import_batch_id",
    ];
    const csvContent = [
      headers_new.join(","),
      ...newRows.map((row) =>
        [
          row.file_path,
          `"${row.metadata.replace(/"/g, '""')}"`,
          `"${row.summary.replace(/"/g, '""')}"`,
          row.source_type,
          row.imported_at,
          row.import_batch_id,
        ].join(",")
      ),
    ].join("\n");

    await fs.writeFile(newCsvPath, csvContent, "utf-8");
    console.log(`✅ Wrote ${newRows.length} rows to: ${newCsvPath}\n`);

    // Summary
    console.log("📊 Migration Summary:");
    console.log(`   Total records: ${newRows.length}`);
    console.log(`   Source type: all marked as "imported"`);
    console.log(`   Batch ID: ${batchId}`);
    console.log(`   Timestamp: ${now}\n`);

    console.log(
      "✅ Migration complete! The unified catalog is ready at data/documents.csv"
    );
    console.log("📝 Next steps:");
    console.log("   1. Verify the migration with: npm run dev");
    console.log("   2. Check /api/catalog returns all records");
    console.log("   3. Test app search/display functionality");
    console.log("   4. Keep public/TransportDecarb_llamacloud_metadata250904.csv as backup\n");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

migrate();
