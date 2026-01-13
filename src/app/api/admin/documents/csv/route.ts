import { NextRequest, NextResponse } from "next/server";
import { addDocumentToCSV, deleteDocumentFromCSV, getNextDocumentId } from "@/lib/csv-utils";

export async function POST(req: NextRequest) {
  try {
    const { documentId, metadata } = await req.json();

    if (!documentId || !metadata) {
      return NextResponse.json(
        { error: "documentId and metadata are required" },
        { status: 400 }
      );
    }

    await addDocumentToCSV(documentId, metadata, metadata.summary || '');

    return NextResponse.json({
      success: true,
      documentId,
    });
  } catch (error: any) {
    console.error("[CSV API] Error:", error);
    return NextResponse.json(
      { error: "Failed to update CSV", details: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');

    if (!documentId) {
      return NextResponse.json(
        { error: "documentId is required" },
        { status: 400 }
      );
    }

    await deleteDocumentFromCSV(documentId);

    return NextResponse.json({
      success: true,
      documentId,
    });
  } catch (error: any) {
    console.error("[CSV API] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete from CSV", details: error.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const nextId = await getNextDocumentId();

    return NextResponse.json({
      nextDocumentId: nextId,
    });
  } catch (error: any) {
    console.error("[CSV API] Error:", error);
    return NextResponse.json(
      { error: "Failed to get next document ID", details: error.message },
      { status: 500 }
    );
  }
}