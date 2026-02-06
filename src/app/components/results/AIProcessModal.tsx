'use client'

import { getThemedColor } from '@worldresources/wri-design-systems'
import { AIProcessModalContentProps } from './types'

export const AIProcessModalContent = ({
  transcript,
}: AIProcessModalContentProps) => (
  <div style={{ padding: '20px' }}>
    {transcript.length === 0 ? (
      <p>No process information available.</p>
    ) : (
      <ol style={{ paddingLeft: '20px' }}>
        {transcript.map((item) => (
          <li key={item} style={{ marginBottom: '8px' }}>
            {item}
          </li>
        ))}
      </ol>
    )}
  </div>
)

export const aiProcessModalHeader = (
  <p
    style={{
      fontWeight: 'bold',
      color: getThemedColor('neutral', 800),
    }}
  >
    AI process explained
  </p>
)
