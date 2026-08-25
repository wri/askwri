# =============================================================================
# ALB Security Group
# =============================================================================

resource "aws_security_group" "alb" {
  count       = var.use_shared_vpc ? 0 : 1
  name        = "${var.project_name}-alb-sg"
  description = "Security group for ALB"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-alb-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# =============================================================================
# ECS Security Group
# =============================================================================

resource "aws_security_group" "ecs" {
  name        = "${var.project_name}-${var.environment}-ecs-sg"
  description = "Security group for ECS tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "Allow traffic from ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [local.alb_security_group_id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-ecs-sg"
  }
}

# =============================================================================
# Search Service ECS Security Group
# =============================================================================

resource "aws_security_group" "search_service" {
  name        = "${var.project_name}-${var.environment}-search-service-sg"
  description = "Security group for Search Service ECS tasks"
  vpc_id      = local.vpc_id

  # Allow traffic from ALB
  ingress {
    description     = "Allow traffic from ALB"
    from_port       = var.search_service_container_port
    to_port         = var.search_service_container_port
    protocol        = "tcp"
    security_groups = [local.alb_security_group_id]
  }

  # Allow traffic from Next.js ECS service
  ingress {
    description     = "Allow traffic from Next.js backend"
    from_port       = var.search_service_container_port
    to_port         = var.search_service_container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-search-service-sg"
  }
}

# =============================================================================
# RDS Access from Next.js
# =============================================================================

resource "aws_security_group_rule" "rds_from_ecs" {
  count = var.rds_security_group_id != "" ? 1 : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs.id
  security_group_id        = var.rds_security_group_id
  description              = "PostgreSQL from ${var.environment} ECS tasks for Next.js"
}

# =============================================================================
# RDS Access from Search Service
# =============================================================================
# Required once RETRIEVAL_BACKEND=postgres: the search service reads chunks,
# embeddings and the sparse keyword lane straight from RDS. Without this rule it
# starts, accepts requests, then fails background indexing with a connection
# timeout ("couldn't get a connection after 30.00 sec") and answers /query with
# 500 "Service not properly initialized".
resource "aws_security_group_rule" "rds_from_search_service" {
  count = var.rds_security_group_id != "" ? 1 : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.search_service.id
  security_group_id        = var.rds_security_group_id
  description              = "PostgreSQL from ${var.environment} ECS tasks for Search Service"
}

# Add rule to allow Next.js to connect to Search Service
resource "aws_security_group_rule" "ecs_to_search_service" {
  type                     = "egress"
  from_port                = var.search_service_container_port
  to_port                  = var.search_service_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.search_service.id
  security_group_id        = aws_security_group.ecs.id
  description              = "Allow Next.js to connect to Search Service"
}

# Add rule to allow Search Service to connect to Next.js
resource "aws_security_group_rule" "search_service_to_ecs" {
  type                     = "egress"
  from_port                = var.container_port
  to_port                  = var.container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs.id
  security_group_id        = aws_security_group.search_service.id
  description              = "Allow Search Service to connect to Next.js"
}

# Add ingress rule to allow Search Service to reach Next.js
resource "aws_security_group_rule" "ecs_from_search_service" {
  type                     = "ingress"
  from_port                = var.container_port
  to_port                  = var.container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.search_service.id
  security_group_id        = aws_security_group.ecs.id
  description              = "Allow traffic from Search Service"
}

# =============================================================================
# Ingestion Worker Security Group
# =============================================================================

resource "aws_security_group" "ingestion_worker" {
  name        = "${var.project_name}-${var.environment}-ingestion-worker-sg"
  description = "Security group for Ingestion Worker ECS tasks"
  vpc_id      = local.vpc_id

  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-ingestion-worker-sg"
  }
}

# =============================================================================
# RDS Access from Ingestion Worker
# =============================================================================

resource "aws_security_group_rule" "rds_from_worker" {
  count = var.rds_security_group_id != "" ? 1 : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ingestion_worker.id
  security_group_id        = var.rds_security_group_id
  description              = "PostgreSQL from ${var.environment} ECS tasks for Ingestion Worker"
}

# Allow Ingestion Worker to reach Search Service
resource "aws_security_group_rule" "search_service_from_worker" {
  type                     = "ingress"
  from_port                = var.search_service_container_port
  to_port                  = var.search_service_container_port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ingestion_worker.id
  security_group_id        = aws_security_group.search_service.id
  description              = "Allow Ingestion Worker to connect to Search Service"
}
