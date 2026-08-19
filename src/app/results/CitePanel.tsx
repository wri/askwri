'use client'

import { useMemo } from 'react'
import { DocMeta } from '@/lib/llamacloud'
import ResultsPage from '@/app/components/results'
import { RowData } from '@/app/components/results/types'
import { exportCitationsCsv } from '../utils/exportCitationsCsv'
import { getRelevanceLevel } from '../utils/relevance'
import {
  authorsFrom,
  buildCatalogIndex,
  matchCatalogRow,
  titleFrom,
  firstSentence,
  urlFrom,
  yearFrom,
  languageLabel,
} from '../utils/utils'

const CitePanel = ({
  query,
  docs,
  index,
  docSummary,
  docWhy,
  docWhyLoading,
  docSummaryLoading,
  ops,
  alignment,
  alignLoading,
  queryUnderstanding,
  onRemoveFacet,
  onApplySuggestion,
}: {
  query: string
  docs: DocMeta[]
  index: ReturnType<typeof buildCatalogIndex> | null
  docSummary: Record<string, string>
  docWhy: Record<string, { why: string; relation: 'direct' | 'indirect' }>
  docWhyLoading: Record<string, boolean>
  docSummaryLoading: Record<string, boolean>
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
  alignLoading: boolean
  queryUnderstanding?: {
    facets: { facet: string; value: string; action: string; source: string }[]
    suggestions: { type: string; text: string }[]
  } | null
  onRemoveFacet?: (chip: { facet: string; value: string }) => void
  onApplySuggestion?: (text: string) => void
}) => {
  const exportBibCsv = (selectedIds: string[]) => {
    exportCitationsCsv({
      docs,
      selectedIds,
      index,
      docSummary,
    })
  }

  // Transform DocMeta[] to RowData[] for ResultsTable
  const tableData: RowData[] = useMemo(
    () =>
      docs.map((doc, idx) => {
        const row = index ? matchCatalogRow(doc, index) : undefined
        const best = [...(doc.kps || [])].sort(
          (a, b) => b.kp_relevance - a.kp_relevance,
        )[0]
        const summary =
          docSummary[doc.doc_id] || firstSentence(best?.snippet ?? '')
        const whyMeta = docWhy[doc.doc_id]
        const url = urlFrom(doc, row)
        const docRel =
          (doc.kps?.length ?? 0) > 0
            ? Math.max(...doc.kps.map((k) => k.kp_relevance || 0))
            : 0

        // Use relevance tier from reranker logit thresholds
        const tierLabels: Record<string, string> = {
          strong: 'Strong',
          partial: 'Partial',
          weak: 'Weak',
        }
        const relevanceLabel =
          doc.relevance_tier && tierLabels[doc.relevance_tier]
            ? tierLabels[doc.relevance_tier]
            : getRelevanceLevel(docRel)

        return {
          id: doc.doc_id,
          publication_title: titleFrom(doc, row),
          // Transliterated English authors from documents.authors (issue #306).
          author: authorsFrom(doc, row).join('; '),
          summary,
          // The document's short ENGLISH summary — never the native-language
          // one and never a passage fallback when a summary exists (#306).
          short_summary: row?.shortSummary || row?.summary || summary,
          relevance: relevanceLabel,
          how_relevant: whyMeta?.why || firstSentence(best?.snippet ?? ''),
          download_url: url,
          relevance_score: docRel,
          row_number: idx + 1,
          year: yearFrom(doc, row),
          language: languageLabel(row),
          fullDoc: doc,
          catalogRow: row,
        }
      }),
    [docs, index, docSummary, docWhy],
  )
  return (
    <ResultsPage
      data={tableData}
      query={query}
      ops={ops}
      docSummaryLoading={docSummaryLoading}
      docWhyLoading={docWhyLoading}
      alignment={alignment}
      alignLoading={alignLoading}
      onExportBib={exportBibCsv}
      queryUnderstanding={queryUnderstanding}
      onRemoveFacet={onRemoveFacet}
      onApplySuggestion={onApplySuggestion}
    />
  )
}

export default CitePanel
