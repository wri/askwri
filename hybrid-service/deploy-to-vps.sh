#!/bin/bash
# Deploy AskWRI Hybrid Service to VPS
# Usage: bash deploy-to-vps.sh

# Configuration - UPDATE THESE VALUES
VPS_USER="root"
VPS_IP="157.245.113.184"
VPS_BASE_DIR="~/askwri"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}AskWRI VPS Deployment${NC}"
echo "====================================="
echo ""

# Validate configuration
if [ "$VPS_USER" = "your-username" ] || [ "$VPS_IP" = "your-vps-ip" ]; then
        echo "ERROR: Please update VPS_USER and VPS_IP in this script first"
        exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "${GREEN}Syncing entire repository (including 1.2GB data folder)${NC}"
rsync -avz --progress \
        --exclude 'node_modules' \
        --exclude '.next' \
        --exclude 'venv' \
        --exclude '__pycache__' \
        --exclude '*.pyc' \
        --exclude '.env' \
        --exclude 'hybrid-service/cache' \
        --exclude '*.pkl' \
        --exclude 'storage' \
        --exclude 'archive' \
        --exclude 'backups' \
        --exclude 'logs' \
        --exclude 'evaluation/results' \
        --exclude '.DS_Store' \
        --exclude '.vercel' \
        --exclude '*.tsbuildinfo' \
        --exclude '.git' \
        "$PROJECT_ROOT/" \
        "${VPS_USER}@${VPS_IP}:${VPS_BASE_DIR}/"

if [ $? -ne 0 ]; then
        echo "ERROR: Failed to sync repository"
        exit 1
fi

echo ""
echo -e "${GREEN}Deployment complete!${NC}"
echo ""
echo "Next steps (run on VPS):"
echo "  1. SSH to VPS: ssh ${VPS_USER}@${VPS_IP}"
echo "  2. cd ${VPS_BASE_DIR}/hybrid-service"
echo "  3. Create venv: python3 -m venv venv"
echo "  4. Install deps: source venv/bin/activate && pip install -r requirements.txt"
echo "  5. Create .env with OPENAI_API_KEY"
echo "  6. Start service: screen -S askwri"
echo "  7. Run: bash run-service.sh"
echo "  8. Detach: Ctrl+A then D"
echo ""
echo "See VPS_SETUP.md for detailed instructions"
