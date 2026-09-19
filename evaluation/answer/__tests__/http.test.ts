/** @jest-environment node */
import * as http from 'http'
import { AddressInfo } from 'net'
import { fetchJson, HttpTimeoutError } from '../http'

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    })
  })
}

function close(server: http.Server): Promise<void> {
  // closeAllConnections() first: close() alone waits forever on keep-alive
  // sockets the fake servers deliberately leave open (never-responding,
  // mid-body stalls) — that hang is what wedged Jest's exit.
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('fetchJson', () => {
  it('rejects with HttpTimeoutError (bounded wall time) when the server never responds', async () => {
    const server = http.createServer(() => {
      /* accept the request, never respond */
    })
    const url = await listen(server)
    const t0 = Date.now()
    await expect(fetchJson(url, { timeoutMs: 300 })).rejects.toThrow(
      HttpTimeoutError,
    )
    // Two attempts (retries default 1) × 300ms must stay well under 2s —
    // the promise settles, it does not hang until Jest times out.
    expect(Date.now() - t0).toBeLessThan(2_000)
    await close(server)
  })

  it('rejects with HttpTimeoutError when the server stalls mid-body', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"partial": true')
      /* headers sent, body never finishes */
    })
    const url = await listen(server)
    const t0 = Date.now()
    await expect(fetchJson(url, { timeoutMs: 300 })).rejects.toThrow(
      HttpTimeoutError,
    )
    expect(Date.now() - t0).toBeLessThan(2_000)
    await close(server)
  })

  it('retries once on a socket error and succeeds', async () => {
    let attempts = 0
    const server = http.createServer((_req, res) => {
      attempts++
      if (attempts === 1) {
        // Reset the connection before any response bytes reach the client.
        _req.socket.destroy()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const url = await listen(server)
    const result = await fetchJson(url, { retries: 1 })
    expect(attempts).toBe(2)
    expect(result.ok).toBe(true)
    expect(result.json).toEqual({ ok: true })
    expect(result.status).toBe(200)
    await close(server)
  })

  it('throws an error carrying status and text for a non-JSON body (no retry)', async () => {
    let attempts = 0
    const server = http.createServer((_req, res) => {
      attempts++
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('Bad Gateway from upstream')
    })
    const url = await listen(server)
    let caught: any
    try {
      await fetchJson(url)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    expect(caught.status).toBe(502)
    expect(caught.message).toContain('Bad Gateway from upstream')
    // A parse failure is a protocol answer, not a transport failure — it
    // must not burn the retry.
    expect(attempts).toBe(1)
    await close(server)
  })
})
