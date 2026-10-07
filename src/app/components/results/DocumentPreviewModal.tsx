'use client'

import { Text, Heading } from '@chakra-ui/react'
import {
  Button,
  getThemedBorderWidth,
  getThemedColor,
  getThemedFontSize,
  getThemedLineHeight,
  Tag,
} from '@worldresources/wri-design-systems'
import { AiIcon } from '../icons/AiIcon'
import { IoMdOpen } from 'react-icons/io'
import {
  MdBusiness,
  MdCalendarToday,
  MdLanguage,
  MdPerson,
} from 'react-icons/md'
import { DocumentPreviewModalContentProps } from './types'
import { languageNameFromCode } from '@/app/utils/utils'

export const DocumentPreviewModalContent = ({
  rowData,
  onExportBib,
}: DocumentPreviewModalContentProps) => {
  const catalog = rowData.catalogRow
  const rawLanguages =
    catalog?.languages?.length && catalog.languages[0]
      ? catalog.languages
      : [rowData.language || catalog?.language].filter(Boolean)
  const languages = rawLanguages
    .map((lang) => String(lang).trim().toLowerCase())
    .filter(Boolean)
  const uniqueLanguages = [...new Set(languages)]
  const languageLabels = uniqueLanguages.map((lang) =>
    languageNameFromCode(lang),
  )
  const publicationYear = rowData.year || catalog?.yearAccepted || 'N/A'
  const organizations = catalog?.office || 'WRI'
  const authors =
    rowData.author ||
    catalog?.allAuthors ||
    rowData.fullDoc.authors?.join('; ') ||
    'N/A'
  const keyDetails = [
    {
      label: 'Organisation(s)',
      value: organizations,
      icon: <MdBusiness color={getThemedColor('secondary', 500)} />,
    },
    {
      label: 'Publication year',
      value: publicationYear,
      icon: <MdCalendarToday color={getThemedColor('secondary', 500)} />,
    },
    {
      label: 'Language(s)',
      value: languageLabels.join(', ') || 'N/A',
      icon: <MdLanguage color={getThemedColor('secondary', 500)} />,
    },
    {
      label: 'Authors',
      value: authors,
      icon: <MdPerson color={getThemedColor('secondary', 500)} />,
    },
  ]
  const sectionHeaderTextStyle = {
    color: getThemedColor('neutral', 800),
    fontSize: getThemedFontSize(500),
    lineHeight: getThemedLineHeight(700),
    fontWeight: 400,
  }
  const bodyTextStyle = {
    color: getThemedColor('neutral', 800),
    fontSize: getThemedFontSize(400),
    lineHeight: getThemedLineHeight(600),
  }
  const secondaryTextStyle = {
    color: getThemedColor('neutral', 700),
    fontSize: getThemedFontSize(400),
    lineHeight: getThemedLineHeight(600),
  }

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
            ...bodyTextStyle,
          }}
        >
          {rowData.short_summary || rowData.summary}
        </Text>
      </div>
      <div
        style={{
          border: `1px solid ${getThemedColor('neutral', 300)}`,
          padding: '16px',
          borderRadius: '4px',
        }}
      >
        <Text
          style={{
            marginBottom: '8px',
            ...sectionHeaderTextStyle,
          }}
        >
          <AiIcon /> How is this relevant?
        </Text>
        <Text
          style={{
            ...secondaryTextStyle,
          }}
        >
          {rowData.how_relevant}
        </Text>
      </div>

      <div
        style={{
          border: `1px solid ${getThemedColor('neutral', 300)}`,
          borderRadius: '4px',
        }}
      >
        <div
          style={{
            padding: '8px',
            background: getThemedColor('neutral', 200),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={sectionHeaderTextStyle}>Key Details</Text>
        </div>
        <div
          style={{
            padding: '12px',
            display: 'grid',
            gap: '8px',
          }}
        >
          {keyDetails.map((item, index) => (
            <div
              key={item.label}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 148px 1fr',
                columnGap: '12px',
                alignItems: 'start',
                fontSize: getThemedFontSize(400),
                lineHeight: getThemedLineHeight(600),
                borderBottom:
                  index === keyDetails.length - 1
                    ? 'none'
                    : `${getThemedBorderWidth(100)} solid ${getThemedColor('neutral', 300)}`,
              }}
            >
              <div style={{ marginTop: '2px' }}>{item.icon}</div>
              <Text
                style={{
                  ...bodyTextStyle,
                }}
              >
                {item.label}
              </Text>
              <Text
                style={{
                  ...bodyTextStyle,
                  wordBreak: 'break-word',
                }}
              >
                {item.value}
              </Text>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          border: `1px solid ${getThemedColor('neutral', 300)}`,
          borderRadius: '4px',
        }}
      >
        <div
          style={{
            padding: '8px',
            background: getThemedColor('neutral', 200),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={sectionHeaderTextStyle}>Document versions</Text>
        </div>
        <div
          style={{
            padding: '12px',
            display: 'grid',
            gap: '12px',
          }}
        >
          {(languageLabels.length ? languageLabels : ['N/A']).map(
            (language) => (
              <div
                key={language}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                }}
              >
                <Text
                  style={{
                    color: getThemedColor('neutral', 800),
                    fontWeight: 700,
                    fontSize: getThemedFontSize(400),
                    lineHeight: getThemedLineHeight(600),
                  }}
                >
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    {language}
                  </span>
                </Text>
                <Button
                  variant='secondary'
                  size='small'
                  rightIcon={<IoMdOpen />}
                  onClick={() => {
                    if (rowData.download_url) {
                      window.open(
                        rowData.download_url,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                  }}
                  disabled={!rowData.download_url}
                >
                  Open document
                </Button>
              </div>
            ),
          )}
        </div>
      </div>

      <div
        style={{
          border: `1px solid ${getThemedColor('neutral', 300)}`,
          borderRadius: '4px',
        }}
      >
        <div
          style={{
            padding: '8px',
            background: getThemedColor('neutral', 200),
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={sectionHeaderTextStyle}>PDF preview</Text>
        </div>
        <div
          style={{
            width: '100%',
            height: '500px',
            padding: '12px',
            overflow: 'hidden',
          }}
        >
          {rowData.download_url ? (
            <iframe
              src={`${rowData.download_url}#page=1&view=FitH`}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
              }}
              title='PDF Preview'
            />
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: getThemedColor('neutral', 600),
                fontSize: getThemedFontSize(400),
                lineHeight: getThemedLineHeight(600),
              }}
            >
              No PDF available
            </div>
          )}
        </div>
      </div>

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
