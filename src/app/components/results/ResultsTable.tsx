'use client'

import { useMemo, useState } from 'react'
import { Text } from '@chakra-ui/react'
import {
  Table,
  getThemedColor,
  Button,
  Modal,
} from '@worldresources/wri-design-systems'
import { MdChat } from 'react-icons/md'
import { ExportActionBar } from './ExportActionBar'
import { SelectableResultRow } from './SelectableResultRow'
import { RowData, ResultsTableProps } from './types'
import { AiIcon } from '../icons/AiIcon'
import { DocumentPreviewModalContent } from './DocumentPreviewModal'
import {
  AIResearchModalContent,
  aiResearchModalHeader,
} from '../AnswerMode/AIResearchModal'

const PAGE_SIZE = 20

const AiGeneratedTag = (
  <Text
    textStyle='xs'
    fontStyle='italic'
    fontWeight={300}
    color={getThemedColor('neutral', 700)}
  >
    <AiIcon /> AI generated
  </Text>
)

const columns = [
  {
    key: 'publication_name',
    label: 'Publication',
    sortable: true,
  },
  {
    key: 'summary',
    label: (
      <div>
        <div>Summary</div>
        {AiGeneratedTag}
      </div>
    ),
  },
  {
    key: 'relevance',
    label: (
      <div>
        <div>Relevance</div>
        {AiGeneratedTag}
      </div>
    ),
    sortable: true,
  },
  {
    key: 'how_relevant',
    label: (
      <div>
        <div>How is this relevant?</div>
        {AiGeneratedTag}
      </div>
    ),
  },
  {
    key: 'row_actions',
    label: '',
  },
]

const ResultsTable = ({
  data,
  docWhyLoading = {},
  docSummaryLoading = {},
  onToggleSelect,
  onExportBib,
}: ResultsTableProps) => {
  const totalItems = data.length
  const pageSize = PAGE_SIZE
  const [selectedRows, setSelectedRows] = useState<RowData[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [activeRowId, setActiveRowId] = useState<string | number | null>(null)
  const [modalData, setModalData] = useState<{
    header?: React.ReactNode
    content?: React.ReactNode
  }>({})
  const [aiModalOpen, setAiModalOpen] = useState(false)

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
      setSelectedRows(sortedData)
    } else {
      setSelectedRows([])
    }
  }
  const handleOpenModal = (rowData: RowData) => {
    setActiveRowId(rowData.id)
    setModalData({
      header: (
        <p
          style={{
            fontWeight: 'bold',
            color: getThemedColor('neutral', 800),
          }}
        >
          Preview
        </p>
      ),
      content: (
        <DocumentPreviewModalContent
          rowData={rowData}
          onExportBib={onExportBib}
        />
      ),
    })
  }

  const handleRowCheckedChange = (
    rowData: RowData,
    checkedValue: boolean | string,
  ) => {
    const isChecked = checkedValue === true || checkedValue === 'true'

    // Call parent's onToggleSelect if provided
    if (onToggleSelect) {
      onToggleSelect(rowData.id.toString(), isChecked)
    }

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
      isActive={activeRowId === rowData.id}
      onCheckedChange={handleRowCheckedChange}
      docSummaryLoading={docSummaryLoading}
      docWhyLoading={docWhyLoading}
      onTitleClick={handleOpenModal}
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
            borderTop: `1px solid ${getThemedColor('neutral', 300)}`,
          }}
        >
          <Button
            variant='primary'
            size='small'
            leftIcon={<MdChat />}
            onClick={() => setAiModalOpen(true)}
          >
            Ask a research question
          </Button>
        </section>
        <Table
          variant='full-width'
          columns={
            columns as {
              key: string
              label: string
              sortable?: boolean
            }[]
          }
          data={dataByPage}
          renderRow={selectableRenderRow}
          onSortColumn={setSortColumn}
          selectedRows={selectedRows}
          onAllItemsSelected={onAllItemsSelected}
          selectable
          onPageChange={setCurrentPage}
          pagination={{
            totalItems,
            currentPage,
            pageSize,
            showItemCount: false,
          }}
        />
      </div>
      <ExportActionBar
        selectedCount={selectedRows.length}
        allSelected={selectedRows.length === sortedData.length}
        onSelectAll={() =>
          onAllItemsSelected(selectedRows.length !== sortedData.length)
        }
        onExport={() => {
          const selectedIds = selectedRows.map((row) => row.id.toString())
          onExportBib?.(selectedIds)
        }}
      />
      <Modal
        header={modalData?.header}
        content={modalData?.content}
        size='large'
        draggable
        blocking={false}
        open={!!modalData?.content}
        onClose={() => {
          setModalData({})
          setActiveRowId(null)
        }}
      />
      <Modal
        header={aiResearchModalHeader}
        content={<AIResearchModalContent citeDocs={dataByPage} />}
        size='xlarge'
        blocking={false}
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
      />
    </>
  )
}

export default ResultsTable
