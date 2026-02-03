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
}

export type ExportActionBarProps = {
  selectedCount: number
  onSelectAll?: () => void
  onExport?: () => void
  bottomOffset?: string
}
