/** @jest-environment node */
import { resolveRouteModel } from '@/lib/route-model'

const req = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', { method: 'POST', headers })

afterEach(() => {
  delete process.env.EVAL_MODEL_OVERRIDE_TOKEN
})

it('uses the fallback when no model is requested', () => {
  expect(resolveRouteModel(req(), {}, 'gpt-5.4-nano')).toEqual({
    ok: true,
    model: 'gpt-5.4-nano',
  })
})

it('uses the fallback for a blank or non-string model', () => {
  expect(resolveRouteModel(req(), { model: '   ' }, 'gpt-5.4-nano').ok).toBe(
    true,
  )
  expect(resolveRouteModel(req(), { model: 42 }, 'gpt-5.4-nano')).toEqual(
    expect.objectContaining({ ok: true, model: 'gpt-5.4-nano' }),
  )
})

it('rejects an override when no token is configured', () => {
  expect(
    resolveRouteModel(req(), { model: 'gpt-5.6-luna' }, 'gpt-5.4-nano'),
  ).toEqual({
    ok: false,
    error: 'model override not enabled',
  })
})

it('rejects an override whose header does not match the token', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(
      req({ 'x-eval-token': 'wrong' }),
      { model: 'gpt-5.6-luna' },
      'gpt-5.4-nano',
    ).ok,
  ).toBe(false)
  expect(
    resolveRouteModel(req(), { model: 'gpt-5.6-luna' }, 'gpt-5.4-nano').ok,
  ).toBe(false)
})

it('honours an override with the matching token', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(
      req({ 'x-eval-token': 'secret' }),
      { model: 'gpt-5.6-luna' },
      'gpt-5.4-nano',
    ),
  ).toEqual({ ok: true, model: 'gpt-5.6-luna' })
})

it('resolves a non-gpt-5 name', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(
      req({ 'x-eval-token': 'secret' }),
      { model: 'o4-mini' },
      'gpt-5.4-nano',
    ),
  ).toEqual({ ok: true, model: 'o4-mini' })
})

it('refuses an override that cannot run the task effort', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  // translate runs at effort 'none', and 6.1-Sol does not support it (design §Constraints).
  expect(
    resolveRouteModel(
      req({ 'x-eval-token': 'secret' }),
      { model: 'gpt-6.1-sol' },
      'gpt-5.4-mini',
      'translate',
    ),
  ).toEqual({
    ok: false,
    error: 'model gpt-6.1-sol cannot run the none effort this task uses',
  })
})

it('allows an override that can run the task effort', () => {
  process.env.EVAL_MODEL_OVERRIDE_TOKEN = 'secret'
  expect(
    resolveRouteModel(
      req({ 'x-eval-token': 'secret' }),
      { model: 'gpt-6-luna' },
      'gpt-5.4-mini',
      'translate',
    ),
  ).toEqual({ ok: true, model: 'gpt-6-luna' })
})
