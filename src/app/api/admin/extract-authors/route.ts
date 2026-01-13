/**
 * API endpoint for extracting authors from uploaded PDF file
 * Used during manual document upload when authors field is empty
 */

import { NextRequest, NextResponse } from 'next/server';
import { extractAuthors } from '@/lib/author-extractor';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Save uploaded file to temp location
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const tempPath = path.join(os.tmpdir(), `author-extract-${Date.now()}.pdf`);
    await writeFile(tempPath, buffer);

    try {
      // Extract authors using our author-extractor library
      const extractedAuthors = await extractAuthors(tempPath);

      // Clean up temp file
      await unlink(tempPath);

      return NextResponse.json({
        success: true,
        authors: extractedAuthors,
      });
    } catch (extractError: any) {
      // Clean up temp file even on error
      try {
        await unlink(tempPath);
      } catch {}

      return NextResponse.json(
        {
          error: 'Author extraction failed',
          details: extractError.message,
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('Extract authors API error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error.message,
      },
      { status: 500 }
    );
  }
}
