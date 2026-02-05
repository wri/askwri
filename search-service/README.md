# AskWRI Search Service

Search service for AskWRI application, deployed via AWS ECS Fargate.

## Overview

This service provides search and backend functionality that integrates with the Next.js frontend. It's designed to handle:
- Data processing tasks
- ML/AI inference (implement as needed)
- Complex computations
- Integration with Python-specific libraries

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   ALB           │────▶│  Next.js Backend │────▶│ Search Service  │
│ /api/search/*   │     │  (ECS Fargate)   │     │  (ECS Fargate)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │                         │
                                ▼                         ▼
                        ┌──────────────────┐    ┌─────────────────┐
                        │ Service Discovery│    │ CloudWatch Logs │
                        │ (AWS Cloud Map)  │    └─────────────────┘
                        └──────────────────┘
```

## Local Development

### Prerequisites

- Python 3.12+
- pip or uv

### Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy environment file
cp .env.example .env

# Run the server
python -m app.main
# Or with uvicorn directly
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### API Documentation

Once running, access the API docs at:
- Swagger UI: http://localhost:8000/api/search/docs
- OpenAPI JSON: http://localhost:8000/api/search/openapi.json

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (ALB target) |
| `/api/search` | GET | API root info |
| `/api/search/health` | GET | API health check |
| `/api/search/nextjs-health` | GET | Check Next.js connectivity |
| `/api/search/message` | POST | Process a message |
| `/api/search/process` | POST | Process data |
| `/api/search/config` | GET | Get configuration |

## Docker

### Build

```bash
docker build -t askwri-search-service .
```

### Run

```bash
docker run -p 8000:8000 \
  -e ENVIRONMENT=development \
  -e DEBUG=true \
  -e NEXTJS_BACKEND_URL=http://host.docker.internal:3000 \
  askwri-search-service
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVIRONMENT` | `development` | Environment name (qa, production) |
| `DEBUG` | `false` | Enable debug mode |
| `PORT` | `8000` | Server port |
| `WORKERS` | `1` | Number of uvicorn workers |
| `LOG_LEVEL` | `info` | Logging level |
| `NEXTJS_BACKEND_URL` | `http://localhost:3000` | Next.js backend URL |

## Deployment

This service is deployed via Terraform to AWS ECS Fargate. See the Terraform configuration in `/terraform/infrastructure/`.

### ECR Push

```bash
# Authenticate with ECR
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-2.amazonaws.com

# Build and tag
docker build -t askwri-app-<env>-search-service .
docker tag askwri-app-<env>-search-service:latest <account>.dkr.ecr.us-east-2.amazonaws.com/askwri-app-<env>-search-service:latest

# Push
docker push <account>.dkr.ecr.us-east-2.amazonaws.com/askwri-app-<env>-search-service:latest
```

## Connecting to Next.js

The Search Service can communicate with Next.js using:

1. **Internal URL** (via Service Discovery): `http://search-service.askwri-app-<env>.local:8000`
2. **Next.js → Search Service**: Uses the `SEARCH_SERVICE_URL` env var in Next.js
3. **Search Service → Next.js**: Uses the `NEXTJS_BACKEND_URL` env var in the service

## Testing

```bash
# Install dev dependencies
pip install pytest pytest-asyncio httpx

# Run tests
pytest
```

## Project Structure

```
search-service/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI application
│   ├── config.py        # Settings and configuration
│   └── routers/
│       ├── __init__.py
│       └── api.py       # API routes
├── Dockerfile
├── requirements.txt
├── .env.example
└── README.md
```
