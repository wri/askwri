# Backend configuration for Production environment
bucket         = "askwri-app-terraform-state-shared"
key            = "production/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "askwri-app-terraform-locks-shared"
encrypt        = true
