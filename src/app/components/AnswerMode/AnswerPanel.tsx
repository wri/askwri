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

  // 0 = no vote, 1 = positive, -1 = negative
  const [vote, setVote] = useState<0 | 1 | -1>(0)
  // logSent: null = not sent, 'loading' = sending, 'success' = sent
  const [logSent, setLogSent] = useState<null | 'loading' | 'success'>(null)

  const sendLog = async (feedback: 'positive' | 'negative') => {
    setLogSent('loading')
    const consultedDocIds = consultedDocs?.map((doc) => doc.id).join(',') || ''
    const supportingDocIds =
      supportingDocs?.map((doc) => doc.doc_id).join(',') || ''

    const firstSupportingDoc = supportingDocs?.[0]

    try {
      const feedbackData = {
        query,
        answer: answer.sentences.join(' '),
        feedback,
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
        setLogSent('success')
      } else {
        setLogSent(null)
      }
    } catch {
      setLogSent(null)
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
                logSent === 'loading' && vote === 1 ? (
                  <Spinner />
                ) : (
                  <Tooltip content='Mark as good result'>
                    <FaThumbsUp />
                  </Tooltip>
                )
              }
              aria-label='Mark as good result'
              onClick={() => {
                if (vote === 1) {
                  setVote(0)
                  setLogSent(null)
                } else {
                  setVote(1)
                  sendLog('positive')
                }
              }}
              style={
                vote === 1
                  ? {
                      background: getThemedColor('success', 300),
                      color: getThemedColor('success', 900),
                      opacity: 0.8,
                    }
                  : {}
              }
              disabled={vote === 1 && logSent === 'loading'}
            />
            <Button
              variant='borderless'
              leftIcon={
                logSent === 'loading' && vote === -1 ? (
                  <Spinner />
                ) : (
                  <Tooltip content='Mark as poor result'>
                    <FaThumbsDown />
                  </Tooltip>
                )
              }
              aria-label='Mark as poor result'
              onClick={() => {
                if (vote === -1) {
                  setVote(0)
                  setLogSent(null)
                } else {
                  setVote(-1)
                  sendLog('negative')
                }
              }}
              style={
                vote === -1
                  ? {
                      background: getThemedColor('error', 300),
                      color: getThemedColor('error', 900),
                      opacity: 0.8,
                    }
                  : {}
              }
              disabled={vote === -1 && logSent === 'loading'}
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
