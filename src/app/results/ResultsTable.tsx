'use client'

import { useMemo, useState } from 'react'
import {
  Table,
  getThemedColor,
  Button,
} from '@worldresources/wri-design-systems'
import { HiDocumentSearch } from 'react-icons/hi'
import { MdChat } from 'react-icons/md'
import { ExportActionBar } from './ExportActionBar'
import { SelectableResultRow } from './SelectableResultRow'
import { RowData } from './types'

const columns = [
  {
    key: 'publication_name',
    label: 'Publication',
    sortable: true,
  },
  {
    key: 'summary',
    label: 'Summary',
  },
  {
    key: 'relevance',
    label: 'Relevance',
    sortable: true,
  },
  {
    key: 'how_relevant',
    label: 'How is this relevant?',
  },
  {
    key: 'row_actions',
    label: '',
  },
]

const ResultsTable = ({ data }: { data: RowData[] }) => {
  const totalItems = data.length
  const [selectedRows, setSelectedRows] = useState<RowData[]>([])
  const [pageSize, setPageSize] = useState(10)
  const [currentPage, setCurrentPage] = useState(1)

  const [sortColumn, setSortColumn] = useState<{ key: string; order: string }>({
    key: '',
    order: '',
  })

  const sortedData = useMemo(() => {
    const fullData = [...data]

    if (!sortColumn.key) {
      return fullData
    }

    const { key, order } = sortColumn
    const isDesc = order === 'desc'

    return fullData.sort((a, b) => {
      const aValue = a[key as keyof RowData]
      const bValue = b[key as keyof RowData]

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return isDesc
          ? bValue.localeCompare(aValue)
          : aValue.localeCompare(bValue)
      }

      const aNumber = typeof aValue === 'number' ? aValue : Number(aValue)
      const bNumber = typeof bValue === 'number' ? bValue : Number(bValue)

      return isDesc ? bNumber - aNumber : aNumber - bNumber
    })
  }, [data, sortColumn])

  const startRange = (currentPage - 1) * pageSize
  const endRange = startRange + pageSize

  const dataByPage = useMemo(
    () => sortedData.slice(startRange, endRange) as RowData[],
    [sortedData, startRange, endRange],
  )

  const onAllItemsSelected = (checked: boolean) => {
    if (checked) {
      setSelectedRows(dataByPage)
    } else {
      setSelectedRows([])
    }
  }
  const handleRowCheckedChange = (
    rowData: RowData,
    checkedValue: boolean | string,
  ) => {
    const isChecked = checkedValue === true || checkedValue === 'true'
    setSelectedRows((current = [] as RowData[]) => {
      if (isChecked) {
        if (current.some((item) => item.id === rowData.id)) {
          return current
        }
        return [...current, rowData]
      }

      return current.filter((item) => item.id !== rowData.id)
    })
  }

  const selectableRenderRow = (rowData: RowData) => (
    <SelectableResultRow
      rowData={rowData}
      selected={selectedRows?.some((item) => item.id === rowData.id)}
      onCheckedChange={handleRowCheckedChange}
    />
  )
  return (
    <>
      <div
        style={{
          width: '100%',
          background: getThemedColor('neutral', 100),
        }}
      >
        <section
          style={{
            display: 'flex',
            gap: '10px',
            padding: '10px',
            justifyContent: 'flex-end',
          }}
        >
          <Button variant='primary' leftIcon={<HiDocumentSearch />}>
            Extract most relevant excerpts
          </Button>
          <Button variant='primary' leftIcon={<MdChat />}>
            Ask a research question
          </Button>
        </section>
        <Table
          variant='full-width'
          columns={columns}
          data={dataByPage}
          renderRow={selectableRenderRow}
          onSortColumn={setSortColumn}
          selectedRows={selectedRows}
          onAllItemsSelected={onAllItemsSelected}
          selectable
          onPageSizeChange={setPageSize}
          onPageChange={setCurrentPage}
          pagination={{
            totalItems,
            currentPage,
            pageSize,
            showItemCount: true,
          }}
        />
      </div>
      <ExportActionBar
        selectedCount={selectedRows.length}
        onSelectAll={() => onAllItemsSelected(true)}
      />
    </>
  )
}

export default ResultsTable
