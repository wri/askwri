import { NextRequest, NextResponse } from 'next/server';
import { readEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const data = await readEvalFile('answer-synthesis-raw.json') as {
    test_cases: Array<{ test_case_id: string }>;
  } | null;

  if (!data) {
    return NextResponse.json(
      { error: 'answer-synthesis-raw.json not found. Run stage 1 first.' },
      { status: 404 },
    );
  }

  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const tc = data.test_cases.find(t => t.test_case_id === id);
    return tc
      ? NextResponse.json(tc)
      : NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  return NextResponse.json(data);
}
