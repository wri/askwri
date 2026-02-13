import { getThemedColor } from '@worldresources/wri-design-systems'

export type RelevanceLevel = 'High' | 'Medium' | 'Low'

export function getRelevanceLevel(score: number): RelevanceLevel {
  const percent = score * 100
  if (percent >= 70) return 'High'
  if (percent >= 40) return 'Medium'
  return 'Low'
}

// Helper to get relevance color (green, yellow, red) using theme colors
export const getRelevanceColor = (relevance: number) => {
  const percent = relevance * 100
  if (percent >= 70) return getThemedColor('success', 500) // green
  if (percent >= 40) return getThemedColor('warning', 500) // yellow
  return getThemedColor('error', 500) // red
}
