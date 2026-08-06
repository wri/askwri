# =============================================================================
# QA Environment Configuration
# =============================================================================

project_name = "askwri-app"
environment  = "qa"
aws_region   = "us-east-2"

# VPC Configuration
vpc_cidr                 = "10.0.0.0/16"
availability_zones_count = 2

# Domain / SSL
domain_name            = "qa.askwri-app.org"
certificate_arn        = "arn:aws:acm:us-east-2:905418285725:certificate/2519ada5-98d9-43f5-9b31-e70801862222"
listener_rule_priority = 200

# ECS Configuration
container_port   = 3000
container_cpu    = 256   # 0.25 vCPU
# TEMPORARY (2026-08-06): raised 512 -> 2048 to get the Spanish transport batch
# uploaded. At 512MB a 79MB PDF OOM-killed the task three times (exit 137,
# "OutOfMemoryError", tasks 6a622d0/91712b0) — one upload holds the file in
# memory up to 4x, and desired_count=1 makes every OOM a site-wide 502.
# 2048 is the Fargate maximum for 256 CPU units.
# DIAL BACK to 512 once the doc-upload push is done AND the per-request copies
# are gone (proxy matcher fix: shipped; streaming upload in the route: not yet).
# Reverting before the route streams to S3 re-opens the same OOM.
container_memory = 2048  # 2 GB
desired_count    = 1     # Lower for QA
min_capacity     = 1
max_capacity     = 1

# Health Check
health_check_path = "/api/health"

# Application Environment Variables
app_environment_variables = {
  "LOG_LEVEL" = "debug"
  "DB_HOST" = "askwri-db1.cty8g4ssygz9.us-east-2.rds.amazonaws.com"
  "DB_PORT" = "5432"
  "DB_NAME" = "qa"
}

# =============================================================================
# Search Service Configuration (QA)
# =============================================================================

search_service_container_port   = 8000
search_service_container_cpu    = 1024  # 1 vCPU
search_service_container_memory = 8192  # 8 GB
search_service_desired_count    = 1
search_service_min_capacity     = 1
search_service_max_capacity     = 1
search_service_health_check_path = "/health"

# Search Service Environment Variables
search_service_environment_variables = {
  "LOG_LEVEL"   = "debug"
  "DEBUG"       = "true"
  "WORKERS"     = "1"
}

# Ingestion Worker Environment Variables
# SPARSE_EN_HANDLES must match the sparse-backfill operator's setting
# (docs/runbooks/qa-push-deploy.md Step 3) — qa's corpus was rebuilt flag-on
# 2026-07-26; without this, the worker's next re-ingest of a non-EN document
# would strip that document's English handles.
ingestion_worker_environment_variables = {
  "SPARSE_EN_HANDLES" = "true"
}

# =============================================================================
# S3 Documents Configuration (QA)
# =============================================================================
# Uncomment and set these to enable S3 document downloads
# RDS Configuration
rds_security_group_id = "sg-0575d778d3c2efb0c"

documents_s3_bucket = "askwri-data"
documents_s3_prefix = "documents/"
cache_s3_prefix     = "cache/"
