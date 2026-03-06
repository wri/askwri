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

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 5
    timeout             = 10
    interval            = 30
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
  # TODO: Upgrade to "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09" after the
  # old http listener state entry is cleaned up (requires a successful deploy first).
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = "arn:aws:acm:us-east-2:905418285725:certificate/2519ada5-98d9-43f5-9b31-e70801862222"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
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
  priority     = var.use_shared_vpc ? 100 : 200

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
