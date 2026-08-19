/**
 * P2 displacement instrument (design 2026-08-19 §7, named regression
 * mechanism): classify each MISSED golden doc by what the fused list and
 * the exact rerank window say happened to it. A "variant-only" node is one
 * no original lane surfaced (dense and sparse both null) — it exists only
 * because an expansion lane (e.g. alias_sparse) added it.
 */
import { extractUrlSlug } from './metrics'

export interface FusedNode {
  node_id: string
  doc_id: string | null
  url: string
  fused_rank: number
  lanes: Record<string, number | null> | null
}

export interface DisplacementRecord {
  expected_url: string
  status:
    | 'never_retrieved'
    | 'in_window_not_returned'
    | 'displaced_by_variant_lane'
    | 'below_window'
  best_fused_rank?: number
  variant_only_in_window?: number
}

function isVariantOnly(lanes: Record<string, number | null> | null): boolean {
  if (!lanes) return false
  if (lanes.dense != null || lanes.sparse != null) return false
  return Object.entries(lanes).some(
    ([name, rank]) => name !== 'dense' && name !== 'sparse' && rank != null,
  )
}

export function classifyDisplacement(
  missedUrls: string[],
  fusedNodes: FusedNode[],
  rerankWindowIds: string[],
): DisplacementRecord[] {
  const window = new Set(rerankWindowIds)
  const variantOnlyInWindow = fusedNodes.filter(
    (n) => window.has(n.node_id) && isVariantOnly(n.lanes),
  ).length

  return missedUrls.map((url) => {
    const slug = extractUrlSlug(url)
    const nodes = fusedNodes.filter(
      (n) => slug && extractUrlSlug(n.url) === slug,
    )
    if (nodes.length === 0) {
      return { expected_url: url, status: 'never_retrieved' as const }
    }
    const best = Math.min(...nodes.map((n) => n.fused_rank))
    if (nodes.some((n) => window.has(n.node_id))) {
      return {
        expected_url: url,
        status: 'in_window_not_returned' as const,
        best_fused_rank: best,
      }
    }
    if (variantOnlyInWindow > 0) {
      return {
        expected_url: url,
        status: 'displaced_by_variant_lane' as const,
        best_fused_rank: best,
        variant_only_in_window: variantOnlyInWindow,
      }
    }
    return {
      expected_url: url,
      status: 'below_window' as const,
      best_fused_rank: best,
    }
  })
}
