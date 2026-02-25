import { NextRequest, NextResponse } from 'next/server';
import { readEvalFile, writeEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { question_id: string; chunk_id: string; override: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { question_id, chunk_id, override: overrideVal } = body;
  if (!question_id || !chunk_id) {
    return NextResponse.json({ error: 'Missing question_id or chunk_id' }, { status: 400 });
  }

  const validOverrides = ['relevant', 'partially_relevant', 'not_relevant', null];
  if (!validOverrides.includes(overrideVal)) {
    return NextResponse.json({ error: 'Invalid override value' }, { status: 400 });
  }

  const data = await readEvalFile('answer-labels-review.json') as {
    questions: Array<{
      id: string;
      chunks: Array<{ chunk_id: string; human_override: string | null }>;
    }>;
  } | null;

  if (!data) {
    return NextResponse.json({ error: 'Labels file not found' }, { status: 404 });
  }

  let found = false;
  for (const q of data.questions) {
    if (q.id === question_id) {
      for (const c of q.chunks) {
        if (c.chunk_id === chunk_id) {
          c.human_override = overrideVal;
          found = true;
          break;
        }
      }
      break;
    }
  }

  if (!found) {
    return NextResponse.json({ error: 'Chunk not found' }, { status: 404 });
  }

  await writeEvalFile('answer-labels-review.json', data);
  return NextResponse.json({ ok: true });
}
