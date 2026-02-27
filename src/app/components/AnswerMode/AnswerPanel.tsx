/* eslint-disable no-plusplus */
/* eslint-disable react/no-array-index-key */

'use client'

import { useState, FC } from 'react'
import { Text, Box, Heading, Spinner } from '@chakra-ui/react'
import {
  Tag,
  Button,
  getThemedColor,
  Modal,
  Tooltip as DS_Tooltip,
} from '@worldresources/wri-design-systems'
import { FaInfoCircle } from 'react-icons/fa'
import { FaThumbsDown, FaThumbsUp } from 'react-icons/fa6'
import { MdChat } from 'react-icons/md'
import { IoIosCopy } from 'react-icons/io'
import { AiIcon } from '../icons/AiIcon'
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
}: AnswerPanelProps) => {
  const [newQuestionModalOpen, setNewQuestionModalOpen] = useState(false)

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
        className='gradient-background'
        style={{
          flex: 1,
          padding: '20px',
          backgroundColor: 'white',
          borderRadius: '8px',
          border: '1px solid',
          borderColor: getThemedColor('neutral', 200),
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
            ? answer.paragraphs.map((paragraph, pIdx) => {
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
                            (c: any, j: number) => (
                              <Button
                                key={j}
                                size='small'
                                variant='secondary'
                                style={{
                                  fontSize: '9px',
                                  minWidth: 0,
                                  height: 'auto',
                                  lineHeight: 1,
                                }}
                                title={`Citation ${globalSentIdx + 1}.${j + 1}`}
                              >
                                {globalSentIdx + 1}.{j + 1}
                              </Button>
                            ),
                          )}{' '}
                        </Text>
                      )
                    })}
                  </Box>
                )
              })
            : answer.sentences.map((sent, i) => (
                <Text as='p' key={i} marginBottom='1' lineHeight='normal'>
                  {sent}{' '}
                  {answer.inline?.[i]?.map((c: any, j: number) => (
                    <Button
                      key={j}
                      size='small'
                      variant='secondary'
                      style={{
                        fontSize: '9px',
                        minWidth: 0,
                        height: 'auto',
                        lineHeight: 1,
                      }}
                      title={`Citation ${i + 1}.${j + 1}`}
                    >
                      {i + 1}.{j + 1}
                    </Button>
                  ))}
                </Text>
              ))}
        </Box>
        <div
          style={{
            paddingTop: '12px',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ width: '150px' }}>
            <Tag
              icon={<FaInfoCircle />}
              label={`${((answer.confidence ?? 0) * 100).toFixed(0)}% Confidence`}
              variant='info-white'
            />
          </div>
          <div>
            <Button
              variant='borderless'
              size='small'
              leftIcon={<IoIosCopy />}
              onClick={() => {
                let text = ''
                if (answer.paragraphs) {
                  text = answer.paragraphs.map((p) => p.join(' ')).join('\n\n')
                } else if (answer.sentences) {
                  text = answer.sentences.join(' ')
                }
                navigator.clipboard.writeText(text)
              }}
            >
              Copy
            </Button>
            <Button
              variant='borderless'
              leftIcon={
                feedbackSubmitted === FeedbackSubmitted.Loading &&
                feedbackState === FeedbackType.Positive ? (
                  <Spinner />
                ) : (
                  <Tooltip content='Mark as good result'>
                    <FaThumbsUp />
                  </Tooltip>
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
            <Button
              variant='borderless'
              leftIcon={
                feedbackSubmitted === FeedbackSubmitted.Loading &&
                feedbackState === FeedbackType.Negative ? (
                  <Spinner />
                ) : (
                  <Tooltip content='Mark as poor result'>
                    <FaThumbsDown />
                  </Tooltip>
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
