#!/bin/bash

# Terraform Backend Setup Script
# This script creates S3 bucket and DynamoDB table for Terraform state management

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default values
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-next-ecs-app}"
ENVIRONMENT="${ENVIRONMENT:-shared}"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Terraform Backend Setup${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "AWS Region: ${YELLOW}${AWS_REGION}${NC}"
echo -e "Project: ${YELLOW}${PROJECT_NAME}${NC}"
echo -e "Environment: ${YELLOW}${ENVIRONMENT}${NC}"
echo ""

# Navigate to backend-setup directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if AWS CLI is configured
if ! aws sts get-caller-identity &>/dev/null; then
    echo -e "${RED}Error: AWS CLI is not configured or credentials are invalid${NC}"
    echo "Please configure AWS CLI with: aws configure"
    exit 1
fi

echo -e "${GREEN}AWS credentials verified${NC}"
echo ""

# Initialize Terraform
echo -e "${YELLOW}Initializing Terraform...${NC}"
terraform init

# Plan the changes
echo ""
echo -e "${YELLOW}Planning Terraform changes...${NC}"
terraform plan \
    -var="aws_region=${AWS_REGION}" \
    -var="project_name=${PROJECT_NAME}" \
    -var="environment=${ENVIRONMENT}" \
    -out=tfplan

# Apply the changes
echo ""
echo -e "${YELLOW}Applying Terraform changes...${NC}"
terraform apply tfplan

# Clean up plan file
rm -f tfplan

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Backend Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "You can now use the following backend configuration in your main Terraform:"
echo ""
terraform output -raw backend_config
echo ""
