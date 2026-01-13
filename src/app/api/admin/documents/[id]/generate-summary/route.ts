import { NextRequest, NextResponse } from 'next/server';
import { readCSV, updateDocumentInCSV } from '@/lib/csv-utils';
import { generateSummary } from '@/lib/summary-generator';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'documents');

/**
 * POST /api/admin/documents/[id]/generate-summary
 * Generate a new summary for a document using LLM
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: documentId } = await params;
  try {

    // 1. Find document in CSV
    const rows = await readCSV();
    const docRow = rows.find(r => r.file_path === `${documentId}.pdf`);

    if (!docRow) {
      return NextResponse.json(
        { error: 'Document not found' },
        { status: 404 }
      );
    }

    // 2. Parse metadata
    let metadata: any = {};
    try {
      metadata = JSON.parse(docRow.metadata);
    } catch (e) {
      return NextResponse.json(
        { error: 'Invalid metadata JSON' },
        { status: 400 }
      );
    }

    const title = metadata['Article Title'] || 'Untitled';

    // 3. Generate summary
    const pdfPath = path.join(DATA_DIR, `${documentId}.pdf`);

    let summary: string;
    try {
      summary = await generateSummary({ pdfPath, title });
    } catch (error: any) {
      console.error(`[Generate Summary] Error for ${documentId}:`, error);
      return NextResponse.json(
        {
          error: 'Failed to generate summary',
          details: error.message,
        },
        { status: 500 }
      );
    }

    // 4. Update CSV
    metadata.summary = summary;
    await updateDocumentInCSV(documentId, metadata, summary);

    console.log(`[Generate Summary] Success for ${documentId}: ${summary.substring(0, 80)}...`);

    return NextResponse.json({
      success: true,
      summary,
      documentId,
    });
  } catch (error: any) {
    console.error('[Generate Summary] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}
