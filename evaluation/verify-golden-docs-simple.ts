/**
 * Verify that all expected documents in golden dataset exist in the catalog
 * Simple version without complex dependencies
 */
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  // Load golden dataset
  const goldenDataPath = path.join(__dirname, 'golden-dataset.json');
  const goldenData = JSON.parse(fs.readFileSync(goldenDataPath, 'utf-8'));

  // Load documents catalog - parse CSV manually
  const catalogPath = path.join(__dirname, '../search-service/data/documents.csv');
  const catalogCSV = fs.readFileSync(catalogPath, 'utf-8');

  // Extract URLs from catalog using simple regex
  const catalogUrls = new Set<string>();
  const catalogUrlsNormalized = new Set<string>();

  // Match ""URL"": ""..."" patterns in the CSV (note the space after colon)
  const urlMatches = catalogCSV.matchAll(/""URL"":\s*""([^"]+)""/g);

  for (const match of urlMatches) {
    const url = match[1];
    catalogUrls.add(url);

    // Normalize for comparison
    const normalized = url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/^www\./, '');
    catalogUrlsNormalized.add(normalized);
  }

  console.log(`📊 Loaded ${catalogUrls.size} unique URLs from catalog`);

  // Function to normalize URL for comparison
  function normalizeUrl(url: string): string {
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .replace(/^www\./, '');
  }

  // Check each test case
  let totalExpected = 0;
  let totalFound = 0;
  let totalMissing = 0;

  const missingByTestCase: Record<string, string[]> = {};

  for (const testCase of goldenData.test_cases) {
    console.log(`\n🔍 Test Case: ${testCase.id}`);
    console.log(`   Question: ${testCase.question}`);
    console.log(`   Expected: ${testCase.expected_count} documents`);

    const missing: string[] = [];

    for (const expectedUrl of testCase.expected_urls) {
      totalExpected++;
      const normalizedExpected = normalizeUrl(expectedUrl);

      if (catalogUrlsNormalized.has(normalizedExpected)) {
        totalFound++;
      } else {
        totalMissing++;
        missing.push(expectedUrl);
        console.log(`   ❌ MISSING: ${expectedUrl}`);
      }
    }

    if (missing.length > 0) {
      missingByTestCase[testCase.id] = missing;
    } else {
      console.log(`   ✅ All ${testCase.expected_urls.length} documents found in catalog`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('📊 VERIFICATION SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total expected documents: ${totalExpected}`);
  console.log(`Found in catalog: ${totalFound} (${((totalFound/totalExpected)*100).toFixed(1)}%)`);
  console.log(`Missing from catalog: ${totalMissing} (${((totalMissing/totalExpected)*100).toFixed(1)}%)`);

  if (totalMissing > 0) {
    console.log('\n⚠️  MISSING DOCUMENTS BY TEST CASE:');
    for (const [testCaseId, urls] of Object.entries(missingByTestCase)) {
      console.log(`\n${testCaseId}:`);
      for (const url of urls) {
        console.log(`  - ${url}`);
      }
    }

    console.log('\n⚠️  Impact: Missing documents will artificially lower recall in eval results.');
    console.log('    These documents cannot be retrieved even if the system is working perfectly.');
    process.exit(1);
  } else {
    console.log('\n✅ All expected documents exist in the catalog!');
    console.log('   Eval results accurately reflect system performance.');
    process.exit(0);
  }
}

main().catch(console.error);
