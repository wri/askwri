'use client'

import { Heading, Card, Text } from '@chakra-ui/react'
import { FaArrowRightLong } from 'react-icons/fa6'
import {
  Button,
  getThemedColor,
  Textarea,
} from '@worldresources/wri-design-systems'
import { AISearchFormProps } from './types'
import QuerySuggestions from '../QuerySuggestions'

export const AISearchForm = ({
  query,
  loading,
  numberOfCiteDocs,
  userSelectedDocs,
  onQueryChange,
  onSubmit,
  handleExampleClick,
}: AISearchFormProps) => (
  <div className='gradient-background'>
    <section
      style={{
        padding: '20px',
        textAlign: 'center',
        maxWidth: '600px',
        margin: '0 auto',
      }}
    >
      <Heading size='3xl' style={{ marginBottom: '12px' }}>
        Ask research questions
      </Heading>

      <Text
        textStyle='lg'
        style={{
          color: getThemedColor('neutral', 800),
        }}
      >
        {numberOfCiteDocs ? (
          <>
            Discover insights by asking about the
            <strong>{` ${numberOfCiteDocs} ${userSelectedDocs ? '' : 'most relevant'} publication${numberOfCiteDocs > 1 ? 's' : ''} `}</strong>
            returned in your search.
          </>
        ) : (
          'Discover insights by asking about WRI Knowledge Products.'
        )}
      </Text>
    </section>

    <section style={{ maxWidth: '600px', margin: '0 auto' }}>
      <Card.Root border={0} background='transparent'>
        <Card.Body>
          <Card.Description as='div'>
            <div
              style={{
                position: 'relative',
                display: 'inline-block',
                width: '100%',
              }}
            >
              <Textarea
                placeholder='Compact urban growth in India between 2019 and 2026'
                size='small'
                resize='none'
                value={query}
                aria-label='Search query input'
                onChange={(event) => onQueryChange(event.target.value)}
              />
              <Button
                leftIcon={<FaArrowRightLong />}
                variant='primary'
                disabled={query.trim() === '' || loading}
                style={{
                  position: 'absolute',
                  right: '12px',
                  bottom: '30px',
                }}
                type='button'
                aria-label='Submit search query'
                onClick={onSubmit}
              />
            </div>
          </Card.Description>
          <QuerySuggestions
            mode='answer'
            handleExampleClick={handleExampleClick}
          />
        </Card.Body>
      </Card.Root>
    </section>
  </div>
)
