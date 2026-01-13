# Golden Dataset Validation Report

**Date:** November 23, 2025
**Source Document:** `docs/AskWRI eval questions 103025.docx`
**Golden Dataset:** `evaluation/golden-dataset.json`
**Document Catalog:** `data/documents.csv`

---

## Executive Summary

This report validates the existing 7 test cases (Q1-Q7) and provides 5 new test cases (Q8-Q12) for the AskWRI evaluation framework.

**Key Findings:**
- **1 discrepancy** found in existing test cases (Q6)
- **1 update required** for Q7 (Jakarta housing)
- **1 URL variant** identified in Q5 (micromobility)
- **CRITICAL DATA ISSUE:** All expected URLs are MISSING from the document catalog
- **5 new test cases** extracted and formatted (Q8-Q12)

---

## 1. Discrepancies in Existing Test Cases (Q1-Q7)

### Q1: Land Value Capture ✓
- **Status:** Matches docx exactly
- **Expected URLs:** 4 papers (all match)
- **No changes needed**

### Q2: Bangalore ✓
- **Status:** Matches docx exactly
- **Expected URLs:** 6 papers (all match)
- **No changes needed**

### Q3: Children and Pollution ✓
- **Status:** Matches docx exactly
- **Expected URLs:** 3 papers (all match)
- **No changes needed**

### Q4: Climate Adaptation in Brazil ✓
- **Status:** Matches docx exactly
- **Expected URLs:** 3 papers (all match)
- **No changes needed**

### Q5: Micromobility ⚠️
- **Status:** Minor URL variant identified
- **Expected URLs:** 8 papers
- **Issue:** One paper (Gounder and Kanuri 2024) has different URL in golden dataset vs docx:
  - **Golden dataset:** `https://wri-india.org/research/enabling-shift-electric-auto-rickshaws-guidebook-electrification-auto-rickshaw-fleets`
  - **Docx:** `https://www.wri.org/update/electric-auto-rickshaws-india-guidebook`
- **Recommendation:** Both URLs refer to the same paper. Keep the current golden dataset URL for consistency, but be aware the docx uses a shorter variant.

### Q6: School Bus Health ❌
- **Status:** DISCREPANCY FOUND
- **Issue:** Golden dataset has `expected_count: 4` but only lists 3 URLs
- **Missing URL:** `https://www.wri.org/research/impactar-tool-air-quality-health-impacts-urban-bus-fleet-brazil-2022`
- **Note in golden dataset:** "Fourth doc has null URL in source data"
- **Docx shows:** 4 papers including Betti et al. 2022 (ImpactAr tool)
- **Action Required:** Add the fourth URL to Q6

### Q7: Jakarta Housing 🔄
- **Status:** UPDATE REQUIRED
- **Current state:** `expected_urls: []` (negative test case)
- **Docx indicates:** Should include 4 related documents:
  - Surabaya paper (Das and King 2019) - other Indonesia city
  - Global housing papers (King et al. 2017, Moreno-Monroy et al., Rode et al. 2017)
- **Action Required:** Update Q7 with 4 expected URLs (see Section 3)

---

## 2. URL Verification Against Document Catalog

### CRITICAL FINDING: All URLs Missing from Catalog

**Issue:** The document catalog (`data/documents.csv`) does NOT contain the web publication URLs used in the golden dataset.

**What the catalog contains:**
- PDF file URLs (e.g., `https://files.wri.org/d8/s3fs-public/...`)
- Direct PDF links from regional sites
- **Empty "Source URL" fields** for many documents

**What the golden dataset expects:**
- Web publication URLs (e.g., `https://www.wri.org/research/...`)

**Documents DO exist in catalog:**
- All expected papers were found BY TITLE in the catalog
- However, their "Source URL" metadata field is EMPTY

**Example:**
```
Title: "Synergizing Land Value Capture and Transit-Oriented Development..."
Source URL: [EMPTY]
Expected URL: https://www.wri.org/research/synergizing-land-value-capture-tod
```

### URLs Missing from Catalog (All Q1-Q12)

**Total URLs needed:** 105 URLs across 12 test cases
**URLs found in catalog:** 0 URLs (all missing due to data quality issue)

**Missing URLs by Question:**

**Q1-Q7 (existing):** 27 URLs
**Q8 (hydrogen):** 5 URLs
**Q9 (WRR):** 16 URLs
**Q10 (urban finance 2020+):** 11 URLs
**Q11 (urban finance no ebus):** 10 URLs
**Q12 (flagship):** 20 URLs

### Implications

1. **Evaluation System Impact:** The evaluation system uses slug-based URL matching, so it will fail to match ANY documents unless:
   - The catalog is updated with web publication URLs, OR
   - The evaluation system is modified to match by document title instead

2. **Data Quality Priority:** This is a HIGH PRIORITY data quality issue that affects the entire evaluation framework

3. **Recommended Actions:**
   - Run a batch update to populate "Source URL" fields in the catalog
   - Add URL validation to the document upload workflow
   - Consider using document IDs instead of URLs for evaluation matching

---

## 3. Updated JSON for Q7 (Jakarta Housing)

**Change:** From negative test case (0 expected) to related documents test (4 expected)

```json
{
  "id": "q7_jakarta_housing",
  "question": "What can be done to solve the housing crisis in Jakarta?",
  "task_description": "Retrieve papers that are about solutions to a general thematic problem area within a determined geography. Do not retrieve papers that only cover theme or geography, and only retrieve papers that talk about solutions.",
  "expected_urls": [
    "https://www.wri.org/research/surabaya-legacy-participatory-upgrading-informal-settlements",
    "https://www.wri.org/research/confronting-urban-housing-crisis-global-south-adequate-secure-and-affordable-housing",
    "https://urbantransitions.global/en/publication/housing-policies-for-sustainable-and-inclusive-cities/",
    "https://urbantransitions.global/en/publication/integrating-national-policies-to-deliver-compact-connected-cities-an-overview-of-transport-and-housing/"
  ],
  "expected_count": 4,
  "difficulty": "hard",
  "query_type": "solution_focused",
  "note": "No Jakarta-specific papers, but includes related docs: Surabaya (other Indonesia city) and global housing papers (King et al. 2017, Moreno-Monroy et al., Rode et al. 2017)"
}
```

---

## 4. New Test Cases (Q8-Q12)

### Q8: Hydrogen Papers (Niche Technology)

```json
{
  "id": "q8_hydrogen",
  "question": "Have we published any papers or reports on hydrogen?",
  "task_description": "Retrieve papers about a niche topic. Do not retrieve papers that talk about broader energy/mobility topics and just tangentially mention the technology.",
  "expected_urls": [
    "https://wri-india.org/research/supporting-energy-transition-addressing-technology-gaps-electrolyzers",
    "https://wri-india.org/research/accelerating-production-and-use-green-hydrogen",
    "https://wri-india.org/research/pathways-decarbonize-indias-transport-sector-scenario-analysis-using-energy-policy",
    "https://www.wri.org/research/completing-trip-establishing-global-quantified-climate-goal-transport-sector",
    "https://wri.org.cn/en/report/Pathways-to-Decarbonize-the-Road-Transport-Sector-in-Guangdong"
  ],
  "expected_count": 5,
  "difficulty": "medium",
  "query_type": "niche_technology",
  "note": "2 papers directly on hydrogen, 3 include it as part of wider energy analysis"
}
```

**Papers:**
- **Direct focus (2):** Nallapaneni et al. 2023, Munjal et al. 2023
- **Includes hydrogen (3):** Ma and Chakrabarty 2024, 苗领 et al. 2023, Zhang and Welle 2025

### Q9: World Resources Report Papers (Umbrella Program)

```json
{
  "id": "q9_world_resources_report",
  "question": "Give me all the papers that were published as part of the cities World Resources Report?",
  "task_description": "Retrieve all papers that were published within a specific, well-defined research program, our WRI Ross Center's flagship research initiative that ran roughly 2015-2021. Do not retrieve papers that cite the WRR or have similar topics but were not part of the official corpus.",
  "expected_urls": [
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
    "https://www.wri.org/research/surabaya-legacy-participatory-upgrading-informal-settlements",
    "https://www.wri.org/research/pune-civil-society-coalitions-policy-contradictions-and-unsteady-transformation",
    "https://www.wri.org/research/kampala-rebuilding-public-sector-legitimacy-new-approach-sanitation-services",
    "https://www.wri.org/research/johannesburg-confronting-spatial-inequality",
    "https://www.wri.org/research/guadalajara-revisiting-public-space-interventions-through-recreactiva"
  ],
  "expected_count": 16,
  "difficulty": "hard",
  "query_type": "umbrella_program",
  "note": "16 papers total: 7 thematic, 7 city case studies, 1 framing paper, 1 synthesis report"
}
```

**Breakdown:**
- **Framing & synthesis (2):** Mahendra et al. 2021, Beard, Mahendra, and Westphal 2016
- **Thematic papers (7):** Westphal et al. 2017, King et al. 2017, Mitlin et al. 2019, Satterthwaite et al. 2019, Venter, Mahendra, and Hidalgo 2019, Chen and Beard 2018, Mahendra and Seto 2019
- **City case studies (7):** Mahadevia, Pai, and Mahendra 2018, Abers et al. 2018, Kamath et al. 2018, Das and King 2019, Sarmiento, Alveano, and King 2019, Pieterse and Owens 2018, Lwasa and Owens 2018

### Q10: Urban Finance Since 2020 (Amorphous + Date Filter)

```json
{
  "id": "q10_urban_finance_since_2020",
  "question": "Have we published anything to do with urban finance since 2020?",
  "task_description": "Retrieve all papers that were published after a specific date on an amorphous intersection. 'Urban finance' is a concatenation of two amorphous terms and not a thing as such, so expecting to return all things in our corpus to do with finance, which is mostly electric buses and transportation.",
  "expected_urls": [
    "https://wri-india.org/research/rolling-out-electric-buses",
    "https://www.wri.org/research/impact-driven-investing-new-mobility-enterprises-perspectives",
    "https://www.wri.org/research/synergizing-land-value-capture-tod",
    "https://www.wri.org/research/fare-look-funding-urban-public-transport-operations",
    "https://www.wri.org/research/access-climate-finance-low-middle-income-countries-14-case-studies-transport-sector",
    "https://es.wri.org/publicaciones/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico",
    "https://wri-india.org/research/assessing-financing-challenges-implementing-large-scale-electric-bus-program-india",
    "https://www.wri.org/research/changing-demand-preference-electric-vehicles-ho-chi-minh-city-costs-and-benefits",
    "https://wri-india.org/research/financial-analysis-charging-station-fact",
    "https://wri.org.cn/en/research/feasibility-of-zero-emission-freight-zones-in-Beijing-Scenario-analysis-and-risk-assessment",
    "https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india"
  ],
  "expected_count": 11,
  "difficulty": "hard",
  "query_type": "amorphous_temporal",
  "note": "Amorphous topic with date filter - mostly e-bus and transportation finance"
}
```

**Challenge:** Tests ability to filter by date AND understand amorphous topic boundaries

### Q11: Urban Finance Excluding E-Buses (Amorphous + Exclusion)

```json
{
  "id": "q11_urban_finance_no_ebus",
  "question": "Have we published anything to do with urban finance – please exclude anything to do with electric buses?",
  "task_description": "Variation on the previous question, asking to remove the dominant thematic intersection and removing the temporal cut off. Should return urban finance papers excluding the e-bus subcategory.",
  "expected_urls": [
    "https://urbantransitions.global/en/publication/scaling-up-investment-for-sustainable-urban-infrastructure-a-guide-to-national-and-subnational-reform/",
    "https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india",
    "https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities",
    "https://es.wri.org/publicaciones/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico",
    "https://urbantransitions.global/en/publication/climate-emergency-urban-opportunity/",
    "https://urbantransitions.global/en/publication/seizing-the-urban-opportunity/",
    "https://www.wri.org/research/synergizing-land-value-capture-tod",
    "https://urbantransitions.global/en/publication/financing-the-urban-transition-for-sustainable-development-better-finance-for-better-cities/",
    "https://www.wri.org/rail-plus-property-development-china-pilot-case-shenzhen",
    "https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations"
  ],
  "expected_count": 10,
  "difficulty": "hard",
  "query_type": "amorphous_exclusion",
  "note": "Amorphous topic with explicit exclusion of dominant subcategory"
}
```

**Challenge:** Tests ability to understand exclusion criteria and remove dominant subcategory

### Q12: Major Flagship Publications (Significance-Based)

```json
{
  "id": "q12_flagship_publications",
  "question": "What are our major flagship research publications in the last decade?",
  "task_description": "Retrieve publications based on their significance for our program, with a loose cut off point. This is a judgement call, and different folks may have different opinions... which makes it interesting to see how the AI would decide this.",
  "expected_urls": [
    "https://urbantransitions.global/en/publication/scaling-up-investment-for-sustainable-urban-infrastructure-a-guide-to-national-and-subnational-reform/",
    "https://www.wri.org/research/towards-more-equal-city-framing-challenges-and-opportunities",
    "https://www.wribrasil.org.br/publicacoes/ruas-completas-no-brasil",
    "https://www.wri.org/research/our-journey-city-deciphering-wri-india-ross-centers-influence-bengaluru",
    "https://wri-india.org/research/safer-streets-mumbai-reflecting-decade-processes-solutions-road-safety",
    "https://www.wri.org/research/unlocking-potential-transformative-climate-adaptation-cities",
    "https://urbantransitions.global/en/publication/climate-emergency-urban-opportunity/",
    "https://urbantransitions.global/en/publication/seizing-the-urban-opportunity/",
    "https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india",
    "https://www.wri.org/research/synergizing-land-value-capture-tod",
    "https://urbantransitions.global/en/publication/financing-the-urban-transition-for-sustainable-development-better-finance-for-better-cities/",
    "https://es.wri.org/publicaciones/analisis-de-los-mecanismos-financieros-para-la-sostenibilidad-del-transporte-publico",
    "https://www.wri.org/research/urban-water-resilience-africa",
    "https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities",
    "https://www.wri.org/research/motorcycle-safety-and-urban-road-infrastructure",
    "https://www.wri.org/research/7-transformations-more-equitable-sustainable-cities",
    "https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations",
    "https://www.wri.org/publication/cities-safer-design",
    "https://www.wri.org/research/low-speed-zone-guide",
    "https://www.wri.org/research/nature-based-solutions-sub-saharan-africa-climate-and-water-resilience"
  ],
  "expected_count": 20,
  "difficulty": "hard",
  "query_type": "significance_based",
  "note": "Subjective query - requires understanding of publication significance and program priorities"
}
```

**Challenge:** Most subjective query type - tests AI's ability to understand program significance and priorities

---

## 5. Summary Statistics

### Before Update
- **Total test cases:** 7
- **Total expected documents:** 27
- **Query types:** 7

### After Update
- **Total test cases:** 12
- **Total expected documents:** 105
- **Query types:** 12

### New Query Types Added
1. `niche_technology` (Q8)
2. `umbrella_program` (Q9)
3. `amorphous_temporal` (Q10)
4. `amorphous_exclusion` (Q11)
5. `significance_based` (Q12)

### Difficulty Distribution
- **Easy:** 0
- **Medium:** 3 (Q1, Q2, Q8)
- **Hard:** 9 (Q3, Q4, Q5, Q6, Q7, Q9, Q10, Q11, Q12)

---

## 6. Action Items

### Immediate (High Priority)

1. **Fix Q6:** Add fourth URL to expected_urls array
2. **Update Q7:** Replace empty array with 4 related document URLs
3. **Add Q8-Q12:** Insert 5 new test cases into golden dataset

### Data Quality (High Priority)

4. **Populate Source URLs:** Run batch update to add web publication URLs to all 166 documents in catalog
5. **URL Validation:** Add validation to document upload workflow to ensure Source URL is populated
6. **Evaluation System:** Verify slug-based URL matching works with populated URLs

### Documentation (Medium Priority)

7. **Update metadata.total_test_cases:** Change from 7 to 12
8. **Update metadata.total_expected_documents:** Change from 27 to 105
9. **Update metadata.query_types:** Add 5 new query types

### Future Considerations (Low Priority)

10. **Consider title-based matching:** If URL matching remains problematic
11. **Add document IDs:** Consider using internal IDs instead of URLs for evaluation
12. **Expand corpus:** Add more test cases for additional query patterns

---

## 7. Files to Update

1. **`evaluation/golden-dataset.json`**
   - Fix Q6 (add fourth URL)
   - Update Q7 (add 4 URLs)
   - Add Q8-Q12 (5 new test cases)
   - Update metadata section

2. **`data/documents.csv`**
   - Populate "Source URL" field for all documents
   - Priority: Documents referenced in Q1-Q12

3. **Documentation**
   - Update any evaluation documentation to reflect new query types
   - Document the URL matching strategy

---

## Appendix: URL Mapping Template

For data quality team to populate Source URLs:

```csv
Document Title,Current Source URL,Expected Source URL
"Synergizing Land Value Capture...",""," https://www.wri.org/research/synergizing-land-value-capture-tod"
"Ahmedabad: Town Planning Schemes...","","https://www.wri.org/research/ahmedabad-town-planning-schemes-equitable-development-glass-half-full-or-half-empty"
[... continue for all 105 documents ...]
```

Use the URLs provided in this report as the source of truth for populating the catalog.
