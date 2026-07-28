import { NextResponse } from 'next/server'
import { SYNTHESIS_REVIEW_HTML } from '@/lib/eval-html-templates'

export const dynamic = 'force-dynamic'

export async function GET() {
  return new NextResponse(SYNTHESIS_REVIEW_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
