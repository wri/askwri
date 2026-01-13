#!/bin/bash
# ============================================================================
# AskWRI Railway Deployment Setup Script
# ============================================================================
# This script automates the complete Railway deployment process:
# 1. Validates prerequisites
# 2. Creates Railway project
# 3. Provisions volume for data storage
# 4. Uploads PDFs and CSV catalog
# 5. Configures environment variables
# 6. Deploys both services (hybrid + frontend)
#
# USAGE: bash railway-setup.sh
# TIME: ~5-10 minutes (depending on upload speed)
# ============================================================================

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_NAME="askwri"
VOLUME_NAME="askwri-data"
VOLUME_MOUNT_PATH="/data"
VOLUME_SIZE="5"  # GB (1.2GB data + growth room)
DATA_DIR="./data"
DOCUMENTS_CSV="$DATA_DIR/documents.csv"
DOCUMENTS_DIR="$DATA_DIR/documents"

# ============================================================================
# Helper Functions
# ============================================================================

print_header() {
    echo -e "${BLUE}"
    echo "============================================================================"
    echo "$1"
    echo "============================================================================"
    echo -e "${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# ============================================================================
# Step 1: Prerequisites Check
# ============================================================================

print_header "Step 1: Checking Prerequisites"

# Check Railway CLI
if ! command -v railway &> /dev/null; then
    print_error "Railway CLI not found!"
    echo ""
    echo "Install with: npm install -g @railway/cli"
    echo "Or visit: https://docs.railway.app/develop/cli"
    exit 1
fi
print_success "Railway CLI installed"

# Check Railway login
if ! railway whoami &> /dev/null; then
    print_warning "Not logged into Railway"
    echo ""
    echo "Logging in now..."
    railway login
    if [ $? -ne 0 ]; then
        print_error "Railway login failed"
        exit 1
    fi
fi
RAILWAY_USER=$(railway whoami)
print_success "Logged in as: $RAILWAY_USER"

# Check data files
if [ ! -f "$DOCUMENTS_CSV" ]; then
    print_error "CSV catalog not found: $DOCUMENTS_CSV"
    exit 1
fi
print_success "CSV catalog found: $DOCUMENTS_CSV"

if [ ! -d "$DOCUMENTS_DIR" ]; then
    print_error "Documents directory not found: $DOCUMENTS_DIR"
    exit 1
fi

# Count PDFs and check size
PDF_COUNT=$(find "$DOCUMENTS_DIR" -name "*.pdf" | wc -l | tr -d ' ')
DATA_SIZE=$(du -sh "$DOCUMENTS_DIR" | awk '{print $1}')
print_success "Found $PDF_COUNT PDFs ($DATA_SIZE)"

# Check for OPENAI_API_KEY
if [ -z "$OPENAI_API_KEY" ]; then
    print_warning "OPENAI_API_KEY not set in environment"
    echo ""
    read -sp "Enter your OpenAI API key: " OPENAI_API_KEY
    echo ""
    if [ -z "$OPENAI_API_KEY" ]; then
        print_error "API key required"
        exit 1
    fi
fi
print_success "OpenAI API key configured"

echo ""

# ============================================================================
# Step 2: Create Railway Project
# ============================================================================

print_header "Step 2: Creating Railway Project"

# Check if already in a project
if railway status &> /dev/null; then
    CURRENT_PROJECT=$(railway status | grep "Project" | awk '{print $2}')
    print_warning "Already linked to Railway project: $CURRENT_PROJECT"
    echo ""
    read -p "Use this project? (y/n): " USE_EXISTING
    if [ "$USE_EXISTING" != "y" ]; then
        print_info "Creating new project..."
        railway init --name "$PROJECT_NAME"
    fi
else
    print_info "Creating new Railway project: $PROJECT_NAME"
    railway init --name "$PROJECT_NAME"
fi

PROJECT_ID=$(railway status | grep "Project" | awk '{print $2}')
print_success "Project ready: $PROJECT_ID"

echo ""

# ============================================================================
# Step 3: Provision Volume
# ============================================================================

print_header "Step 3: Provisioning Volume for Data Storage"

print_info "Creating volume: $VOLUME_NAME (${VOLUME_SIZE}GB)"
print_warning "This will cost approximately $$(echo "$VOLUME_SIZE * 0.25" | bc)/month"

# Create volume
railway volume create \
    --name "$VOLUME_NAME" \
    --mount "$VOLUME_MOUNT_PATH" \
    --size "$VOLUME_SIZE"

if [ $? -eq 0 ]; then
    print_success "Volume created and mounted at $VOLUME_MOUNT_PATH"
else
    print_error "Failed to create volume"
    exit 1
fi

echo ""

# ============================================================================
# Step 4: Upload Data to Volume
# ============================================================================

print_header "Step 4: Uploading Data to Volume"

print_info "This will upload ~$DATA_SIZE and may take 5-10 minutes..."
print_warning "Do not interrupt this process!"

# Upload documents directory
print_info "Uploading documents directory..."
railway volume upload "$VOLUME_NAME" \
    --source "$DOCUMENTS_DIR" \
    --destination "$VOLUME_MOUNT_PATH/documents"

if [ $? -eq 0 ]; then
    print_success "Documents uploaded"
else
    print_error "Failed to upload documents"
    exit 1
fi

# Upload CSV catalog
print_info "Uploading CSV catalog..."
railway volume upload "$VOLUME_NAME" \
    --source "$DOCUMENTS_CSV" \
    --destination "$VOLUME_MOUNT_PATH/documents.csv"

if [ $? -eq 0 ]; then
    print_success "CSV catalog uploaded"
else
    print_error "Failed to upload CSV"
    exit 1
fi

echo ""

# ============================================================================
# Step 5: Configure Environment Variables
# ============================================================================

print_header "Step 5: Configuring Environment Variables"

print_info "Setting shared environment variables..."

# Set OPENAI_API_KEY
railway variables set OPENAI_API_KEY="$OPENAI_API_KEY"
print_success "Set OPENAI_API_KEY"

# Set model configurations (optional, with defaults)
railway variables set OPENAI_MODEL="gpt-4o-mini"
railway variables set OPENAI_MODEL_WHY="gpt-4o-mini"
railway variables set OPENAI_MODEL_RELATES="gpt-4o-mini"
railway variables set OPENAI_MODEL_SUMMARY="gpt-4o-mini"
railway variables set OPENAI_MODEL_ALIGNMENT="gpt-5-nano"
print_success "Set model configurations"

# Set data paths
railway variables set DATA_PATH="$VOLUME_MOUNT_PATH"
railway variables set CSV_PATH="$VOLUME_MOUNT_PATH/documents.csv"
railway variables set DOCUMENTS_PATH="$VOLUME_MOUNT_PATH/documents"
print_success "Set data paths"

# Set production environment
railway variables set NODE_ENV="production"
print_success "Set NODE_ENV=production"

echo ""

# ============================================================================
# Step 6: Deploy Services
# ============================================================================

print_header "Step 6: Deploying Services"

print_info "Deploying hybrid service and frontend..."
print_warning "First deployment may take 3-5 minutes"

# Deploy using railway.toml configuration
railway up --detach

if [ $? -eq 0 ]; then
    print_success "Deployment triggered"
else
    print_error "Deployment failed"
    exit 1
fi

echo ""
print_info "Waiting for services to start (this may take a few minutes)..."

# Wait for deployment to complete
sleep 10

# Get service URLs
HYBRID_URL=$(railway service hybrid-service url 2>/dev/null || echo "pending")
FRONTEND_URL=$(railway service frontend url 2>/dev/null || echo "pending")

# If we got the hybrid service URL, set it for the frontend
if [ "$HYBRID_URL" != "pending" ] && [ -n "$HYBRID_URL" ]; then
    print_info "Setting LLAMAINDEX_SERVICE_URL for frontend..."
    railway service frontend variables set LLAMAINDEX_SERVICE_URL="$HYBRID_URL"
    print_success "Frontend configured to use hybrid service"
fi

echo ""

# ============================================================================
# Deployment Complete
# ============================================================================

print_header "Deployment Complete!"

echo ""
print_success "AskWRI is deployed to Railway!"
echo ""

echo "📍 Service URLs:"
if [ "$HYBRID_URL" != "pending" ] && [ -n "$HYBRID_URL" ]; then
    echo "   • Hybrid Service: $HYBRID_URL"
    echo "     Health check: $HYBRID_URL/health"
else
    echo "   • Hybrid Service: (starting...)"
fi

if [ "$FRONTEND_URL" != "pending" ] && [ -n "$FRONTEND_URL" ]; then
    echo "   • Frontend: $FRONTEND_URL"
    echo "   • Admin: $FRONTEND_URL/admin/documents"
else
    echo "   • Frontend: (starting...)"
fi

echo ""
echo "📊 Resource Info:"
echo "   • Volume: $VOLUME_NAME (${VOLUME_SIZE}GB)"
echo "   • Mount: $VOLUME_MOUNT_PATH"
echo "   • Data: $PDF_COUNT PDFs ($DATA_SIZE)"
echo ""

echo "🔧 Management Commands:"
echo "   • View logs:        railway logs"
echo "   • Check status:     railway status"
echo "   • Open dashboard:   railway open"
echo "   • Redeploy:         railway up"
echo ""

echo "💰 Estimated Cost:"
echo "   • Services: ~\$5/month (Hobby plan)"
echo "   • Volume: ~$$(echo "$VOLUME_SIZE * 0.25" | bc)/month"
echo "   • Total: ~\$6-10/month"
echo ""

print_warning "Note: First startup may take 30-60s to build indexes"
print_info "Check deployment status: railway logs --follow"

echo ""
print_success "Setup complete! 🎉"
