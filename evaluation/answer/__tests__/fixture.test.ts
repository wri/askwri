/** @jest-environment node */
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  docSetOf,
  expectedDocsOutsideSet,
  expectedIdsOf,
  isNegative,
  keyFactsOf,
  loadEvalset,
  twinOf,
} from '../fixture'
import { DocSet, Evalset, FixtureCase } from '../types'

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

// --- doc_sets (Task 1: fixture contract) ---

const trucksSet: DocSet = {
  id: 'trucks-cluster',
  doc_ids: [
    '2025_zero-emission-heavy-duty-trucks_00015',
    '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
  ],
  note: 'zh source + en twin',
}

const trucksTwins: [string, string][] = [
  [
    '2025_zero-emission-heavy-duty-trucks_00015',
    '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
  ],
]

describe('doc_sets', () => {
  it('loads doc_sets and docSetOf resolves the referenced set', () => {
    const es = loadEvalset(
      writeJson('sets.json', {
        name: 'with-sets',
        test_cases: [
          { ...caseWithIds, doc_set_id: 'trucks-cluster' },
          { id: 'q2', question: 'No set on this one?' },
        ],
        twins: trucksTwins,
        doc_sets: [trucksSet],
      }),
    )
    expect(docSetOf(es, es.test_cases[0])?.id).toBe('trucks-cluster')
    expect(docSetOf(es, es.test_cases[0])?.doc_ids).toEqual(trucksSet.doc_ids)
    expect(docSetOf(es, es.test_cases[1])).toBeUndefined()
  })

  it('tolerates an evalset with no doc_sets at all (no-selection path)', () => {
    const es = loadEvalset(
      writeJson('no-sets.json', {
        name: 'legacy',
        test_cases: [caseWithIds],
      }),
    )
    expect(es.doc_sets).toBeUndefined()
    expect(docSetOf(es, es.test_cases[0])).toBeUndefined()
  })

  it('throws at load when a case doc_set_id names no set', () => {
    expect(() =>
      loadEvalset(
        writeJson('dangling-set.json', {
          name: 'x',
          test_cases: [{ id: 'q1', question: 'Q?', doc_set_id: 'missing-set' }],
          doc_sets: [trucksSet],
        }),
      ),
    ).toThrow('names no doc set')
  })

  it('throws at load when a case has doc_set_id but the evalset has no doc_sets at all', () => {
    // The same load-error rule as above, hit through the empty-ids path:
    // no doc_sets key anywhere -> every doc_set_id is unresolvable.
    expect(() =>
      loadEvalset(
        writeJson('no-sets-dangling.json', {
          name: 'x',
          test_cases: [
            { id: 'q1', question: 'Q?', doc_set_id: 'trucks-cluster' },
          ],
        }),
      ),
    ).toThrow('names no doc set')
  })

  it('throws when doc_sets is not an array', () => {
    expect(() =>
      loadEvalset(
        writeJson('bad-sets.json', {
          name: 'x',
          test_cases: [{ id: 'q1', question: 'Q?' }],
          doc_sets: 'nope',
        }),
      ),
    ).toThrow('doc_sets')
  })

  it('throws when a doc set entry lacks id or has empty doc_ids', () => {
    expect(() =>
      loadEvalset(
        writeJson('bad-entry.json', {
          name: 'x',
          test_cases: [{ id: 'q1', question: 'Q?' }],
          doc_sets: [{ doc_ids: ['a'] }],
        }),
      ),
    ).toThrow('doc_sets[0]')

    expect(() =>
      loadEvalset(
        writeJson('empty-ids.json', {
          name: 'x',
          test_cases: [{ id: 'q1', question: 'Q?' }],
          doc_sets: [{ id: 's1', doc_ids: [] }],
        }),
      ),
    ).toThrow('s1')
  })

  it('throws on duplicate doc set ids', () => {
    expect(() =>
      loadEvalset(
        writeJson('dup-set.json', {
          name: 'x',
          test_cases: [{ id: 'q1', question: 'Q?' }],
          doc_sets: [
            { id: 's1', doc_ids: ['a'] },
            { id: 's1', doc_ids: ['b'] },
          ],
        }),
      ),
    ).toThrow('duplicate')
  })

  it('a negative case may reference a doc set (checked at capture, not load)', () => {
    const es = loadEvalset(
      writeJson('neg-set.json', {
        name: 'x',
        test_cases: [
          {
            id: 'q17_negative',
            question: 'How do I apply for a Schengen visa?',
            doc_set_id: 'trucks-cluster',
          },
        ],
        doc_sets: [trucksSet],
      }),
    )
    expect(docSetOf(es, es.test_cases[0])?.id).toBe('trucks-cluster')
  })
})

describe('expectedDocsOutsideSet', () => {
  it('returns [] for a case with no doc set (no-selection tolerance)', () => {
    const es: Evalset = {
      name: 'x',
      test_cases: [caseWithIds],
      twins: trucksTwins,
    }
    expect(expectedDocsOutsideSet(es, caseWithIds)).toEqual([])
  })

  it('returns [] when every expected doc and its twin is in the set', () => {
    const es = loadEvalset(
      writeJson('subset-ok.json', {
        name: 'x',
        test_cases: [{ ...caseWithIds, doc_set_id: 'trucks-cluster' }],
        twins: trucksTwins,
        doc_sets: [trucksSet],
      }),
    )
    expect(expectedDocsOutsideSet(es, es.test_cases[0])).toEqual([])
  })

  it('reports expected docs and twins missing from the set, deduped', () => {
    const es = loadEvalset(
      writeJson('subset-bad.json', {
        name: 'x',
        test_cases: [{ ...caseWithIds, doc_set_id: 'zh-only' }],
        twins: trucksTwins,
        doc_sets: [
          {
            id: 'zh-only',
            doc_ids: ['2025_zero-emission-heavy-duty-trucks_00015'],
          },
        ],
      }),
    )
    // Expected ids are [zh, en]; the set holds only zh. The en doc is both
    // an expected id and the zh doc's twin — reported once.
    expect(expectedDocsOutsideSet(es, es.test_cases[0])).toEqual([
      '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
    ])
  })

  it('reports an expected doc whose twin alone is outside the set', () => {
    // Expected ids are [zh]; the set holds zh, so the expected-id branch
    // alone would return []. Only the zh doc's en twin is outside — this
    // pins the twin branch of the subset check (q16's union rule).
    const es = loadEvalset(
      writeJson('twin-outside.json', {
        name: 'x',
        test_cases: [
          {
            id: 'q1_zero-emission-heavy-duty-trucks',
            question: 'What is the projected market penetration rate?',
            retrieval_ground_truth: {
              expected_external_ids: [
                '2025_zero-emission-heavy-duty-trucks_00015',
              ],
            },
            doc_set_id: 'zh-only',
          },
        ],
        twins: trucksTwins,
        doc_sets: [
          {
            id: 'zh-only',
            doc_ids: ['2025_zero-emission-heavy-duty-trucks_00015'],
          },
        ],
      }),
    )
    expect(expectedDocsOutsideSet(es, es.test_cases[0])).toEqual([
      '2025_charging-toward-2035-policies-to-accelerate-zero_7455',
    ])
  })

  it('returns [] for a negative case with a doc set (no expected docs)', () => {
    const es = loadEvalset(
      writeJson('neg-subset.json', {
        name: 'x',
        test_cases: [
          {
            id: 'q17_negative',
            question: 'Off-domain question?',
            doc_set_id: 'trucks-cluster',
          },
        ],
        doc_sets: [trucksSet],
      }),
    )
    expect(expectedDocsOutsideSet(es, es.test_cases[0])).toEqual([])
  })
})
