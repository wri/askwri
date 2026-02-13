export interface AnswerResult {
  sentences: string[]
  paragraphs?: string[][]
  inline?: { ref: string; page: number }[][]
  confidence?: number
  warning?: string
  warningMessage?: string
}

export interface AnswerPanelProps {
  query: string
  answer: AnswerResult
  setAnswer: (answer: AnswerResult | null) => void
  setQuery: (query: string) => void
}

export interface AISearchFormProps {
  query: string
  loading: boolean
  suggestions: string[]
  onQueryChange: (query: string) => void
  onSubmit: () => void
  onShuffleSuggestions: () => void
  onExampleClick: (example: string) => void
}

export interface KP {
  snippet: string
  page?: number
  passage_id?: string
  kp_relevance: number
  citation_targets?: Array<{ score: number; page?: number; passage_id: string }>
}

export interface DocMeta {
  doc_id: string
  ref: string
  title?: string
  authors?: string[]
  year?: number
  kps?: KP[]
  score?: number
  url?: string
  _url?: string
}

export interface WhyMeta {
  why: string
  relation: 'direct' | 'indirect'
}

export interface SupportingCitationsProps {
  docs: DocMeta[]
}
