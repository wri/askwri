import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { insertAnswerModeFeedback } from '../../../db/queries/insertAnswerModeFeedback'

export async function POST(req: NextRequest) {
  await initializeDatabase()
  try {
    const body = await req.json()
    const feedback = await insertAnswerModeFeedback(body)
    console.log('✅ Answer feedback inserted:', feedback)
    return NextResponse.json(feedback, { status: 201 })
  } catch (error) {
    console.error('❌ Error inserting answer feedback:', error)
    return NextResponse.json(
      { error: 'Failed to insert answer feedback', details: error },
      { status: 500 },
    )
  }
}
