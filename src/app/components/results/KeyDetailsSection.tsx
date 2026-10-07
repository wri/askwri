import { Text } from '@chakra-ui/react'
import {
  getThemedBorderWidth,
  getThemedColor,
  getThemedFontSize,
  getThemedLineHeight,
} from '@worldresources/wri-design-systems'
import {
  MdBusiness,
  MdCalendarToday,
  MdLanguage,
  MdPerson,
} from 'react-icons/md'
import {
  sectionBoxStyle,
  sectionHeaderBarStyle,
  sectionHeaderTextStyle,
} from './previewModalStyles'

type KeyDetailsSectionProps = {
  organizations: string
  publicationYear: string | number
  languagesValue: string
  authors: string
}

export const KeyDetailsSection = ({
  organizations,
  publicationYear,
  languagesValue,
  authors,
}: KeyDetailsSectionProps) => {
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
      value: languagesValue,
      icon: <MdLanguage color={getThemedColor('secondary', 500)} />,
    },
    {
      label: 'Authors',
      value: authors,
      icon: <MdPerson color={getThemedColor('secondary', 500)} />,
    },
  ]

  return (
    <div style={sectionBoxStyle}>
      <div style={sectionHeaderBarStyle}>
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
                color: getThemedColor('neutral', 800),
                fontSize: getThemedFontSize(400),
                lineHeight: getThemedLineHeight(600),
              }}
            >
              {item.label}
            </Text>
            <Text
              style={{
                color: getThemedColor('neutral', 800),
                fontSize: getThemedFontSize(400),
                lineHeight: getThemedLineHeight(600),
                wordBreak: 'break-word',
              }}
            >
              {item.value}
            </Text>
          </div>
        ))}
      </div>
    </div>
  )
}
