export type RowData = {
  id: string | number
  publication_name: string
  author: string
  summary: string
  relevance: string
  how_relevant: string
  download_url?: string | null
  relevance_score?: number
  confidence?: number
}

export type SelectableResultRowProps = {
  rowData: RowData
  selected: boolean
  onCheckedChange: (row: RowData, checked: boolean | string) => void
  docSummaryLoading?: Record<string, boolean>
  docWhyLoading?: Record<string, boolean>
  onOpenPdf?: (url: string) => void
}

export type ExportActionBarProps = {
  selectedCount: number
  onSelectAll?: () => void
  onExport?: () => void
  bottomOffset?: string
}

export type ResultsTableProps = {
  data: RowData[]
  docWhyLoading?: Record<string, boolean>
  docSummaryLoading?: Record<string, boolean>
  onToggleSelect?: (id: string, v: boolean) => void
  onOpenPdf?: (url: string) => void
}

export type ResultsPageProps = {
  data?: RowData[]
  query: string
  confidence?: number
  docSummaryLoading?: Record<string, boolean>
  docWhyLoading?: Record<string, boolean>
  onOpenPdf?: (url: string) => void
}
