# Terraform Infrastructure Configuration Guide

This guide explains how to configure and deploy the Terraform infrastructure for QA and Production environments.

## 📋 Prerequisites

1. **AWS CLI** configured with credentials:
   ```bash
   aws configure
   # Enter your AWS Access Key ID, Secret Key, and region
   ```

2. **Terraform** installed (version 1.0+):
   ```bash
   terraform --version
   ```

3. **Required AWS IAM Permissions**: Your AWS credentials need:
   - S3 (for state management)
   - DynamoDB (for state locking)
   - EC2, VPC, ECS, ECR, ELB, IAM, CloudWatch

## 🔧 Step-by-Step Configuration

### Step 1: Set Up Terraform State Backend

The backend stores Terraform state in S3 with DynamoDB locking. This is **shared** across both QA and Production.

```bash
cd terraform/backend-setup

# Run the setup script
./setup.sh
```

**What this creates:**
- S3 bucket: `next-ecs-app-terraform-state-shared`
- DynamoDB table: `next-ecs-app-terraform-locks-shared`
- Versioning enabled on S3 bucket
- Encryption enabled

**Output will show:**
```
Backend configuration to use in main Terraform:
terraform {
  backend "s3" {
    bucket         = "next-ecs-app-terraform-state-shared"
    key            = "terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "next-ecs-app-terraform-locks-shared"
    encrypt        = true
  }
}
```

### Step 2: Configure QA Environment

```bash
cd ../infrastructure

# Initialize Terraform with QA backend
terraform init -backend-config=../environments/qa.backend.hcl

# Review the QA configuration
cat ../environments/qa.tfvars
```

**QA Configuration** ([terraform/environments/qa.tfvars](../terraform/environments/qa.tfvars)):
- VPC CIDR: `10.0.0.0/16`
- Container CPU: 256 (0.25 vCPU)
- Container Memory: 512 MB
- Desired Tasks: 1
- Auto-scaling: 1-2 tasks

**Validate and Plan:**
```bash
# Validate configuration
terraform validate

# See what will be created
terraform plan -var-file=../environments/qa.tfvars
```

**Apply (Deploy):**
```bash
terraform apply -var-file=../environments/qa.tfvars
```

**What this creates:**
- VPC with public/private subnets across 2 AZs
- Internet Gateway and NAT Gateways
- Application Load Balancer
- ECR Repository: `next-ecs-app-qa`
- ECS Cluster: `next-ecs-app-qa-cluster`
- ECS Service with Fargate tasks
- CloudWatch Log Group
- Security Groups
- IAM Roles

**Get the outputs:**
```bash
terraform output

# Get the application URL
terraform output app_url
```

### Step 3: Configure Production Environment

Production uses **separate state** from QA. You need to reinitialize Terraform.

```bash
# Clean local state (don't worry, state is in S3)
rm -rf .terraform
rm .terraform.lock.hcl

# Initialize with Production backend
terraform init -backend-config=../environments/production.backend.hcl

# Review production configuration
cat ../environments/production.tfvars
```

**Production Configuration** ([terraform/environments/production.tfvars](../terraform/environments/production.tfvars)):
- VPC CIDR: `10.1.0.0/16` (different from QA!)
- Container CPU: 512 (0.5 vCPU)
- Container Memory: 1024 MB
- Desired Tasks: 2
- Auto-scaling: 2-10 tasks

**Plan and Apply:**
```bash
# Validate
terraform validate

# Plan
terraform plan -var-file=../environments/production.tfvars

# Apply
terraform apply -var-file=../environments/production.tfvars
```

### Step 4: Verify Deployment

After deployment, verify the infrastructure:

```bash
# Check ECS cluster
aws ecs list-clusters

# Check ECS services
aws ecs list-services --cluster next-ecs-app-qa-cluster

# Get ALB DNS name
aws elbv2 describe-load-balancers \
  --names next-ecs-app-qa-alb \
  --query 'LoadBalancers[0].DNSName' \
  --output text

# Test health endpoint
curl http://<ALB-DNS-NAME>/api/health
```

## 📝 Customizing Configuration

### Modify Resource Allocation

Edit `terraform/environments/qa.tfvars` or `production.tfvars`:

```hcl
# Increase container resources
container_cpu    = 1024  # 1 vCPU
container_memory = 2048  # 2 GB

# Adjust auto-scaling
desired_count = 3
min_capacity  = 2
max_capacity  = 5
```

Then re-apply:
```bash
terraform apply -var-file=../environments/qa.tfvars
```

### Add Environment Variables

Add custom environment variables for your app:

```hcl
app_environment_variables = {
  "LOG_LEVEL"        = "debug"
  "API_BASE_URL"     = "https://api.example.com"
  "DATABASE_URL"     = "postgresql://..."
  "CUSTOM_VAR"       = "value"
}
```

### Change AWS Region

1. Update backend config (`qa.backend.hcl`):
```hcl
region = "us-west-2"
```

2. Update environment config (`qa.tfvars`):
```hcl
aws_region = "us-west-2"
```

3. Re-run backend setup in the new region (if needed)

4. Re-initialize and apply:
```bash
terraform init -backend-config=../environments/qa.backend.hcl -reconfigure
terraform apply -var-file=../environments/qa.tfvars
```

## 🔄 State Management

### Switch Between Environments

```bash
cd terraform/infrastructure

# Switch to QA
rm -rf .terraform .terraform.lock.hcl
terraform init -backend-config=../environments/qa.backend.hcl

# Switch to Production
rm -rf .terraform .terraform.lock.hcl
terraform init -backend-config=../environments/production.backend.hcl
```

### View Current State

```bash
# List resources
terraform state list

# Show specific resource
terraform state show aws_ecs_cluster.main

# View outputs
terraform output
```

### Import Existing Resources

If you have existing AWS resources:

```bash
terraform import aws_ecs_cluster.main next-ecs-app-qa-cluster
```

## 🔍 Troubleshooting

### Common Issues

**1. State Lock Error:**
```
Error: Error acquiring the state lock
```
**Solution:** Wait for other operations to complete, or manually release in DynamoDB:
```bash
aws dynamodb delete-item \
  --table-name next-ecs-app-terraform-locks-shared \
  --key '{"LockID":{"S":"next-ecs-app-terraform-state-shared/qa/terraform.tfstate-md5"}}'
```

**2. Backend Not Configured:**
```
Error: Backend initialization required
```
**Solution:** Initialize with backend config:
```bash
terraform init -backend-config=../environments/qa.backend.hcl
```

**3. Resource Already Exists:**
```
Error: resource already exists
```
**Solution:** Import the existing resource or destroy and recreate:
```bash
terraform import <resource_type>.<resource_name> <resource_id>
```

**4. Insufficient Permissions:**
```
Error: AccessDenied
```
**Solution:** Ensure your AWS credentials have the required permissions.

## 🗑️ Destroying Infrastructure

### Destroy QA Environment

```bash
cd terraform/infrastructure

# Initialize with QA backend
terraform init -backend-config=../environments/qa.backend.hcl

# Destroy
terraform destroy -var-file=../environments/qa.tfvars
```

### Destroy Production Environment

```bash
# Reinitialize with Production backend
rm -rf .terraform .terraform.lock.hcl
terraform init -backend-config=../environments/production.backend.hcl

# Destroy
terraform destroy -var-file=../environments/production.tfvars
```

### Destroy Backend (Last Step)

⚠️ **Warning:** Only do this after destroying all environments!

```bash
cd terraform/backend-setup
./teardown.sh
```

## 📊 Terraform Commands Reference

```bash
# Initialize
terraform init

# Validate syntax
terraform validate

# Format code
terraform fmt -recursive

# Plan changes
terraform plan -var-file=../environments/qa.tfvars

# Apply changes
terraform apply -var-file=../environments/qa.tfvars

# Show current state
terraform show

# List outputs
terraform output

# Refresh state
terraform refresh -var-file=../environments/qa.tfvars

# Destroy infrastructure
terraform destroy -var-file=../environments/qa.tfvars
```

## 🔐 Security Best Practices

1. **Never commit state files** to git (already in .gitignore)
2. **Use separate AWS accounts** for QA and Production (recommended)
3. **Enable MFA** on AWS accounts
4. **Use IAM roles** instead of access keys when possible
5. **Enable CloudTrail** for audit logging
6. **Regularly rotate** AWS access keys
7. **Review security groups** - ensure minimum required access
8. **Enable encryption** on all resources (already configured)

## 💡 Tips

- Use `terraform plan` before `apply` to review changes
- Tag resources appropriately (already configured via default_tags)
- Use workspaces for environment isolation (alternative to backend configs)
- Keep Terraform version consistent across team members
- Use remote state for collaboration
- Regular backup S3 state bucket
- Monitor CloudWatch logs for application issues
- Use `terraform fmt` to maintain consistent formatting

## 📚 Additional Resources

- [Terraform AWS Provider Docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- [AWS ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/)
- [Terraform Backend Configuration](https://www.terraform.io/language/settings/backends/s3)
