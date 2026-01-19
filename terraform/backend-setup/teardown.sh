#!/bin/bash

# Terraform Backend Teardown Script
# This script destroys S3 bucket and DynamoDB table used for Terraform state

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-askwri-app}"
ENVIRONMENT="${ENVIRONMENT:-shared}"
BUCKET_NAME="${PROJECT_NAME}-terraform-state-${ENVIRONMENT}"

echo -e "${RED}========================================${NC}"
echo -e "${RED}Terraform Backend Teardown${NC}"
echo -e "${RED}========================================${NC}"
echo ""
echo -e "${RED}WARNING: This will permanently delete:${NC}"
echo -e "  - S3 bucket: ${YELLOW}${BUCKET_NAME}${NC}"
echo -e "  - DynamoDB table: ${YELLOW}${PROJECT_NAME}-terraform-locks-${ENVIRONMENT}${NC}"
echo -e "  - All Terraform state files${NC}"
echo ""
echo -e "${RED}This action is IRREVERSIBLE!${NC}"
echo ""

# Confirm destruction
read -p "Are you sure you want to proceed? Type 'yes' to confirm: " confirmation

if [ "$confirmation" != "yes" ]; then
    echo -e "${YELLOW}Teardown cancelled.${NC}"
    exit 0
fi

# Navigate to backend-setup directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo -e "${RED}Error: AWS CLI is not configured or credentials are invalid${NC}"
    exit 1
fi

# First, empty the S3 bucket (required before deletion)
echo ""
echo -e "${YELLOW}Emptying S3 bucket...${NC}"
aws s3 rm "s3://${BUCKET_NAME}" --recursive 2>/dev/null || true

# Delete all versions (if versioning was enabled)
echo -e "${YELLOW}Deleting all object versions...${NC}"
aws s3api list-object-versions \
    --bucket "${BUCKET_NAME}" \
    --query 'Versions[].{Key:Key,VersionId:VersionId}' \
    --output text 2>/dev/null | while read key version; do
    if [ -n "$key" ] && [ -n "$version" ]; then
        aws s3api delete-object --bucket "${BUCKET_NAME}" --key "$key" --version-id "$version" 2>/dev/null || true
    fi
done

# Delete all delete markers
aws s3api list-object-versions \
    --bucket "${BUCKET_NAME}" \
    --query 'DeleteMarkers[].{Key:Key,VersionId:VersionId}' \
    --output text 2>/dev/null | while read key version; do
    if [ -n "$key" ] && [ -n "$version" ]; then
        aws s3api delete-object --bucket "${BUCKET_NAME}" --key "$key" --version-id "$version" 2>/dev/null || true
    fi
done

# Initialize Terraform if needed
echo ""
echo -e "${YELLOW}Initializing Terraform...${NC}"
terraform init

# Destroy the infrastructure
echo ""
echo -e "${YELLOW}Destroying Terraform resources...${NC}"
terraform destroy \
    -var="aws_region=${AWS_REGION}" \
    -var="project_name=${PROJECT_NAME}" \
    -var="environment=${ENVIRONMENT}" \
    -auto-approve

# Clean up local state files
rm -rf .terraform
rm -f .terraform.lock.hcl
rm -f terraform.tfstate*
rm -f tfplan

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Backend Teardown Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
