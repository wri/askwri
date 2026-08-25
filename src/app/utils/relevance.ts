export type RelevanceLevel = string // 0 to 1, where 1 is most relevant

export function getRelevanceLevel(score: number): RelevanceLevel {
  return score.toFixed(2).toString()
}
