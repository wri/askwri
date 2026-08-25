export interface FeedbackInput {
  mode: string
  query: string
  docId: string
  relevance_score: number
  publication_name: string
  row_number: number
  summary: string
  how_relevant: string
  feedback?: string
}
