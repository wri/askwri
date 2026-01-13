#!/usr/bin/env tsx

/**
 * Script to add program_series metadata to World Resources Report documents
 *
 * Updates the metadata JSON in data/documents.csv to include:
 * "program_series": "World Resources Report"
 *
 * for the 16 documents identified in golden-dataset.json Q9
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// 16 WRR document URLs from golden-dataset.json Q9
const WRR_URLS = [
  "https://www.wri.org/research/7-transformations-more-equitable-sustainable-cities",
  "https://www.wri.org/research/towards-more-equal-city-framing-challenges-and-opportunities",
  "https://www.wri.org/research/powering-cities-global-south-how-energy-access-all-benefits-economy-and-environment",
  "https://www.wri.org/research/confronting-urban-housing-crisis-global-south-adequate-secure-and-affordable-housing",
  "https://www.wri.org/research/unaffordable-and-undrinkable-rethinking-urban-water-access-global-south",
  "https://www.wri.org/research/untreated-and-unsafe-solving-urban-sanitation-crisis-global-south",
  "https://www.wri.org/research/mobility-access-all-expanding-urban-transportation-choices-global-south",
  "https://www.wri.org/research/including-excluded-supporting-informal-workers-more-equal-and-productive-cities-global",
  "https://www.wri.org/research/upward-and-outward-growth-managing-urban-expansion-more-equitable-cities-global-south",
  "https://www.wri.org/research/ahmedabad-town-planning-schemes-equitable-development-glass-half-full-or-half-empty",
  "https://www.wri.org/research/porto-alegre-participatory-budgeting-and-challenge-sustaining-transformative-change",
  "https://www.wri.org/research/pune-civil-society-coalitions-policy-contradictions-and-unsteady-transformation",
  "https://www.wri.org/research/surabaya-legacy-participatory-upgrading-informal-settlements",
  "https://www.wri.org/research/guadalajara-revisiting-public-space-interventions-through-recreactiva",
  "https://www.wri.org/research/kampala-rebuilding-public-sector-legitimacy-new-approach-sanitation-services",
  "https://www.wri.org/research/johannesburg-confronting-spatial-inequality"
];

// Extract URL slug for matching
function extractUrlSlug(url: string): string {
  try {
    const normalized = url.trim().toLowerCase();
    if (!normalized.startsWith('http')) {
      const filename = path.basename(normalized);
      return filename.replace(/\.pdf$/i, '');
    }
    const urlObj = new URL(normalized);
    const pathname = urlObj.pathname;
    const segments = pathname.split('/').filter(s => s.length > 0);
    const lastSegment = segments[segments.length - 1];
    return lastSegment
      .replace(/\.pdf$/i, '')
      .replace(/\.html?$/i, '')
      .replace(/\?.*$/, '')
      .replace(/#.*$/, '');
  } catch (e) {
    return '';
  }
}

async function addWRRMetadata() {
  const csvPath = path.join(__dirname, '../data/documents.csv');

  console.log('Reading CSV...');
  const csvContent = fs.readFileSync(csvPath, 'utf-8');

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  console.log(`Total documents: ${records.length}`);

  // Create slug set for efficient matching
  const wrrSlugs = new Set(WRR_URLS.map(extractUrlSlug));
  console.log(`\nWRR document slugs to match: ${wrrSlugs.size}`);

  let updated = 0;
  let alreadyHadMetadata = 0;

  for (const record of records) {
    // Parse metadata JSON
    let metadata;
    try {
      metadata = JSON.parse(record.metadata || '{}');
    } catch (e) {
      console.warn(`Warning: Could not parse metadata for ID ${record.id}`);
      continue;
    }

    // Check if URL matches any WRR URL
    // Field is "URL" not "Source URL" in the CSV
    const sourceUrl = metadata['URL'] || metadata['Source URL'] || '';
    const slug = extractUrlSlug(sourceUrl);

    if (wrrSlugs.has(slug)) {
      // Check if already has program_series
      if (metadata.program_series) {
        alreadyHadMetadata++;
        console.log(`  ✓ ID ${record.id} already has program_series: "${metadata.program_series}"`);
      } else {
        // Add program_series
        metadata.program_series = 'World Resources Report';
        record.metadata = JSON.stringify(metadata);
        updated++;
        console.log(`  + ID ${record.id}: Added program_series (${metadata['Article Title'] || 'unknown'})`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Documents updated: ${updated}`);
  console.log(`Already had metadata: ${alreadyHadMetadata}`);
  console.log(`Total WRR documents found: ${updated + alreadyHadMetadata} / ${WRR_URLS.length}`);

  if (updated > 0) {
    // Write back to CSV
    console.log('\nWriting updated CSV...');
    const output = stringify(records, {
      header: true,
      quoted_string: true,
    });

    // Backup original
    const backupPath = csvPath + `.backup-${Date.now()}`;
    fs.copyFileSync(csvPath, backupPath);
    console.log(`Backup created: ${backupPath}`);

    fs.writeFileSync(csvPath, output, 'utf-8');
    console.log('CSV updated successfully!');
  } else {
    console.log('\nNo changes needed - all WRR documents already have program_series metadata');
  }
}

addWRRMetadata().catch(console.error);
