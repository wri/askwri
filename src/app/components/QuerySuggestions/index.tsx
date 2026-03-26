import { useState } from 'react'
import { FaArrowTurnUp } from 'react-icons/fa6'
import { LuRefreshCcw } from 'react-icons/lu'
import { Spinner, Text } from '@chakra-ui/react'
import { Button, getThemedColor } from '@worldresources/wri-design-systems'
import { AiIcon } from '../icons/AiIcon'
import { QuerySuggestionsProps } from './types'
import {
  ANSWER_MODE_SUGGESTION_POOL,
  CITE_MODE_SUGGESTION_POOL,
  getRandomSuggestions,
} from './suggestionPool'
import './QuerySuggestions.css'

const ALL_SUGGESTIONS = [
  ...ANSWER_MODE_SUGGESTION_POOL,
  ...CITE_MODE_SUGGESTION_POOL,
]

const QuerySuggestions = ({
  mode,
  handleExampleClick,
}: QuerySuggestionsProps) => {
  const pool =
    mode === 'cite' ? CITE_MODE_SUGGESTION_POOL : ANSWER_MODE_SUGGESTION_POOL
  const [localSuggestions, setLocalSuggestions] = useState(() =>
    pool.slice(0, 3),
  )
  const [loadingItem, setLoadingItem] = useState<string | null>(null)
  const [newItem, setNewItem] = useState<string | null>(null)

  const handleShuffle = () => {
    setLocalSuggestions(getRandomSuggestions(3, mode))
  }

  const handleClick = (item: string) => {
    if (loadingItem) return
    setLoadingItem(item)
    setTimeout(() => {
      const replacement = ALL_SUGGESTIONS.find(
        (s) => !localSuggestions.includes(s),
      )
      const next = replacement ?? item
      setLocalSuggestions((prev) => prev.map((s) => (s === item ? next : s)))
      setNewItem(next)
      setLoadingItem(null)
      handleExampleClick(item)
    }, 600)
  }

  return (
    <>
      <Text
        as='div'
        marginTop='2'
        marginBottom='2'
        color={getThemedColor('neutral', 700)}
        fontWeight='400'
        fontSize='sm'
      >
        For best results, ask a direct question and experiment with different
        levels of specificity, including geography.
      </Text>
      <section className='suggestions-list'>
        {localSuggestions.map((item) => (
          <Button
            key={item}
            variant='borderless'
            leftIcon={loadingItem === item ? <Spinner size='xs' /> : <AiIcon />}
            onClick={() => handleClick(item)}
            className='suggestion-button'
          >
            <span
              className={
                newItem === item ? 'suggestion-text-reveal' : undefined
              }
              onAnimationEnd={() => setNewItem(null)}
            >
              {loadingItem === item ? 'Loading new suggestion...' : item}
            </span>
            {loadingItem !== item && (
              <span className='suggestion-enter'>
                <FaArrowTurnUp />
              </span>
            )}
          </Button>
        ))}
      </section>
      <div style={{ display: 'flex', marginTop: '12px' }}>
        <Button
          variant='secondary'
          size='small'
          leftIcon={<LuRefreshCcw />}
          onClick={handleShuffle}
        >
          More suggestions
        </Button>
      </div>
    </>
  )
}

export default QuerySuggestions
