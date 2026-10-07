import {
  getThemedColor,
  getThemedFontSize,
  getThemedLineHeight,
} from '@worldresources/wri-design-systems'

export const sectionHeaderTextStyle = {
  color: getThemedColor('neutral', 800),
  fontSize: getThemedFontSize(500),
  lineHeight: getThemedLineHeight(700),
  fontWeight: 400,
}

export const secondaryTextStyle = {
  color: getThemedColor('neutral', 700),
  fontSize: getThemedFontSize(400),
  lineHeight: getThemedLineHeight(600),
}

export const sectionBoxStyle = {
  border: `1px solid ${getThemedColor('neutral', 300)}`,
  borderRadius: '4px',
}

export const sectionHeaderBarStyle = {
  padding: '8px',
  background: getThemedColor('neutral', 200),
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}
