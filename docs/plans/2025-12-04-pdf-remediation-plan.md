# PDF Link Remediation Plan

**Date**: 2025-12-04
**Status**: Ready for implementation

## Problem Summary

13 documents have broken PDF links in the UI, and 37 duplicate entries cause repeated results in search.

| Issue | Count |
|-------|-------|
| External URL 403 Forbidden (wri-india.org) | 7 |
| External URL Timeout (wri.org.cn) | 1 |
| URL-encoded filenames causing 404 | 4 |
| Missing local file | 1 |
| Duplicate entries (same PDF indexed twice) | 37 groups (77 rows) |

## Solution

Use local PDFs exclusively (remove external Source URLs), fix filename issues, and deduplicate.

---

## Phase 1: Backup

Create timestamped backup before any changes.

```bash
BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp data/documents.csv "$BACKUP_DIR/"
cp -r data/documents/ "$BACKUP_DIR/documents/"
echo "Backup created: $BACKUP_DIR"
```

**Validation**: Confirm backup has 204 PDFs and 1 CSV file.

---

## Phase 2: Fix URL-Encoded Filenames

4 files have literal `%20` in their names. Rename to use underscores.

| Old filename | New filename |
|--------------|--------------|
| `e-Bus_Guidebook_22nd%20March.pdf` | `e-Bus_Guidebook_22nd_March.pdf` |
| `Open%20E-bus%20blueprint_working%20paper_web.pdf` | `Open_E-bus_blueprint_working_paper_web.pdf` |
| `Real-world%20Electric%20Bus%20Operation_Working%20Paper%20final%20_revised.pdf` | `Real-world_Electric_Bus_Operation_Working_Paper_final_revised.pdf` |
| `WP_Ebus%20Financing%2010th%20Sep%20V2%201.pdf` | `WP_Ebus_Financing_10th_Sep_V2_1.pdf` |

**Actions**:
1. Rename files on disk
2. Update `file_path` column in CSV for these 4 rows

**Validation**: `curl` test each renamed file via `/api/pdf/` endpoint.

---

## Phase 3: Remove Source URLs

41 entries have external `Source URL` in metadata. Remove these so the app uses local PDFs.

**Actions**:
1. For each row with `Source URL` in metadata JSON:
   - Parse the metadata JSON
   - Remove the `Source URL` field
   - Write back the updated JSON

**Why all 41?** Even working external URLs add latency and external dependency. Local PDFs are faster and always available.

**Validation**: Spot-check that documents previously using external URLs now serve from `/api/pdf/`.

---

## Phase 4: Deduplicate

37 duplicate groups where same PDF exists under two names (e.g., `doc_000098.pdf` and `electric-school-bus-us-market-study.pdf`).

**Strategy**: Keep named files, delete `doc_XXXXXX` entries. Merge any better metadata first.

**Actions**:
1. For each duplicate group:
   - Identify "keep" entry (named file) and "delete" entry (`doc_XXXXXX`)
   - Compare metadata: authors, year, summary, sub-tag
   - If `doc_XXXXXX` has more complete data, merge into keep entry
   - Delete the duplicate CSV row
2. Delete orphan PDF files from disk

**Duplicate groups** (35 pairs + 2 triples = 40 rows to delete):

| Keep (named file) | Delete |
|-------------------|--------|
| `access-climate-finance-low-middle-income-countries.pdf` | `doc_000110.pdf` |
| `barriers-to-adopting-electric-buses-executive-summary.pdf` | `doc_000047.pdf` |
| `changing-demand-electric-vehicles-ho-chi-minh-city.pdf` | `doc_000010.pdf` |
| `completing-the-trip.pdf` | `doc_000101.pdf` |
| `costs-emissions-appraisal-tool-transit-buses.pdf` | `doc_000057.pdf` |
| `dataset-esb-adoption-tech-note-july-2025.pdf` | `doc_000015.pdf` |
| `dataset-us-school-bus-depots-technical-note.pdf` | `doc_000131.pdf` |
| `decarbonizing-china-road-transport-sector.pdf` | `doc_000030.pdf` |
| `developing-electric-mobility-roadmap-subnational-case-studies-vietnamese-cities.pdf` | `doc_000019.pdf` |
| `developing-electric-mobility-roadmap-vietnam.pdf` | `doc_000011.pdf` |
| `E-auto-guidebook_WRI-India.pdf` | `doc_000082.pdf` |
| `e-Bus_Guidebook_22nd_March.pdf` (renamed) | `doc_000014.pdf` |
| `electric-school-bus-us-market-study.pdf` | `doc_000098.pdf` |
| `electrifying-ride-hailing-vehicles-unites-states-europe-canada.pdf` | `doc_000012.pdf` |
| `electrifying-us-school-bus-fleets-equitably.pdf` | `doc_000122.pdf` |
| `financial-analysis-charging-station-wri-india.pdf` | `doc_000003.pdf` |
| `financing-electric-hybrid-electric-buses_0.pdf` | `doc_000053.pdf` |
| `Future-Mobility-Calculator_An-electric-mobility-infrastructure-assessment-tool-technical-note.pdf` | `doc_000076.pdf` |
| `how-to-enable-electric-bus-adoption-cities-worldwide-executive-summary.pdf` | `doc_000046.pdf` |
| `improving-school-infrastructure-healthier-communities.pdf` | `doc_000104.pdf` |
| `needs-assessment-equitable-school-bus-electrification-united-states-school-districts-2023.pdf` | `doc_000115.pdf` |
| `Open_E-bus_blueprint_working_paper_web.pdf` (renamed) | `doc_000107.pdf` |
| `pole-mounted-electric-vehicle-charging-preliminary-guidance.pdf` | `doc_000020.pdf` |
| `quantifying-grid-impacts-large-adoption-electric-vehicles-china.pdf` | `doc_000095.pdf` |
| `Real-world_Electric_Bus_Operation_Working_Paper_final_revised.pdf` (renamed) | `doc_000124.pdf` |
| `Seizing_the_Urban_Opportunity_WEB-1.pdf` | `doc_000078.pdf` |
| `sustainable-urban-mobility-ndcs-essential-role-public-transport_0.pdf` | `doc_000009.pdf` |
| `technical-note-dataset-us-school-bus-fleets-2.pdf` | `doc_000007.pdf` |
| `technical-note-ev-grid.pdf` | `doc_000031.pdf` |
| `understanding-impact-bus-aggregators-urban-mobility-indias-national-capital-region.pdf` | `doc_000048.pdf` |
| `visioning-to-implementation-executive-summary.pdf` | `doc_000126.pdf` |
| `WP_Ebus_Financing_10th_Sep_V2_1.pdf` (renamed) | `doc_000114.pdf` |
| `zero-emission-delivery-zones.pdf` | `doc_000008.pdf` |
| `zet-promotion-in-china-en.pdf` | `doc_000035.pdf` |

**Triples** (keep first, delete others):
| Keep | Delete |
|------|--------|
| `doc_000087.pdf` | `doc_000152.pdf` |
| `doc_000143.pdf` | `doc_000144.pdf`, `doc_000156.pdf` |

**Also delete orphan PDFs on disk** (not in CSV):
- `action-plans-policy-recommendations-vehicle-grid-integration-china.pdf`
- `sustainable-urban-mobility-ndcs-essential-role-public-transport.pdf`

**Validation**: CSV row count drops from 203 → 162. PDF count drops from 204 → 162.

---

## Phase 5: Fix Missing File

`doc_21.pdf` is referenced in CSV but doesn't exist on disk. External URL times out (wri.org.cn).

**Action**: Delete the CSV row for `doc_21.pdf`.

**Validation**: No CSV entries point to non-existent files.

---

## Phase 6: Validate

Run comprehensive test of all PDF links.

```bash
# Test every CSV file_path via API
for f in $(csvtool col 1 data/documents.csv | tail -n +2); do
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/pdf/$f")
  if [ "$status" != "200" ]; then
    echo "FAIL: $f (HTTP $status)"
  fi
done
```

**Expected results**:
- 161 unique documents (162 - 1 missing file deleted)
- 161 PDF files on disk
- 0 API failures

---

## Phase 7: Clean Reindex

Clear all hybrid service caches and rebuild from scratch.

```bash
# Stop hybrid service if running
pkill -f "python.*main.py" || true

# Clear all caches
rm -rf hybrid-service/cache/*

# Restart hybrid service (will rebuild indexes)
cd hybrid-service && python main.py &

# Wait for startup (watch logs for "Application startup complete")
```

**Cost**: ~$1-2 for OpenAI embeddings (one-time)
**Time**: ~5-10 minutes for full reindex

**Validation**:
1. Health check: `curl http://localhost:8002/health`
2. Test Cite mode query - verify no duplicate documents in results
3. Test PDF links from search results

---

## Implementation Scripts

Create a single remediation script: `scripts/remediate-pdfs.ts`

The script should:
1. Run in dry-run mode by default (preview changes)
2. Accept `--execute` flag to apply changes
3. Log all actions for audit trail
4. Include rollback instructions

---

## Rollback Plan

If issues occur, restore from backup:

```bash
# Find most recent backup
BACKUP=$(ls -td backups/*/ | head -1)

# Restore CSV
cp "$BACKUP/documents.csv" data/documents.csv

# Restore PDFs
rm -rf data/documents/
cp -r "$BACKUP/documents/" data/documents/

# Clear cache and reindex
rm -rf hybrid-service/cache/*
```

---

## Success Criteria

- [ ] All 161 PDFs accessible via `/api/pdf/` (100% HTTP 200)
- [ ] No duplicate documents in Cite mode results
- [ ] No external URL dependencies for PDF viewing
- [ ] CSV has 161 rows (down from 203)
- [ ] Hybrid service indexes 161 unique documents
