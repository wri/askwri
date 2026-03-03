'use client'

import { Heading, Card, Text } from '@chakra-ui/react'
import { LuRefreshCcw } from 'react-icons/lu'
import { FaArrowRightLong } from 'react-icons/fa6'
import {
  Button,
  getThemedColor,
  Textarea,
} from '@worldresources/wri-design-systems'
import { AiIcon } from '../icons/AiIcon'
import { AISearchFormProps } from './types'

export const AISearchForm = ({
  query,
  loading,
  suggestions,
  numberOfCiteDocs,
  onQueryChange,
  onSubmit,
  onShuffleSuggestions,
  onExampleClick,
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

          paddingBottom: '20px',
        }}
      >
        {numberOfCiteDocs ? (
          <>
            Discover insights by asking about the
            <strong>{` ${numberOfCiteDocs} publications `}</strong>returned in
            your search.
          </>
        ) : (
          'Discover insights by asking about WRI knowledge products.'
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
            <Text
              as='div'
              marginTop='2'
              color={getThemedColor('neutral', 700)}
              fontWeight='400'
            >
              For best results, try to include a topic, geography, and timeframe
              in your search.
            </Text>
          </Card.Description>
          <section key={suggestions.join('|')} className='suggestions-list'>
            {suggestions.map((item) => (
              <Button
                key={item}
                variant='borderless'
                leftIcon={<AiIcon />}
                onClick={() => onExampleClick(item)}
              >
                {item}
              </Button>
            ))}
          </section>
        </Card.Body>
        <Card.Footer>
          <Button
            variant='secondary'
            size='small'
            leftIcon={<LuRefreshCcw />}
            onClick={onShuffleSuggestions}
          >
            More suggestions
          </Button>
        </Card.Footer>
      </Card.Root>
    </section>
  </div>
)
