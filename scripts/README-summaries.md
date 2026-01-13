# Document Summary Generation

This directory contains scripts for generating and managing document summaries for the AskWRI application.

## Overview

Instead of generating summaries on-the-fly for each user request (expensive and slow), we pre-generate high-quality summaries once and store them in the CSV catalog alongside other metadata.

## How to Generate Summaries

### Prerequisites

1. Ensure you have a `.env.local` file with:
   ```bash
   OPENAI_API_KEY=your-key-here
   OPENAI_MODEL_SUMMARY=gpt-5-mini  # or gpt-4o-mini
   ```

2. Install dependencies:
   ```bash
   npm install csv-parse csv-stringify
   ```

### Running the Script

1. Generate summaries and add them to a new CSV:
   ```bash
   npx tsx scripts/add-summaries-to-csv.ts
   ```

2. The script will:
   - Read the existing CSV from `public/TransportDecarb_llamacloud_metadata250904.csv`
   - Generate a 2-3 sentence summary for each document
   - Save to `public/TransportDecarb_llamacloud_metadata_with_summaries.csv`
   - Show progress for each document

3. Review the generated summaries in the new CSV file

4. When satisfied, replace the original CSV:
   ```bash
   cp public/TransportDecarb_llamacloud_metadata_with_summaries.csv \
      public/TransportDecarb_llamacloud_metadata250904.csv
   ```

5. Deploy the updated CSV to production

## How It Works

1. **CSV Structure**: The script adds a new `summary` column to the existing CSV
2. **Metadata Integration**: The summary is automatically picked up by the catalog API
3. **UI Usage**: The UI checks for `d.summary` first, only calling the API if missing
4. **Performance**: Eliminates ~38 API calls per session, reducing costs and latency

## Cost Estimation

- One-time generation: ~38 documents × $0.001 ≈ $0.04
- Per-session savings: ~38 API calls × $0.001 ≈ $0.04 per user
- Break-even: After just 1 user session!

## Regenerating Summaries

To regenerate summaries (e.g., after model improvements):

```bash
# Backup current CSV
cp public/TransportDecarb_llamacloud_metadata250904.csv \
   public/TransportDecarb_llamacloud_metadata250904.backup.csv

# Generate new summaries
npx tsx scripts/add-summaries-to-csv.ts

# Review and replace
cp public/TransportDecarb_llamacloud_metadata_with_summaries.csv \
   public/TransportDecarb_llamacloud_metadata250904.csv
```

## Troubleshooting

- **Rate limits**: The script includes 1-second delays between API calls
- **Failed summaries**: Get a generic fallback; can be manually edited in CSV
- **Model selection**: Use `gpt-5-mini` with `reasoning_effort: 'high'` for best quality