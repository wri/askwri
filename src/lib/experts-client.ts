import type { ExpertsRequest, ExpertsResponse } from './experts/types'

export async function fetchExperts(
  req: ExpertsRequest,
): Promise<ExpertsResponse> {
  const res = await fetch('/api/experts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(body?.error || `experts request failed (${res.status})`)
  return body as ExpertsResponse
}
