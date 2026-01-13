import { NextRequest, NextResponse } from "next/server";
import { jobQueue } from "@/lib/job-queue";
import { readCSV, getNextDocumentId, addDocumentToCSV } from "@/lib/csv-utils";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "documents");

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

/**
 * GET /api/admin/documents - List all documents
 */
export async function GET(req: NextRequest) {
  try {
    const rows = await readCSV();

    const documents = rows.map((row, index) => {
      let metadata: any = {};
      try {
        metadata = JSON.parse(row.metadata);
      } catch (e) {
        console.error('Failed to parse metadata:', e);
      }

      const documentId = row.file_path.replace('.pdf', '');

      return {
        // Use documentId with index as fallback to ensure uniqueness
        id: `${documentId}_${index}`,
        documentId, // Original ID for API calls
        fileName: row.file_path,
        title: metadata['Article Title'] || 'Untitled',
        authors: metadata['All authors'] || '',
        year: metadata['YEAR accepted'] || '',
        attributionUrl: metadata['Attribution URL'] || metadata['Source URL'] || '',
        summary: row.summary || '',
        downloadUrl: `/api/documents/${documentId}.pdf`,
        metadata,
      };
    });

    return NextResponse.json({ documents });
  } catch (error: any) {
    console.error("[Documents API] Error:", error);
    return NextResponse.json(
      { error: "Failed to list documents", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/documents - Upload new document(s)
 */
export async function POST(req: NextRequest) {
  try {
    await ensureDataDir();

    const formData = await req.formData();
    const files = formData.getAll('files') as File[];
    const metadataStr = formData.get('metadata') as string;

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: "No files provided" },
        { status: 400 }
      );
    }

    if (!metadataStr) {
      return NextResponse.json(
        { error: "Metadata is required" },
        { status: 400 }
      );
    }

    let metadataList: any[];
    try {
      metadataList = JSON.parse(metadataStr);
    } catch (e) {
      return NextResponse.json(
        { error: "Invalid metadata JSON" },
        { status: 400 }
      );
    }

    if (files.length !== metadataList.length) {
      return NextResponse.json(
        { error: "Number of files must match number of metadata entries" },
        { status: 400 }
      );
    }

    // Process each document
    const jobIds: string[] = [];
    const uploadedDocuments: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const metadata = metadataList[i];

      try {
        // Get next document ID
        const documentId = await getNextDocumentId();

        // Read file buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Save PDF to disk
        const filePath = path.join(DATA_DIR, `${documentId}.pdf`);
        await fs.writeFile(filePath, buffer);
        console.log(`[Documents API] Saved PDF for ${documentId}`);

        // Add to CSV
        await addDocumentToCSV(documentId, metadata, metadata.summary || '');
        console.log(`[Documents API] Added ${documentId} to CSV`);

        uploadedDocuments.push(documentId);

        // Queue processing job
        const jobId = await jobQueue.addJob('process_document', {
          documentId,
          metadata,
          fileName: file.name,
        });

        jobIds.push(jobId);
        console.log(`[Documents API] Queued ${documentId} as job ${jobId}`);
      } catch (error) {
        console.error(`[Documents API] Failed to process file ${i}:`, error);
        throw error;
      }
    }

    // Queue reindex job after all documents are processed
    const reindexJobId = await jobQueue.addJob('reindex', {
      reason: `Added ${files.length} new document(s)`,
    });

    jobIds.push(reindexJobId);

    return NextResponse.json({
      success: true,
      jobIds,
      uploadedDocuments,
      message: `Successfully uploaded and queued ${files.length} document(s) for processing`,
    });

  } catch (error: any) {
    console.error("[Documents API] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload documents", details: error.message },
      { status: 500 }
    );
  }
}