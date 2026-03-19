import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { insertAnswerModeQueryLog } from '../../../db/queries/insertAnswerModeQueryLog'

export async function POST(req: NextRequest) {
  await initializeDatabase()
  try {
    const body = await req.json()
    const record = await insertAnswerModeQueryLog(body)
    console.log('✅ Query inserted')
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error('❌ Error inserting query:', error)
    const errorMessage =
      error instanceof Error ? error.message : 'An unexpected error occurred'
    const isProduction = process.env.NODE_ENV === 'production'
    const responseBody: { error: string; details?: string } = {
      error: 'Error inserting query',
    }
    if (!isProduction) {
      responseBody.details = errorMessage
    }
    return NextResponse.json(responseBody, { status: 500 })
  }
}
