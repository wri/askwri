/** @jest-environment node */
import { assertReadableCaptureSchema } from '../fingerprint'

/** Minimal shape — the assertion only looks at `schema`. */
const base = { provenance: {}, preflight: {}, cases: [] }

describe('assertReadableCaptureSchema', () => {
  it('accepts @1 (pre-selection captures)', () => {
    expect(() =>
      assertReadableCaptureSchema(
        { ...base, schema: 'answer-eval/capture@1' },
        'capture-x.json',
      ),
    ).not.toThrow()
  })

  it('accepts @2 (selection-bearing captures)', () => {
    expect(() =>
      assertReadableCaptureSchema(
        {
          ...base,
          schema: 'answer-eval/capture@2',
          selection: { mode: 'fixture-set', by_case: [] },
        },
        'capture-x.json',
      ),
    ).not.toThrow()
  })

  it('rejects an unknown schema string, naming the origin and the found schema', () => {
    expect(() =>
      assertReadableCaptureSchema(
        { ...base, schema: 'answer-eval/capture@3' },
        'capture-x.json',
      ),
    ).toThrow(/capture-x\.json[\s\S]*capture@3/)
  })

  it('rejects a judged artifact handed to --capture', () => {
    expect(() =>
      assertReadableCaptureSchema(
        { schema: 'answer-eval/judged@1' },
        'judged-x.json',
      ),
    ).toThrow(/judged-x\.json[\s\S]*judged@1/)
  })

  it('rejects a missing schema, naming the origin', () => {
    expect(() => assertReadableCaptureSchema({}, 'capture-x.json')).toThrow(
      /capture-x\.json[\s\S]*missing/,
    )
  })
})
