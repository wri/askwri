'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Heading, Card, Text } from '@chakra-ui/react'
import {
  Button,
  getThemedColor,
  Tag,
  Textarea,
  Toast,
  InlineMessage,
} from '@worldresources/wri-design-systems'
import { FaArrowRightLong } from 'react-icons/fa6'
import { WriLogoIcon } from '../components/icons/WriLogo'
import { AIResearchModal } from '../components/AnswerMode/AIResearchModal'
import QuerySuggestions from '../components/QuerySuggestions'

import '../styles.css'

const Landing = () => {
  const [query, setQuery] = useState('')
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const router = useRouter()

  const handleExampleClick = (example: string) => {
    setQuery(example)
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
      <InlineMessage
        size='full-width'
        variant='warning'
        label='For WRI staff use only'
        caption='This tool is under testing and intended for WRI employees only, not for external use. It is currently limited to a selection of Knowledge Products published by WRI Cities program. Results are generated using AI and may occasionally be incomplete or inaccurate.'
      />

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
          <Tag label='Alpha' variant='info-grey' />
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
          Find relevant Knowledge Products for your research, identify insights,
          and export citations.
        </Text>
      </section>
      <section>
        <Card.Root borderRadius={10} width={640} margin={5}>
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
                  placeholder='Compact urban growth in India between 2019 and 2026'
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
            </Card.Description>
            <QuerySuggestions
              mode='cite'
              handleExampleClick={handleExampleClick}
            />
          </Card.Body>
        </Card.Root>
      </section>
      <section style={{ marginBottom: '150px' }}>
        <Card.Root borderRadius={10} width={640} margin={5}>
          <Card.Body gap='2'>
            <Card.Title
              mt='2'
              display='flex'
              justifyContent='space-between'
              alignItems='center'
            >
              AI assistant [Early release]
              <Button
                variant='primary'
                size='small'
                onClick={() => setAiModalOpen(true)}
              >
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
                Get insights by asking research questions across WRI Knowledge
                Products.
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
      <AIResearchModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
      />
    </main>
  )
}

export default Landing
