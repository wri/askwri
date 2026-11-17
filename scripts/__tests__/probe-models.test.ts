/** @jest-environment node */
import { SYS_V2 } from '../../src/lib/answer-synthesis'
import { probeProfile } from '../probe-models'
import { profiles } from '../probe-profiles'

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

it('reports usable=false when a json_object profile returns prose', async () => {
  const r = await probeProfile({
    profile: profiles['alignment.json_object'],
    model: 'gpt-6-luna',
    effort: 'none',
    budget: 1500,
    apiKey: 'k',
    fetchImpl: (async () =>
      reply({
        choices: [{ finish_reason: 'stop', message: { content: 'Sure!' } }],
        usage: {},
      })) as any,
  })
  expect(r.ok).toBe(true)
  expect(r.usable).toBe(false)
})

it('reports usable=false when the reply hit the budget', async () => {
  const r = await probeProfile({
    profile: profiles['answer'],
    model: 'gpt-6.1-sol',
    effort: 'medium',
    budget: 2000,
    apiKey: 'k',
    fetchImpl: (async () =>
      reply({
        choices: [
          { finish_reason: 'length', message: { content: '{"sentences":[' } },
        ],
        usage: {},
      })) as any,
  })
  expect(r).toMatchObject({ ok: true, usable: false, finishReason: 'length' })
})

it('reports reasoning tokens separately from answer tokens', async () => {
  const r = await probeProfile({
    profile: profiles['alignment.schema'],
    model: 'gpt-6.1-terra',
    effort: 'medium',
    budget: 4000,
    apiKey: 'k',
    fetchImpl: (async () =>
      reply({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                insights: ['a', 'b'],
                alignment: 'High',
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 2400,
          completion_tokens: 340,
          completion_tokens_details: { reasoning_tokens: 32 },
        },
      })) as any,
  })
  expect(r).toMatchObject({
    ok: true,
    usable: true,
    promptTokens: 2400,
    completionTokens: 340,
    reasoningTokens: 32,
  })
})

it('sends only the fields the profile supplies — no temperature for a reasoning profile', async () => {
  let url = ''
  let sent: any = {}
  let auth = ''
  await probeProfile({
    profile: profiles['why'],
    model: 'gpt-6-luna',
    effort: 'none',
    budget: 2200,
    apiKey: 'k',
    fetchImpl: (async (u: string, init: any) => {
      url = u
      auth = init.headers.authorization
      sent = JSON.parse(init.body)
      return reply({
        choices: [{ finish_reason: 'stop', message: { content: '[]' } }],
        usage: {},
      })
    }) as any,
  })
  expect(url).toMatch(/\/chat\/completions$/)
  expect(auth).toBe('Bearer k')
  expect(sent.model).toBe('gpt-6-luna')
  expect(sent.reasoning_effort).toBe('none')
  expect(sent.max_completion_tokens).toBe(2200)
  expect(sent).not.toHaveProperty('temperature')
  expect(sent).not.toHaveProperty('max_tokens')
  expect(sent).not.toHaveProperty('response_format')
})

it('never throws, and a timeout reports ok=false', async () => {
  const r = await probeProfile({
    profile: profiles['translate'],
    model: 'gpt-6-luna',
    effort: 'none',
    budget: 2000,
    apiKey: 'k',
    timeoutMs: 5,
    fetchImpl: (async () => {
      await new Promise((res) => setTimeout(res, 50))
      return reply({})
    }) as any,
  })
  expect(r.ok).toBe(false)
})

it('reports ok=false when the body never arrives before the timeout', async () => {
  const r = await probeProfile({
    profile: profiles['translate'],
    model: 'gpt-6-luna',
    effort: 'none',
    budget: 2000,
    apiKey: 'k',
    timeoutMs: 5,
    fetchImpl: (async () =>
      ({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      }) as any) as any,
  })
  expect(r.ok).toBe(false)
})

it('reads a tool call before prose, so a forced tool_choice reply stays usable', async () => {
  const r = await probeProfile({
    profile: profiles['alignment.tools'],
    model: 'gpt-6.1-terra',
    effort: 'medium',
    budget: 4000,
    apiKey: 'k',
    fetchImpl: (async () =>
      reply({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'Sure!',
              tool_calls: [
                {
                  function: {
                    name: 'set_assessment',
                    arguments: JSON.stringify({
                      insights: ['a', 'b'],
                      alignment: 'High',
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {},
      })) as any,
  })
  expect(r).toMatchObject({ ok: true, usable: true })
})

it('a profile supplies its own body verbatim', () => {
  const body = profiles['answer'].body({
    model: 'gpt-6.1-sol',
    effort: 'medium',
    budget: 2000,
  })
  const messages = body.messages as Array<{ role: string; content: string }>
  // The answer route sends no response_format: it asks for JSON in the prompt.
  expect(body).not.toHaveProperty('response_format')
  expect(body.max_completion_tokens).toBe(2000)
  expect(body.reasoning_effort).toBe('medium')
  expect(messages[0]).toEqual({ role: 'system', content: SYS_V2 })
  expect(messages[1].content).toMatch(/^Question: /)
  expect(messages[1].content.match(/^\[\d+\] "/gm)).toHaveLength(
    profiles['answer'].inputCount,
  )
  expect(profiles['why'].inputCount).toBe(25)
})
