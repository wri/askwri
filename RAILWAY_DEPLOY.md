# AskWRI Railway Deployment Guide

Complete guide for deploying AskWRI to Railway with automated setup.

## 📋 Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [What Gets Deployed](#what-gets-deployed)
- [Architecture](#architecture)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [Post-Deployment](#post-deployment)
- [Troubleshooting](#troubleshooting)
- [Cost Estimates](#cost-estimates)
- [Updating the Deployment](#updating-the-deployment)

## 🎯 Overview

This deployment:
- ✅ Deploys both services (hybrid + frontend) to Railway
- ✅ Uses Railway volumes for persistent data storage (1.2GB PDFs + CSV)
- ✅ Ephemeral cache (rebuilds on each deploy, ~30-60s cold start)
- ✅ Shared environment variables across services
- ✅ One-command automated setup
- ✅ **Zero impact on local development**

## ✅ Prerequisites

### 1. Railway Account
- Sign up at [railway.app](https://railway.app)
- Free tier available, but paid plan recommended ($5/month Hobby plan)

### 2. Railway CLI
```bash
npm install -g @railway/cli
```

Verify installation:
```bash
railway --version
```

### 3. OpenAI API Key
- Get from [platform.openai.com](https://platform.openai.com/api-keys)
- Set in environment:
```bash
export OPENAI_API_KEY=sk-your-key-here
```

### 4. Local Data Ready
Ensure you have:
- ✅ `data/documents.csv` (CSV catalog)
- ✅ `data/documents/` directory with PDFs (~1.2GB)

Verify:
```bash
ls -lh data/documents.csv
ls -lh data/documents/ | wc -l  # Should show ~715 PDFs
```

## 🚀 Quick Start

**One command deployment:**

```bash
bash railway-setup.sh
```

That's it! The script will:
1. Check prerequisites
2. Create Railway project
3. Provision 5GB volume
4. Upload 1.2GB of data
5. Configure environment variables
6. Deploy both services

**Expected time:** 5-10 minutes (mostly data upload)

## 📦 What Gets Deployed

### Services
1. **askwri-hybrid-service** (Python/FastAPI)
   - Port: 8002
   - Healthcheck: `/health`
   - Builds indexes on startup

2. **askwri-frontend** (Next.js)
   - Port: 3000
   - Connects to hybrid service
   - Serves UI and API routes

### Data Storage
- **Railway Volume**: 5GB at `/data`
  - Contains: `documents.csv` + `documents/` directory
  - Persists across deploys
  - Costs ~$1.25/month

### Environment Variables (Shared)
- `OPENAI_API_KEY` (required)
- `LLAMAINDEX_SERVICE_URL` (auto-configured)
- Model configs (gpt-4o-mini defaults)
- Data paths (auto-configured)

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────┐
│           Railway Project: askwri               │
├─────────────────────────────────────────────────┤
│                                                 │
│  Service 1: askwri-frontend (Next.js)          │
│  ├─ Port: 3000                                 │
│  ├─ Health: /                                  │
│  └─ Env: LLAMAINDEX_SERVICE_URL → Service 2    │
│                                                 │
│  Service 2: askwri-hybrid-service (FastAPI)    │
│  ├─ Port: 8002                                 │
│  ├─ Health: /health                            │
│  └─ Volume: /data (5GB persistent)             │
│                                                 │
│  Volume: askwri-data                           │
│  ├─ /data/documents.csv (207KB)               │
│  └─ /data/documents/*.pdf (1.2GB, 715 files)  │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Data Flow

**On Railway (Production):**
```
1. User hits frontend URL → askwri-frontend:3000
2. Query → /api/llamaindex → askwri-hybrid-service:8002
3. Hybrid service reads /data/documents.csv
4. Hybrid service loads PDFs from /data/documents/
5. Results → Frontend → User
```

**Local Dev (Unchanged):**
```
1. User hits localhost:3000 → Next.js dev server
2. Query → /api/llamaindex → localhost:8002
3. Hybrid service reads ../data/documents.csv
4. Hybrid service loads PDFs from ../data/documents/
5. Results → Frontend → User
```

## 📖 Step-by-Step Deployment

### Option 1: Automated (Recommended)

```bash
# Set your OpenAI API key
export OPENAI_API_KEY=sk-your-key-here

# Run automated setup
bash railway-setup.sh
```

The script handles everything automatically.

### Option 2: Manual Deployment

If you prefer manual control:

#### 1. Login to Railway
```bash
railway login
```

#### 2. Create Project
```bash
railway init --name askwri
```

#### 3. Create Volume
```bash
railway volume create \
  --name askwri-data \
  --mount /data \
  --size 5
```

#### 4. Upload Data
```bash
# Upload PDFs
railway volume upload askwri-data \
  --source ./data/documents \
  --destination /data/documents

# Upload CSV
railway volume upload askwri-data \
  --source ./data/documents.csv \
  --destination /data/documents.csv
```

**Note:** This takes 5-10 minutes for 1.2GB

#### 5. Set Environment Variables
```bash
railway variables set OPENAI_API_KEY="sk-your-key-here"
railway variables set OPENAI_MODEL="gpt-4o-mini"
railway variables set NODE_ENV="production"
```

#### 6. Deploy
```bash
railway up
```

#### 7. Link Services
```bash
# Get hybrid service URL
HYBRID_URL=$(railway service hybrid-service url)

# Configure frontend to use it
railway service frontend variables set LLAMAINDEX_SERVICE_URL="$HYBRID_URL"
```

## 🎉 Post-Deployment

### Verify Deployment

1. **Check Status**
```bash
railway status
```

2. **View Logs**
```bash
# All services
railway logs

# Specific service
railway logs --service hybrid-service
railway logs --service frontend
```

3. **Test Hybrid Service**
```bash
HYBRID_URL=$(railway service hybrid-service url)
curl $HYBRID_URL/health
```

Expected response:
```json
{
  "status": "healthy",
  "documents_count": 715,
  "total_chunks": 4649,
  "indexes_loaded": {
    "vector_index": true,
    "bm25_retriever": true
  }
}
```

4. **Test Frontend**
```bash
FRONTEND_URL=$(railway service frontend url)
curl $FRONTEND_URL
```

5. **Test Query Flow**
Open frontend URL in browser:
- Research interface: `https://your-frontend.railway.app`
- Admin panel: `https://your-frontend.railway.app/admin/documents`

### Get Service URLs

```bash
railway service hybrid-service url
railway service frontend url
```

Or open dashboard:
```bash
railway open
```

## 🐛 Troubleshooting

### Issue: Services won't start

**Symptoms:** Services show "crashed" or "starting" indefinitely

**Solutions:**
1. Check logs:
   ```bash
   railway logs --service hybrid-service
   ```

2. Common causes:
   - Missing `OPENAI_API_KEY` → Set via `railway variables set`
   - Volume not mounted → Verify in Railway dashboard
   - Build failed → Check `railway.toml` syntax

3. Restart services:
   ```bash
   railway service hybrid-service restart
   railway service frontend restart
   ```

### Issue: Frontend can't reach hybrid service

**Symptoms:** Query errors, "Failed to fetch" in UI

**Solutions:**
1. Check `LLAMAINDEX_SERVICE_URL` is set:
   ```bash
   railway service frontend variables
   ```

2. If missing, set it manually:
   ```bash
   HYBRID_URL=$(railway service hybrid-service url)
   railway service frontend variables set LLAMAINDEX_SERVICE_URL="$HYBRID_URL"
   ```

3. Restart frontend:
   ```bash
   railway service frontend restart
   ```

### Issue: Slow cold start (>2 minutes)

**Symptoms:** First query after deploy takes forever

**Expected:** This is normal! Hybrid service needs to:
1. Parse 715 PDFs (if not cached)
2. Generate embeddings for ~4,649 chunks
3. Build vector + BM25 indexes

**Solution:** Wait for initial startup. Subsequent queries are fast (<500ms).

Check progress:
```bash
railway logs --service hybrid-service --follow
```

### Issue: Data upload failed

**Symptoms:** Volume upload errors during setup

**Solutions:**
1. Check network connection
2. Verify Railway CLI is up-to-date:
   ```bash
   npm update -g @railway/cli
   ```

3. Try uploading in smaller batches:
   ```bash
   # Upload PDFs in batches of 100
   find data/documents -name "*.pdf" | head -100 | xargs -I {} railway volume upload askwri-data --source {} --destination /data/documents/
   ```

### Issue: Local dev broken after deployment

**This should NEVER happen!** All changes are additive.

**Verify local dev still works:**
```bash
# In project root
bash start.sh
```

If issues occur:
1. Check git status for unexpected changes:
   ```bash
   git status
   git diff
   ```

2. Verify data paths unchanged:
   ```bash
   ls -la data/documents.csv
   ls -la data/documents/
   ```

3. Report as bug (this indicates a deployment script issue)

## 💰 Cost Estimates

### Railway Hobby Plan ($5/month)
- Unlimited projects
- Shared CPU/memory
- 500GB bandwidth
- Recommended for production

### Volume Storage
- **Formula:** $0.25/GB/month
- **Current:** 5GB = $1.25/month
- **Actual usage:** 1.2GB (room for growth)

### Total Monthly Cost
- Services: $5
- Volume: $1.25
- **Total: ~$6-7/month**

### OpenAI API Costs
Separate from Railway, depends on usage:
- Embeddings: ~$0.002 per query (initial indexing)
- Synthesis: ~$0.001-0.01 per answer (gpt-4o-mini)
- Estimate: $5-20/month for moderate use

## 🔄 Updating the Deployment

### Updating Code

```bash
# Make changes locally
git add .
git commit -m "Update feature X"

# Deploy to Railway
railway up
```

Railway will:
1. Pull latest code
2. Rebuild services
3. Restart with new code
4. Data persists (on volume)

### Updating Data

#### Option 1: Full re-upload
```bash
# Upload new CSV
railway volume upload askwri-data \
  --source ./data/documents.csv \
  --destination /data/documents.csv

# Upload new PDFs (incremental)
railway volume upload askwri-data \
  --source ./data/documents \
  --destination /data/documents
```

#### Option 2: Use admin UI
1. Open admin panel: `https://your-frontend.railway.app/admin/documents`
2. Upload new documents via web UI
3. Trigger reindex job

### Updating Environment Variables

```bash
railway variables set VARIABLE_NAME="new-value"
```

Example:
```bash
railway variables set OPENAI_MODEL="gpt-4o"
```

Services restart automatically after env var changes.

### Force Rebuild

```bash
railway service hybrid-service restart
railway service frontend restart
```

Or redeploy completely:
```bash
railway up --force
```

## 🔐 Security Notes

### API Keys
- Never commit `.env` files to git
- Use Railway dashboard to manage secrets
- Rotate OpenAI keys regularly

### Volume Access
- Volume is private to your Railway project
- Not accessible from outside Railway network
- Backed up automatically by Railway

### Service URLs
- Public by default
- Add authentication if needed
- Consider Railway's private networking for service-to-service communication

## 📚 Additional Resources

- [Railway Documentation](https://docs.railway.app)
- [Railway CLI Reference](https://docs.railway.app/develop/cli)
- [Railway Volumes Guide](https://docs.railway.app/deploy/volumes)
- [Project README](./README.md)
- [Architecture Docs](./ARCHITECTURE.md)

## 🆘 Support

### Issues with Railway
- Railway Discord: https://discord.gg/railway
- Railway Support: support@railway.app

### Issues with AskWRI
- Check logs: `railway logs`
- Review this guide's troubleshooting section
- Open GitHub issue with logs and error details

---

**Remember:** Local development is completely unaffected by this deployment. All changes are Railway-specific and detected automatically based on environment.
