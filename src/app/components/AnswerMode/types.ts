import { DocMeta } from '@/lib/llamacloud'
import { RowData } from '../results/types'

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
  firstDocHowRelevant: string
  consultedDocs?: RowData[]
  supportingDocs: DocMeta[]
  setAnswer: (answer: AnswerResult | null) => void
  setQuery: (query: string) => void
}

export interface AISearchFormProps {
  query: string
  loading: boolean
  suggestions: string[]
  numberOfCiteDocs?: number
  onQueryChange: (query: string) => void
  onSubmit: () => void
  onShuffleSuggestions: () => void
  onExampleClick: (example: string) => void
}

export type CitationTarget = {
  score: number
  page?: number
  passage_id: string
}

export interface WhyMeta {
  why: string
  relation: 'direct' | 'indirect'
}

export interface SupportingCitationsProps {
  supportingDocs: DocMeta[]
  setFirstDocHowRelevant: (why: string) => void
}
