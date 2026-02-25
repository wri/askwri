import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { insertFeedback } from '../../../db/queries/insertFeedback'

export async function POST(req: NextRequest) {
  await initializeDatabase()
  try {
    const body = await req.json()
    const feedback = await insertFeedback(body)
    console.log('✅ Feedback inserted:', feedback)
    return NextResponse.json(feedback, { status: 201 })
  } catch (error) {
    console.error('❌ Error inserting feedback:', error)
    return NextResponse.json(
      { error: 'Error inserting feedback', details: error },
      { status: 500 },
    )
  }
}
