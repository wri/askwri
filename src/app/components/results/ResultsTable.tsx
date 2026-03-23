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
import { AIResearchModalContent } from '../AnswerMode/AIResearchModal'

const PAGE_SIZE = 20
const MAXIMUM_CONSULTED_DOCS = 20

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
    key: 'publication_title',
    label: 'Publication',
  },
  {
    key: 'short_summary',
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
  query,
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
  const startRange = (currentPage - 1) * pageSize
  const endRange = startRange + pageSize

  const dataByPage = useMemo(
    () => data.slice(startRange, endRange) as RowData[],
    [data, startRange, endRange],
  )

  const onAllItemsSelected = (checked: boolean) => {
    if (checked) {
      setSelectedRows(data)
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
      query={query}
      rowData={rowData}
      rowNumber={rowData.row_number ?? 0}
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
        <Text
          style={{
            position: 'relative',
            top: -45,
            padding: 20,
            width: '150px',
            color: getThemedColor('neutral', 700),
          }}
        >
          {pageSize} per page
        </Text>
      </div>
      <ExportActionBar
        selectedCount={selectedRows.length}
        allSelected={selectedRows.length === data.length}
        onSelectAll={() =>
          onAllItemsSelected(selectedRows.length !== data.length)
        }
        onExport={() => {
          const selectedIds = selectedRows.map((row) => row.id.toString())
          onExportBib?.(selectedIds)
        }}
      />
      <Modal
        header={modalData?.header}
        content={modalData?.content}
        size='medium'
        draggable
        blocking={false}
        open={!!modalData?.content}
        onClose={() => {
          setModalData({})
          setActiveRowId(null)
        }}
      />

      <AIResearchModalContent
        consultedDocs={
          selectedRows.length
            ? selectedRows.slice(0, MAXIMUM_CONSULTED_DOCS)
            : data.slice(0, MAXIMUM_CONSULTED_DOCS)
        }
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
      />
    </>
  )
}

export default ResultsTable
