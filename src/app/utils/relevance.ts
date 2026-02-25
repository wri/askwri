import { getThemedColor } from '@worldresources/wri-design-systems'

export type RelevanceLevel = string // 0 to 1, where 1 is most relevant

export function getRelevanceLevel(score: number): RelevanceLevel {
  return score.toString()
}

// Helper to get relevance color (green, yellow, red) using theme colors
export const getRelevanceColor = (relevance: number) => {
  const percent = relevance * 100
  if (percent >= 70) return getThemedColor('success', 500) // green
  if (percent >= 40) return getThemedColor('warning', 500) // yellow
  return getThemedColor('error', 500) // red
}
