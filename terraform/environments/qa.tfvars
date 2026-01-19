# =============================================================================
# QA Environment Configuration
# =============================================================================

project_name = "askwri-app"
environment  = "qa"
aws_region   = "us-east-1"

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
