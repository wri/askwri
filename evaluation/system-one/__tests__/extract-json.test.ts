/**
 * @jest-environment node
 *
 * node, not jsdom: `systems.ts` pulls in `node:child_process` and uses
 * `AbortSignal.timeout`, neither of which jsdom provides.
 */
import { extractJsonObject } from '../systems'

describe('extractJsonObject', () => {
  it('returns a bare JSON body unchanged', () => {
    expect(extractJsonObject('{"value":"x","confidence":0.9}')).toBe('{"value":"x","confidence":0.9}')
  })

  it('finds the object inside surrounding prose', () => {
    expect(extractJsonObject('Sure, here you go:\n{"value":"x"}\nHope that helps.')).toBe('{"value":"x"}')
  })

  it('ignores a stray closing brace in prose before the JSON', () => {
    // A greedy /\{[\s\S]*\}/ spans first-to-last brace; a naive depth counter
    // goes negative here and then never sees the real object.
    expect(extractJsonObject('see §} below\n{"value":"x"}')).toBe('{"value":"x"}')
  })

  it('stops at the first balanced object when two are present', () => {
    expect(extractJsonObject('{"a":1} and then {"b":2}')).toBe('{"a":1}')
  })

  it('returns the outermost object for nested JSON', () => {
    expect(extractJsonObject('prefix {"a":{"b":1}} suffix')).toBe('{"a":{"b":1}}')
  })

  it('does not treat braces inside strings as structure', () => {
    expect(extractJsonObject('{"note":"a } brace","v":1}')).toBe('{"note":"a } brace","v":1}')
  })

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"note":"say \\"hi\\"","v":1}')).toBe('{"note":"say \\"hi\\"","v":1}')
  })

  it('returns null when there is no object at all', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('}{')).toBeNull()
  })
})
