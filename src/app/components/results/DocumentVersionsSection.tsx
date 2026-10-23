import { Text } from '@chakra-ui/react'
import {
  Button,
  getThemedColor,
  getThemedFontSize,
  getThemedLineHeight,
} from '@worldresources/wri-design-systems'
import { IoMdOpen } from 'react-icons/io'
import { DocumentVersion } from '@/app/utils/documentVersions'
import {
  sectionBoxStyle,
  sectionHeaderBarStyle,
  sectionHeaderTextStyle,
  secondaryTextStyle,
} from './previewModalStyles'

type DocumentVersionsSectionProps = {
  documentVersions: DocumentVersion[]
}

export const DocumentVersionsSection = ({
  documentVersions,
}: DocumentVersionsSectionProps) => (
  <div style={sectionBoxStyle}>
    <div style={sectionHeaderBarStyle}>
      <Text style={sectionHeaderTextStyle}>Document versions</Text>
    </div>
    <div
      style={{
        padding: '12px',
        display: 'grid',
        gap: '12px',
      }}
    >
      {(documentVersions.length
        ? documentVersions
        : [{ language: 'N/A', url: '' }]
      ).map((version) => (
        <div
          key={`${version.language}-${version.url || 'missing'}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div>
            <Text
              style={{
                color: getThemedColor('neutral', 900),
                fontWeight: 700,
                fontSize: getThemedFontSize(400),
                lineHeight: getThemedLineHeight(600),
              }}
            >
              {version.language}
              {documentVersions.length > 1 &&
                version.isOriginal &&
                ' (original)'}
            </Text>
            {version.description && (
              <Text style={secondaryTextStyle}>{version.description}</Text>
            )}
          </div>
          <Button
            variant='secondary'
            size='small'
            rightIcon={<IoMdOpen />}
            onClick={() => {
              if (version.url) {
                window.open(version.url, '_blank', 'noopener,noreferrer')
              }
            }}
            disabled={!version.url}
          >
            Open document
          </Button>
        </div>
      ))}
    </div>
  </div>
)
