# =============================================================================
# Production Environment Configuration
# =============================================================================

project_name = "askwri-app"
environment  = "production"
aws_region   = "us-east-2"

# VPC Configuration - Use QA's shared VPC
use_shared_vpc       = true
shared_vpc_state_key = "qa/terraform.tfstate"

# Domain / SSL
domain_name            = "www.askwri-app.org"
certificate_arn        = "arn:aws:acm:us-east-2:905418285725:certificate/a1db6b2a-e11c-4c14-99d3-5437ba37947d"
listener_rule_priority = 100

# ECS Configuration - Higher resources for production
#
# Capacity is deliberately pinned at 1 (was max_capacity = 10). This is a
# standing cost decision, not an oversight — see issue #232, where it was
# reviewed and kept. What it buys and what it costs:
#   - buys: no autoscaling spend; one task per service
#   - costs: no high availability (single task = single point of failure), no
#     headroom for traffic spikes, and no rolling-deploy safety margin
# Raise min_capacity to 2 and max_capacity above it when HA is worth the spend.
container_port   = 3000
container_cpu    = 512   # 0.5 vCPU
container_memory = 1024  # 1 GB
desired_count    = 1     # Could be raised higher based on usage patterns
min_capacity     = 1
max_capacity     = 1

# Health Check
health_check_path = "/api/health"

# Application Environment Variables
app_environment_variables = {
  "LOG_LEVEL" = "info"
  "DB_HOST" = "askwri-db1.cty8g4ssygz9.us-east-2.rds.amazonaws.com"
  "DB_PORT" = "5432"
  "DB_NAME" = "production"
}

# =============================================================================
# Search Service Configuration (Production)
# =============================================================================

search_service_container_port   = 8000
search_service_container_cpu    = 1024  # 1 vCPU
search_service_container_memory = 8192  # 8 GB
search_service_desired_count    = 1     # Could be raised higher based on usage patterns
search_service_min_capacity     = 1
search_service_max_capacity     = 1
search_service_health_check_path = "/health"

# Search Service Environment Variables
search_service_environment_variables = {
  "LOG_LEVEL" = "info"
  "DEBUG"     = "false"
  # WORKERS=1 is a per-worker RAM decision, and the reason has narrowed: since
  # the Bedrock cutover there are no in-process models (embed and rerank are
  # API calls), so the old "indexes+models into RAM" rationale is half retired.
  # What still duplicates per worker is every document's full text, loaded at
  # boot for passage context (search-service/app/main.py:670). Re-measure that
  # footprint before raising this; concurrency work is tracked in AW-60.
  "WORKERS" = "1"
}

# =============================================================================
# S3 Documents Configuration (Production)
# =============================================================================
# Uncomment and set these to enable S3 document downloads
# RDS Configuration
rds_security_group_id = "sg-0575d778d3c2efb0c"

documents_s3_bucket = "askwri-data"
documents_s3_prefix = "documents/"
cache_s3_prefix     = "cache/"
