# =============================================================================
# Production Environment Configuration
# =============================================================================

project_name = "askwri-app"
environment  = "production"
aws_region   = "us-east-2"

# VPC Configuration
vpc_cidr                 = "10.1.0.0/16"
availability_zones_count = 2

# ECS Configuration - Higher resources for production
container_port   = 3000
container_cpu    = 512   # 0.5 vCPU
container_memory = 1024  # 1 GB
desired_count    = 1     # Could be raised higher based on usage patterns
min_capacity     = 1
max_capacity     = 10

# Health Check
health_check_path = "/api/health"

# Application Environment Variables
app_environment_variables = {
  "LOG_LEVEL" = "info"
}

# =============================================================================
# Search Service Configuration (Production)
# =============================================================================

search_service_container_port   = 8000
search_service_container_cpu    = 512   # 0.5 vCPU
search_service_container_memory = 1024  # 1 GB
search_service_desired_count    = 1     # Could be raised higher based on usage patterns
search_service_min_capacity     = 1
search_service_max_capacity     = 10
search_service_health_check_path = "/health"

# Search Service Environment Variables
search_service_environment_variables = {
  "LOG_LEVEL"   = "info"
  "DEBUG"       = "false"
  "WORKERS"     = "4"
}

# =============================================================================
# S3 Documents Configuration (Production)
# =============================================================================
# Uncomment and set these to enable S3 document downloads
documents_s3_bucket = "askwri-data"
documents_s3_prefix = "documents/"
