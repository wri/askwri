#!/usr/bin/env tsx
/**
 * Validate that all URLs in eval questions docx exist in our document catalog
 */

import * as fs from 'fs';
import * as path from 'path';

// Helper to extract URL slug (matches evaluation logic)
function extractUrlSlug(url: string): string {
  try {
    const normalized = url.trim().toLowerCase();

    // Handle local file paths
    if (!normalized.startsWith('http')) {
      const filename = path.basename(normalized);
      return filename.replace(/\.pdf$/i, '');
    }

    // Extract from URL
    const urlObj = new URL(normalized);
    const pathname = urlObj.pathname;

    // Get the last meaningful segment
    const segments = pathname.split('/').filter(s => s.length > 0);
    if (segments.length === 0) return '';

    const lastSegment = segments[segments.length - 1];

    // Remove file extensions
    return lastSegment
      .replace(/\.pdf$/i, '')
      .replace(/\.html?$/i, '')
      .replace(/\?.*$/, '')  // Remove query params
      .replace(/#.*$/, '');  // Remove fragments
  } catch (e) {
    return '';
  }
}

// Parse CSV (simple parser for our use case)
function parseCSV(csvPath: string): Array<{file_path: string, metadata: any, summary: string}> {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n');
  const results: Array<{file_path: string, metadata: any, summary: string}> = [];

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV line (handle JSON in metadata column)
    const match = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*),(.*)$/);
    if (!match) continue;

    const [, file_path, metadataStr, summary] = match;

    try {
      // Remove quotes and unescape
      const cleanMeta = metadataStr.replace(/^"|"$/g, '').replace(/""/g, '"');
      const metadata = JSON.parse(cleanMeta);
      results.push({ file_path, metadata, summary });
    } catch (e) {
      console.error(`Failed to parse line ${i}: ${e}`);
    }
  }

  return results;
}

// All URLs from the docx (existing + new questions)
const DOCX_URLS = [
  // Q1: Land value capture
  "https://www.wri.org/research/synergizing-land-value-capture-tod",
  "https://www.wri.org/research/ahmedabad-town-planning-schemes-equitable-development-glass-half-full-or-half-empty",
  "https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations",
  "https://www.wri.org/rail-plus-property-development-china-pilot-case-shenzhen",

  // Q2: Bangalore
  "https://www.wri.org/research/our-journey-city-deciphering-wri-india-ross-centers-influence-bengaluru",
  "https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india",
  "https://www.wri.org/research/synergizing-land-value-capture-tod",  // duplicate
  "https://www.wri.org/research/urban-blue-green-conundrum-10-city-study-impacts-urbanization-natural-infrastructure-india",
  "https://wri-india.org/research/improving-metro-access-india",
  "https://wri-india.org/publication/climate-resilient-cities-assessing-differential-vulnerability-climate-hazards-urban",

  // Q3: Children and pollution
  "https://www.wri.org/research/driving-forward-clean-ride-kids",
  "https://www.wri.org/research/technical-note-dataset-modeling-societal-health-and-climate-benefits-electric-school-buses",
  "https://www.wri.org/research/improving-school-infrastructure-healthier-students-and-communities",

  // Q4: Climate adaptation in Brazil
  "https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities",
  "https://www.wribrasil.org.br/publicacoes/accessibility-public-green-areas-case-study-belo-horizonte-brazil",
  "https://www.wri.org/research/prepared-communities",

  // Q5: Micromobility
  "https://urbantransitions.global/en/publication/mexico-frontrunners/",
  "https://wri-india.org/research/enabling-shift-electric-auto-rickshaws-guidebook-electrification-auto-rickshaw-fleets",
  "https://www.wri.org/research/how-dockless-bike-sharing-changes-lives-analysis-chinese-cities",
  "https://www.wri.org/research/public-bicycle-sharing-india-lessons-learned-implementation-three-cities",
  "https://www.numo.global/resources/micromobility-emissions-life-cycle-assessment-guide",
  "https://www.wri.org/research/evolution-bike-sharing",
  "https://wri-india.org/research/assessing-viability-using-autorickshaws-urban-freight-delivery-india",
  "https://www.wri.org/research/guadalajara-revisiting-public-space-interventions-through-recreactiva",

  // Q6: School bus health
  "https://www.wri.org/research/driving-forward-clean-ride-kids",  // duplicate
  "https://www.wri.org/research/technical-note-dataset-modeling-societal-health-and-climate-benefits-electric-school-buses",  // duplicate
  "https://www.wri.org/research/improving-school-infrastructure-healthier-students-and-communities",  // duplicate
  "https://www.wri.org/research/impactar-tool-air-quality-health-impacts-urban-bus-fleet-brazil-2022",

  // Q7: Jakarta housing (updated with related docs)
  "https://www.wri.org/research/surabaya-legacy-participatory-upgrading-informal-settlements",
  "https://www.wri.org/research/confronting-urban-housing-crisis-global-south-adequate-secure-and-affordable-housing",
  "https://urbantransitions.global/en/publication/housing-policies-for-sustainable-and-inclusive-cities/",
  "https://urbantransitions.global/en/publication/integrating-national-policies-to-deliver-compact-connected-cities-an-overview-of-transport-and-housing/",

  // Q8: Hydrogen
  "https://wri-india.org/research/supporting-energy-transition-addressing-technology-gaps-electrolyzers",
  "https://wri-india.org/research/accelerating-production-and-use-green-hydrogen",
  "https://wri-india.org/research/pathways-decarbonize-indias-transport-sector-scenario-analysis-using-energy-policy",
  "https://www.wri.org/research/completing-trip-establishing-global-quantified-climate-goal-transport-sector",
  "https://wri.org.cn/en/report/Pathways-to-Decarbonize-the-Road-Transport-Sector-in-Guangdong",

  // Q9: World Resources Report (16 papers)
  "https://www.wri.org/research/7-transformations-more-equitable-sustainable-cities",
  "https://www.wri.org/research/towards-more-equal-city-framing-challenges-and-opportunities",
  "https://www.wri.org/research/powering-cities-global-south-how-energy-access-all-benefits-economy-and-environment",
  "https://www.wri.org/research/confronting-urban-housing-crisis-global-south-adequate-secure-and-affordable-housing",  // duplicate
  "https://www.wri.org/research/unaffordable-and-undrinkable-rethinking-urban-water-access-global-south",
  "https://www.wri.org/research/untreated-and-unsafe-solving-urban-sanitation-crisis-global-south",
  "https://www.wri.org/research/mobility-access-all-expanding-urban-transportation-choices-global-south",
  "https://www.wri.org/research/including-excluded-supporting-informal-workers-more-equal-and-productive-cities-global",
  "https://www.wri.org/research/upward-and-outward-growth-managing-urban-expansion-more-equitable-cities-global-south",
  "https://www.wri.org/research/ahmedabad-town-planning-schemes-equitable-development-glass-half-full-or-half-empty",  // duplicate
  "https://www.wri.org/research/porto-alegre-participatory-budgeting-and-challenge-sustaining-transformative-change",
  "https://www.wri.org/research/pune-civil-society-coalitions-policy-contradictions-and-unsteady-transformation",
  "https://www.wri.org/research/surabaya-legacy-participatory-upgrading-informal-settlements",  // duplicate
  "https://www.wri.org/research/guadalajara-revisiting-public-space-interventions-through-recreactiva",  // duplicate
  "https://www.wri.org/research/kampala-rebuilding-public-sector-legitimacy-new-approach-sanitation-services",
  "https://www.wri.org/research/johannesburg-confronting-spatial-inequality",

  // Q10: Urban finance since 2020
  "https://wri-india.org/research/rolling-out-electric-buses",
  "https://wri-india.org/research/impact-driven-investing-new-mobility-enterprises-perspectives",
  "https://www.wri.org/research/fare-look-funding-urban-public-transport-operations",
  "https://www.wri.org/research/access-climate-finance-low-middle-income-countries-14-case-studies-transport-sector",
  "https://es.wri.org/publicaciones/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico",
  "https://wri-india.org/research/assessing-financing-challenges-implementing-large-scale-electric-bus-program-india",
  "https://www.wri.org/research/changing-demand-preference-electric-vehicles-ho-chi-minh-city-costs-and-benefits",
  "https://wri.org.cn/en/research/feasibility-of-zero-emission-freight-zones-in-Beijing-Scenario-analysis-and-risk-assessment",
  "https://wri-india.org/research/financial-analysis-charging-station-fact",  // duplicate
  "https://www.wri.org/research/synergizing-land-value-capture-tod",  // duplicate

  // Q11: Urban finance excluding e-buses
  "https://urbantransitions.global/en/publication/scaling-up-investment-for-sustainable-urban-infrastructure-a-guide-to-national-and-subnational-reform/",
  "https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india",  // duplicate
  "https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities",  // duplicate
  "https://es.wri.org/publicaciones/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico",  // duplicate
  "https://urbantransitions.global/en/publication/climate-emergency-urban-opportunity/",
  "https://urbantransitions.global/en/publication/seizing-the-urban-opportunity/",
  "https://urbantransitions.global/en/publication/financing-the-urban-transition-for-sustainable-development-better-finance-for-better-cities/",
  "https://www.wri.org/rail-plus-property-development-china-pilot-case-shenzhen",  // duplicate
  "https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations",  // duplicate

  // Q12: Major flagship publications
  "https://urbantransitions.global/en/publication/scaling-up-investment-for-sustainable-urban-infrastructure-a-guide-to-national-and-subnational-reform/",  // duplicate
  "https://www.wri.org/research/towards-more-equal-city-framing-challenges-and-opportunities",  // duplicate
  "https://www.wribrasil.org.br/publicacoes/ruas-completas-no-brasil",
  "https://www.wri.org/research/our-journey-city-deciphering-wri-india-ross-centers-influence-bengaluru",  // duplicate
  "https://wri-india.org/research/safer-streets-mumbai-reflecting-decade-processes-solutions-road-safety",
  "https://www.wri.org/research/unlocking-potential-transformative-climate-adaptation-cities",
  "https://urbantransitions.global/en/publication/climate-emergency-urban-opportunity/",  // duplicate
  "https://urbantransitions.global/en/publication/seizing-the-urban-opportunity/",  // duplicate
  "https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india",  // duplicate
  "https://www.wri.org/research/synergizing-land-value-capture-tod",  // duplicate
  "https://urbantransitions.global/en/publication/financing-the-urban-transition-for-sustainable-development-better-finance-for-better-cities/",  // duplicate
  "https://es.wri.org/publicaciones/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico",  // duplicate
  "https://www.wri.org/research/urban-water-resilience-africa",
  "https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities",  // duplicate
  "https://www.wri.org/research/motorcycle-safety-and-urban-road-infrastructure",
  "https://www.wri.org/research/7-transformations-more-equitable-sustainable-cities",  // duplicate
  "https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations",  // duplicate
  "https://www.wri.org/research/exploring-wri-ross-centers-experience-mexico-city-deep-city-level-engagement-approach",
  "https://www.wri.org/research/nature-based-solutions-urban-climate-resilience",
  "https://www.wri.org/research/road-safety-paradigm-toward-vision-zero",
  "https://www.wri.org/research/10-years-urban-led-climate-action-progress-challenges-opportunities"
];

async function main() {
  console.log('🔍 Validating eval question URLs against document catalog\n');

  // Load catalog
  const catalogPath = path.join(__dirname, '../data/documents.csv');
  console.log(`📂 Loading catalog: ${catalogPath}`);
  const catalog = parseCSV(catalogPath);
  console.log(`✅ Loaded ${catalog.length} documents from catalog\n`);

  // Extract all Source URLs from catalog
  const catalogUrls = new Map<string, string>();  // slug -> original URL
  for (const doc of catalog) {
    const url = doc.metadata?.URL || doc.metadata?.url || '';
    if (url) {
      const slug = extractUrlSlug(url);
      if (slug) {
        catalogUrls.set(slug, url);
      }
    }
  }

  console.log(`📊 Catalog has ${catalogUrls.size} unique URL slugs\n`);

  // Check each docx URL
  const uniqueDocxUrls = [...new Set(DOCX_URLS)];
  console.log(`📋 Checking ${uniqueDocxUrls.length} unique URLs from docx\n`);

  const found: string[] = [];
  const missing: string[] = [];

  for (const url of uniqueDocxUrls) {
    const slug = extractUrlSlug(url);
    if (catalogUrls.has(slug)) {
      found.push(url);
      console.log(`✅ ${slug}`);
    } else {
      missing.push(url);
      console.log(`❌ MISSING: ${slug}`);
      console.log(`   URL: ${url}`);
    }
  }

  // Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 SUMMARY`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total unique URLs in docx: ${uniqueDocxUrls.length}`);
  console.log(`Found in catalog: ${found.length} (${((found.length/uniqueDocxUrls.length)*100).toFixed(1)}%)`);
  console.log(`Missing from catalog: ${missing.length} (${((missing.length/uniqueDocxUrls.length)*100).toFixed(1)}%)`);

  if (missing.length > 0) {
    console.log(`\n❌ MISSING URLS:`);
    missing.forEach((url, i) => console.log(`${i+1}. ${url}`));
  } else {
    console.log(`\n🎉 All URLs found in catalog!`);
  }
}

main().catch(console.error);
