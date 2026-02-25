import { NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await readEvalFile('answer-synthesis-eval-final.json');
  if (!data) {
    return NextResponse.json(
      { error: 'answer-synthesis-eval-final.json not found. Run stages 1-2 first.' },
      { status: 404 },
    );
  }
  return NextResponse.json(data);
}
