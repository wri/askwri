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
desired_count    = 2     # Higher for production
min_capacity     = 2
max_capacity     = 10

# Health Check
health_check_path = "/api/health"

# Application Environment Variables
app_environment_variables = {
  "LOG_LEVEL" = "info"
}
