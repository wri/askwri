/**
 * @jest-environment node
 */
import { resolveProvider, chatCompletion } from '../chat-completions'

const ENV = { ...process.env }
afterEach(() => {
  process.env = { ...ENV }
  jest.restoreAllMocks()
})

describe('resolveProvider', () => {
  it('defaults to OpenAI with the default model', () => {
    delete process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_KEY = 'sk-openai'
    const p = resolveProvider('gpt-5.4')
    expect(p).toEqual({
      model: 'gpt-5.4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      isGpt5: true,
    })
  })

  it('honours OPENAI_BASE_URL and strips a trailing slash', () => {
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1/'
    process.env.OPENAI_API_KEY = 'sk-openai'
    expect(resolveProvider('gpt-5.4').baseUrl).toBe('https://proxy.example/v1')
  })

  it('uses the lunaroute key when the override base_url is lunaroute', () => {
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.LUNAROUTE_BASE_URL = 'https://gw.lunaroute.com/v1'
    process.env.LUNAROUTE_API_KEY = 'lr-key'
    const p = resolveProvider('gpt-5.4', {
      model: 'glm-5.2-vision',
      base_url: 'https://gw.lunaroute.com/v1/',
    })
    expect(p).toEqual({
      model: 'glm-5.2-vision',
      baseUrl: 'https://gw.lunaroute.com/v1',
      apiKey: 'lr-key',
      isGpt5: false,
    })
  })

  it('an override base_url that is not lunaroute keeps the OpenAI key', () => {
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.LUNAROUTE_BASE_URL = 'https://gw.lunaroute.com/v1'
    process.env.LUNAROUTE_API_KEY = 'lr-key'
    const p = resolveProvider('gpt-5.4', {
      base_url: 'https://other.example/v1',
    })
    expect(p.apiKey).toBe('sk-openai')
    expect(p.baseUrl).toBe('https://other.example/v1')
  })
})

describe('chatCompletion', () => {
  it('POSTs to <baseUrl>/chat/completions with bearer auth and returns parsed json', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        {
          status: 200,
        },
      ),
    )
    const r = await chatCompletion({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      body: { model: 'gpt-5.4', messages: [] },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sk-x' }),
        body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.json.choices[0].message.content).toBe('hi')
  })

  it('returns {raw} json when the body is not JSON', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('<html>bad gateway</html>', { status: 502 }),
      )
    const r = await chatCompletion({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      body: {},
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(502)
    expect(r.json).toEqual({ raw: '<html>bad gateway</html>' })
    expect(r.text).toBe('<html>bad gateway</html>')
  })
})
