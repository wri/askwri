# =============================================================================
# ECS Cluster
# =============================================================================

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
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
            "s3:prefix" = ["${var.documents_s3_prefix}*"]
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
        Resource = "arn:aws:s3:::${var.documents_s3_bucket}/${var.documents_s3_prefix}*"
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

  container_definitions = jsonencode([
    {
      name  = "${var.project_name}-${var.environment}"
      image = "${aws_ecr_repository.app.repository_url}:latest"

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
        command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:${var.container_port}${var.health_check_path} || exit 1"]
        interval    = 30
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
  name                   = "${var.project_name}-${var.environment}-service"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.app.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  enable_execute_command = true

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

  container_definitions = jsonencode([
    {
      name  = "${var.project_name}-${var.environment}-search-service"
      image = "${aws_ecr_repository.search_service.repository_url}:latest"

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
  name                   = "${var.project_name}-${var.environment}-search-service"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.search_service.arn
  desired_count          = var.search_service_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = true

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
