# Backend configuration for QA environment
bucket         = "askwri-app-terraform-state-shared"
key            = "qa/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "askwri-app-terraform-locks-shared"
encrypt        = true
