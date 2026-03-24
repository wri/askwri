import type { Dispatch, SetStateAction } from 'react'
import { DocMeta, KP } from '@/lib/llamacloud'
import { RowData } from '../results/types'

export type Assessment = {
  insights: string[]
  alignment: 'High' | 'Moderate' | 'Low' | 'Very Low'
  _debugKeys?: string[]
}

export interface AnswerResult {
  sentences: string[]
  paragraphs?: string[][]
  inline?: { ref: string; page: number }[][]
  warning?: string
  warningMessage?: string
}

export type Ops = {
  index_version: string
  prompt_version: string
  cost_usd: number | null
  energy_gco2e: number | null
}

export interface AnswerPanelProps {
  query: string
  answer: AnswerResult
  firstDocHowRelevant: string
  consultedDocs?: RowData[]
  supportingDocs: DocMeta[]
  setAnswer: (answer: AnswerResult | null) => void
  setQuery: (query: string) => void
  alignLoading?: boolean
  alignment?: Assessment | null
  ops: Ops | null
  setSupportingCitationsPage?: (page: number) => void
  supportingCitationsPage?: number
  coverageRating?: string
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
  page?: number
  setPage?: (p: number) => void
  scrollVersion?: number
  sourceRelevance?: Record<string, string> // doc_id → 'strong' | 'partial' | 'weak'
  coverageRating?: string
  coverageExplanation?: string
  passageWhy: Record<string, WhyMeta>
  setPassageWhy: Dispatch<SetStateAction<Record<string, WhyMeta>>>
  passageWhyLoading: Record<string, boolean>
  setPassageWhyLoading: Dispatch<SetStateAction<Record<string, boolean>>>
}

export type Usage = {
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
}

export interface CitationCardProps {
  doc: DocMeta
  kp: KP
  idx: number
  itemRef: (el: HTMLElement | null) => void
  passageWhy: Record<string, WhyMeta>
  passageWhyLoading: Record<string, boolean>
  docSummary: Record<string, string>
  docSummaryLoading: Record<string, boolean>
}
