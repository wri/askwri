/**
 * Analyze why specific documents are missing from retrieval
 *
 * For high-priority missing docs (Q8, Q10, Q11), this tool:
 * 1. Reads document metadata from CSV
 * 2. Analyzes query keywords vs document content
 * 3. Checks if document exists in index
 * 4. Scores BM25 keyword overlap
 * 5. Identifies potential root causes
 */

import * as fs from 'fs'
import * as path from 'path'
import { parse } from 'csv-parse/sync'

const PYTHON_SERVICE_URL =
  process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8000'

// Load golden dataset
const goldenDataPath = path.join(__dirname, '../golden-dataset.json')
const goldenData = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'))

// Load documents CSV
const csvPath = path.join(__dirname, '../../search-service/data/documents.csv')
const csvContent = fs.readFileSync(csvPath, 'utf-8')
const documents: Array<Record<string, string>> = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
})

interface TestCase {
  id: string
  question: string
  expected_urls: string[]
  expected_count: number
}

interface DocumentMetadata {
  file_path: string
  title: string
  authors: string
  year: number
  summary: string
  url: string
}

function extractUrlSlug(url: string): string {
  if (!url) return ''

  const pathParts = url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')
    .filter(Boolean)
  const lastPart = pathParts[pathParts.length - 1] || ''

  return lastPart
    .split('?')[0]
    .replace(/\.(pdf|docx?|html?)$/i, '')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/^_+|_+$/g, '')
}

function findDocumentByUrl(url: string): DocumentMetadata | null {
  const slug = extractUrlSlug(url)

  for (const doc of documents) {
    const metadata = JSON.parse(doc.metadata || '{}')
    const docUrl = metadata.URL || metadata['Source URL'] || ''
    const docSlug = extractUrlSlug(docUrl)

    if (docSlug === slug) {
      return {
        file_path: doc.file_path,
        title: metadata['Article Title'] || '',
        authors: metadata['All authors'] || '',
        year: metadata['YEAR published'] || 0,
        summary: doc.summary || metadata.summary || '',
        url: docUrl,
      }
    }
  }

  return null
}

function extractKeywords(text: string): string[] {
  // Simple keyword extraction: lowercase, remove punctuation, split
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3) // Filter short words

  return [...new Set(words)] // Deduplicate
}

function calculateKeywordOverlap(
  queryKeywords: string[],
  docKeywords: string[],
): {
  overlap: number
  matches: string[]
} {
  const matches: string[] = []

  for (const qk of queryKeywords) {
    if (docKeywords.includes(qk)) {
      matches.push(qk)
    }
  }

  const overlap = matches.length / queryKeywords.length
  return { overlap, matches }
}

async function analyzeRetrievalForMissingDoc(
  testCase: TestCase,
  missingUrl: string,
): Promise<void> {
  console.log(`\n${'='.repeat(80)}`)
  console.log(`Query: ${testCase.id}`)
  console.log(`Question: ${testCase.question}`)
  console.log(`Missing Document: ${extractUrlSlug(missingUrl)}`)

  // Find document metadata
  const doc = findDocumentByUrl(missingUrl)

  if (!doc) {
    console.log(`\n❌ ERROR: Document not found in CSV catalog`)
    console.log(`   URL: ${missingUrl}`)
    return
  }

  console.log(`\n📄 Document Metadata:`)
  console.log(`   Title: ${doc.title}`)
  console.log(`   Authors: ${doc.authors}`)
  console.log(`   Year: ${doc.year}`)
  console.log(`   Summary length: ${doc.summary.length} chars`)

  // Extract keywords from query and document
  const queryKeywords = extractKeywords(testCase.question)
  const titleKeywords = extractKeywords(doc.title)
  const summaryKeywords = extractKeywords(doc.summary)

  console.log(`\n🔍 Keyword Analysis:`)
  console.log(
    `   Query keywords: ${queryKeywords.slice(0, 5).join(', ')}${queryKeywords.length > 5 ? '...' : ''}`,
  )

  // Check title overlap
  const titleOverlap = calculateKeywordOverlap(queryKeywords, titleKeywords)
  console.log(
    `\n   Title keyword overlap: ${(titleOverlap.overlap * 100).toFixed(1)}%`,
  )
  if (titleOverlap.matches.length > 0) {
    console.log(`   Matches: ${titleOverlap.matches.join(', ')}`)
  } else {
    console.log(`   ⚠️  NO keyword matches in title`)
  }

  // Check summary overlap
  const summaryOverlap = calculateKeywordOverlap(queryKeywords, summaryKeywords)
  console.log(
    `\n   Summary keyword overlap: ${(summaryOverlap.overlap * 100).toFixed(1)}%`,
  )
  if (summaryOverlap.matches.length > 0) {
    console.log(`   Matches: ${summaryOverlap.matches.join(', ')}`)
  } else {
    console.log(`   ⚠️  NO keyword matches in summary`)
  }

  // Call retrieval service to see where this doc ranks
  try {
    const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: testCase.question,
        mode: 'cite',
        max_results: 200, // Get more results to see if doc appears later
        similarity_threshold: 0.0,
        include_metadata: true,
        rerank: true,
        vector_top_k: 500,
        bm25_top_k: 500,
        rerank_top_n: 200, // Increase to see full ranking
      }),
    })

    const data = await response.json()
    const retrievedUrls = data.docs.map(
      (d: any) => d.metadata.url || d.metadata.file_path,
    )
    const retrievedSlugs = retrievedUrls.map(extractUrlSlug)
    const targetSlug = extractUrlSlug(missingUrl)

    const docIndex = retrievedSlugs.indexOf(targetSlug)

    console.log(`\n📊 Retrieval Ranking (top 200):`)
    if (docIndex === -1) {
      console.log(`   ❌ Document NOT FOUND in top 200 results`)
      console.log(`   Root cause: Document filtered out before reranking OR`)
      console.log(`              Insufficient vector/BM25 similarity`)
    } else {
      console.log(`   ✅ Found at position: ${docIndex + 1}`)
      const doc_data = data.docs[docIndex]
      console.log(`   Reranker score: ${doc_data.score.toFixed(4)}`)
      if (docIndex >= 60) {
        console.log(`   Issue: Ranked below rerank_top_n=60 cutoff`)
        console.log(`   Reranking filtered it out`)
      }
    }
  } catch (error: any) {
    console.error(`   ❌ Error querying service: ${error.message}`)
  }

  // Diagnose potential root causes
  console.log(`\n🔎 Potential Root Causes:`)

  if (titleOverlap.overlap === 0 && summaryOverlap.overlap < 0.2) {
    console.log(`   1. ⚠️  Low keyword overlap with query (BM25 may miss it)`)
    console.log(
      `      Solution: Rely more on vector search for semantic matching`,
    )
  }

  if (summaryOverlap.overlap > 0.3) {
    console.log(`   2. ✅ Good summary overlap - vector search should work`)
    console.log(
      `      Issue may be: reranking filtering it out or vector_top_k too low`,
    )
  }

  console.log(`   3. Check if document is about a related but different topic`)
  console.log(`   4. Check if query needs expansion (synonyms, related terms)`)
}

async function main() {
  console.log('🔍 Analyzing Missing Documents from Retrieval')
  console.log('Focus: Queries with worst retrieval recall (Q8, Q10, Q11)')
  console.log('')

  // Q10: Urban Finance 2020 (50% retrieval recall, 5 missing docs)
  const q10 = goldenData.test_cases.find(
    (tc: any) => tc.id === 'q10_urban_finance_since_2020',
  )
  const q10Missing = [
    'https://www.wri.org/research/rolling-out-electric-buses',
    'https://wri-india.org/research/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico',
    'https://wri-india.org/research/assessing-financing-challenges-implementing-large-scale-electric-bus-program-india',
    'https://www.wri.org/research/feasibility-of-zero-emission-freight-zones-in-beijing-scenario-analysis-and-risk-assessment',
    'https://wri-india.org/research/financial-analysis-charging-station-fact',
  ]

  console.log('\n' + '█'.repeat(80))
  console.log('Q10: Urban Finance since 2020 (5 missing documents)')
  console.log('█'.repeat(80))

  for (const url of q10Missing.slice(0, 2)) {
    // Analyze first 2 for now
    await analyzeRetrievalForMissingDoc(q10, url)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Q11: Urban Finance exclude buses (60% retrieval recall, 4 missing docs)
  const q11 = goldenData.test_cases.find(
    (tc: any) => tc.id === 'q11_urban_finance_exclude_ebuses',
  )
  const q11Missing = [
    'https://www.wri.org/research/accelerating-nature-based-solutions-brazilian-cities',
    'https://wri-india.org/research/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico',
  ]

  console.log('\n\n' + '█'.repeat(80))
  console.log('Q11: Urban Finance exclude e-buses (4 missing documents)')
  console.log('█'.repeat(80))

  for (const url of q11Missing.slice(0, 1)) {
    // Analyze first 1
    await analyzeRetrievalForMissingDoc(q11, url)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  // Q8: Hydrogen (60% retrieval recall, 2 missing docs)
  const q8 = goldenData.test_cases.find((tc: any) => tc.id === 'q8_hydrogen')
  const q8Missing = [
    'https://www.wri.org/research/completing-trip-establishing-global-quantified-climate-goal-transport-sector',
    'https://wri.org.cn/en/research/pathways-to-decarbonize-the-road-transport-sector-in-guangdong',
  ]

  console.log('\n\n' + '█'.repeat(80))
  console.log('Q8: Hydrogen papers (2 missing documents)')
  console.log('█'.repeat(80))

  for (const url of q8Missing) {
    await analyzeRetrievalForMissingDoc(q8, url)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  console.log('\n\n' + '='.repeat(80))
  console.log('✅ Analysis complete')
  console.log('='.repeat(80))
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
