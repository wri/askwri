'use client'

import { useEffect, useState } from 'react'
import { Text, Heading } from '@chakra-ui/react'
import {
  Button,
  Tag,
  getThemedColor,
  getThemedFontSize,
  getThemedLineHeight,
} from '@worldresources/wri-design-systems'
import { AiIcon } from '../icons/AiIcon'
import { DocumentPreviewModalContentProps } from './types'
import { languageNameFromCode } from '@/app/utils/utils'
import {
  DocumentVersion,
  fetchDocumentVersions,
} from '@/app/utils/documentVersions'
import {
  sectionBoxStyle,
  sectionHeaderTextStyle,
  secondaryTextStyle,
} from './previewModalStyles'
import { KeyDetailsSection } from './KeyDetailsSection'
import { DocumentVersionsSection } from './DocumentVersionsSection'
import { PdfPreviewSection } from './PdfPreviewSection'

export const DocumentPreviewModalContent = ({
  rowData,
  onExportBib,
}: DocumentPreviewModalContentProps) => {
  const catalog = rowData.catalogRow
  const currentLanguageLabel = languageNameFromCode(
    String(rowData.language || catalog?.language || 'en'),
  )
  const [documentVersions, setDocumentVersions] = useState<DocumentVersion[]>(
    [],
  )
  const originalLanguageLabel = documentVersions.find(
    (v) => v.isOriginal,
  )?.language
  const allLanguages = [
    ...new Set([
      currentLanguageLabel,
      ...documentVersions.map((v) => v.language),
    ]),
  ].filter(Boolean)
  const languagesValue =
    (originalLanguageLabel && documentVersions.length > 1
      ? [
          `${originalLanguageLabel} (original)`,
          ...allLanguages.filter((l) => l !== originalLanguageLabel),
        ]
      : allLanguages
    ).join(', ') || 'N/A'

  useEffect(() => {
    let active = true

    const loadVersions = async () => {
      const versions = await fetchDocumentVersions(
        rowData,
        currentLanguageLabel,
      )
      if (active) {
        setDocumentVersions(versions)
      }
    }

    loadVersions()

    return () => {
      active = false
    }
  }, [catalog?.language, currentLanguageLabel, rowData])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '16px',
      }}
    >
      <div style={{ width: 'fit-content' }}>
        <Tag
          label={`${rowData.relevance} Relevance`}
          variant={
            rowData.relevance === 'Strong'
              ? 'success'
              : rowData.relevance === 'Partial'
                ? 'warning'
                : rowData.relevance === 'Weak'
                  ? 'info-grey'
                  : 'success'
          }
        />
      </div>
      <div>
        <Heading size='2xl'>{rowData.publication_title}</Heading>
      </div>

      <div>
        <Text
          style={{
            marginBottom: '8px',
            color: getThemedColor('neutral', 800),
            fontSize: getThemedFontSize(400),
            lineHeight: getThemedLineHeight(600),
          }}
        >
          {rowData.short_summary || rowData.summary}
        </Text>
      </div>
      <div style={{ ...sectionBoxStyle, padding: '16px' }}>
        <Text
          style={{
            marginBottom: '8px',
            ...sectionHeaderTextStyle,
          }}
        >
          <AiIcon /> How is this relevant?
        </Text>
        <Text style={secondaryTextStyle}>{rowData.how_relevant}</Text>
      </div>

      <KeyDetailsSection
        organizations={catalog?.office || 'WRI'}
        publicationYear={rowData.year || catalog?.yearAccepted || 'N/A'}
        languagesValue={languagesValue}
        authors={
          rowData.author ||
          catalog?.allAuthors ||
          rowData.fullDoc.authors?.join('; ') ||
          'N/A'
        }
      />

      <DocumentVersionsSection documentVersions={documentVersions} />

      <PdfPreviewSection downloadUrl={rowData.download_url} />

      <div>
        <Button
          variant='secondary'
          onClick={() => {
            onExportBib?.([rowData.id.toString()])
          }}
        >
          Export citations (.csv)
        </Button>
      </div>
    </div>
  )
}
