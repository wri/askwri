import { Text } from '@chakra-ui/react'
import {
  getThemedColor,
  getThemedFontSize,
  getThemedLineHeight,
} from '@worldresources/wri-design-systems'
import {
  sectionBoxStyle,
  sectionHeaderBarStyle,
  sectionHeaderTextStyle,
} from './previewModalStyles'

type PdfPreviewSectionProps = {
  downloadUrl?: string | null
}

export const PdfPreviewSection = ({ downloadUrl }: PdfPreviewSectionProps) => (
  <div style={sectionBoxStyle}>
    <div style={sectionHeaderBarStyle}>
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
      {downloadUrl ? (
        <iframe
          src={`${downloadUrl}#page=1&view=FitH`}
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
)
