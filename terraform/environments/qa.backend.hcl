# Backend configuration for QA environment
bucket         = "next-ecs-app-terraform-state-shared"
key            = "qa/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "next-ecs-app-terraform-locks-shared"
encrypt        = true
