export const CITE_MODE_SUGGESTION_POOL = [
  'How to build more equal cities',
  'Economic benefits of transit-oriented development',
  'Guidelines for safe bike lanes',
  'Urban nature-based solutions',
  'Policies to support electric bus fleets',
  'Most effective urban climate actions',
  'Latest on building efficiency',
  'How to integrate cities into NDCs',
  'Paratransit integration for cities',
]

export const ANSWER_MODE_SUGGESTION_POOL = [
  'What role do land value capture mechanisms play in more equitable urban development?',
  'Are denser cities more sustainable? Why?',
  'How can national governments better integrate subnational leadership into their NDCs?',
  'How do we improve motorcycle safety in cities?',
  'How can cities pay for electric buses?',
  'What are nature-based solutions and how can they improve cities?',
  'How do slums and informality affect climate resilience in cities?',
  'What are the key opportunities for enhancing public transport in NDCs?',
  'How do we make housing more affordable in cities?',
]

export const getRandomSuggestions = (
  count = 3,
  mode: 'cite' | 'answer' = 'cite',
) => {
  const pool = [
    ...(mode === 'cite'
      ? CITE_MODE_SUGGESTION_POOL
      : ANSWER_MODE_SUGGESTION_POOL),
  ]
  const results: string[] = []

  while (pool.length > 0 && results.length < count) {
    const index = Math.floor(Math.random() * pool.length)
    const [item] = pool.splice(index, 1)
    results.push(item)
  }

  return results
}
