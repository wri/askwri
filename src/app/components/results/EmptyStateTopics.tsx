'use client'

import React from 'react'
import { Tag } from '@worldresources/wri-design-systems'

// Empty states that navigate (design §3): a dead end becomes a door.
export const EmptyStateTopics = ({
  query,
  topics,
  onPickTopic,
  message,
}: {
  query: string
  topics: string[]
  onPickTopic: (topic: string) => void
  /** Overrides the default sentence. `/experts` looks for PEOPLE, so the
   *  document-framed default reads wrong there — but the chips-as-a-door
   *  behaviour is identical, so the component is shared, not copied. */
  message?: React.ReactNode
}) => (
  <div style={{ padding: '32px', textAlign: 'center' }}>
    <p style={{ fontSize: '16px', marginBottom: '12px' }}>
      {message ?? <>No strong matches for &ldquo;{query}&rdquo;.</>}
    </p>
    {topics.length > 0 && (
      <>
        <p style={{ fontSize: '14px', color: '#555', marginBottom: '8px' }}>
          Nearby topics in our library:
        </p>
        <div
          style={{
            display: 'flex',
            gap: '8px',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          {topics.map((t) => (
            <button
              key={t}
              onClick={() => onPickTopic(t)}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <Tag label={t} variant='info-grey' />
            </button>
          ))}
        </div>
      </>
    )}
  </div>
)
