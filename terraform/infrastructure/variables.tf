# =============================================================================
# General Variables
# =============================================================================

variable "project_name" {
  description = "Name of the project"
  type        = string
  default     = "askwri-app"
}

variable "environment" {
  description = "Environment name (e.g., qa, production)"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "wri_project" {
  description = "WRI project name for tagging"
  type        = string
  default     = "restoration-diagnostic"
}

variable "wri_owner" {
  description = "WRI owner email for tagging"
  type        = string
  default     = "kinshuk.govil@wri.org"
}

# =============================================================================
# VPC Variables
# =============================================================================

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones_count" {
  description = "Number of availability zones to use"
  type        = number
  default     = 2
}

# =============================================================================
# ECS Variables
# =============================================================================

variable "container_port" {
  description = "Port the container listens on"
  type        = number
  default     = 3000
}

variable "container_cpu" {
  description = "CPU units for the container (1 vCPU = 1024)"
  type        = number
  default     = 256
}

variable "container_memory" {
  description = "Memory for the container in MB"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Desired number of tasks"
  type        = number
  default     = 2
}

variable "min_capacity" {
  description = "Minimum number of tasks for auto-scaling"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of tasks for auto-scaling"
  type        = number
  default     = 4
}

variable "health_check_path" {
  description = "Health check path for the ALB target group"
  type        = string
  default     = "/api/health"
}

# =============================================================================
# Application Variables
# =============================================================================

variable "app_environment_variables" {
  description = "Environment variables for the application"
  type        = map(string)
  default     = {}
}
