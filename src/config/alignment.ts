// Alignment LLM settings (OpenAI)
// Add OPENAI_API_KEY to .env.local

export const ALIGNMENT_MODEL =
  process.env.OPENAI_MODEL_ALIGNMENT ?? 'gpt-4o-mini'
export const ALIGNMENT_MAX_TOKENS = Number(process.env.OPENAI_MAX_TOKENS ?? 800)
export const ALIGNMENT_TEMPERATURE = Number(
  process.env.OPENAI_TEMPERATURE ?? 0.3,
)

// System prompt: two-step thinking (analyze, then synthesize)
export const ALIGNMENT_SYSTEM_PROMPT = `You are a research search assistant. Given a user query and a set of retrieved publications with relevance scores, produce feedback. Return this JSON: { 'insights': [string max 30 words] lenght 2, 'confidence': number }. Base your answer on this template replacing the examples in []: 
Several sources discuss [urban growth broadly rather than compact growth in India, with limited coverage from...].
You can improve your search by [including a timeframe, and a specific topic, for example interest in policies...]`
