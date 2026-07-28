# =============================================================================
# ECS Cluster
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}-cluster"

  # Container Insights is off as a standing cost decision (issue #236), not an
  # oversight. It carries a per-cluster charge, and it was turned off in the
  # same pass that cut CPU/memory and pinned autoscaling at 1 task.
  # The tradeoff: no CloudWatch task-level CPU/memory/task-count metrics, which
  # is exactly what you would want to confirm the reduced capacity holds under
  # load. What remains: the awslogs driver still ships container logs, and
  # /query emits per-stage latency as CloudWatch EMF (AskWRI/Query namespace,
  # search-service/app/main.py:_emit_query_emf).
  # Re-enable temporarily when task-level metrics are the only way to diagnose
  # something; flip back afterwards.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-cluster"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}

# =============================================================================
# CloudWatch Log Group
# =============================================================================

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project_name}-${var.environment}"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-${var.environment}-logs"
  }
}

# =============================================================================
# ECS Task Execution Role
# =============================================================================

resource "aws_iam_role" "ecs_task_execution" {
  name = "${var.project_name}-${var.environment}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-ecs-execution-role"
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# =============================================================================
# ECS Task Role (for application permissions)
# =============================================================================

resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-${var.environment}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-${var.environment}-ecs-task-role"
  }
}

# SSM permissions for ECS Exec
resource "aws_iam_role_policy" "ecs_task_ssm" {
  name = "${var.project_name}-${var.environment}-ecs-task-ssm-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = "*"
      }
    ]
  })
}

# Bedrock permissions for the v3 retrieval substrate (multilingual spec v3 §11):
# dense = Cohere embed-v4, rerank = Cohere Rerank 3.5 — both managed Bedrock
# APIs. Neither model is hosted in us-east-2, so the services call the nearest
# hosting region directly (embed: us-east-1, rerank: us-west-2) — hence
# Resource covers the foundation-model ARNs in any region. bedrock:Rerank
# (the bedrock-agent-runtime Rerank API) does not support resource-level
# scoping beyond the model.
resource "aws_iam_role_policy" "ecs_task_bedrock" {
  name = "${var.project_name}-${var.environment}-ecs-task-bedrock-policy"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeCohereModels"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel"
        ]
        # The cross-region inference profile (us.cohere.embed-v4:0) is the
        # re-embed path of record: 300k tokens/min quota vs 150k on-demand
        # (measured 2026-07-22 — the on-demand bucket throttle-kills bulk
        # re-embeds at batch 96, and even batch 24 runs ~2x slower). Profile
        # invocation needs InvokeModel on BOTH the profile ARN and the
        # underlying regional foundation-model ARNs.
        Resource = [
          "arn:aws:bedrock:*::foundation-model/cohere.embed-v4:0",
          "arn:aws:bedrock:*::foundation-model/cohere.rerank-v3-5:0",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.cohere.embed-v4:0"
        ]
      },
      {
        Sid    = "RerankApi"
        Effect = "Allow"
        Action = [
          "bedrock:Rerank"
        ]
        Resource = "*"
      }
    ]
  })
}

# S3 permissions for downloading documents
resource "aws_iam_role_policy" "ecs_task_s3" {
  count = var.documents_s3_bucket != "" ? 1 : 0
  name  = "${var.project_name}-${var.environment}-ecs-task-s3-policy"
  role  = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ListBucket"
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}"
        Condition = {
          StringLike = {
            "s3:prefix" = ["${var.documents_s3_prefix}*", "${var.cache_s3_prefix}*", "${var.intake_s3_prefix}*"]
          }
        }
      },
      {
        Sid    = "GetObjects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion"
        ]
        Resource = [
          "arn:aws:s3:::${var.documents_s3_bucket}/${var.documents_s3_prefix}*",
          "arn:aws:s3:::${var.documents_s3_bucket}/${var.cache_s3_prefix}*"
        ]
      },
      {
        Sid    = "GetEvalObjects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:HeadObject"
        ]
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}/eval-data/*"
      },
      {
        Sid    = "PutEvalObjects"
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}/eval-data/*"
      },
      {
        Sid    = "WorkerIntakeObjects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}/${var.intake_s3_prefix}*"
      },
      {
        Sid    = "PutIntakeObjects"
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}/${var.intake_s3_prefix}*"
      },
      {
        Sid    = "WorkerPutDocuments"
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}/${var.documents_s3_prefix}*"
      }
    ]
  })
}

# =============================================================================
# ECS Task Definition
# =============================================================================

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project_name}-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.container_cpu
  memory                   = var.container_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Ephemeral writable volumes (Fargate ephemeral storage, not tmpfs).
  # Required because the rest of the container's root filesystem is read-only.
  #
  # Fargate always initializes ephemeral volumes as empty root:root 755 directories,
  # regardless of the image content at the mount path.  The init-volumes container
  # (below) runs as root before the app starts and chowns docs and next-cache to
  # the nextjs user (UID 1001).  ssm-agent is intentionally excluded: the SSM agent
  # binary is injected by ECS and runs as root, so it does not need chown.
  volume {
    name = "docs"
  }

  volume {
    name = "next-cache"
  }

  volume {
    name = "ssm-agent"
  }

  container_definitions = jsonencode([
    # Init container: runs as root to chown ephemeral volumes before the app starts.
    # Fargate volumes are always root:root 755 on creation; this fixes ownership for
    # the non-root nextjs user (UID 1001).
    # ssm-agent is intentionally omitted: the SSM agent runs as root and needs no chown.
    {
      name      = "init-volumes"
      image     = "${aws_ecr_repository.app.repository_url}:latest"
      essential = false
      user      = "0"
      command   = ["sh", "-c", "chown 1001:1001 /tmp/askWRI_docs /app/.next/cache"]

      mountPoints = [
        {
          sourceVolume  = "docs"
          containerPath = "/tmp/askWRI_docs"
          readOnly      = false
        },
        {
          sourceVolume  = "next-cache"
          containerPath = "/app/.next/cache"
          readOnly      = false
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs-init"
        }
      }
    },
    {
      name  = "${var.project_name}-${var.environment}"
      image = "${aws_ecr_repository.app.repository_url}:latest"

      # Security hardening:
      # - readonlyRootFilesystem prevents attackers from dropping payloads onto disk.
      # - linuxParameters drops all Linux capabilities; the Node process needs none.
      # - ulimits cap process count to slow fork-bomb / miner-spawn behaviour.
      # - mountPoints expose only the specific writable paths needed:
      #   /tmp/askWRI_docs  S3-synced documents directory
      #   /app/.next/cache  next/image optimized-image cache; without it the app
      #                     fails to boot or serves 500s for next/image requests
      #   /var/lib/amazon/ssm  writable scratch space for the SSM agent injected
      #                        by ECS Exec; required when using aws ecs execute-command
      dependsOn = [
        {
          containerName = "init-volumes"
          condition     = "SUCCESS"
        }
      ]

      readonlyRootFilesystem = true
      privileged             = false

      linuxParameters = {
        capabilities = {
          drop = ["ALL"]
        }
        initProcessEnabled = true
      }

      ulimits = [
        {
          name      = "nproc"
          softLimit = 1024
          hardLimit = 2048
        }
      ]

      mountPoints = [
        {
          sourceVolume  = "docs"
          containerPath = "/tmp/askWRI_docs"
          readOnly      = false
        },
        {
          sourceVolume  = "next-cache"
          containerPath = "/app/.next/cache"
          readOnly      = false
        },
        {
          sourceVolume  = "ssm-agent"
          containerPath = "/var/lib/amazon/ssm"
          readOnly      = false
        }
      ]

      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = concat(
        [
          {
            name  = "NODE_ENV"
            value = "production"
          },
          {
            name  = "PORT"
            value = tostring(var.container_port)
          },
          {
            name  = "HOSTNAME"
            value = "0.0.0.0"
          },
          {
            name  = "NEXT_PUBLIC_ENVIRONMENT"
            value = var.environment
          },
          {
            name  = "SEARCH_SERVICE_URL"
            value = "http://search-service.${var.project_name}-${var.environment}.local:${var.search_service_container_port}"
          },
          {
            name  = "EVAL_S3_PREFIX"
            value = "eval-data/"
          },
          {
            name  = "DOCUMENTS_S3_BUCKET"
            value = var.documents_s3_bucket
          },
          {
            name  = "DOCUMENTS_S3_PREFIX"
            value = var.documents_s3_prefix
          },
          {
            name  = "CACHE_S3_PREFIX"
            value = var.cache_s3_prefix
          }
        ],
        [
          for key, value in var.app_environment_variables : {
            name  = key
            value = value
          }
        ],
        # Secret environment variables from GitHub Secrets (JSON decoded)
        [
          for key, value in try(jsondecode(var.askwri_app_secret_env), {}) : {
            name  = key
            value = value
          }
        ]
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:${var.container_port}${var.health_check_path} || exit 1"]
        # 15s rather than 30s so a replacement task is declared healthy sooner
        # on deploys; retries stays at 5 so failure tolerance is unchanged.
        interval    = 15
        timeout     = 10
        retries     = 5
        startPeriod = 120
      }

      essential = true
    }
  ])

  tags = {
    Name = "${var.project_name}-${var.environment}-task"
  }
}

# =============================================================================
# ECS Service
# =============================================================================

resource "aws_ecs_service" "app" {
  name                    = "${var.project_name}-${var.environment}-service"
  cluster                 = aws_ecs_cluster.main.id
  task_definition         = aws_ecs_task_definition.app.arn
  desired_count           = var.desired_count
  launch_type             = "FARGATE"
  enable_execute_command  = true
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "${var.project_name}-${var.environment}"
    container_port   = var.container_port
  }

  # Enable service discovery for internal communication
  service_registries {
    registry_arn = aws_service_discovery_service.nextjs.arn
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Ignore changes to desired_count when auto-scaling is enabled
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener_rule.host_based]

  tags = {
    Name = "${var.project_name}-${var.environment}-service"
  }
}

# =============================================================================
# Auto Scaling
# =============================================================================

resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# CPU autoscaling disabled
# resource "aws_appautoscaling_policy" "ecs_cpu" {
#   name               = "${var.project_name}-${var.environment}-cpu-autoscaling"
#   policy_type        = "TargetTrackingScaling"
#   resource_id        = aws_appautoscaling_target.ecs.resource_id
#   scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
#   service_namespace  = aws_appautoscaling_target.ecs.service_namespace
#
#   target_tracking_scaling_policy_configuration {
#     predefined_metric_specification {
#       predefined_metric_type = "ECSServiceAverageCPUUtilization"
#     }
#     target_value       = 70.0
#     scale_in_cooldown  = 300
#     scale_out_cooldown = 60
#   }
# }

# Memory autoscaling disabled
# resource "aws_appautoscaling_policy" "ecs_memory" {
#   name               = "${var.project_name}-${var.environment}-memory-autoscaling"
#   policy_type        = "TargetTrackingScaling"
#   resource_id        = aws_appautoscaling_target.ecs.resource_id
#   scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
#   service_namespace  = aws_appautoscaling_target.ecs.service_namespace

#   target_tracking_scaling_policy_configuration {
#     predefined_metric_specification {
#       predefined_metric_type = "ECSServiceAverageMemoryUtilization"
#     }
#     target_value       = 80.0
#     scale_in_cooldown  = 300
#     scale_out_cooldown = 60
#   }
# }

# =============================================================================
# Search Service CloudWatch Log Group
# =============================================================================

resource "aws_cloudwatch_log_group" "search_service" {
  name              = "/ecs/${var.project_name}-${var.environment}-search-service"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-${var.environment}-search-service-logs"
  }
}

# =============================================================================
# Search Service ECS Task Definition
# =============================================================================

resource "aws_ecs_task_definition" "search_service" {
  family                   = "${var.project_name}-${var.environment}-search-service"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.search_service_container_cpu
  memory                   = var.search_service_container_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Ephemeral writable volumes for /tmp and SSM agent scratch space.
  # Required because the container runs with readonlyRootFilesystem = true.
  #
  # Fargate always initializes ephemeral volumes as empty root:root 755 directories.
  # The init-volumes container (below) runs as root, creates the docs/cache
  # subdirectories, and chowns all of /tmp to appuser (UID 1000), giving the app
  # a fully writable /tmp (needed by Python's tempfile module in addition to the
  # S3-sync directories).  ssm-agent is intentionally excluded: the SSM agent
  # runs as root and needs no chown.
  volume {
    name = "tmp"
  }

  volume {
    name = "ssm-agent"
  }

  container_definitions = jsonencode([
    # Init container: runs as root to set up /tmp before the app starts.
    # Creates the S3-sync subdirectories and chowns all of /tmp to appuser (UID
    # 1000) so the app can write tempfiles as well as the docs/cache directories.
    # ssm-agent is intentionally omitted: the SSM agent runs as root and needs no chown.
    {
      name      = "init-volumes"
      image     = "${aws_ecr_repository.search_service.repository_url}:latest"
      essential = false
      user      = "0"
      command   = ["sh", "-c", "mkdir -p /tmp/askWRI_docs /tmp/askWRI_cache/hf_hub && chown -R 1000:1000 /tmp"]

      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.search_service.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs-init"
        }
      }
    },
    {
      name  = "${var.project_name}-${var.environment}-search-service"
      image = "${aws_ecr_repository.search_service.repository_url}:latest"

      readonlyRootFilesystem = true
      privileged             = false

      dependsOn = [
        {
          containerName = "init-volumes"
          condition     = "SUCCESS"
        }
      ]

      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        },
        {
          sourceVolume  = "ssm-agent"
          containerPath = "/var/lib/amazon/ssm"
          readOnly      = false
        }
      ]

      portMappings = [
        {
          containerPort = var.search_service_container_port
          hostPort      = var.search_service_container_port
          protocol      = "tcp"
        }
      ]

      environment = concat(
        [
          {
            name  = "ENVIRONMENT"
            value = var.environment
          },
          {
            name  = "PORT"
            value = tostring(var.search_service_container_port)
          },
          {
            name  = "NEXTJS_BACKEND_URL"
            value = "http://nextjs.${var.project_name}-${var.environment}.local:${var.container_port}"
          },
          {
            name  = "DOCUMENTS_S3_BUCKET"
            value = var.documents_s3_bucket
          },
          {
            name  = "DOCUMENTS_S3_PREFIX"
            value = var.documents_s3_prefix
          },
          {
            name  = "CACHE_S3_PREFIX"
            value = var.cache_s3_prefix
          },
          {
            # HF_HOME points at the baked-in read-only model weights.
            # HF_HUB_CACHE redirects hub cache metadata (e.g. .no_exist sentinel
            # files) to a writable path so they don't try to write into /opt/models
            # which is read-only under readonlyRootFilesystem = true.
            name  = "HF_HUB_CACHE"
            value = "/tmp/askWRI_cache/hf_hub"
          }
        ],
        [
          for key, value in var.search_service_environment_variables : {
            name  = key
            value = value
          }
        ],
        # Secret environment variables from GitHub Secrets (JSON decoded)
        [
          for key, value in try(jsondecode(var.search_service_secret_env), {}) : {
            name  = key
            value = value
          }
        ]
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.search_service.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }

      # healthCheck is disabled for search service to prevent ECS from restarting
      # the container if the search service is not healthy.
      # healthCheck = {
      #   command     = ["CMD-SHELL", "curl -f http://localhost:${var.search_service_container_port}${var.search_service_health_check_path} || exit 1"]
      #   interval    = 30
      #   timeout     = 10
      #   retries     = 5
      #   startPeriod = 120
      # }

      essential = true
    }
  ])

  tags = {
    Name = "${var.project_name}-${var.environment}-search-service-task"
  }
}

# =============================================================================
# Search Service ECS Service
# =============================================================================

resource "aws_ecs_service" "search_service" {
  name                    = "${var.project_name}-${var.environment}-search-service"
  cluster                 = aws_ecs_cluster.main.id
  task_definition         = aws_ecs_task_definition.search_service.arn
  desired_count           = var.search_service_desired_count
  launch_type             = "FARGATE"
  enable_execute_command  = true
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.search_service.id]
    assign_public_ip = false
  }

  # Enable service discovery for internal communication
  service_registries {
    registry_arn = aws_service_discovery_service.search_service.arn
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-search-service"
  }
}

# =============================================================================
# Service Discovery for Internal Communication
# =============================================================================

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "${var.project_name}-${var.environment}.local"
  description = "Private DNS namespace for service discovery"
  vpc         = local.vpc_id

  tags = {
    Name = "${var.project_name}-${var.environment}-namespace"
  }
}

resource "aws_service_discovery_service" "nextjs" {
  name = "nextjs"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-nextjs-discovery"
  }
}

resource "aws_service_discovery_service" "search_service" {
  name = "search-service"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-search-service-discovery"
  }
}

# =============================================================================
# Search Service Auto Scaling
# =============================================================================

resource "aws_appautoscaling_target" "search_service" {
  max_capacity       = var.search_service_max_capacity
  min_capacity       = var.search_service_min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.search_service.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# CPU autoscaling disabled
# resource "aws_appautoscaling_policy" "search_service_cpu" {
#   name               = "${var.project_name}-${var.environment}-search-service-cpu-autoscaling"
#   policy_type        = "TargetTrackingScaling"
#   resource_id        = aws_appautoscaling_target.search_service.resource_id
#   scalable_dimension = aws_appautoscaling_target.search_service.scalable_dimension
#   service_namespace  = aws_appautoscaling_target.search_service.service_namespace

#   target_tracking_scaling_policy_configuration {
#     predefined_metric_specification {
#       predefined_metric_type = "ECSServiceAverageCPUUtilization"
#     }
#     target_value       = 70.0
#     scale_in_cooldown  = 300
#     scale_out_cooldown = 60
#   }
# }

# =============================================================================
# Ingestion Worker CloudWatch Log Group
# =============================================================================

resource "aws_cloudwatch_log_group" "ingestion_worker" {
  name              = "/ecs/${var.project_name}-${var.environment}-ingestion-worker"
  retention_in_days = 30

  tags = {
    Name = "${var.project_name}-${var.environment}-ingestion-worker-logs"
  }
}

# =============================================================================
# Ingestion Worker ECS Task Definition
# =============================================================================

resource "aws_ecs_task_definition" "ingestion_worker" {
  family                   = "${var.project_name}-${var.environment}-ingestion-worker"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.ingestion_worker_container_cpu
  memory                   = var.ingestion_worker_container_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Ephemeral writable /tmp for Python tempfile (PDF parsing uses NamedTemporaryFile).
  # The init-volumes container chowns /tmp to appuser (UID 1000) so the worker can
  # write temp files with readonlyRootFilesystem = true.  Pattern mirrors search-service.
  volume {
    name = "tmp"
  }

  volume {
    name = "ssm-agent"
  }

  container_definitions = jsonencode([
    # Init container: runs as root to chown /tmp to appuser (UID 1000).
    # Required because Fargate initialises ephemeral volumes as root:root 755.
    {
      name      = "init-volumes"
      image     = "${aws_ecr_repository.search_service.repository_url}:latest"
      essential = false
      user      = "0"
      command   = ["sh", "-c", "chown -R 1000:1000 /tmp"]

      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_worker.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs-init"
        }
      }
    },
    {
      name    = "${var.project_name}-${var.environment}-ingestion-worker"
      image   = "${aws_ecr_repository.search_service.repository_url}:latest"
      command = ["python", "-m", "worker.main"]

      readonlyRootFilesystem = true
      privileged             = false

      dependsOn = [
        {
          containerName = "init-volumes"
          condition     = "SUCCESS"
        }
      ]

      mountPoints = [
        {
          sourceVolume  = "tmp"
          containerPath = "/tmp"
          readOnly      = false
        },
        {
          sourceVolume  = "ssm-agent"
          containerPath = "/var/lib/amazon/ssm"
          readOnly      = false
        }
      ]

      environment = concat(
        [
          {
            name  = "ENVIRONMENT"
            value = var.environment
          },
          {
            name  = "DOCUMENTS_S3_BUCKET"
            value = var.documents_s3_bucket
          },
          {
            name  = "DOCUMENTS_S3_PREFIX"
            value = var.documents_s3_prefix
          },
          {
            name  = "INTAKE_S3_PREFIX"
            value = var.intake_s3_prefix
          },
          {
            name  = "SEARCH_SERVICE_URL"
            value = "http://search-service.${var.project_name}-${var.environment}.local:${var.search_service_container_port}"
          },
          {
            name  = "WORKER_LLM_MODEL"
            value = var.worker_llm_model
          }
        ],
        [
          for key, value in var.ingestion_worker_environment_variables : {
            name  = key
            value = value
          }
        ],
        # Secret environment variables from GitHub Secrets (JSON decoded)
        [
          for key, value in try(jsondecode(var.ingestion_worker_secret_env), {}) : {
            name  = key
            value = value
          }
        ]
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ingestion_worker.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ecs"
        }
      }

      essential = true
    }
  ])

  tags = {
    Name = "${var.project_name}-${var.environment}-ingestion-worker-task"
  }
}

# =============================================================================
# Ingestion Worker ECS Service
# =============================================================================

resource "aws_ecs_service" "ingestion_worker" {
  name                    = "${var.project_name}-${var.environment}-ingestion-worker"
  cluster                 = aws_ecs_cluster.main.id
  task_definition         = aws_ecs_task_definition.ingestion_worker.arn
  desired_count           = var.ingestion_worker_desired_count
  launch_type             = "FARGATE"
  enable_execute_command  = true
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.ingestion_worker.id]
    assign_public_ip = false
  }

  # Stop-then-start: queue worker, not load-balanced — never run two task
  # revisions concurrently during a deploy.
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-ingestion-worker"
  }
}

# Memory autoscaling disabled
# resource "aws_appautoscaling_policy" "search_service_memory" {
#   name               = "${var.project_name}-${var.environment}-search-service-memory-autoscaling"
#   policy_type        = "TargetTrackingScaling"
#   resource_id        = aws_appautoscaling_target.search_service.resource_id
#   scalable_dimension = aws_appautoscaling_target.search_service.scalable_dimension
#   service_namespace  = aws_appautoscaling_target.search_service.service_namespace

#   target_tracking_scaling_policy_configuration {
#     predefined_metric_specification {
#       predefined_metric_type = "ECSServiceAverageMemoryUtilization"
#     }
#     target_value       = 80.0
#     scale_in_cooldown  = 300
#     scale_out_cooldown = 60
#   }
# }
