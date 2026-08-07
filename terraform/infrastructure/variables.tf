# =============================================================================
# General Variables
# =============================================================================

variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "askwri-app"
}

variable "environment" {
  description = "Environment name (e.g., qa, production)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "wri_project" {
  description = "WRI project name for tagging"
  type        = string
  default     = "askwri"
}

variable "wri_owner" {
  description = "WRI owner email for tagging"
  type        = string
  default     = "kinshuk.govil@wri.org"
}

# =============================================================================
# VPC Variables
# =============================================================================

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones_count" {
  description = "Number of availability zones to use"
  type        = number
  default     = 2
}

variable "use_shared_vpc" {
  description = "Whether to use a shared VPC from another environment's Terraform state"
  type        = bool
  default     = false
}

variable "shared_vpc_state_key" {
  description = "S3 key for the Terraform state containing the shared VPC (e.g., 'qa/terraform.tfstate')"
  type        = string
  default     = ""
}

# =============================================================================
# Domain / SSL Variables
# =============================================================================

variable "domain_name" {
  description = "Domain name for the application (e.g., qa.askwri-app.org)"
  type        = string
}

variable "certificate_arn" {
  description = "ARN of the ACM certificate for HTTPS"
  type        = string
}

variable "listener_rule_priority" {
  description = "Priority for the host-based ALB listener rule (must be unique per listener)"
  type        = number
}

# =============================================================================
# ECS Variables
# =============================================================================

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 3000
}

variable "container_cpu" {
  description = "CPU units for the container (1 vCPU = 1024)"
  type        = number
  default     = 256
}

variable "container_memory" {
  description = "Memory for the container in MB"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of tasks"
  type        = number
  default     = 2
}

variable "min_capacity" {
  description = "Minimum number of tasks for auto-scaling"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of tasks for auto-scaling"
  type        = number
  default     = 4
}

variable "health_check_path" {
  description = "Health check path for the ALB target group"
  type        = string
  default     = "/api/health"
}

# =============================================================================
# Application Variables
# =============================================================================

variable "app_environment_variables" {
  description = "Environment variables for the application"
  type        = map(string)
  default     = {}
}

variable "askwri_app_secret_env" {
  description = "Secret environment variables for Next.js app as JSON string (from GitHub Secrets)"
  type        = string
  sensitive   = true
  default     = "{}"
}

# =============================================================================
# Search Service Variables
# =============================================================================

variable "search_service_container_port" {
  description = "Port the Search Service container listens on"
  type        = number
  default     = 8000
}

variable "search_service_container_cpu" {
  description = "CPU units for the Search Service container (1 vCPU = 1024)"
  type        = number
  default     = 256
}

variable "search_service_container_memory" {
  description = "Memory for the Search Service container in MB"
  type        = number
  default     = 512
}

variable "search_service_desired_count" {
  description = "Desired number of Search Service tasks"
  type        = number
  default     = 2
}

variable "search_service_min_capacity" {
  description = "Minimum number of Search Service tasks for auto-scaling"
  type        = number
  default     = 1
}

variable "search_service_max_capacity" {
  description = "Maximum number of Search Service tasks for auto-scaling"
  type        = number
  default     = 4
}

variable "search_service_health_check_path" {
  description = "Health check path for the Search Service ALB target group"
  type        = string
  default     = "/health"
}

variable "search_service_environment_variables" {
  description = "Environment variables for the Search Service application"
  type        = map(string)
  default     = {}
}

variable "search_service_secret_env" {
  description = "Secret environment variables for Search Service as JSON string (from GitHub Secrets)"
  type        = string
  sensitive   = true
  default     = "{}"
}

# =============================================================================
# RDS Variables
# =============================================================================

variable "rds_security_group_id" {
  description = "Security group ID of the RDS instance to allow connections from ECS"
  type        = string
  default     = ""
}

# =============================================================================
# S3 Variables
# =============================================================================

variable "image_tag" {
  description = <<-EOT
    ECR tag the ECS task definitions run. The deploy workflows pass the full
    commit SHA, which is immutable, so a task definition records exactly which
    commit is live and a rollback is `terraform apply -var="image_tag=<sha>"`
    with no rebuild.

    Defaults to "latest" so a manual `terraform apply` outside the workflows
    still resolves. Do not rely on that default for a real deploy: `latest` is
    mutable, so the running task becomes whichever build pushed most recently.
  EOT
  type        = string
  default     = "latest"
}

variable "documents_s3_bucket" {
  description = "S3 bucket name containing documents for the search service"
  type        = string
  default     = ""
}

variable "documents_s3_prefix" {
  description = "S3 prefix (folder path) for documents within the bucket"
  type        = string
  default     = "documents/"
}

variable "cache_s3_prefix" {
  description = "S3 prefix (folder path) for cache within the bucket"
  type        = string
  default     = "cache/"
}

# =============================================================================
# Ingestion Worker Variables
# =============================================================================

variable "ingestion_worker_container_cpu" {
  description = "CPU units for the Ingestion Worker container (1 vCPU = 1024)"
  type        = number
  default     = 512
}

variable "ingestion_worker_container_memory" {
  description = "Memory for the Ingestion Worker container in MB"
  type        = number
  default     = 2048
}

variable "ingestion_worker_desired_count" {
  description = "Desired number of Ingestion Worker tasks"
  type        = number
  default     = 1
}

variable "ingestion_worker_environment_variables" {
  description = "Environment variables for the Ingestion Worker application"
  type        = map(string)
  default     = {}
}

variable "ingestion_worker_secret_env" {
  description = "Secret environment variables for Ingestion Worker as JSON string (from GitHub Secrets)"
  type        = string
  sensitive   = true
  default     = "{}"
}

variable "intake_s3_prefix" {
  description = "S3 prefix (folder path) for intake documents within the bucket"
  type        = string
  default     = "intake/"
}

variable "worker_llm_model" {
  description = "LLM model name used by the ingestion worker for summaries and tagging"
  type        = string
  default     = "gpt-5-mini"
}
