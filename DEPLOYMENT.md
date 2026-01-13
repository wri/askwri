# AskWRI v3.0 Deployment Guide

Complete guide for deploying AskWRI's hybrid architecture to production.

## 🏗️ Architecture Overview

AskWRI v3.0 uses a **dual-service architecture**:
- **Frontend**: Next.js app deployed on Vercel
- **Backend**: Python FastAPI service deployed on Railway
- **Communication**: HTTP API calls between services

## 🚀 Production Deployment

### Step 1: Deploy Hybrid Service to Railway

**1. Prepare your repository:**
```bash
git clone <your-askwri-repo>
cd askwri
```

**2. Deploy to Railway:**
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and initialize
railway login
cd hybrid-service
railway init

# Deploy the service
railway up
```

**3. Configure environment variables in Railway dashboard:**
- Go to your Railway project dashboard
- Navigate to Variables tab
- Add: `OPENAI_API_KEY=sk-your-openai-key`

**4. Note the service URL:**
- Railway will provide a URL like: `https://askwri-hybrid-service-production.up.railway.app`
- Save this URL for the next step

### Step 2: Deploy Frontend to Vercel

**1. Deploy to Vercel:**
```bash
cd .. # Back to project root
npm install -g vercel
vercel --prod
```

**2. Configure environment variables in Vercel:**
- Go to your Vercel project dashboard
- Navigate to Settings → Environment Variables
- Add these variables:
  - `OPENAI_API_KEY`: `sk-your-openai-key`
  - `LLAMAINDEX_SERVICE_URL`: `https://your-railway-service-url`

**3. Redeploy to apply environment variables:**
```bash
vercel --prod
```

## 🔧 Alternative Cloud Platforms

### Railway Alternatives for Backend

**Option 1: Fly.io**
```bash
# Install Fly CLI and login
fly auth login

# Initialize in hybrid-service directory
cd hybrid-service
fly launch

# Set environment variables
fly secrets set OPENAI_API_KEY=sk-your-key
```

**Option 2: Render**
```bash
# Connect GitHub repo to Render
# Set build command: pip install -r requirements.txt
# Set start command: python main.py
# Add environment variable: OPENAI_API_KEY
```

### Vercel Alternatives for Frontend

**Option 1: Netlify**
```bash
# Connect GitHub repo to Netlify
# Build settings:
# - Build command: npm run build
# - Publish directory: .next
# Environment variables:
# - OPENAI_API_KEY
# - LLAMAINDEX_SERVICE_URL
```

**Option 2: Railway (Full Stack)**
```bash
# Deploy both services to Railway
railway init --template next-js  # Frontend
railway init --template python    # Backend
```

## 🧪 Local Development Setup

### Complete Local Setup

**1. Clone and setup:**
```bash
git clone <your-repo>
cd askwri
```

**2. Backend setup:**
```bash
cd hybrid-service

# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# OR
venv\Scripts\activate     # Windows

# Install dependencies
pip install -r requirements.txt

# Set environment variable
export OPENAI_API_KEY=sk-your-key  # Linux/Mac
# OR
set OPENAI_API_KEY=sk-your-key     # Windows

# Start service
python main.py
# Service runs on http://127.0.0.1:8002
```

**3. Frontend setup (new terminal):**
```bash
cd .. # Back to project root

# Install dependencies
npm install

# Set environment variables
export OPENAI_API_KEY=sk-your-key
export LLAMAINDEX_SERVICE_URL=http://127.0.0.1:8002

# Start frontend
npm run dev
# Frontend runs on http://localhost:3000
```

## 🔐 Environment Variables Reference

### Frontend (.env.local or Vercel)
```bash
# Required
OPENAI_API_KEY=sk-your-openai-api-key
LLAMAINDEX_SERVICE_URL=https://your-hybrid-service-url

# Optional
OPENAI_MODEL=gpt-5-mini
OPENAI_MODEL_WHY=gpt-4o-mini
OPENAI_MODEL_RELATES=gpt-4o-mini
OPENAI_MODEL_ALIGNMENT=gpt-5-mini
FILE_METADATA_PATH=public/TransportDecarb_llamacloud_metadata_with_summaries.csv
ENERGY_PROVIDER=AZURE
ENERGY_GRID_REGION=US
```

### Backend (Railway/Fly.io/Render)
```bash
# Required
OPENAI_API_KEY=sk-your-openai-api-key

# Optional
PORT=8002
PYTHONPATH=/app
```

## 🛠️ Deployment Verification

### Health Checks

**1. Verify backend service:**
```bash
curl https://your-hybrid-service-url/health
# Expected: {"status": "healthy", "documents_count": 37, ...}
```

**2. Test hybrid retrieval:**
```bash
curl -X POST https://your-hybrid-service-url/query \
  -H "Content-Type: application/json" \
  -d '{"query": "electric buses", "mode": "answer", "max_results": 5}'
```

**3. Verify frontend:**
- Visit your Vercel URL
- Test both Answer and Cite modes
- Check that citations are clickable and show unique content

### Performance Testing

**Load test the backend:**
```bash
# Install hey (load testing tool)
# Test 100 requests with 10 concurrent connections
hey -n 100 -c 10 -m POST -H "Content-Type: application/json" \
  -d '{"query": "electric buses", "mode": "cite"}' \
  https://your-hybrid-service-url/query
```

## 🚨 Troubleshooting

### Common Issues

**"Service unavailable" errors:**
- Check that `LLAMAINDEX_SERVICE_URL` is correctly set in Vercel
- Verify the Railway service is running and healthy
- Check Railway logs for Python service errors

**"No results returned":**
- Verify `OPENAI_API_KEY` is set in Railway
- Check that PDFs are being loaded (check Railway logs)
- Test the `/health` endpoint to verify document count

**Frontend deployment fails:**
- Check that all required environment variables are set in Vercel
- Verify the build succeeds locally with `npm run build`
- Check Vercel function logs for API route errors

**Backend deployment fails:**
- Check Python version compatibility (3.11+ required)
- Verify all dependencies in `requirements.txt` are installable
- Check that the `PORT` environment variable is set correctly

### Debug Commands

**Check service logs:**
```bash
# Railway
railway logs

# Vercel
vercel logs

# Local backend
python main.py --debug

# Local frontend
npm run dev -- --verbose
```

**Test API connectivity:**
```bash
# Test from frontend to backend
curl -X POST http://localhost:3000/api/llamaindex \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "mode": "answer"}'
```

## 📊 Monitoring

### Railway Monitoring
- Built-in metrics dashboard
- Resource usage tracking
- Automatic scaling based on demand

### Vercel Monitoring
- Function execution metrics
- Build and deployment status
- Performance analytics

### Custom Monitoring
```bash
# Add health check monitoring
curl -f https://your-hybrid-service-url/health || exit 1
curl -f https://your-vercel-app.vercel.app/api/health || exit 1
```

## 🔄 Updates and Maintenance

### Updating the Backend
```bash
cd hybrid-service
git pull origin main
railway up
```

### Updating the Frontend
```bash
git pull origin main
vercel --prod
```

### Adding New Documents
1. Update the CSV file with new document metadata
2. Add PDF files to the hybrid service
3. Restart the Railway service to reprocess documents
4. Clear any local caches

## 💰 Cost Management

### Railway Costs
- **Hobby Plan**: $5/month for light usage
- **Pro Plan**: $20/month + usage for production
- Monitor resource usage in dashboard

### Vercel Costs
- **Hobby Plan**: Free for personal projects
- **Pro Plan**: $20/month for team/production use
- Function execution limits apply

### OpenAI API Costs
- Embeddings: ~$0.0001 per query
- GPT synthesis: ~$0.002-0.008 per query
- Total: ~$0.01-0.05 per user session

---

🚀 **Your AskWRI v3.0 is now deployed and ready for production use!**