#!/usr/bin/env node
/**
 * Verify that all URLs in the golden dataset exist in the documents.csv catalog
 */

import * as fs from 'fs'
import * as path from 'path'
import { parse } from 'csv-parse/sync'

const GOLDEN_DATASET_PATH = path.join(__dirname, '../golden-dataset.json')
const DOCUMENTS_CSV_PATH = path.join(
  __dirname,
  '..',
  '..',
  'search-service',
  'data',
  'documents.csv',
)

interface GoldenTestCase {
  id: string
  question: string
  expected_urls: string[]
  expected_count: number
  difficulty: string
  query_type: string
}

interface GoldenDataset {
  test_cases: GoldenTestCase[]
}

interface DocumentRecord {
  file_path: string
  metadata: string
  summary: string
}

function normalizeUrl(url: string): string {
  // Remove trailing slashes and normalize to lowercase for comparison
  return url.toLowerCase().replace(/\/$/, '')
}

function main() {
  console.log('🔍 Checking golden dataset URLs against documents.csv...\n')

  // Load golden dataset
  const goldenData: GoldenDataset = JSON.parse(
    fs.readFileSync(GOLDEN_DATASET_PATH, 'utf-8'),
  )

  // Load and parse CSV
  const csvContent = fs.readFileSync(DOCUMENTS_CSV_PATH, 'utf-8')
  const records: DocumentRecord[] = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  })

  console.log(`📊 Found ${records.length} documents in CSV\n`)

  // Extract all URLs from CSV
  const csvUrls = new Set<string>()
  const urlToTitle = new Map<string, string>()

  for (const record of records) {
    try {
      const metadata = JSON.parse(record.metadata)
      const url = metadata['Source URL'] || metadata['URL']
      const title = metadata['Article Title']

      if (url) {
        const normalized = normalizeUrl(url)
        csvUrls.add(normalized)
        if (title) {
          urlToTitle.set(normalized, title)
        }
      }
    } catch (_e) {
      // Skip invalid JSON
    }
  }

  console.log(`🔗 Extracted ${csvUrls.size} unique URLs from CSV\n`)

  // Collect all expected URLs from golden dataset
  const allExpectedUrls = new Set<string>()
  for (const testCase of goldenData.test_cases) {
    for (const url of testCase.expected_urls) {
      allExpectedUrls.add(normalizeUrl(url))
    }
  }

  console.log(
    `📝 Golden dataset expects ${allExpectedUrls.size} unique documents\n`,
  )
  console.log('='.repeat(80))
  console.log('\n')

  // Check each test case
  let totalMissing = 0
  let totalFound = 0

  for (const testCase of goldenData.test_cases) {
    console.log(`\n📋 Test Case: ${testCase.id}`)
    console.log(`   Question: ${testCase.question}`)
    console.log(`   Expected: ${testCase.expected_count} documents`)
    console.log(`   Actual URLs: ${testCase.expected_urls.length}`)

    const missing: string[] = []
    const found: string[] = []

    for (const expectedUrl of testCase.expected_urls) {
      const normalized = normalizeUrl(expectedUrl)
      if (csvUrls.has(normalized)) {
        found.push(expectedUrl)
        const title = urlToTitle.get(normalized)
        console.log(`   ✅ FOUND: ${title || 'Unknown'}`)
        console.log(`      URL: ${expectedUrl}`)
      } else {
        missing.push(expectedUrl)
        console.log(`   ❌ MISSING: ${expectedUrl}`)
      }
    }

    totalFound += found.length
    totalMissing += missing.length

    if (missing.length === 0) {
      console.log(`   ✨ All ${found.length} documents found!`)
    } else {
      console.log(`   ⚠️  ${missing.length} missing, ${found.length} found`)
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log('\n📊 SUMMARY:')
  console.log(`   Total expected documents: ${allExpectedUrls.size}`)
  console.log(
    `   Found in index: ${totalFound} (${((totalFound / (totalFound + totalMissing)) * 100).toFixed(1)}%)`,
  )
  console.log(
    `   Missing from index: ${totalMissing} (${((totalMissing / (totalFound + totalMissing)) * 100).toFixed(1)}%)`,
  )

  if (totalMissing === 0) {
    console.log('\n✅ All golden dataset documents are present in the index!')
    process.exit(0)
  } else {
    console.log(
      '\n❌ Some golden dataset documents are missing from the index.',
    )
    console.log('   You should add these documents before running evaluations.')
    process.exit(1)
  }
}

main()
