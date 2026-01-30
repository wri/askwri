export const SUGGESTION_POOL = [
  "What has WRI published on land value capture?",
  "What has WRI published on Bangalore?",
  "What has WRI published on children and pollution?",
  "What has WRI published on sustainable transport in Latin America?",
  "What has WRI published on climate finance in Africa?",
  "What has WRI published on energy efficiency in buildings?",
  "What has WRI published on regenerative agriculture in India?",
  "What has WRI published on blue carbon restoration?",
  "What has WRI published on water resilience in cities?",
  "What has WRI published on just energy transition policies?",
];

export const getRandomSuggestions = (count = 3) => {
  const pool = [...SUGGESTION_POOL];
  const results: string[] = [];

  while (pool.length > 0 && results.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    const [item] = pool.splice(index, 1);
    results.push(item);
  }

  return results;
};
