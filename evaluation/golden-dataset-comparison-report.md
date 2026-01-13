# Golden Dataset vs Index Comparison Report

**Generated**: 2025-11-17
**Purpose**: Verify all expected documents in golden dataset are present in the current retrieval index

---

## Executive Summary

- **Total Test Cases**: 7
- **Total Expected Documents**: 27 (23 unique URLs)
- **Documents in Index**: 203
- **Match Rate**: 26/27 (96.3%)
- **Missing**: 1 document (URL mismatch)

### Status: ⚠️ ONE URL MISMATCH DETECTED

The document exists in the index but under a different URL than expected by the golden dataset.

---

## Detailed Test Case Analysis

### ✅ Test Case 1: Land Value Capture (topic_area)
**Question**: What have we published on land value capture?
**Difficulty**: Medium
**Expected**: 4 documents
**Status**: ✅ ALL FOUND (4/4)

| Status | Document Title | Expected URL |
|--------|---------------|--------------|
| ✅ | Synergizing Land Value Capture and Transit-Oriented Development: A Study of Bengaluru Metro | https://www.wri.org/research/synergizing-land-value-capture-tod |
| ✅ | Ahmedabad: Town Planning Schemes for Equitable Development—Glass Half Full or Half Empty? | https://www.wri.org/research/ahmedabad-town-planning-schemes-equitable-development-glass-half-full-or-half-empty |
| ✅ | Urban Land Value Capture in São Paulo, Addis Ababa, and Hyderabad: Differing Interpretations, Equity Impacts, and Enabling Conditions | https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations |
| ✅ | Rail Plus Property Development in China: the Pilot Case of Shenzhen | https://www.wri.org/rail-plus-property-development-china-pilot-case-shenzhen |

---

### ✅ Test Case 2: Bangalore Geography (geography)
**Question**: What have we published on Bangalore?
**Difficulty**: Medium
**Expected**: 6 documents
**Status**: ✅ ALL FOUND (6/6)

| Status | Document Title | Expected URL |
|--------|---------------|--------------|
| ✅ | Our Journey with the City: Deciphering WRI India Ross Center's Influence in Bengaluru | https://www.wri.org/research/our-journey-city-deciphering-wri-india-ross-centers-influence-bengaluru |
| ✅ | Accelerating Innovation in Urban Service Delivery in Indian Cities: Lessons from TheCityFix Labs India | https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india |
| ✅ | Synergizing Land Value Capture and Transit-Oriented Development: A Study of Bengaluru Metro | https://www.wri.org/research/synergizing-land-value-capture-tod |
| ✅ | Urban Blue-Green Conundrum: A 10-City Study on the Impacts of Urbanization on Natural Infrastructure in India | https://www.wri.org/research/urban-blue-green-conundrum-10-city-study-impacts-urbanization-natural-infrastructure-india |
| ✅ | Improving Metro Access in India | https://wri-india.org/research/improving-metro-access-india |
| ✅ | Climate Resilient Cities: Assessing Differential Vulnerability to Climate Hazards in Urban India | https://wri-india.org/publication/climate-resilient-cities-assessing-differential-vulnerability-climate-hazards-urban |

---

### ✅ Test Case 3: Children and Pollution (thematic_intersection)
**Question**: What have we published on children and pollution?
**Difficulty**: Hard
**Expected**: 3 documents
**Status**: ✅ ALL FOUND (3/3)

| Status | Document Title | Expected URL |
|--------|---------------|--------------|
| ✅ | Driving Forward on a Clean Ride for Kids | https://www.wri.org/research/driving-forward-clean-ride-kids |
| ✅ | Technical Note for a Dataset Modeling the Societal Health and Climate Benefits Associated With Transitioning the US School Bus Fleet From Diesel to Electric | https://www.wri.org/research/technical-note-dataset-modeling-societal-health-and-climate-benefits-electric-school-buses |
| ✅ | Improving School Infrastructure for Healthier Students and Communities | https://www.wri.org/research/improving-school-infrastructure-healthier-students-and-communities |

---

### ✅ Test Case 4: Climate Adaptation in Brazil (thematic_geographic_intersection)
**Question**: What have we published on climate adaptation in Brazil?
**Difficulty**: Hard
**Expected**: 3 documents
**Status**: ✅ ALL FOUND (3/3)

| Status | Document Title | Expected URL |
|--------|---------------|--------------|
| ✅ | Accelerating Nature-Based Solutions in Brazilian Cities | https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities |
| ✅ | Accessibility to public green areas: case study in Belo Horizonte, Brazil | https://www.wribrasil.org.br/publicacoes/accessibility-public-green-areas-case-study-belo-horizonte-brazil |
| ✅ | Prepared Communities | https://www.wri.org/research/prepared-communities |

---

### ⚠️ Test Case 5: Micromobility Solutions (fuzzy_topic)
**Question**: How can cities implement micromobility solutions?
**Difficulty**: Hard
**Expected**: 8 documents
**Status**: ⚠️ 7 FOUND, 1 MISMATCH (7/8)

| Status | Document Title | Expected URL | Notes |
|--------|---------------|--------------|-------|
| ✅ | Mexico Frontrunners - Sustainable mobility for sustainable cities: Lessons from cycling schemes in Mexico City and Guadalajara, Mexico | https://urbantransitions.global/en/publication/mexico-frontrunners/ | |
| ❌ | **URL MISMATCH** | https://www.wri.org/update/electric-auto-rickshaws-india-guidebook | **See Issue #1 below** |
| ✅ | How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities | https://www.wri.org/research/how-dockless-bike-sharing-changes-lives-analysis-chinese-cities | |
| ✅ | Public Bicycle Sharing in India: Lessons Learned from Implementation in Three Cities | https://www.wri.org/research/public-bicycle-sharing-india-lessons-learned-implementation-three-cities | |
| ✅ | Assessing the Environmental Impact of Shared Micromobility Services: A Guide for Cities | https://www.numo.global/resources/micromobility-emissions-life-cycle-assessment-guide | |
| ✅ | The Evolution of Bike Sharing: 10 Questions on the Emergence of New Technologies, Opportunities, and Risks | https://www.wri.org/research/evolution-bike-sharing | |
| ✅ | Assessing the Viability of Using Autorickshaws for Urban Freight Delivery in India | https://wri-india.org/research/assessing-viability-using-autorickshaws-urban-freight-delivery-india | |
| ✅ | Guadalajara: Revisiting Public Space Interventions through the Via RecreActiva | https://www.wri.org/research/guadalajara-revisiting-public-space-interventions-through-recreactiva | |

---

### ✅ Test Case 6: School Bus Electrification Health Outcomes (intervention_impact)
**Question**: Will electrifying school buses be beneficial for children's health outcomes?
**Difficulty**: Medium
**Expected**: 4 documents (note in dataset says "Fourth doc has null URL in source data")
**Actual URLs in Dataset**: 3
**Status**: ✅ ALL FOUND (3/3)

| Status | Document Title | Expected URL |
|--------|---------------|--------------|
| ✅ | Driving Forward on a Clean Ride for Kids | https://www.wri.org/research/driving-forward-clean-ride-kids |
| ✅ | Technical Note for a Dataset Modeling the Societal Health and Climate Benefits Associated With Transitioning the US School Bus Fleet From Diesel to Electric | https://www.wri.org/research/technical-note-dataset-modeling-societal-health-and-climate-benefits-electric-school-buses |
| ✅ | Improving School Infrastructure for Healthier Students and Communities | https://www.wri.org/research/improving-school-infrastructure-healthier-students-and-communities |

**Note**: The golden dataset indicates `expected_count: 4` but only provides 3 URLs. The note states "Fourth doc has null URL in source data" - this appears to be a known limitation in the golden dataset itself.

---

### ✅ Test Case 7: Jakarta Housing Crisis (solution_focused)
**Question**: What can be done to solve the housing crisis in Jakarta?
**Difficulty**: Hard
**Expected**: 0 documents
**Status**: ✅ CORRECT (0/0)

**Note**: This is a **negative test case** - it should return NO documents. The golden dataset correctly expects an empty result set.

---

## Issues Identified

### Issue #1: Electric Auto-Rickshaw Guidebook URL Mismatch

**Test Case**: q5_micromobility
**Severity**: ⚠️ Medium (document exists, URL differs)

**Expected URL** (in golden-dataset.json):
```
https://www.wri.org/update/electric-auto-rickshaws-india-guidebook
```

**Actual URL** (in documents.csv, line 83):
```
https://wri-india.org/research/enabling-shift-electric-auto-rickshaws-guidebook-electrification-auto-rickshaw-fleets
```

**Document Details**:
- **File**: doc_000082.pdf
- **Title**: "Enabling the Shift to Electric Auto-Rickshaws: A Guidebook for Electrification of Auto-rickshaw Fleets in Indian Cities"
- **Authors**: Gounder, Kanika; Kanuri, Chaitanya
- **Year**: 2024
- **Summary**: "This project update highlights the release of a comprehensive guidebook aimed at facilitating the transition to electric auto-rickshaws (e-autos) in Indian Cities..."

**Analysis**:
This appears to be the same document published on different WRI domains:
- Expected: `wri.org/update/...` (main WRI site, update/blog post format)
- Actual: `wri-india.org/research/...` (regional site, research publication format)

**Impact on Evaluations**:
When the evaluation harness runs test case `q5_micromobility`, it will:
- Query the system for micromobility documents
- Retrieve results including this auto-rickshaw guidebook
- Attempt to match retrieved URLs against the golden dataset
- **FAIL to match this document** due to URL mismatch
- Report as a **false negative** (missed expected document)
- Artificially **lower recall score** for this test case

**Expected Behavior**:
- Precision: Unaffected
- Recall for q5: Will drop from 100% to 87.5% (7/8 instead of 8/8)
- Overall recall: Will be slightly lower than actual system performance

---

## URL Patterns Observed

Analysis of URLs in golden dataset shows three domain patterns:

1. **Main WRI Research** (14 documents):
   - Pattern: `https://www.wri.org/research/*`
   - Example: `https://www.wri.org/research/driving-forward-clean-ride-kids`

2. **Regional WRI Sites** (6 documents):
   - Pattern: `https://wri-india.org/*` or `https://www.wribrasil.org.br/*`
   - Example: `https://wri-india.org/research/improving-metro-access-india`

3. **Partner Organizations** (3 documents):
   - Patterns: `urbantransitions.global`, `numo.global`, `shiftcities.org`
   - Example: `https://urbantransitions.global/en/publication/mexico-frontrunners/`

The mismatch occurs between pattern #1 (expected) and pattern #2 (actual) for the same document.

---

## Document Coverage Statistics

### By Test Case Type

| Query Type | Test Cases | Expected Docs | Found | Missing | Success Rate |
|------------|-----------|---------------|-------|---------|--------------|
| topic_area | 1 | 4 | 4 | 0 | 100% |
| geography | 1 | 6 | 6 | 0 | 100% |
| thematic_intersection | 1 | 3 | 3 | 0 | 100% |
| thematic_geographic_intersection | 1 | 3 | 3 | 0 | 100% |
| fuzzy_topic | 1 | 8 | 7 | 1 | 87.5% |
| intervention_impact | 1 | 3 | 3 | 0 | 100% |
| solution_focused | 1 | 0 | 0 | 0 | 100% |
| **TOTAL** | **7** | **27** | **26** | **1** | **96.3%** |

### By Difficulty Level

| Difficulty | Test Cases | Expected Docs | Found | Missing | Success Rate |
|------------|-----------|---------------|-------|---------|--------------|
| Medium | 3 | 13 | 13 | 0 | 100% |
| Hard | 4 | 14 | 13 | 1 | 92.9% |
| **TOTAL** | **7** | **27** | **26** | **1** | **96.3%** |

---

## Recommendations for Running Evaluations

### Option 1: Run Evaluations As-Is (Recommended for Baseline)
**Pros**:
- Get immediate baseline metrics
- Understand actual system performance
- Identify if URL matching is a systematic issue

**Cons**:
- q5_micromobility test will show artificially low recall (87.5% instead of 100%)
- Overall metrics slightly deflated

**Action**: Run `npm run eval:full` and note that q5 has a known URL mismatch

### Option 2: Temporarily Skip q5_micromobility
**Pros**:
- Get clean metrics for other 6 test cases
- Avoid confusion from known mismatch

**Cons**:
- Miss valuable test case (fuzzy_topic is important category)
- Don't measure system performance on micromobility queries

### Option 3: Address Before Running
**Requires**:
- Either update golden dataset URL to match index
- Or implement fuzzy URL matching in evaluation harness
- Or add the expected URL as an alternate URL in the document metadata

**Benefit**: Get fully accurate evaluation results

---

## Index Health Check

**Total documents in CSV**: 203
**Documents with URLs**: 178 (87.7%)
**Documents without URLs**: 25 (12.3%)

**URL Distribution**:
- wri.org domains: ~140 documents
- wri-india.org: ~20 documents
- wribrasil.org.br: ~5 documents
- Other partners: ~13 documents

**Assessment**: The index is healthy and contains all expected documents. The single URL mismatch is a formatting/domain difference, not a missing document.

---

## Next Steps

1. **Decision Point**: Choose evaluation approach (Option 1, 2, or 3 above)

2. **Run Initial Evaluation**: Execute `npm run eval:full` to establish baseline

3. **Review Results**: Examine HTML report, particularly:
   - Overall precision/recall/F1 scores
   - Per-test-case performance
   - False positives (unexpected retrievals)
   - False negatives (missed expected docs)

4. **URL Normalization**: If URL mismatches become a pattern, consider:
   - Implementing fuzzy URL matching (compare domain-normalized URLs)
   - Maintaining URL aliases in document metadata
   - Updating golden dataset to reflect actual URLs

5. **Golden Dataset Evolution**: After initial eval, consider:
   - Adding more test cases for underrepresented query types
   - Expanding difficulty = "hard" coverage
   - Testing edge cases (spelling variations, abbreviations, etc.)

---

## Appendix: All 23 Unique Expected Documents

1. ✅ https://www.wri.org/research/synergizing-land-value-capture-tod
2. ✅ https://www.wri.org/research/ahmedabad-town-planning-schemes-equitable-development-glass-half-full-or-half-empty
3. ✅ https://www.wri.org/research/urban-land-value-capture-sao-paulo-addis-ababa-and-hyderabad-differing-interpretations
4. ✅ https://www.wri.org/rail-plus-property-development-china-pilot-case-shenzhen
5. ✅ https://www.wri.org/research/our-journey-city-deciphering-wri-india-ross-centers-influence-bengaluru
6. ✅ https://www.wri.org/research/accelerating-innovation-urban-service-delivery-indian-cities-lessons-thecityfix-labs-india
7. ✅ https://www.wri.org/research/urban-blue-green-conundrum-10-city-study-impacts-urbanization-natural-infrastructure-india
8. ✅ https://wri-india.org/research/improving-metro-access-india
9. ✅ https://wri-india.org/publication/climate-resilient-cities-assessing-differential-vulnerability-climate-hazards-urban
10. ✅ https://www.wri.org/research/driving-forward-clean-ride-kids
11. ✅ https://www.wri.org/research/technical-note-dataset-modeling-societal-health-and-climate-benefits-electric-school-buses
12. ✅ https://www.wri.org/research/improving-school-infrastructure-healthier-students-and-communities
13. ✅ https://www.shiftcities.org/publication/accelerating-nature-based-solutions-brazilian-cities
14. ✅ https://www.wribrasil.org.br/publicacoes/accessibility-public-green-areas-case-study-belo-horizonte-brazil
15. ✅ https://www.wri.org/research/prepared-communities
16. ✅ https://urbantransitions.global/en/publication/mexico-frontrunners/
17. ❌ https://www.wri.org/update/electric-auto-rickshaws-india-guidebook (URL MISMATCH)
18. ✅ https://www.wri.org/research/how-dockless-bike-sharing-changes-lives-analysis-chinese-cities
19. ✅ https://www.wri.org/research/public-bicycle-sharing-india-lessons-learned-implementation-three-cities
20. ✅ https://www.numo.global/resources/micromobility-emissions-life-cycle-assessment-guide
21. ✅ https://www.wri.org/research/evolution-bike-sharing
22. ✅ https://wri-india.org/research/assessing-viability-using-autorickshaws-urban-freight-delivery-india
23. ✅ https://www.wri.org/research/guadalajara-revisiting-public-space-interventions-through-recreactiva

---

**Report End**
