/* eslint-disable no-plusplus */
/* eslint-disable react/no-array-index-key */

'use client'

import { Text, Box } from '@chakra-ui/react'
import { Tag, Button, getThemedColor } from '@worldresources/wri-design-systems'
import { FaInfoCircle } from 'react-icons/fa'
import { MdChat } from 'react-icons/md'
import { AiIcon } from '../icons/AiIcon'
import { AnswerPanelProps } from './types'

export const AnswerPanel = ({ query, answer }: AnswerPanelProps) => (
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
        onClick={
          () =>
            console.log(
              'New search',
            ) /* TODO: implement new search functionality */
        }
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
                          <Text
                            as='span'
                            key={j}
                            fontSize='11px'
                            textDecoration='underline'
                            textDecorationStyle='dotted'
                            color='blue.600'
                            cursor='pointer'
                            _hover={{ opacity: 0.8 }}
                            title={`Citation ${globalSentIdx + 1}.${j + 1}`}
                          >
                            [{globalSentIdx + 1}.{j + 1}]
                          </Text>
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
                <Text
                  as='span'
                  key={j}
                  fontSize='11px'
                  textDecoration='underline'
                  textDecorationStyle='dotted'
                  color='blue.600'
                  cursor='pointer'
                  _hover={{ opacity: 0.8 }}
                  title={`Citation ${i + 1}.${j + 1}`}
                >
                  [{i + 1}.{j + 1}]
                </Text>
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
      <div style={{ width: '127px' }}>
        <Tag
          icon={<FaInfoCircle />}
          label={`${(answer.confidence ?? 0 * 100).toFixed(0)}% Confidence`}
          variant='info-white'
        />
      </div>
    </div>
  </Box>
)
