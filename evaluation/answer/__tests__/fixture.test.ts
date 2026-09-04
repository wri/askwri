/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  expectedIdsOf,
  isNegative,
  keyFactsOf,
  loadEvalset,
  twinOf,
} from '../fixture'
import { Evalset, FixtureCase } from '../types'

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalset-test-'))
})
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeJson(name: string, data: unknown): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(data))
  return p
}

// Mirrors the real evalset_answer_02.json case shape (nested
// retrieval_ground_truth, chunk-resolved text_snippet).
const caseWithIds: FixtureCase = {
  id: 'q1_zero-emission-heavy-duty-trucks',
  question: 'What is the projected market penetration rate?',
  retrieval_ground_truth: {
    expected_external_ids: [
      '2025_zero-emission-heavy-duty-trucks_00015',
      '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
    ],
    expected_document_ids: [],
    expected_passages: [
      {
        doc_id: '2025_zero-emission-heavy-duty-trucks_00015',
        chunk_id: '2025_zero-emission-heavy-duty-trucks_00015_chunk_14',
        page: 7,
        text_snippet: '在测算新能源重卡的成本回收期与TCO过程中',
      },
    ],
  },
  synthesis_ground_truth: { key_facts: ['fact one', 'fact two'] },
}

describe('loadEvalset', () => {
  it('loads a valid minimal evalset', () => {
    const es = loadEvalset(
      writeJson('ok.json', {
        name: 'evalset-answer-02',
        version: '3.0',
        test_cases: [{ id: 'q1', question: 'What about trucks?' }],
      }),
    )
    expect(es.name).toBe('evalset-answer-02')
    expect(es.version).toBe('3.0')
    expect(es.test_cases).toHaveLength(1)
    expect(es.test_cases[0].id).toBe('q1')
  })

  it('loads the full nested-fixture shape', () => {
    const es = loadEvalset(
      writeJson('full.json', {
        name: 'full',
        test_cases: [caseWithIds],
        twins: [
          [
            '2025_zero-emission-heavy-duty-trucks_00015',
            '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
          ],
        ],
      }),
    )
    expect(es.test_cases[0]).toEqual(caseWithIds)
    expect(es.twins).toHaveLength(1)
  })

  it('throws when test_cases is not an array', () => {
    expect(() =>
      loadEvalset(
        writeJson('bad-cases.json', { name: 'x', test_cases: 'nope' }),
      ),
    ).toThrow('test_cases')
  })

  it('throws with the case id when a case is missing its question', () => {
    expect(() =>
      loadEvalset(
        writeJson('no-question.json', {
          name: 'x',
          test_cases: [{ id: 'q9' }],
        }),
      ),
    ).toThrow('q9')
  })

  it('throws with the index when a case is missing its id', () => {
    expect(() =>
      loadEvalset(
        writeJson('no-id.json', {
          name: 'x',
          test_cases: [{ question: 'Q?' }],
        }),
      ),
    ).toThrow('index 0')
  })

  it('throws when a twins entry is not a 2-length array', () => {
    expect(() =>
      loadEvalset(
        writeJson('bad-twins.json', {
          name: 'x',
          test_cases: [{ id: 'q1', question: 'Q?' }],
          twins: [['a'], ['b', 'c', 'd']],
        }),
      ),
    ).toThrow('twins')
  })

  it('throws with the case id when an expected_passages entry lacks doc_id/text_snippet', () => {
    expect(() =>
      loadEvalset(
        writeJson('bad-passage.json', {
          name: 'x',
          test_cases: [
            {
              id: 'q2',
              question: 'Q?',
              retrieval_ground_truth: {
                expected_passages: [{ doc_id: 'd', chunk_id: 'c' }],
              },
            },
          ],
        }),
      ),
    ).toThrow('q2')
  })
})

describe('twinOf', () => {
  const es: Evalset = {
    name: 'twins',
    test_cases: [],
    twins: [['doc_a', 'doc_twin']],
  }

  it('resolves the partner in both directions', () => {
    expect(twinOf(es, 'doc_a')).toBe('doc_twin')
    expect(twinOf(es, 'doc_twin')).toBe('doc_a')
  })

  it('is undefined for a non-twin id and for an evalset without twins', () => {
    expect(twinOf(es, 'other')).toBeUndefined()
    expect(twinOf({ name: 'plain', test_cases: [] }, 'doc_a')).toBeUndefined()
  })
})

describe('keyFactsOf', () => {
  it('returns the key facts', () => {
    expect(keyFactsOf(caseWithIds)).toEqual(['fact one', 'fact two'])
  })

  it('returns [] when absent', () => {
    expect(keyFactsOf({ id: 'q1', question: 'Q?' })).toEqual([])
  })
})

describe('expectedIdsOf', () => {
  it('returns the nested expected_external_ids', () => {
    expect(expectedIdsOf(caseWithIds)).toEqual([
      '2025_zero-emission-heavy-duty-trucks_00015',
      '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
    ])
  })

  it('returns [] when absent', () => {
    expect(expectedIdsOf({ id: 'q1', question: 'Q?' })).toEqual([])
  })
})

describe('isNegative', () => {
  it('true for empty expected ids and no key facts', () => {
    expect(
      isNegative({
        id: 'q_neg',
        question: 'Anything on nuclear microreactors?',
        retrieval_ground_truth: { expected_external_ids: [] },
      }),
    ).toBe(true)
  })

  it('false for a case with expected ids', () => {
    expect(isNegative(caseWithIds)).toBe(false)
  })

  it('false for a case with no ids but key facts', () => {
    expect(
      isNegative({
        id: 'q3',
        question: 'Q?',
        synthesis_ground_truth: { key_facts: ['a fact'] },
      }),
    ).toBe(false)
  })
})
