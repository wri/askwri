'use client'

 
 

import { useState, FC } from 'react'
import { Text, Box, Heading, Spinner } from '@chakra-ui/react'
import {
  Tag,
  Button,
  getThemedColor,
  Modal,
  InlineMessage,
  Tooltip as DS_Tooltip,
} from '@worldresources/wri-design-systems'
import { FaInfoCircle } from 'react-icons/fa'
import { FaThumbsDown, FaThumbsUp } from 'react-icons/fa6'
import { AiFillThunderbolt } from 'react-icons/ai'
import { HiCurrencyDollar } from 'react-icons/hi2'
import { MdChat } from 'react-icons/md'
import { IoIosCopy, IoMdCheckmark } from 'react-icons/io'
import { AiIcon } from '../icons/AiIcon'
import { formatCO2, formatCost } from '../../utils/utils'
import { AnswerPanelProps } from './types'
import { FeedbackType, FeedbackSubmitted } from '../results/types'

const Tooltip = DS_Tooltip as FC<any> // temporary fix to resolve type issues with Tooltip component from wri-design-systems

export const AnswerPanel = ({
  query,
  answer,
  firstDocHowRelevant,
  consultedDocs,
  supportingDocs,
  setAnswer,
  setQuery,
  alignLoading,
  alignment,
  ops,
  setSupportingCitationsPage,
  supportingCitationsPage,
  coverageRating,
}: AnswerPanelProps) => {
  const [newQuestionModalOpen, setNewQuestionModalOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const numberOfUsedKnowledgeProducts = supportingDocs
    ? new Set(supportingDocs.map((doc) => doc.doc_id)).size
    : 0
  // 0 = no feedbackState, 1 = positive, -1 = negative
  const [feedbackState, setFeedbackState] = useState<FeedbackType>(
    FeedbackType.None,
  )
  // feedbackSubmitted: null = not sent, 'loading' = sending, 'success' = sent
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<FeedbackSubmitted>(
    FeedbackSubmitted.Unsent,
  )

  const submitFeedback = async (feedbackType: FeedbackType) => {
    setFeedbackSubmitted(FeedbackSubmitted.Loading)
    const consultedDocIds = consultedDocs
      ? Array.from(new Set(consultedDocs.map((doc) => doc.id))).join(',')
      : ''
    const supportingDocIds = supportingDocs
      ? Array.from(new Set(supportingDocs.map((doc) => doc.doc_id))).join(',')
      : ''

    const firstSupportingDoc = supportingDocs?.[0]

    try {
      const feedbackData = {
        query,
        answer: answer.sentences.join(' '),
        feedback:
          feedbackType === FeedbackType.Positive ? 'positive' : 'negative',
        consultedDocIds,
        supportingDocIds,
        firstRelevanceScore: firstSupportingDoc?.score?.toString(),
        firstPublicationName: firstSupportingDoc?.title,
        firstDocSummary: firstSupportingDoc?.kps?.[0]?.snippet,
        firstDocHowRelevant,
      }

      const res = await fetch('/api/answer-mode-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedbackData),
      })
      if (res.ok) {
        setFeedbackSubmitted(FeedbackSubmitted.Success)
      } else {
        setFeedbackSubmitted(FeedbackSubmitted.Unsent)
      }
    } catch {
      setFeedbackSubmitted(FeedbackSubmitted.Unsent)
    }
  }

  const handleFeedback = (type: FeedbackType) => {
    if (feedbackState === type) {
      setFeedbackState(FeedbackType.None)
      setFeedbackSubmitted(FeedbackSubmitted.Unsent)
    } else {
      setFeedbackState(type)
      submitFeedback(type)
    }
  }
  return (
    <>
      <Box
        style={{
          flex: 1,
          padding: '20px',
          backgroundColor: 'white',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignContent: 'center',
            width: '100%',
          }}
        >
          <Text
            textStyle='2xl'
            fontWeight='bold'
            marginBottom='4'
            color={getThemedColor('neutral', 900)}
          >
            <AiIcon /> AI Answer
          </Text>
          <Button
            key='new-search'
            variant='secondary'
            size='small'
            leftIcon={<MdChat />}
            onClick={() => setNewQuestionModalOpen(true)}
          >
            Ask new question
          </Button>
        </div>

        <Text
          textStyle='sm'
          marginBottom='4'
          color={getThemedColor('neutral', 700)}
        >
          Your question:
        </Text>
        <Text
          textStyle='md'
          marginBottom='6'
          fontWeight='bold'
          color={getThemedColor('neutral', 800)}
        >
          {query}
        </Text>

        {answer.warning === 'low_coverage' && answer.warningMessage && (
          <Box marginBottom='3'>
            <InlineMessage
              variant='warning'
              label='Limited coverage'
              caption={answer.warningMessage}
            />
          </Box>
        )}
        {numberOfUsedKnowledgeProducts > 0 && (
          <Text
            textStyle='sm'
            marginBottom='4'
            color={getThemedColor('neutral', 700)}
          >
            {`Based on ${numberOfUsedKnowledgeProducts} Knowledge Product${
              numberOfUsedKnowledgeProducts === 1 ? '' : 's'
            }:`}
          </Text>
        )}

        <Box
          style={{
            fontSize: '14px',
            lineHeight: '1.6',
            maxHeight: '520px',
            overflowY: 'auto',
            paddingRight: '8px',
          }}
        >
          {answer.paragraphs
            ? (() => {
                let globalCitationIdx = 0
                return answer.paragraphs.map((paragraph, pIdx) => {
                  let sentenceOffset = 0
                  for (let p = 0; p < pIdx; p++) {
                    sentenceOffset += answer.paragraphs![p].length
                  }
                  return (
                    <Box key={pIdx} marginBottom='3'>
                      {paragraph.map((sent, sIdx) => {
                        const globalSentIdx = sentenceOffset + sIdx
                        return (
                          <Text as='span' key={sIdx}>
                            {sent}{' '}
                            {answer.inline?.[globalSentIdx]?.map(
                              (c: any, j: number) => {
                                const citationDisplay = `${globalSentIdx + 1}.${j + 1}`
                                const citationPage = globalCitationIdx + 1
                                const btn = (
                                  <Button
                                    key={j}
                                    size='small'
                                    variant='secondary'
                                    style={{
                                      fontSize: '9px',
                                      minWidth: 0,
                                      height: 'auto',
                                      lineHeight: 1,
                                      ...(supportingCitationsPage ===
                                      citationPage
                                        ? {
                                            background: '#0A4298',
                                            color: 'white',
                                          }
                                        : {}),
                                    }}
                                    title={`Citation ${globalSentIdx + 1}.${j + 1}`}
                                    onClick={() =>
                                      setSupportingCitationsPage?.(citationPage)
                                    }
                                  >
                                    {citationDisplay}
                                  </Button>
                                )
                                globalCitationIdx++
                                return btn
                              },
                            )}{' '}
                          </Text>
                        )
                      })}
                    </Box>
                  )
                })
              })()
            : (() => {
                let globalCitationIdx = 0
                return answer.sentences.map((sent, i) => (
                  <Text as='p' key={i} marginBottom='1' lineHeight='normal'>
                    {sent}{' '}
                    {answer.inline?.[i]?.map((c: any, j: number) => {
                      const citationDisplay = `${i + 1}.${j + 1}`
                      const citationPage = globalCitationIdx + 1
                      const btn = (
                        <Button
                          key={j}
                          size='small'
                          variant='secondary'
                          style={{
                            fontSize: '9px',
                            minWidth: 0,
                            height: 'auto',
                            lineHeight: 1,
                            ...(supportingCitationsPage === citationPage
                              ? {
                                  background: '#0A4298',
                                  color: 'white',
                                }
                              : {}),
                          }}
                          title={`Citation ${i + 1}.${j + 1}`}
                          onClick={() =>
                            setSupportingCitationsPage?.(citationPage)
                          }
                        >
                          {citationDisplay}
                        </Button>
                      )
                      globalCitationIdx++
                      return btn
                    })}
                  </Text>
                ))
              })()}
        </Box>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            paddingTop: '12px',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ flexShrink: 0 }}>
            {alignLoading ? (
              <Spinner />
            ) : alignment ? (
              <Tooltip content='AI assessment of how well the retrieved sources address the query and whether important gaps or risks remain.'>
                <Tag
                  icon={<FaInfoCircle />}
                  label={`Alignment: ${alignment.alignment}`}
                  variant='info-white'
                />
              </Tooltip>
            ) : null}
            {coverageRating === 'poor' && (
              <Tooltip content='The corpus may not contain sufficient material to answer this question'>
                <Tag
                  icon={<FaInfoCircle />}
                  label='Low corpus coverage'
                  variant={'default' as any}
                />
              </Tooltip>
            )}
            {coverageRating === 'limited' && (
              <Tooltip content='Some relevant sources found but coverage may be incomplete'>
                <Tag
                  icon={<FaInfoCircle />}
                  label='Limited coverage'
                  variant='info-white'
                />
              </Tooltip>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {!alignLoading && (
              <>
                <Tooltip content='Carbon equivalent of search'>
                  <Button
                    leftIcon={<AiFillThunderbolt />}
                    variant='borderless'
                    as='div'
                    size='small'
                    label={formatCO2(ops?.energy_gco2e)}
                    aria-label='Carbon equivalent of search'
                    onClick={() => {}}
                  />
                </Tooltip>
                <Tooltip content='Cost of credits used in search'>
                  <Button
                    as='div'
                    leftIcon={<HiCurrencyDollar />}
                    variant='borderless'
                    size='small'
                    label={formatCost(ops?.cost_usd)}
                    aria-label='Cost of credits used in search'
                    onClick={() => {}}
                  />
                </Tooltip>
              </>
            )}
            <Tooltip content={copied ? 'Copied' : 'Copy answer'}>
              <Button
                as='div'
                variant='borderless'
                size='small'
                leftIcon={copied ? <IoMdCheckmark /> : <IoIosCopy />}
                aria-label={copied ? 'Answer copied' : 'Copy answer'}
                onClick={() => {
                  let text = ''
                  if (answer.paragraphs) {
                    text = answer.paragraphs
                      .map((p) => p.join(' '))
                      .join('\n\n')
                  } else if (answer.sentences) {
                    text = answer.sentences.join(' ')
                  }
                  navigator.clipboard.writeText(text)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              />
            </Tooltip>
            <Tooltip content='Mark as good result'>
              <Button
                as='div'
                variant='borderless'
                size='small'
                leftIcon={
                  feedbackSubmitted === FeedbackSubmitted.Loading &&
                  feedbackState === FeedbackType.Positive ? (
                    <Spinner />
                  ) : (
                    <FaThumbsUp />
                  )
                }
                aria-label='Mark as good result'
                onClick={() => handleFeedback(FeedbackType.Positive)}
                style={
                  feedbackState === FeedbackType.Positive
                    ? {
                        background: getThemedColor('success', 300),
                        color: getThemedColor('success', 900),
                        opacity: 0.8,
                      }
                    : {}
                }
                disabled={
                  feedbackState === FeedbackType.Positive &&
                  feedbackSubmitted === FeedbackSubmitted.Loading
                }
              />
            </Tooltip>
            <Tooltip content='Mark as poor result'>
              <Button
                as='div'
                variant='borderless'
                size='small'
                leftIcon={
                  feedbackSubmitted === FeedbackSubmitted.Loading &&
                  feedbackState === FeedbackType.Negative ? (
                    <Spinner />
                  ) : (
                    <FaThumbsDown />
                  )
                }
                aria-label='Mark as poor result'
                onClick={() => handleFeedback(FeedbackType.Negative)}
                style={
                  feedbackState === FeedbackType.Negative
                    ? {
                        background: getThemedColor('error', 300),
                        color: getThemedColor('error', 900),
                        opacity: 0.8,
                      }
                    : {}
                }
                disabled={
                  feedbackState === FeedbackType.Negative &&
                  feedbackSubmitted === FeedbackSubmitted.Loading
                }
              />
            </Tooltip>
          </div>
        </div>
      </Box>
      <Modal
        size='medium'
        header={
          <Text textStyle='md' fontWeight='bold'>
            Ask new question
          </Text>
        }
        content={
          <Box>
            <Heading size='lg' style={{ marginBottom: '12px' }}>
              Current answer and citations will be lost
            </Heading>
            <Text>
              Please ensure you have copied the answer or any relevant citations
              before asking a new question as you will not be able to retrieve
              them.
            </Text>
          </Box>
        }
        draggable
        blocking={false}
        open={newQuestionModalOpen}
        footer={
          <>
            <Button
              label='Cancel'
              variant='secondary'
              onClick={() => {
                setNewQuestionModalOpen(false)
              }}
            />
            <Button
              label='Ask new question'
              onClick={() => {
                setAnswer(null)
                setQuery('')
              }}
            />
          </>
        }
        onClose={() => setNewQuestionModalOpen(false)}
      />
    </>
  )
}
