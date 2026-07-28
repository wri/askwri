import { NextResponse } from 'next/server'
import { CITE_REPORT_HTML } from '@/lib/eval-html-templates'

export const dynamic = 'force-dynamic'

export async function GET() {
  return new NextResponse(CITE_REPORT_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
