# Backend configuration for Production environment
bucket         = "next-ecs-app-terraform-state-shared"
key            = "production/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "next-ecs-app-terraform-locks-shared"
encrypt        = true
