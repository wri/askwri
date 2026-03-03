# =============================================================================
# QA Environment Configuration
# =============================================================================

project_name = "askwri-app"
environment  = "qa"
aws_region   = "us-east-2"

# VPC Configuration
vpc_cidr                 = "10.0.0.0/16"
availability_zones_count = 2

# ECS Configuration
container_port   = 3000
container_cpu    = 256   # 0.25 vCPU
container_memory = 512   # 512 MB
desired_count    = 1     # Lower for QA
min_capacity     = 1
max_capacity     = 2

# Health Check
health_check_path = "/api/health"

# Application Environment Variables
app_environment_variables = {
  "LOG_LEVEL" = "debug"
}

# =============================================================================
# Search Service Configuration (QA)
# =============================================================================

search_service_container_port   = 8000
search_service_container_cpu    = 1024  # 1 vCPU
search_service_container_memory = 16384 # 16 GB
search_service_desired_count    = 1     # Lower for QA
search_service_min_capacity     = 1
search_service_max_capacity     = 2
search_service_health_check_path = "/health"

# Search Service Environment Variables
search_service_environment_variables = {
  "LOG_LEVEL"   = "debug"
  "DEBUG"       = "true"
  "WORKERS"     = "1"
}

# =============================================================================
# S3 Documents Configuration (QA)
# =============================================================================
# Uncomment and set these to enable S3 document downloads
documents_s3_bucket = "askwri-data"
documents_s3_prefix = "documents/"
