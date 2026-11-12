/**
 * Shapes shared by the route-sweep stages. A frozen set is written once and
 * reused across model pairs, so it carries the provenance that makes a rerun
 * comparable: the target, the evalset, the submodule commit that pinned the
 * cases, and the `max_results` that sized each retrieval.
 */
import type { RouteProvenance } from '@/lib/route-model'

export type RouteName =
  'batch-why' | 'batch-relates' | 'alignment' | 'translate'

export type FrozenCase = {
  id: string
  question: string
  source_language?: string
  docs: any[]
  doc_count: number
}

/** What the readout needs to say which cases never ran: `runSweep` skips a case
 * whose frozen retrieval returned nothing, so a case with no calls is absent
 * from `calls[]` entirely and would otherwise read as a case nobody selected.
 * The frozen retrieval is left out on purpose — `calls[]` already records the
 * request each call actually sent, and embedding every case's documents would
 * turn the artifact's header into retrieval payload nobody reads. */
export type CaseRoster = { id: string; question: string; doc_count: number }

export type FrozenSet = {
  label: string
  target: string
  evalset: string
  submodule_commit: string
  max_results: number
  cases: FrozenCase[]
  /** Present only when the loaded set had no `expert_approved` case to filter
   * on, so a reader is not left believing these cases were reviewed. */
  evalsetNote?: string
}

export type CallResult = {
  route: RouteName
  case_id: string
  model: string
  request: unknown
  response: unknown
  provenance?: RouteProvenance
  latency_ms: number
  error?: string
}

export type SweepArtifact = {
  label: string
  target: string
  models: [string, string]
  code_version: string | null
  max_results: number
  submodule_commit: string
  /** Optional: an artifact written before the roster existed, or by a caller
   * that did not freeze a set, still renders — it just says nothing about
   * cases that never ran rather than inventing them. */
  cases?: CaseRoster[]
  calls: CallResult[]
}
