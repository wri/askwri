import { NextRequest, NextResponse } from "next/server";
import { addDocumentToCSV, deleteDocumentFromCSV } from "@/lib/csv-utils";
import { jobQueue } from "@/lib/job-queue";

/**
 * PATCH /api/admin/documents/:id - Update document metadata
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: documentId } = await params;
    const { metadata } = await req.json();

    if (!metadata) {
      return NextResponse.json(
        { error: "Metadata is required" },
        { status: 400 }
      );
    }

    // Update CSV with new metadata
    await addDocumentToCSV(documentId, metadata, metadata.summary || '');

    // Queue reindex
    const jobId = await jobQueue.addJob('reindex', {
      reason: `Updated metadata for ${documentId}`,
    });

    return NextResponse.json({
      success: true,
      documentId,
      jobId,
    });

  } catch (error: any) {
    console.error("[Documents API] Error:", error);
    return NextResponse.json(
      { error: "Failed to update document", details: error.message },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/documents/:id - Delete document
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: documentId } = await params;

    // Delete from CSV
    await deleteDocumentFromCSV(documentId);

    // Delete from cache
    try {
      await fetch(`/api/admin/documents/cache?documentId=${documentId}`, {
        method: 'DELETE',
      });
    } catch (e) {
      console.warn(`[Documents API] Failed to delete cache for ${documentId}:`, e);
    }

    // Queue reindex
    const jobId = await jobQueue.addJob('reindex', {
      reason: `Deleted ${documentId}`,
    });

    return NextResponse.json({
      success: true,
      documentId,
      jobId,
    });

  } catch (error: any) {
    console.error("[Documents API] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete document", details: error.message },
      { status: 500 }
    );
  }
}