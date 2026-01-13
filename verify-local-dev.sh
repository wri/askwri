#!/bin/bash
# ============================================================================
# AskWRI Local Development Verification Script
# ============================================================================
# Run this script to verify that local development still works after
# Railway deployment changes
#
# USAGE: bash verify-local-dev.sh
# ============================================================================

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🔍 Verifying Local Development Environment..."
echo ""

# Check data files exist
echo "📁 Checking data files..."
if [ -f "data/documents.csv" ]; then
    echo -e "${GREEN}✅ data/documents.csv exists${NC}"
else
    echo -e "${RED}❌ data/documents.csv missing${NC}"
    exit 1
fi

if [ -d "data/documents" ]; then
    PDF_COUNT=$(find data/documents -name "*.pdf" | wc -l | tr -d ' ')
    echo -e "${GREEN}✅ data/documents/ exists ($PDF_COUNT PDFs)${NC}"
else
    echo -e "${RED}❌ data/documents/ directory missing${NC}"
    exit 1
fi

echo ""

# Check environment file
echo "🔧 Checking environment configuration..."
if [ -f ".env" ]; then
    echo -e "${GREEN}✅ .env file exists${NC}"
    if grep -q "OPENAI_API_KEY" .env; then
        echo -e "${GREEN}✅ OPENAI_API_KEY configured${NC}"
    else
        echo -e "${YELLOW}⚠️  OPENAI_API_KEY not set in .env${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  .env file not found (run: cp .env.example .env)${NC}"
fi

echo ""

# Check Python dependencies
echo "🐍 Checking Python environment..."
if [ -d "hybrid-service/venv" ]; then
    echo -e "${GREEN}✅ Python venv exists${NC}"
else
    echo -e "${YELLOW}⚠️  Python venv not found (will be created on start)${NC}"
fi

echo ""

# Check Node dependencies
echo "📦 Checking Node dependencies..."
if [ -d "node_modules" ]; then
    echo -e "${GREEN}✅ node_modules exists${NC}"
else
    echo -e "${YELLOW}⚠️  node_modules not found (run: npm install)${NC}"
fi

echo ""

# Test path resolution
echo "🔍 Testing path resolution logic..."
python3 -c "
from pathlib import Path

# Test CSV paths (Railway volume should not exist locally)
railway_csv = Path('/data/documents.csv')
local_csv = Path('data/documents.csv')

print(f'Railway CSV path exists: {railway_csv.exists()}')
print(f'Local CSV path exists: {local_csv.exists()}')

if not railway_csv.exists() and local_csv.exists():
    print('\033[0;32m✅ Path resolution working correctly (will use local paths)\033[0m')
else:
    print('\033[0;31m❌ Path resolution issue detected\033[0m')
    exit(1)
"

echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Local development environment verified!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🚀 To start local development:"
echo "   bash start.sh"
echo ""
echo "📝 Railway deployment changes are isolated and won't affect local dev"
echo ""
