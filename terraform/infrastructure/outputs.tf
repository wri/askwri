# =============================================================================
# VPC Outputs
# =============================================================================

output "vpc_id" {
  description = "ID of the VPC"
  value       = local.vpc_id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets"
  value       = local.public_subnet_ids
}

output "private_subnet_ids" {
  description = "IDs of the private subnets"
  value       = local.private_subnet_ids
}

# =============================================================================
# ECR Outputs
# =============================================================================

output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.app.repository_url
}

output "ecr_repository_name" {
  description = "Name of the ECR repository"
  value       = aws_ecr_repository.app.name
}

# =============================================================================
# ECS Outputs
# =============================================================================

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster"
  value       = aws_ecs_cluster.main.arn
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.app.name
}

output "task_definition_arn" {
  description = "ARN of the task definition"
  value       = aws_ecs_task_definition.app.arn
}

# =============================================================================
# ALB Outputs
# =============================================================================

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = local.alb_dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  value       = local.alb_zone_id
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = local.alb_arn
}

output "https_listener_arn" {
  description = "ARN of the HTTPS listener"
  value       = local.https_listener_arn
}

output "app_url" {
  description = "URL to access the application"
  value       = "https://${var.domain_name}"
}

# =============================================================================
# CloudWatch Outputs
# =============================================================================

output "cloudwatch_log_group" {
  description = "Name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.app.name
}

# =============================================================================
# Security Group Outputs
# =============================================================================

output "alb_security_group_id" {
  description = "ID of the ALB security group"
  value       = local.alb_security_group_id
}

output "ecs_security_group_id" {
  description = "ID of the ECS security group"
  value       = aws_security_group.ecs.id
}

# =============================================================================
# Search Service Outputs
# =============================================================================

output "search_service_ecr_repository_url" {
  description = "URL of the Search Service ECR repository"
  value       = aws_ecr_repository.search_service.repository_url
}

output "search_service_ecr_repository_name" {
  description = "Name of the Search Service ECR repository"
  value       = aws_ecr_repository.search_service.name
}

output "search_service_ecs_service_name" {
  description = "Name of the Search Service ECS service"
  value       = aws_ecs_service.search_service.name
}

output "search_service_task_definition_arn" {
  description = "ARN of the Search Service task definition"
  value       = aws_ecs_task_definition.search_service.arn
}

output "search_service_cloudwatch_log_group" {
  description = "Name of the Search Service CloudWatch log group"
  value       = aws_cloudwatch_log_group.search_service.name
}

output "search_service_security_group_id" {
  description = "ID of the Search Service security group"
  value       = aws_security_group.search_service.id
}

output "search_service_internal_url" {
  description = "Internal URL to access Search Service from Next.js"
  value       = "http://search-service.${var.project_name}-${var.environment}.local:${var.search_service_container_port}"
}

output "nextjs_internal_url" {
  description = "Internal URL to access Next.js from Search Service"
  value       = "http://nextjs.${var.project_name}-${var.environment}.local:${var.container_port}"
}

output "search_service_url" {
  description = "External URL to access Search Service via ALB"
  value       = "https://${var.domain_name}/api/search"
}
