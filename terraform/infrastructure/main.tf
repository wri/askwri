terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend configuration - will be configured per environment
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project       = var.project_name
      Environment   = var.environment
      ManagedBy     = "terraform"
      "wri:project" = var.wri_project
      "wri:owner"   = var.wri_owner
    }
  }
}

# Data source for availability zones
data "aws_availability_zones" "available" {
  state = "available"
}

# Data source for current AWS account
data "aws_caller_identity" "current" {}

# Data source for current region
data "aws_region" "current" {}

# =============================================================================
# Shared VPC (read from another environment's Terraform state)
# =============================================================================

data "terraform_remote_state" "shared_vpc" {
  count   = var.use_shared_vpc ? 1 : 0
  backend = "s3"

  config = {
    bucket = "askwri-app-terraform-state-shared"
    key    = var.shared_vpc_state_key
    region = var.aws_region
  }
}

locals {
  vpc_id             = var.use_shared_vpc ? data.terraform_remote_state.shared_vpc[0].outputs.vpc_id : aws_vpc.main[0].id
  public_subnet_ids  = var.use_shared_vpc ? data.terraform_remote_state.shared_vpc[0].outputs.public_subnet_ids : aws_subnet.public[*].id
  private_subnet_ids = var.use_shared_vpc ? data.terraform_remote_state.shared_vpc[0].outputs.private_subnet_ids : aws_subnet.private[*].id
}
