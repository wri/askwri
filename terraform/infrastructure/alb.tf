# =============================================================================
# Application Load Balancer
# =============================================================================

resource "aws_lb" "main" {
  count              = var.use_shared_vpc ? 0 : 1
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = local.public_subnet_ids
  idle_timeout       = 300 # 5 minutes (longer than max nextJS response time)

  enable_deletion_protection = false

  tags = {
    Name = "${var.project_name}-alb"
  }
}

# =============================================================================
# Target Group
# =============================================================================

resource "aws_lb_target_group" "app" {
  name        = "${var.project_name}-${var.environment}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  # Was the AWS default of 300s, which keeps a draining task registered for up
  # to five minutes on every deployment. The app's longest request is bounded by
  # the ALB idle_timeout above; 30s covers in-flight requests with room to spare.
  deregistration_delay = 30

  # interval: a new task cannot be declared healthy before
  # healthy_threshold * interval, which sits directly on the deployment critical
  # path — 60s at interval 30, 30s at 15. timeout stays at 10 (it must remain
  # below interval) because /api/health queries the database, and
  # unhealthy_threshold stays at 5 so failure tolerance is unchanged rather than
  # traded away for deploy speed.
  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 5
    timeout             = 10
    interval            = 15
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
  }

  tags = {
    Name = "${var.project_name}-${var.environment}-tg"
  }
}

# =============================================================================
# ALB Listeners (only created by the ALB-owning environment)
# =============================================================================

resource "aws_lb_listener" "https" {
  count             = var.use_shared_vpc ? 0 : 1
  load_balancer_arn = aws_lb.main[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  count             = var.use_shared_vpc ? 0 : 1
  load_balancer_arn = aws_lb.main[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# =============================================================================
# Host-based Listener Rule (routes traffic to this environment's target group)
# =============================================================================

resource "aws_lb_listener_rule" "host_based" {
  listener_arn = local.https_listener_arn
  priority     = var.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  condition {
    host_header {
      values = [var.domain_name]
    }
  }
}

# Attach this environment's certificate to the shared HTTPS listener
# (only needed when using a shared ALB, since the owning env's cert is already the default)
resource "aws_lb_listener_certificate" "this" {
  count           = var.use_shared_vpc ? 1 : 0
  listener_arn    = local.https_listener_arn
  certificate_arn = var.certificate_arn
}
