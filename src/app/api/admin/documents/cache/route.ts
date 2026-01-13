import { NextRequest, NextResponse } from "next/server";
import fs from 'fs/promises';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), '..', 'hybrid-service', 'cache', 'pdf_texts');

// Ensure cache directory exists
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

export async function POST(req: NextRequest) {
  try {
    const { documentId, text, metadata } = await req.json();

    if (!documentId || !text) {
      return NextResponse.json(
        { error: "documentId and text are required" },
        { status: 400 }
      );
    }

    await ensureCacheDir();

    const cacheData = {
      text,
      metadata,
      cachedAt: new Date().toISOString(),
    };

    const cachePath = path.join(CACHE_DIR, `${documentId}.json`);
    await fs.writeFile(cachePath, JSON.stringify(cacheData, null, 2), 'utf-8');

    console.log(`[Cache API] Cached text for ${documentId} (${text.length} chars)`);

    return NextResponse.json({
      success: true,
      documentId,
      cachedAt: cacheData.cachedAt,
    });
  } catch (error: any) {
    console.error("[Cache API] Error:", error);
    return NextResponse.json(
      { error: "Failed to cache document text", details: error.message },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const documentId = searchParams.get('documentId');

    if (!documentId) {
      return NextResponse.json(
        { error: "documentId is required" },
        { status: 400 }
      );
    }

    const cachePath = path.join(CACHE_DIR, `${documentId}.json`);

    try {
      const content = await fs.readFile(cachePath, 'utf-8');
      const cacheData = JSON.parse(content);

      return NextResponse.json({
        success: true,
        ...cacheData,
      });
    } catch (error) {
      return NextResponse.json(
        { error: "Document not found in cache" },
        { status: 404 }
      );
    }
  } catch (error: any) {
    console.error("[Cache API] Error:", error);
    return NextResponse.json(
      { error: "Failed to read cache", details: error.message },
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

    const cachePath = path.join(CACHE_DIR, `${documentId}.json`);

    try {
      await fs.unlink(cachePath);
      console.log(`[Cache API] Deleted cache for ${documentId}`);

      return NextResponse.json({
        success: true,
        documentId,
      });
    } catch (error) {
      return NextResponse.json(
        { error: "Document not found in cache" },
        { status: 404 }
      );
    }
  } catch (error: any) {
    console.error("[Cache API] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete cache", details: error.message },
      { status: 500 }
    );
  }
}