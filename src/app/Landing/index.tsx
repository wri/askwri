'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Heading, Card, Text } from '@chakra-ui/react'
import {
  Button,
  getThemedColor,
  Tag,
  Textarea,
  showToast,
  Toast,
} from '@worldresources/wri-design-systems'
import { LuRefreshCcw } from 'react-icons/lu'
import { FaArrowRightLong } from 'react-icons/fa6'
import { WriLogoIcon } from '../components/icons/WriLogo'
import { AiIcon } from '../components/icons/AiIcon'
import { SUGGESTION_POOL, getRandomSuggestions } from './exampleQuestions'
import '../styles.css'

const Landing = () => {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>(() =>
    SUGGESTION_POOL.slice(0, 3),
  )

  const router = useRouter()

  const toastShownRef = useRef(false)

  useEffect(() => {
    // add a timer to render the toast after the component mounts
    if (toastShownRef.current) {
      return
    }
    toastShownRef.current = true
    const handle = window.setTimeout(() => {
      showToast({
        label: 'Ask WRI is for staff use only',
        caption:
          'This tool is being tested and improved, and is currently only intended for WRI employees and not for external use. Results are generated using AI and may occasionally be incomplete or inaccurate.',
        type: 'info',
        placement: 'top-start',
        closable: true,
        closableLabel: 'Dismiss',
        duration: Infinity,
      })
    }, 0)

    return () => {
      window.clearTimeout(handle)
    }
  }, [])

  const handleExampleClick = (example: string) => {
    setQuery(example)
  }

  const handleShuffleSuggestions = () => {
    setSuggestions(getRandomSuggestions())
  }

  const handleSubmit = () => {
    const normalized = query.trim()
    if (!normalized) {
      return
    }
    const encoded = encodeURIComponent(normalized)
    router.push(`/results?q=${encoded}`)
  }

  return (
    <main
      className='gradient-background'
      style={{
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <section>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '20px',
            margin: '10px',
          }}
        >
          <WriLogoIcon height='100px' />
          <Tag label='Beta' variant='info-grey' />
        </div>

        <Heading size='5xl'>Discover WRI publications</Heading>
        <Text
          textStyle='lg'
          style={{
            color: getThemedColor('neutral', 800),
            maxWidth: '600px',
            paddingBottom: '20px',
          }}
        >
          Find relevant publications for your research from across WRI,
          highlight specific passages, and generate citations in your chosen
          format.
        </Text>
      </section>
      <section>
        <Card.Root borderRadius={10} maxWidth={640} margin={5}>
          <Card.Body gap='2'>
            <Card.Title mt='2' style={{ fontWeight: 700 }}>
              What has WRI published on...
            </Card.Title>
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
                  onChange={(event) => setQuery(event.target.value)}
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
                  onClick={handleSubmit}
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
      <section style={{ marginBottom: '150px' }}>
        <Card.Root borderRadius={10} maxWidth={640} margin={5}>
          <Card.Body gap='2'>
            <Card.Title
              mt='2'
              display='flex'
              justifyContent='space-between'
              alignItems='center'
            >
              AI assistant [Early release]
              <Button variant='primary' size='small'>
                Try now
              </Button>
            </Card.Title>
            <Card.Description as='div'>
              <Text
                as='div'
                textStyle='md'
                style={{
                  color: getThemedColor('neutral', 800),
                }}
              >
                Get insights by asking research questions across WRI
                publications.
              </Text>
              <Text
                as='div'
                marginTop={2}
                fontStyle='italic'
                style={{
                  color: getThemedColor('neutral', 700),
                }}
              >
                This feature is in early release and under evaluation. Output
                quality may vary and should be treated as exploratory.
              </Text>
            </Card.Description>
          </Card.Body>
        </Card.Root>
      </section>
      <Toast />
    </main>
  )
}

export default Landing
