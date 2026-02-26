import { NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await readEvalFile('cite-report-latest.json');
  if (!data) {
    return NextResponse.json(
      { error: 'No cite report found. Run eval:cite then eval:upload.' },
      { status: 404 },
    );
  }
  return NextResponse.json(data);
}
