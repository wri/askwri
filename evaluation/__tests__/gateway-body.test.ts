import {
  gatewayBody,
  expansionArm,
  facetsForCase,
  validateFacetCaseIds,
} from '../lib/gateway-body'

const ENV = { ...process.env }
afterEach(() => {
  process.env = { ...ENV }
})

it('sends no retrieval params when no arm is asked for', () => {
  delete process.env.EVAL_EXPANSION
  expect(gatewayBody('hydrogen buses', 'cite')).toEqual({
    query: 'hydrogen buses',
    mode: 'cite',
  })
  expect(expansionArm()).toBe('on')
})

it('sends expansion:false for the flag-off arm', () => {
  process.env.EVAL_EXPANSION = 'off'
  expect(gatewayBody('hydrogen buses', 'cite')).toEqual({
    query: 'hydrogen buses',
    mode: 'cite',
    expansion: false,
  })
  expect(expansionArm()).toBe('off')
})

it('sends the plain body for an explicit on', () => {
  process.env.EVAL_EXPANSION = 'on'
  expect(gatewayBody('hydrogen buses', 'answer')).toEqual({
    query: 'hydrogen buses',
    mode: 'answer',
  })
})

it('fails fast on any other value rather than running a default-arm comparison', () => {
  for (const bad of ['Of', 'false', '0', 'OFF ']) {
    process.env.EVAL_EXPANSION = bad
    expect(() => expansionArm()).toThrow(/EVAL_EXPANSION/)
  }
})

it('sends per-case facets and asks for exclusion diagnostics', () => {
  process.env.EVAL_FACETS = JSON.stringify({
    q11: [{ facet: 'excluded_keyword', value: 'electric buses' }],
  })
  expect(facetsForCase('q11')).toEqual([
    { facet: 'excluded_keyword', value: 'electric buses' },
  ])
  expect(gatewayBody('q', 'cite', facetsForCase('q11'))).toMatchObject({
    facets: [{ facet: 'excluded_keyword', value: 'electric buses' }],
    return_intermediate_results: true,
  })
})

it('sends no facets for cases the manifest does not name', () => {
  process.env.EVAL_FACETS = JSON.stringify({
    q11: [{ facet: 'excluded_keyword', value: 'electric buses' }],
  })
  expect(facetsForCase('q12')).toEqual([])
  expect(gatewayBody('q', 'cite', facetsForCase('q12'))).toEqual({
    query: 'q',
    mode: 'cite',
  })
})

it('returns no facets for any case when EVAL_FACETS is unset', () => {
  delete process.env.EVAL_FACETS
  expect(facetsForCase('q11')).toEqual([])
})

it('returns an empty manifest on a fresh module with EVAL_FACETS unset', () => {
  // Regression: the cache starts null, and `manifestCache?.raw === undefined`
  // matched the unset env value, so the first call dereferenced null.
  delete process.env.EVAL_FACETS
  jest.resetModules()
  const fresh =
    require('../lib/gateway-body') as typeof import('../lib/gateway-body')
  expect(fresh.facetsManifest()).toEqual({})
  expect(fresh.facetsForCase('q11')).toEqual([])
})

it('fails fast on a malformed facets manifest', () => {
  process.env.EVAL_FACETS = JSON.stringify({ q11: 'electric buses' })
  expect(() => facetsForCase('q11')).toThrow(/EVAL_FACETS/)
})

it('fails fast on facets manifest JSON that does not parse', () => {
  process.env.EVAL_FACETS = '{q11:'
  expect(() => facetsForCase('q11')).toThrow(/EVAL_FACETS/)
})

it('accepts a manifest key present in the union of case ids', () => {
  process.env.EVAL_FACETS = JSON.stringify({
    q11: [{ facet: 'excluded_keyword', value: 'electric buses' }],
  })
  expect(() =>
    validateFacetCaseIds(new Set(['q12', 'q11', 'q13'])),
  ).not.toThrow()
})

it('fails fast on a manifest key absent from the union of case ids', () => {
  process.env.EVAL_FACETS = JSON.stringify({
    q11: [{ facet: 'excluded_keyword', value: 'electric buses' }],
  })
  expect(() => validateFacetCaseIds(new Set(['q12', 'q13']))).toThrow(
    /EVAL_FACETS/,
  )
})
