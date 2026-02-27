'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  getThemedColor,
  Modal,
  Textarea,
  Button,
  InlineMessage,
} from '@worldresources/wri-design-systems'
import { Text, Box, Heading, Spinner } from '@chakra-ui/react'
import { FaArrowRightLong } from 'react-icons/fa6'
import { HiCurrencyDollar } from 'react-icons/hi2'
import { AiFillThunderbolt } from 'react-icons/ai'
import { ImproveSearchModalProps } from './types'
import { AiIcon } from '../icons/AiIcon'

const ImproveSearchModal = ({
  energy_gco2e = 0,
  cost_usd,
  suggestions,
  initialQuery,
  improveSearchModalOpen,
  setImproveSearchModalOpen,
}: ImproveSearchModalProps) => {
  const [query, setQuery] = useState(initialQuery)
  const [loading, setLoading] = useState(false)

  const router = useRouter()

  const onQueryChange = (newQuery: string) => {
    setQuery(newQuery)
  }

  const handleSubmit = () => {
    setLoading(true)
    const normalized = query.trim()
    if (!normalized) {
      return
    }
    const encoded = encodeURIComponent(normalized)
    router.push(`/results?q=${encoded}`)
  }

  return (
    <Modal
      header={
        <p
          style={{
            fontWeight: 'bold',
            color: getThemedColor('neutral', 800),
          }}
        >
          Improve search
        </p>
      }
      content={
        <>
          {loading && (
            <div
              style={{
                minHeight: '200px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Spinner />
            </div>
          )}
          {!loading && (
            <>
              <div style={{ margin: '-12px' }} className='gradient-background'>
                <Box style={{ padding: '32px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      margin: '0px 0px 8px 0px',
                    }}
                  >
                    <AiIcon />
                    <Heading size='2xl'>AI suggestion</Heading>
                  </div>
                  <Text
                    textStyle='medium'
                    style={{
                      color: getThemedColor('neutral', 800),
                      fontWeight: '700',
                      paddingBottom: '8px',
                    }}
                  >
                    What has WRI published on...
                  </Text>

                  <section style={{ margin: '0 auto' }}>
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
                        disabled={
                          query.trim() === '' ||
                          loading ||
                          initialQuery.trim() === query.trim()
                        }
                        style={{
                          position: 'absolute',
                          right: '12px',
                          bottom: '30px',
                        }}
                        type='button'
                        aria-label='Submit search query'
                        onClick={() => {
                          handleSubmit()
                        }}
                      />
                    </div>
                    <Text
                      as='div'
                      textStyle='xs'
                      color={getThemedColor('neutral', 700)}
                      fontWeight='400'
                    >
                      This will start a new search, and may return different
                      results. Export citations for any returned publications
                      before continuing.
                    </Text>
                  </section>
                </Box>
              </div>
              <section style={{ padding: '0 24px' }}>
                <Text textStyle='md' style={{ marginTop: '24px' }}>
                  Your original search:
                </Text>
                <Text
                  textStyle='lg'
                  style={{ fontWeight: '700', marginBottom: '12px' }}
                >
                  {`"${query}"`}
                </Text>
                <InlineMessage
                  variant='error'
                  size='full-width'
                  label='Unclear search prompt'
                  caption={` To improve your search we suggest:
${suggestions.length > 0 ? suggestions.join(', ') : 'additional context about your research question, such as specific topics, locations, or types of publications you are interested in.'}`}
                />
              </section>
              <section style={{ padding: '0 24px', marginTop: '24px' }}>
                <Text
                  textStyle='md'
                  style={{ fontWeight: '700', marginBottom: '12px' }}
                >
                  Search Metrics
                </Text>
                <div
                  style={{
                    border: '1px solid',
                    borderColor: getThemedColor('neutral', 400),
                    borderRadius: '8px',
                  }}
                >
                  <div
                    style={{
                      padding: '16px',
                      display: 'flex',
                      gap: '24px',
                      marginBottom: '8px',
                      justifyContent: 'space-between',
                      borderBottom: '1px solid',
                      borderColor: getThemedColor('neutral', 400),
                      paddingBottom: '8px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      <AiFillThunderbolt />
                      Carbon equivalent
                    </div>
                    <div
                      style={{ fontWeight: 'bold' }}
                    >{`${energy_gco2e?.toFixed(2)} gCO2e`}</div>
                  </div>

                  <div
                    style={{
                      padding: '16px',
                      display: 'flex',
                      gap: '24px',

                      justifyContent: 'space-between',
                      borderBottom: '1px solid',
                      borderColor: getThemedColor('neutral', 400),
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}
                    >
                      <HiCurrencyDollar />
                      Credit Usage
                    </div>
                    <div
                      style={{ fontWeight: 'bold' }}
                    >{`$${cost_usd?.toFixed(2)}`}</div>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: '16px',
                      marginBottom: '8px',
                      flexDirection: 'column',
                      padding: '16px',
                    }}
                  >
                    <p>
                      At WRI, we are working hard to track and reduce the
                      environmental footprint of our digital tools.
                    </p>

                    <p>
                      When you enter a clear search prompt, you help reduce
                      repeat searches and unnecessary processing. This improves
                      results while saving energy.
                    </p>
                    <p>
                      The aim of these metrics isn’t to stop you using the tool,
                      it is to help raise awareness and inform you on how you
                      can use it more efficiently.
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}
        </>
      }
      size='large'
      blocking={false}
      open={improveSearchModalOpen}
      onClose={() => setImproveSearchModalOpen(false)}
    />
  )
}

export default ImproveSearchModal
