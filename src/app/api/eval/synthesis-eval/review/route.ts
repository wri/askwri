import { NextRequest, NextResponse } from 'next/server';
import { readEvalFile, writeEvalFile } from '@/lib/eval-storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: {
    test_case_id: string;
    human_eval: {
      scores: Record<string, number>;
      qualitative_feedback: string;
      key_facts_confirmed: string[];
      key_facts_added: string[];
      reviewed: boolean;
    };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.test_case_id || !body.human_eval) {
    return NextResponse.json({ error: 'Missing test_case_id or human_eval' }, { status: 400 });
  }

  const he = body.human_eval;
  const validDims = ['faithfulness', 'completeness', 'conciseness', 'coherence', 'citation_accuracy'];
  if (he.scores) {
    for (const [key, val] of Object.entries(he.scores)) {
      if (!validDims.includes(key) || typeof val !== 'number' || val < 0 || val > 1) {
        return NextResponse.json({ error: `Invalid score: ${key}=${val}` }, { status: 400 });
      }
    }
  }
  if (typeof he.reviewed !== 'boolean') {
    return NextResponse.json({ error: 'reviewed must be a boolean' }, { status: 400 });
  }

  const data = await readEvalFile('answer-synthesis-eval-final.json') as {
    test_cases: Array<{ test_case_id: string; human_eval: any }>;
  } | null;

  if (!data) {
    return NextResponse.json({ error: 'Eval file not found' }, { status: 404 });
  }

  const tc = data.test_cases.find(t => t.test_case_id === body.test_case_id);
  if (!tc) {
    return NextResponse.json({ error: 'Test case not found' }, { status: 404 });
  }

  tc.human_eval = body.human_eval;
  await writeEvalFile('answer-synthesis-eval-final.json', data);
  return NextResponse.json({ ok: true });
}
