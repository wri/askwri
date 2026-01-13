import fs from 'fs/promises';
import path from 'path';

export interface CSVRow {
  file_path: string;
  metadata: string;
  summary: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const CSV_FILE = path.join(DATA_DIR, 'documents.csv');

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

// CSV format: file_path,metadata,summary
// Where metadata is JSON stringified
const CSV_HEADER = 'file_path,metadata,summary\n';

async function getCsvContent(): Promise<string> {
  try {
    return await fs.readFile(CSV_FILE, 'utf-8');
  } catch (error) {
    // File doesn't exist, return header only
    return CSV_HEADER;
  }
}

function parseCSVLine(line: string): CSVRow | null {
  if (!line.trim() || line === CSV_HEADER.trim()) return null;

  // RFC 4180 compliant CSV parsing
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let fieldStart = true;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote: "" becomes "
        current += '"';
        i++;
      } else if (fieldStart && !inQuotes) {
        // Opening quote of field
        inQuotes = true;
        fieldStart = false;
      } else if (inQuotes && (nextChar === "," || nextChar === undefined)) {
        // Closing quote of field
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === "," && !inQuotes) {
      // End of field
      fields.push(current.trim());
      current = "";
      fieldStart = true;
    } else {
      current += char;
      fieldStart = false;
    }
  }

  // Last field
  fields.push(current.trim());

  if (fields.length < 3) return null;

  const filePath = fields[0];
  const metadata = fields[1];
  const summary = fields[2] || "";

  return { file_path: filePath, metadata, summary };
}

function escapeCSVField(field: string): string {
  // If field contains comma or quote, wrap in quotes and escape quotes
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export async function readCSV(): Promise<CSVRow[]> {
  await ensureDataDir();
  const content = await getCsvContent();

  // Parse CSV respecting quoted fields that may contain newlines
  const rows: CSVRow[] = [];
  let currentLine = '';
  let inQuotes = false;
  let isFirstLine = true;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        currentLine += '""';
        i++;
      } else {
        // Toggle quotes
        inQuotes = !inQuotes;
        currentLine += char;
      }
    } else if (char === '\n' && !inQuotes) {
      // End of line (not inside quotes)
      if (currentLine.trim()) {
        // Skip header line
        if (isFirstLine) {
          isFirstLine = false;
        } else {
          const parsed = parseCSVLine(currentLine);
          if (parsed) {
            rows.push(parsed);
          }
        }
      }
      currentLine = '';
    } else {
      currentLine += char;
    }
  }

  // Handle last line if no trailing newline
  if (currentLine.trim() && !isFirstLine) {
    const parsed = parseCSVLine(currentLine);
    if (parsed) {
      rows.push(parsed);
    }
  }

  return rows;
}

export async function getNextDocumentId(): Promise<string> {
  await ensureDataDir();
  const rows = await readCSV();

  // Extract numeric IDs and find the max
  const ids = rows
    .map(r => {
      const match = r.file_path.match(/doc_(\d+)/);
      return match ? parseInt(match[1]) : 0;
    })
    .filter(id => id > 0);

  const nextId = (Math.max(...ids, 0) + 1).toString().padStart(6, '0');
  return `doc_${nextId}`;
}

export async function addDocumentToCSV(
  documentId: string,
  metadata: any,
  summary: string
): Promise<void> {
  await ensureDataDir();

  const rows = await readCSV();

  // Remove existing entry if present
  const filtered = rows.filter(r => !r.file_path.includes(documentId));

  // Add new entry
  const metadataStr = JSON.stringify(metadata);
  const filePath = `${documentId}.pdf`;

  filtered.push({
    file_path: filePath,
    metadata: metadataStr,
    summary: summary || ''
  });

  // Write back to CSV
  const lines = [CSV_HEADER.trim()];
  for (const row of filtered) {
    lines.push(`${escapeCSVField(row.file_path)},${escapeCSVField(row.metadata)},${escapeCSVField(row.summary)}`);
  }

  await fs.writeFile(CSV_FILE, lines.join('\n') + '\n', 'utf-8');
}

export async function updateDocumentInCSV(
  documentId: string,
  metadata: any,
  summary: string
): Promise<void> {
  await ensureDataDir();

  const rows = await readCSV();
  const fileName = documentId.endsWith('.pdf') ? documentId : `${documentId}.pdf`;

  const rowIndex = rows.findIndex(r => r.file_path === fileName);

  if (rowIndex === -1) {
    throw new Error(`Document not found: ${documentId}`);
  }

  // Update the row
  rows[rowIndex].metadata = JSON.stringify(metadata);
  rows[rowIndex].summary = summary;

  // Write back to CSV
  const lines = [CSV_HEADER.trim()];
  for (const row of rows) {
    lines.push(`${escapeCSVField(row.file_path)},${escapeCSVField(row.metadata)},${escapeCSVField(row.summary)}`);
  }

  await fs.writeFile(CSV_FILE, lines.join('\n') + '\n', 'utf-8');
}

export async function deleteDocumentFromCSV(documentId: string): Promise<void> {
  await ensureDataDir();

  const rows = await readCSV();
  const filtered = rows.filter(r => !r.file_path.includes(documentId));

  const lines = [CSV_HEADER.trim()];
  for (const row of filtered) {
    lines.push(`${escapeCSVField(row.file_path)},${escapeCSVField(row.metadata)},${escapeCSVField(row.summary)}`);
  }

  await fs.writeFile(CSV_FILE, lines.join('\n') + '\n', 'utf-8');
}

/**
 * Detect if a document already exists in the database
 * Uses title, authors, and year as key identifiers
 */
export async function findDuplicateDocument(
  newMetadata: any
): Promise<{ exists: boolean; documentId?: string; conflictReason?: string }> {
  const rows = await readCSV();

  const newTitle = (newMetadata["Article Title"] || "").toLowerCase().trim();
  const newAuthors = (newMetadata["All authors"] || "").toLowerCase().trim();
  const newYear = newMetadata["YEAR accepted"];

  for (const row of rows) {
    try {
      const existingMeta = JSON.parse(row.metadata);
      const existingTitle = (existingMeta["Article Title"] || "").toLowerCase().trim();
      const existingAuthors = (existingMeta["All authors"] || "").toLowerCase().trim();
      const existingYear = existingMeta["YEAR accepted"];

      // Exact match: same title, authors, and year
      if (newTitle && existingTitle === newTitle && newAuthors && existingAuthors === newAuthors && newYear === existingYear) {
        return {
          exists: true,
          documentId: row.file_path,
          conflictReason: "Exact match: same title, authors, and year"
        };
      }

      // Fuzzy match: same title and year (authors might vary)
      if (newTitle && existingTitle === newTitle && newYear === existingYear && newTitle.length > 10) {
        return {
          exists: true,
          documentId: row.file_path,
          conflictReason: "Likely duplicate: same title and year"
        };
      }

      // Same title in same batch (likely copy)
      if (newTitle && existingTitle === newTitle && newTitle.length > 20) {
        return {
          exists: true,
          documentId: row.file_path,
          conflictReason: "Title already exists in database"
        };
      }
    } catch (e) {
      // Skip rows with invalid metadata JSON
      continue;
    }
  }

  return { exists: false };
}

/**
 * Detect duplicate documents in a batch before upload
 */
export async function detectBatchDuplicates(
  documentsToUpload: Array<{ metadata: any }>
): Promise<Array<{
  index: number;
  title: string;
  existingDocumentId?: string;
  conflictReason: string;
}>> {
  const conflicts: Array<{
    index: number;
    title: string;
    existingDocumentId?: string;
    conflictReason: string;
  }> = [];

  for (let i = 0; i < documentsToUpload.length; i++) {
    const doc = documentsToUpload[i];
    const result = await findDuplicateDocument(doc.metadata);

    if (result.exists) {
      conflicts.push({
        index: i,
        title: doc.metadata["Article Title"] || "Untitled",
        existingDocumentId: result.documentId,
        conflictReason: result.conflictReason || "Duplicate detected"
      });
    }
  }

  return conflicts;
}
