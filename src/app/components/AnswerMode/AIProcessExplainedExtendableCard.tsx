import { Text, Box, Heading } from '@chakra-ui/react'
import {
  getThemedColor,
  ExtendableCard,
} from '@worldresources/wri-design-systems'
import { ThinkIcon } from '../icons/ThinkIcon'

const AIProcessExplainedExtendableCard = ({ query }: { query: string }) => (
  <div style={{ background: 'white', marginTop: '20px' }}>
    <ExtendableCard
      header={
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ThinkIcon />
          AI process explained
        </div>
      }
    >
      <Box style={{ padding: '20px' }}>
        <Heading size='lg' style={{ marginBottom: '12px' }}>
          How results are generated
        </Heading>
        <Text>
          AI helps find and rank publications by analysing your query, searching
          across a library of WRI knowledge products (currently limited to
          Cities program), and identifying the most relevant sources. The steps
          below explain how this process worked for your search.
        </Text>
        <hr style={{ margin: '20px 0' }} />
        <Heading size='lg' style={{ marginBottom: '12px' }}>
          1. Query interpretation
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          {`Identified the main topic, location, and intent from “${query}”.`}
        </Text>
        <Heading size='lg' style={{ marginBottom: '12px', marginTop: '24px' }}>
          2. Search approach
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          Used a citation-focused search to prioritise relevant publications
          with summaries and metadata.
        </Text>
        <Heading size='lg' style={{ marginBottom: '12px', marginTop: '24px' }}>
          3. Retrieval
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          Searched across WRI publications using a hybrid approach combining
          semantic similarity and keyword matching.
        </Text>
        <Heading size='lg' style={{ marginBottom: '12px', marginTop: '24px' }}>
          4. Ranking
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          Merged results from both retrieval methods and re-ranked publications
          by relevance.
        </Text>
        <Heading size='lg' style={{ marginBottom: '12px', marginTop: '24px' }}>
          5. Result selection
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          Reviewed ~500 candidates and selected the top ~35 most relevant
          publications for display.
        </Text>
        <Heading size='lg' style={{ marginBottom: '12px', marginTop: '24px' }}>
          6. Filters
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          No date or sub-topic filters were applied.
        </Text>
        <Heading size='lg' style={{ marginBottom: '12px', marginTop: '24px' }}>
          7. Coverage assessment
        </Heading>
        <Text style={{ color: getThemedColor('neutral', 700) }}>
          Identified strong overall coverage and suggested Answer mode for
          synthesis.
        </Text>
        <Text style={{ marginTop: '20px', fontStyle: 'italic' }}>
          This search was generated using the following Ask WRI models: V1.0
          ANSv1.3
        </Text>
      </Box>
    </ExtendableCard>
  </div>
)

export default AIProcessExplainedExtendableCard
