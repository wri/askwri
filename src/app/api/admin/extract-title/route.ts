/**
 * API endpoint for extracting title from uploaded PDF file
 * Used during manual document upload when title field is empty or looks like filename
 */

import { NextRequest, NextResponse } from 'next/server';
import { extractTitle } from '@/lib/title-extractor';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const currentTitle = formData.get('currentTitle') as string || '';

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // Save uploaded file to temp location
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const tempPath = path.join(os.tmpdir(), `title-extract-${Date.now()}.pdf`);
    await writeFile(tempPath, buffer);

    try {
      // Extract title using our title-extractor library
      const extractedTitle = await extractTitle(tempPath, currentTitle);

      // Clean up temp file
      await unlink(tempPath);

      return NextResponse.json({
        success: true,
        title: extractedTitle,
      });
    } catch (extractError: any) {
      // Clean up temp file even on error
      try {
        await unlink(tempPath);
      } catch {}

      return NextResponse.json(
        {
          error: 'Title extraction failed',
          details: extractError.message,
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('Extract title API error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error.message,
      },
      { status: 500 }
    );
  }
}
