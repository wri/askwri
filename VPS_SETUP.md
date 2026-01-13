# VPS Deployment Guide

Simple deployment guide for running the AskWRI Hybrid Retrieval Service on a Ubuntu 24.04 VPS.

## Overview

This deployment approach uses:
- **rsync** for file transfer (code + data)
- **screen** for persistent background process
- **auto-restart wrapper** for crash recovery
- **No Docker, no git, no CI/CD** - just simple SSH + rsync

The VPS runs the Python hybrid service on port 8002, while the Next.js frontend continues to run on Railway and proxies queries to the VPS.

## Prerequisites

- Ubuntu 24.04 VPS with public IP address
- SSH access to the VPS
- At least 2GB RAM (for LlamaIndex + rerankers)
- At least 5GB disk space (1.2GB PDFs + indexes + cache)
- Firewall allows incoming traffic on port 8002

## Initial Setup on VPS

### 1. Install Dependencies

SSH to your VPS and install Python and screen:

```bash
ssh your-username@your-vps-ip

sudo apt update
sudo apt install -y python3 python3-pip python3-venv screen ufw
```

### 2. Configure Firewall

Allow port 8002 for the hybrid service:

```bash
sudo ufw allow 8002/tcp
sudo ufw allow OpenSSH  # Don't lock yourself out!
sudo ufw enable
```

Verify the rule:
```bash
sudo ufw status
```

### 3. Create Project Directory

```bash
mkdir -p ~/askwri/hybrid-service
mkdir -p ~/askwri/data
```

## Deploy from Local Machine

### 1. Configure Deployment Script

Edit `hybrid-service/deploy-to-vps.sh` on your local machine:

```bash
# Update these values:
VPS_USER="your-username"
VPS_IP="your-vps-ip"
```

### 2. Run Deployment

From your local machine, in the `hybrid-service` directory:

```bash
cd /Users/paul/Projects/wri/askwri/mockups/askwri/hybrid-service
bash deploy-to-vps.sh
```

This will:
- Sync all code files (excluding venv, cache, __pycache__)
- Sync the entire `/data` folder (1.2GB - may take 5-10 minutes)

## Configure & Start Service on VPS

### 1. Create Python Virtual Environment

SSH back to the VPS:

```bash
ssh your-username@your-vps-ip
cd ~/askwri/hybrid-service
```

Create and activate venv:

```bash
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

This will take 2-3 minutes to install all dependencies (FastAPI, LlamaIndex, sentence-transformers, etc.).

### 2. Create Environment File

Create `.env` file with your OpenAI API key:

```bash
nano .env
```

Add:
```bash
OPENAI_API_KEY=sk-your-key-here
```

Save and exit (Ctrl+X, Y, Enter).

### 3. Test the Service

Quick test to ensure everything works:

```bash
python main.py
```

You should see:
- "Starting document processing and index building..."
- "Loaded 166 documents from CSV metadata at /home/username/askwri/data/documents.csv"
- "Created 2000+ text chunks"
- "Dense index built with 2000+ nodes"
- "Uvicorn running on http://0.0.0.0:8002"

Press Ctrl+C to stop the test.

### 4. Start Service in Screen Session

Start a persistent screen session:

```bash
screen -S askwri
```

Run the auto-restart wrapper:

```bash
bash run-service.sh
```

The service is now running. Detach from the screen session:
- Press `Ctrl+A`, then press `D`

You can now logout from SSH - the service will keep running.

## Verify Deployment

### From Your Local Machine

Test the health endpoint:

```bash
curl http://your-vps-ip:8002/health
```

Expected response:
```json
{
  "status": "healthy",
  "dense_index_nodes": 2000,
  "sparse_index_docs": 166,
  "metadata_count": 166
}
```

Test a query:

```bash
curl -X POST http://your-vps-ip:8002/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "electric buses",
    "denseTopK": 10,
    "sparseTopK": 10,
    "rerankTopN": 5
  }'
```

## Update Railway Frontend

Update the Railway frontend to point to your VPS:

```bash
railway variables set LLAMAINDEX_SERVICE_URL=http://your-vps-ip:8002
```

The frontend will now proxy all retrieval queries to your VPS instead of the Railway Python service.

## Managing the Service

### View Service Logs

Reattach to the screen session:

```bash
screen -r askwri
```

You'll see live output from the service. Detach again with `Ctrl+A`, then `D`.

### Restart the Service

1. Reattach to screen: `screen -r askwri`
2. Stop service: `Ctrl+C`
3. Start again: `bash run-service.sh`
4. Detach: `Ctrl+A`, then `D`

### Stop the Service

1. Reattach to screen: `screen -r askwri`
2. Stop service: `Ctrl+C`
3. Exit screen: `exit`

### Deploy Updates

When you make code changes locally, re-run the deployment script:

```bash
cd /Users/paul/Projects/wri/askwri/mockups/askwri/hybrid-service
bash deploy-to-vps.sh
```

Then restart the service on VPS:

```bash
screen -r askwri
# Ctrl+C to stop
bash run-service.sh
# Ctrl+A, D to detach
```

If you updated `requirements.txt`, reinstall dependencies first:

```bash
source ~/askwri/hybrid-service/venv/bin/activate
pip install -r ~/askwri/hybrid-service/requirements.txt
```

## Troubleshooting

### Service Won't Start

**Check logs:**
```bash
screen -r askwri
```

**Common issues:**
- Missing `.env` file with `OPENAI_API_KEY`
- Data folder not synced (should be at `~/askwri/data/documents/`)
- Python dependencies not installed
- Port 8002 already in use: `sudo lsof -i :8002`

### Can't Connect from Railway

**Check firewall:**
```bash
sudo ufw status
```

Should show: `8002/tcp ALLOW Anywhere`

**Check if service is listening:**
```bash
sudo netstat -tulpn | grep 8002
```

Should show Python listening on `0.0.0.0:8002`

**Test from VPS itself:**
```bash
curl http://localhost:8002/health
```

### Screen Session Lost

List all screen sessions:
```bash
screen -ls
```

If the session is "Detached", reattach:
```bash
screen -r askwri
```

If there's no session, the service crashed. Check VPS system logs:
```bash
dmesg | tail -50
```

## Auto-Start on Reboot (Optional)

The screen session won't survive a VPS reboot. For production use, consider creating a systemd service instead.

Quick systemd setup:

```bash
sudo nano /etc/systemd/system/askwri.service
```

Add:
```ini
[Unit]
Description=AskWRI Hybrid Retrieval Service
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/your-username/askwri/hybrid-service
Environment="PATH=/home/your-username/askwri/hybrid-service/venv/bin"
ExecStart=/home/your-username/askwri/hybrid-service/venv/bin/python main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable askwri
sudo systemctl start askwri
sudo systemctl status askwri
```

## Cost Estimation

Typical VPS requirements:
- **2GB RAM, 1 CPU, 25GB SSD**: ~$5-10/month
  - DigitalOcean Droplet: $6/month
  - Linode: $5/month
  - Vultr: $5/month
  - Hetzner: €4.15/month (~$4.50)

Cheaper than Railway if you're paying for the Hobby plan (~$7/month) plus volume storage.

## Next Steps

Once deployed and verified:
1. Test queries from Railway frontend
2. Monitor VPS resource usage: `htop` or `top`
3. Consider setting up systemd for auto-restart on reboot
4. Optional: Set up nginx reverse proxy for HTTPS (if needed)
5. Optional: Configure log rotation for long-term operation
