import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { initializeDatabase, AppDataSource } from '../../../../db/data-source'

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

    // Withdrawn documents must not be served. Match the document whose s3_key
    // basename equals the requested filename ('<external_id>.pdf' or
    // 'documents/<file>.pdf'). Legacy CSV-only files have no documents row and
    // are served as before. On DB failure, fail open (serve) so a database
    // outage never breaks the public results UI.
    try {
      await initializeDatabase()
      const [row] = await AppDataSource.query(
        `SELECT status FROM documents WHERE s3_key = $1 OR s3_key LIKE '%/' || $1 LIMIT 1`,
        [filename],
      )
      if (row && row.status === 'withdrawn') {
        return NextResponse.json({ error: 'PDF not found', filename }, { status: 404 })
      }
    } catch (dbErr) {
      console.error('Error checking document status for PDF (failing open):', dbErr)
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
