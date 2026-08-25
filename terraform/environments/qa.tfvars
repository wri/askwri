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
container_memory = 512   # 512 MB
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

  # Query-expansion lanes + retrieval tunings (issue #353, merged in #357).
  # Turn the lanes ON in qa and apply the eval-gated knobs:
  #   - QUERY_UNDERSTANDING_ENABLED / QUERY_EXPANSION_LANES_ENABLED: the P1/P2
  #     flags gating the expansion lanes (topic_dense, geo_dense). OFF by
  #     default in code; ON here so the lane work ships in qa.
  #   - QUERY_UNDERSTANDING_LLM_ENABLED: P3 LLM sidecar (issue #362). Augments
  #     the deterministic tier with query variants, LLM-grade facets (suggest
  #     only in slice 1), intent, disambiguation. Dark by default; ON in qa for
  #     the gate. Deterministic-first; failure-soft; one cached call per query.
  #   - EXPANSION_LANE_WEIGHT=0.25: expansion-lane RRF mass at 0.25x (vs 1x
  #     default) to cut ranking dilution where adjacent-topic docs rerank
  #     above goldens (d7/d11). Multi-query tradeoff: regresses d4/q8; left
  #     at the eval-gated best-net tradeoff.
  #   - DEEP_RESCUE_MAX=10: 2nd-rerank up to 10 docs surfaced by a non-dense
  #     lane that sit deep in fused order and miss the cap-2 window when
  #     the lanes add diversity (d11/q11).
  # Eval-gated live 2026-08-22: cite_02 MAP 74.1->76.3, aR 87.5->89.6;
  # cite_01 MAP 37.6->37.1, aR 71.1->77.9; d3 AP 25->100. q1/q3/q8/q11
  # remain below flag-off (irreducible single-knob tradeoffs, see #357).
  # QA ONLY. production.tfvars is unchanged. Revert = remove these vars +
  # redeploy.
  "QUERY_UNDERSTANDING_ENABLED"      = "true"
  "QUERY_EXPANSION_LANES_ENABLED"   = "true"
  "QUERY_UNDERSTANDING_LLM_ENABLED" = "true"
  "EXPANSION_LANE_WEIGHT"           = "0.25"
  "DEEP_RESCUE_MAX"                 = "10"
}

# Ingestion Worker LLM model: pin QA to the current small/fast classifier even
# if the global default (variables.tf) is reverted. gpt-5.6-luna is the
# cost tier of the newest (Feb 2026) GPT-5.6 line; supports structured
# outputs via Chat Completions (required by worker/llm.py chat_json).
worker_llm_model = "gpt-5.6-luna"

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
