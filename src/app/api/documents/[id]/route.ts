import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "documents");

/**
 * GET /api/documents/[id]
 * Serves uploaded PDF documents
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const documentId = id.endsWith(".pdf") ? id.slice(0, -4) : id;

    // Security: validate document ID format to prevent path traversal
    if (!/^doc_\d{6}$/.test(documentId)) {
      return NextResponse.json(
        { error: "Invalid document ID format" },
        { status: 400 }
      );
    }

    const filePath = path.join(DATA_DIR, `${documentId}.pdf`);

    try {
      const buffer = await fs.readFile(filePath);

      return new NextResponse(Buffer.from(buffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${documentId}.pdf"`,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (error) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 }
      );
    }
  } catch (error: any) {
    console.error("[Documents API] Error serving PDF:", error);
    return NextResponse.json(
      { error: "Failed to serve document", details: error.message },
      { status: 500 }
    );
  }
}
