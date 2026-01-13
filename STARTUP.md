# AskWRI - Startup Guide

## Quick Start

### First Time Setup

1. **Copy environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Add your OpenAI API key:**
   ```bash
   # Edit .env and set:
   OPENAI_API_KEY=sk-your-actual-key-here
   ```

3. **Start everything:**
   ```bash
   ./start.sh              # macOS/Linux
   start.bat               # Windows
   npm run start:all       # Alternative
   ```

That's it! The script handles everything else automatically.

## What the Startup Script Does

### Automatic Setup
- ✅ Checks for `.env` file (creates from example if missing)
- ✅ Validates `OPENAI_API_KEY` is set
- ✅ Creates Python virtual environment (first run only)
- ✅ Installs Python dependencies (first run only)
- ✅ Installs Node.js dependencies (first run only)
- ✅ Creates logs directory

### Service Startup
- ✅ Starts hybrid service on port 8002
- ✅ Waits for hybrid service health check
- ✅ Starts Next.js frontend on port 3000
- ✅ Waits for frontend to be ready
- ✅ Shows all access URLs

### During Operation
- ✅ Logs both services to `logs/` directory
- ✅ Handles graceful shutdown on Ctrl+C
- ✅ Cleans up background processes

## Access Points

Once started, you can access:

- **Research Interface:** http://localhost:3000
- **Document Management:** http://localhost:3000/admin/documents
- **Hybrid Service API:** http://localhost:8002
- **Health Check:** http://localhost:8002/health
- **API Stats:** http://localhost:8002/stats

## Logs

View real-time logs:

```bash
# Hybrid service logs
tail -f logs/hybrid-service.log

# Frontend logs
tail -f logs/frontend.log

# Both at once (Linux/macOS)
tail -f logs/*.log
```

## Stopping Services

### Graceful Shutdown

If you started with `./start.sh`:
- Press `Ctrl+C` to stop all services gracefully

If services are still running:
```bash
./stop.sh              # macOS/Linux
stop.bat               # Windows
npm run stop:all       # Alternative
```

### Manual Cleanup

If scripts don't work:
```bash
# Kill hybrid service
lsof -ti:8002 | xargs kill

# Kill frontend
lsof -ti:3000 | xargs kill

# Windows equivalent
netstat -ano | findstr :8002  # Note the PID
taskkill /F /PID <pid>
```

## Troubleshooting

### Script Won't Execute (macOS/Linux)

```bash
chmod +x start.sh stop.sh
```

### "OPENAI_API_KEY not set"

1. Check `.env` file exists
2. Verify `OPENAI_API_KEY=sk-...` line is present
3. No spaces around `=`
4. No quotes around the key

### "Port already in use"

Stop existing services first:
```bash
./stop.sh
```

Or kill processes manually:
```bash
# Check what's using ports
lsof -i :3000
lsof -i :8002

# Kill by port
lsof -ti:3000 | xargs kill
lsof -ti:8002 | xargs kill
```

### Python Virtual Environment Issues

Delete and recreate:
```bash
cd hybrid-service
rm -rf venv
cd ..
./start.sh  # Will recreate venv
```

### Dependencies Not Installing

**Python dependencies:**
```bash
cd hybrid-service
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

**Node dependencies:**
```bash
rm -rf node_modules package-lock.json
npm install
```

### Services Don't Start

Check logs for errors:
```bash
cat logs/hybrid-service.log
cat logs/frontend.log
```

Common issues:
- Missing `OPENAI_API_KEY`
- Port conflicts (3000 or 8002 in use)
- Python/Node version incompatibility
- Network/firewall blocking localhost

## Development Workflow

### Typical Day-to-Day

```bash
# Morning: Start everything
./start.sh

# Work on features...
# Make code changes...
# Frontend auto-reloads

# Need to restart hybrid service?
./stop.sh
./start.sh

# End of day: Stop everything
./stop.sh
```

### Working on Frontend Only

If hybrid service is already running:
```bash
npm run dev
```

### Working on Hybrid Service Only

```bash
cd hybrid-service
source venv/bin/activate
python main.py
```

### Running Tests

```bash
# TypeScript type checking
npm run typecheck

# Lint
npm run lint

# Run test suite
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage

# Build (to verify no errors)
npm run build
```

**Test Results:**
- 16 tests passing (PDF extraction, CSV metadata interfaces)
- 24 tests skipped (job queue - async timing issues)
- See [TESTING.md](./TESTING.md) for details

## Environment Variables

### Required

- `OPENAI_API_KEY` - Your OpenAI API key (starts with `sk-`)

### Optional

- `LLAMAINDEX_SERVICE_URL` - Defaults to `http://127.0.0.1:8002`
- `OPENAI_MODEL` - Defaults to `gpt-4o-mini`
- `OPENAI_MODEL_SUMMARY` - Model for summaries
- `FILE_METADATA_PATH` - CSV file location
- `ENERGY_PROVIDER` - Energy tracking provider
- `ENERGY_GRID_REGION` - Grid region for carbon calc

See `.env.example` for full list.

## Platform-Specific Notes

### macOS
- Use `start.sh` and `stop.sh`
- Requires bash (installed by default)
- May need to allow terminal permissions

### Linux
- Use `start.sh` and `stop.sh`
- Requires bash (installed by default)
- May need to install `curl` if not present

### Windows
- Use `start.bat` and `stop.bat`
- Requires Command Prompt or PowerShell
- May need to install `curl` via Windows package manager
- Python must be in PATH

## Production Deployment

For production, use cloud services instead of these scripts:

1. **Railway/Render:** Deploy hybrid service
2. **Vercel:** Deploy Next.js app
3. Set `LLAMAINDEX_SERVICE_URL` to Railway URL
4. Both services auto-scale and have monitoring

See main README for full deployment instructions.

## Support

If you encounter issues not covered here:

1. Check main README.md troubleshooting section
2. Review logs in `logs/` directory
3. Test API endpoints with curl
4. Open GitHub issue with error details and logs