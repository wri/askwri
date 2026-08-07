import { NextResponse } from 'next/server'
import { readEvalFile } from '@/lib/eval-storage'

export const dynamic = 'force-dynamic'

export async function GET() {
  const data = await readEvalFile('answer-labels-review.json')
  if (!data) {
    return NextResponse.json(
      { error: 'answer-labels-review.json not found. Run golden-label first.' },
      { status: 404 },
    )
  }
  return NextResponse.json(data)
}
