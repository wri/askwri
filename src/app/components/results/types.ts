import { DocMeta } from '@/lib/llamacloud'

export type RowData = {
  id: string | number
  publication_title: string
  author: string
  summary: string
  short_summary?: string
  relevance: string
  how_relevant: string
  download_url?: string | null
  relevance_score?: number
  confidence?: number
  row_number?: number
  year?: number
  fullDoc: DocMeta
}

export type SelectableResultRowProps = {
  query: string
  rowData: RowData
  rowNumber: number
  selected: boolean
  isActive?: boolean
  onCheckedChange: (row: RowData, checked: boolean | string) => void
  docSummaryLoading?: Record<string, boolean>
  docWhyLoading?: Record<string, boolean>
  onTitleClick?: (row: RowData) => void
}

export type ExportActionBarProps = {
  selectedCount: number
  allSelected?: boolean
  onSelectAll?: () => void
  onExport?: () => void
  bottomOffset?: string
}

export type ResultsTableProps = {
  query: string
  data: RowData[]
  docWhyLoading?: Record<string, boolean>
  docSummaryLoading?: Record<string, boolean>
  onToggleSelect?: (id: string, v: boolean) => void
  onExportBib?: (selectedIds: string[]) => void
}

export type ResultsPageProps = {
  data?: RowData[]
  query: string
  docSummaryLoading?: Record<string, boolean>
  docWhyLoading?: Record<string, boolean>
  onExportBib?: (selectedIds: string[]) => void
  ops: {
    index_version: string
    prompt_version: string
    cost_usd: number | null
    energy_gco2e: number | null
  } | null
  alignment: {
    insights?: string[]
    alignment?: 'High' | 'Moderate' | 'Low' | 'Very Low'
    _debugKeys?: string[]
  } | null
  alignLoading?: boolean
}

export type DocumentPreviewModalContentProps = {
  rowData: RowData
  onExportBib?: (selectedIds: string[]) => void
}

export enum FeedbackType {
  None = 0, // 0 = no feedback
  Positive = 1, // 1 = positive
  Negative = -1, // -1 = negative
}

export enum FeedbackSubmitted {
  Unsent = 'unsent', // null = not sent
  Loading = 'loading', // 'loading' = sending
  Success = 'success', // 'success' = sent
}
