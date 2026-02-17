import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  try {
    const { filename } = await params

    // Security: Only allow PDF files and prevent directory traversal
    if (
      !filename.endsWith('.pdf') ||
      filename.includes('..') ||
      filename.includes('/')
    ) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
    }

    // Construct path to PDF in data/documents directory
    const pdfPath = join("/tmp", "askWRI_docs", filename)

    // Check if file exists
    if (!existsSync(pdfPath)) {
      return NextResponse.json(
        { error: 'PDF not found', filename },
        { status: 404 },
      )
    }

    // Read and serve the PDF file
    const pdfBuffer = await readFile(pdfPath)

    return new NextResponse(Uint8Array.from(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=31536000, immutable', // Cache for 1 year
      },
    })
  } catch (error: any) {
    console.error('Error serving PDF:', error)
    return NextResponse.json(
      { error: 'Failed to serve PDF', message: error.message },
      { status: 500 },
    )
  }
}
