import { gatewayBody, expansionArm } from '../lib/gateway-body'

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
