import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '../../../db/data-source'
import { insertCiteModeQueryLog } from '../../../db/queries/insertCiteModeQueryLog'

export async function POST(req: NextRequest) {
  await initializeDatabase()
  try {
    const body = await req.json()
    const record = await insertCiteModeQueryLog(body)
    console.log('✅ Query inserted:', record)
    return NextResponse.json(record, { status: 201 })
  } catch (error) {
    console.error('❌ Error inserting query:', error)
    return NextResponse.json(
      { error: 'Error inserting query', details: error },
      { status: 500 },
    )
  }
}
