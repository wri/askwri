/**
 * Fake-server helpers for the answer-eval suites. Servers bind 127.0.0.1
 * only; tests never leave the loopback interface.
 */
import * as http from 'http'
import { AddressInfo } from 'net'

/** Bind a fake server to 127.0.0.1 on an ephemeral port; resolves its base URL. */
export function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

/** closeAllConnections() BEFORE close(): deliberately-stalled keep-alive
 * sockets otherwise wedge Jest's exit after the suite. */
export function close(server: http.Server): Promise<void> {
  // Idempotent: a suite's afterEach registry may close a server the test
  // already closed on its happy path.
  if (!server.listening) return Promise.resolve()
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

/** Collect a request's JSON body, then hand it to the handler. */
export function readJsonBody(
  req: http.IncomingMessage,
  handler: (body: any) => void,
): void {
  let raw = ''
  req.on('data', (c: string) => (raw += c))
  req.on('end', () => handler(raw ? JSON.parse(raw) : null))
}

/** Respond with JSON. */
export function respondJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
