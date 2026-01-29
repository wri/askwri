# Next.js ECS Fargate Deployment

A production-ready Next.js application with CI/CD pipeline for deploying to AWS ECS Fargate using Terraform and GitHub Actions.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         AWS Cloud                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                          VPC                              │  │
│  │  ┌─────────────────────┐    ┌─────────────────────────┐  │  │
│  │  │   Public Subnets    │    │    Private Subnets      │  │  │
│  │  │  ┌───────────────┐  │    │  ┌─────────────────┐    │  │  │
│  │  │  │      ALB      │  │───▶│  │   ECS Fargate   │    │  │  │
│  │  │  └───────────────┘  │    │  │     Tasks       │    │  │  │
│  │  │         │           │    │  └─────────────────┘    │  │  │
│  │  │  ┌───────────────┐  │    │          │              │  │  │
│  │  │  │  NAT Gateway  │  │◀───│──────────┘              │  │  │
│  │  │  └───────────────┘  │    │                         │  │  │
│  │  └─────────────────────┘    └─────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                │
│  │    ECR     │  │ CloudWatch │  │    S3      │                │
│  │ Repository │  │    Logs    │  │  (TF State)│                │
│  └────────────┘  └────────────┘  └────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
.
├── .github/
│   └── workflows/
│       ├── deploy-qa.yml           # QA deployment workflow
│       ├── deploy-production.yml   # Production deployment workflow
│       ├── pr-check.yml            # Pull request validation
│       └── destroy.yml             # Infrastructure teardown
├── src/
│   └── app/                        # Next.js App Router
│       ├── api/health/route.ts     # Health check endpoint
│       ├── layout.tsx
│       ├── page.tsx
│       └── globals.css
├── terraform/
│   ├── backend-setup/              # Terraform state backend
│   │   ├── main.tf
│   │   ├── setup.sh
│   │   └── teardown.sh
│   ├── infrastructure/             # Main infrastructure
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   ├── vpc.tf
│   │   ├── security_groups.tf
│   │   ├── alb.tf
│   │   ├── ecr.tf
│   │   └── ecs.tf
│   └── environments/               # Environment configs
│       ├── qa.tfvars
│       ├── qa.backend.hcl
│       ├── production.tfvars
│       └── production.backend.hcl
├── Dockerfile
├── package.json
└── README.md
```

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20.x or later
- [Docker](https://www.docker.com/)
- [Terraform](https://www.terraform.io/) 1.0+
- [AWS CLI](https://aws.amazon.com/cli/) configured with appropriate credentials
- [GitHub](https://github.com/) account

### 1. Clone and Install Dependencies

```bash
git clone <repository-url>
cd askwri-app
npm install
```

### 2. Set Up Terraform State Backend

Before deploying infrastructure, you need to create the S3 bucket and DynamoDB table for Terraform state:

```bash
cd terraform/backend-setup

# Make the script executable
chmod +x setup.sh

# Run setup (uses default values)
./setup.sh

# Or customize with environment variables
AWS_REGION=us-east-1 PROJECT_NAME=askwri-app ./setup.sh
```

### 3. Configure GitHub Repository

1. Create a new GitHub repository
2. Push this code to the repository
3. Create the following branches:
   - `main` or `production` - Production deployments
   - `qa` - QA deployments

4. Add GitHub variables for AWS permissions (Settings → Secrets and variables → Actions -> Variables):
   - `OIDC_ROLE` - ARN from AWS console for role GitHubActionsOIDC

### 4. Required AWS IAM Permissions

The AWS credentials need permissions for:
- ECR (create/push images)
- ECS (manage clusters, services, tasks)
- EC2 (VPC, subnets, security groups, NAT gateways)
- ELB (Application Load Balancers)
- IAM (create roles and policies)
- CloudWatch (logs)
- S3 (Terraform state)
- DynamoDB (Terraform locks)

### 5. Deploy

Push to the appropriate branch to trigger deployment:

```bash
# Deploy to QA
git checkout -b qa
git push origin qa

# Deploy to Production
git checkout main
git push origin main
```

## 🔧 Local Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run tests
npm test

# Build for production
npm run build

# Start production server
npm start
```

### Docker Build

```bash
# Build image
docker build -t askwri-app .

# Run container
docker run -p 3000:3000 askwri-app
```

## 📋 Environment Configuration

### QA Environment
- VPC CIDR: `10.0.0.0/16`
- Resources: 256 CPU / 512 MB Memory
- Desired count: 1 task
- Auto-scaling: 1-2 tasks

### Production Environment
- VPC CIDR: `10.1.0.0/16`
- Resources: 512 CPU / 1024 MB Memory
- Desired count: 2 tasks
- Auto-scaling: 2-10 tasks

## 🔄 CI/CD Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `deploy-qa.yml` | Push to `qa` branch | Deploy to QA environment |
| `deploy-production.yml` | Push to `main`/`production` | Deploy to Production |
| `pr-check.yml` | Pull requests | Run tests and validate |
| `destroy.yml` | Manual | Tear down infrastructure |

## 🗑️ Teardown

### Destroy Infrastructure (via GitHub Actions)

1. Go to Actions → Destroy Infrastructure
2. Select the environment (qa or production)
3. Type `DESTROY` to confirm
4. Run workflow

### Destroy Terraform State Backend

```bash
cd terraform/backend-setup
chmod +x teardown.sh
./teardown.sh
```

⚠️ **Warning**: This will permanently delete all Terraform state files!

## 📊 Monitoring

- **CloudWatch Logs**: `/ecs/askwri-app-{environment}`
- **Container Insights**: Enabled on ECS cluster
- **Health Check**: `GET /api/health`

## 🔐 Security Features

- VPC with public/private subnet isolation
- NAT Gateways for private subnet internet access
- Security groups limiting traffic
- S3 bucket versioning and encryption for Terraform state
- ECR image scanning on push
- Non-root container user
- HTTPS headers configured in Next.js

## 💰 Cost Optimization

- Use `FARGATE_SPOT` for non-production workloads
- Auto-scaling based on CPU/Memory utilization
- ECR lifecycle policies to clean old images
- Consider reducing NAT Gateway count for non-production

## 📝 Customization

### Adding Environment Variables

1. Update `terraform/environments/{env}.tfvars`:
```hcl
app_environment_variables = {
  "MY_VAR" = "my-value"
}
```

2. Redeploy

### Changing Resources

Edit `terraform/environments/{env}.tfvars`:
```hcl
container_cpu    = 512   # 0.5 vCPU
container_memory = 1024  # 1 GB
desired_count    = 3
```

## 🆘 Troubleshooting

### Common Issues

1. **Deployment fails at ECS service stability**
   - Check CloudWatch logs
   - Verify health check endpoint returns 200
   - Check security group rules

2. **Terraform state lock error**
   - Wait for other deployments to complete
   - If stuck, manually release lock in DynamoDB

3. **Docker build fails**
   - Ensure all dependencies are in package.json
   - Check for missing files in .dockerignore

## 📄 License

MIT
# askwri
