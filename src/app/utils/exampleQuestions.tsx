export const CITE_MODE_SUGGESTION_POOL = [
  'What have we published on land value capture? (topic area)',
  'What have we published on Bangalore?',
  'What have we published on children and pollution?',
  'What have we published on climate adaptation in Brazil?',
  'How can cities implement micromobility solutions?',
  "Will electrifying school buses be beneficial for children's health outcomes?",
  'What can be done to solve the housing crisis in Jakarta?',
  'Have we published any papers or reports on hydrogen?',
  'Give me all the papers that were published as part of the cities World Resources Report?',
  'Have we published anything to do with urban finance since 2020?',
  'Have we published anything to do with urban finance – please exclude anything to do with electric buses?',
]

export const ANSWER_MODE_SUGGESTION_POOL = [
  'How has compact urban growth changed in India since 2020?',
  'What have we published on Bangalore?',
  'What have we published on children and pollution?',
  'What have we published on climate adaptation in Brazil?',
  'How can cities implement micromobility solutions?',
  "Will electrifying school buses be beneficial for children's health outcomes?",
  'What can be done to solve the housing crisis in Jakarta?',
  'Have we published any papers or reports on hydrogen?',
  'Give me all the papers that were published as part of the cities World Resources Report?',
  'Have we published anything to do with urban finance since 2020?',
  'Have we published anything to do with urban finance – please exclude anything to do with electric buses?',
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
