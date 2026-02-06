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
  isActive?: boolean
  onCheckedChange: (row: RowData, checked: boolean | string) => void
  docSummaryLoading?: Record<string, boolean>
  docWhyLoading?: Record<string, boolean>
  onOpenPdf?: (url: string) => void
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
  data: RowData[]
  docWhyLoading?: Record<string, boolean>
  docSummaryLoading?: Record<string, boolean>
  onToggleSelect?: (id: string, v: boolean) => void
  onOpenPdf?: (url: string) => void
  onExportBib?: (selectedIds: string[]) => void
}

export type ResultsPageProps = {
  data?: RowData[]
  query: string
  docSummaryLoading?: Record<string, boolean>
  docWhyLoading?: Record<string, boolean>
  onOpenPdf?: (url: string) => void
  onExportBib?: (selectedIds: string[]) => void
  ops: {
    index_version: string
    prompt_version: string
    cost_usd: number | null
    energy_gco2e: number | null
  } | null
  transcript: string[]
  alignment: {
    coverage?: string[]
    caveats?: string[]
    risks?: string[]
    suggestions?: string[]
    confidence?: number
    _debugKeys?: string[]
  } | null
}

export type DocumentPreviewModalContentProps = {
  rowData: RowData
  onExportBib?: (selectedIds: string[]) => void
}

export type AIProcessModalContentProps = {
  transcript: string[]
}
