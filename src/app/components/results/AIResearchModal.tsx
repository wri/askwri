'use client'

import { useState } from 'react'
import { Heading, Card, Text } from '@chakra-ui/react'
import { LuRefreshCcw } from 'react-icons/lu'
import { FaArrowRightLong } from 'react-icons/fa6'
import {
  Button,
  getThemedColor,
  Textarea,
  InlineMessage,
} from '@worldresources/wri-design-systems'
import { AiIcon } from '../icons/AiIcon'
import {
  SUGGESTION_POOL,
  getRandomSuggestions,
} from '../../utils/exampleQuestions'

export const AIResearchModalContent = () => {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>(() =>
    SUGGESTION_POOL.slice(0, 3),
  )

  const handleShuffleSuggestions = () => {
    setSuggestions(getRandomSuggestions())
  }

  const handleExampleClick = (example: string) => {
    setQuery(example)
  }
  return (
    <div
      className='gradient-background'
      style={{ margin: '-10px', padding: '20px' }}
    >
      <div>
        <InlineMessage
          size='large'
          variant='warning'
          label='AI research assistant is in early testing'
          caption='This tool is being tested and improved, and is currently only intended for WRI employees and not for external use. Results are generated using AI and may occasionally be incomplete or inaccurate.'
        />
      </div>
      <section style={{ padding: '20px', textAlign: 'center' }}>
        <Heading size='3xl' style={{ marginBottom: '12px' }}>
          Ask research questions
        </Heading>

        <Text
          textStyle='lg'
          style={{
            color: getThemedColor('neutral', 800),
            maxWidth: '600px',
            paddingBottom: '20px',
          }}
        >
          Discover insights by asking about WRI knowledge products.
        </Text>
      </section>

      <section>
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
                  placeholder='Compact urban growth in India'
                  size='small'
                  resize='none'
                  value={query}
                  aria-label='Search query input'
                  onChange={(event) => console.log(event.target.value)}
                />
                <Button
                  leftIcon={<FaArrowRightLong />}
                  variant='primary'
                  disabled={query.trim() === ''}
                  style={{
                    position: 'absolute',
                    right: '12px',
                    bottom: '30px',
                  }}
                  type='button'
                  aria-label='Submit search query'
                  onClick={() => console.log('Submit clicked')}
                />
              </div>
              <Text
                as='div'
                marginTop='2'
                color={getThemedColor('neutral', 700)}
                fontWeight='400'
              >
                For best results, try to include a topic, geography, and
                timeframe in your search.
              </Text>
            </Card.Description>
            <section key={suggestions.join('|')} className='suggestions-list'>
              {suggestions.map((item) => (
                <Button
                  key={item}
                  variant='borderless'
                  leftIcon={<AiIcon />}
                  onClick={() => handleExampleClick(item)}
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
              onClick={handleShuffleSuggestions}
            >
              More suggestions
            </Button>
          </Card.Footer>
        </Card.Root>
      </section>
    </div>
  )
}

export const aiResearchModalHeader = (
  <p
    style={{
      fontWeight: 'bold',
      color: getThemedColor('neutral', 800),
    }}
  >
    AI research assistant
  </p>
)
