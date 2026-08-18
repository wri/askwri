'use client'

import { Box } from '@chakra-ui/react'
import { TopicTaxonomyManager } from './components/TopicTaxonomyManager'

/**
 * Deep-link to just the rich topic taxonomy UI (no facet tabs).
 * The primary entry point is /admin/tags?facet=topic (the Topic tab);
 * this route is for direct linking and bookmarks.
 */
const TopicsPage = () => (
  <Box style={{ paddingBottom: 48 }}>
    <TopicTaxonomyManager />
  </Box>
)

export default TopicsPage
