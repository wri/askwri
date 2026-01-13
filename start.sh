#!/bin/bash
# AskWRI - Start all services

set -e

echo "🚀 Starting AskWRI v3.0..."
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  No .env file found. Creating from .env.example..."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "✅ Created .env file. Please add your OPENAI_API_KEY"
        exit 1
    fi
fi

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Check for OPENAI_API_KEY
if [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ Error: OPENAI_API_KEY not set in .env file"
    exit 1
fi

# Set default service URL for local development
export LLAMAINDEX_SERVICE_URL=${LLAMAINDEX_SERVICE_URL:-http://127.0.0.1:8002}

# Check if cross-encoder models are cached
HF_CACHE_DIR="${HF_HOME:-$HOME/.cache/huggingface}/hub"
MODEL_L12="models--cross-encoder--ms-marco-MiniLM-L-12-v2"
MODEL_L6="models--cross-encoder--ms-marco-MiniLM-L-6-v2"

if [ -d "$HF_CACHE_DIR/$MODEL_L12" ] && [ -d "$HF_CACHE_DIR/$MODEL_L6" ]; then
    echo "✅ Cross-encoder models found in cache - using offline mode"
    export HF_HUB_OFFLINE=1
else
    echo "📥 First run detected - will download cross-encoder models (~225MB)"
    echo "   This only happens once. Future startups will use cached models."
    export HF_HUB_OFFLINE=0
fi

echo ""
echo "📋 Configuration:"
echo "   OPENAI_API_KEY: ${OPENAI_API_KEY:0:8}..."
echo "   LLAMAINDEX_SERVICE_URL: $LLAMAINDEX_SERVICE_URL"
echo "   HF_HUB_OFFLINE: $HF_HUB_OFFLINE (${HF_HUB_OFFLINE:-0} = download allowed, 1 = cached only)"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down services..."
    kill $HYBRID_PID $FRONTEND_PID 2>/dev/null
    exit
}

trap cleanup SIGINT SIGTERM

# Create logs directory if it doesn't exist
mkdir -p logs

# Start Python hybrid service
echo "🔧 Starting Python hybrid service..."
cd hybrid-service

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "   Creating Python virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    echo "   Installing dependencies..."
    pip install -q -r requirements.txt
else
    source venv/bin/activate
fi

# Start hybrid service in background
python main.py > ../logs/hybrid-service.log 2>&1 &
HYBRID_PID=$!

cd ..

echo "   ✅ Hybrid service starting (PID: $HYBRID_PID)"
echo "   📝 Logs: logs/hybrid-service.log"
echo ""

# Wait for hybrid service to be ready
# Check if embeddings cache exists (first run needs longer timeout)
CACHE_DIR="hybrid-service/cache"
if [ -d "$CACHE_DIR" ] && ls "$CACHE_DIR"/*_vector_index 1>/dev/null 2>&1; then
    MAX_WAIT=300  # 5 minutes for cached startup
    MAX_ITERATIONS=150
    echo "⏳ Waiting for hybrid service to initialize..."
    echo "   💡 Using cached embeddings - should be ready in 2-5 minutes"
else
    MAX_WAIT=900  # 15 minutes for first run (creating embeddings)
    MAX_ITERATIONS=450
    echo "⏳ Waiting for hybrid service to initialize..."
    echo "   ⚠️  FIRST RUN: Creating embeddings for ~27K chunks via OpenAI API"
    echo "   💡 This takes 10-15 minutes but only happens once"
fi
echo "   📊 Progress: Loading document chunks and ML models..."
echo "   👀 Watch progress: tail -f logs/hybrid-service.log (in another terminal)"
echo ""

WAIT_TIME=0
for i in $(seq 1 $MAX_ITERATIONS); do
    if curl -s http://127.0.0.1:8002/health > /dev/null 2>&1; then
        echo ""
        echo "   ✅ Hybrid service ready! (took ${WAIT_TIME}s)"
        break
    fi
    if [ $i -eq $MAX_ITERATIONS ]; then
        echo ""
        echo "   ❌ Hybrid service failed to start after ${WAIT_TIME}s"
        echo "   📝 Check logs/hybrid-service.log for details"
        kill $HYBRID_PID 2>/dev/null
        exit 1
    fi

    # Show progress with time elapsed
    if [ $((i % 15)) -eq 0 ]; then
        echo "   ⏱️  Still loading... (${WAIT_TIME}s elapsed)"
    else
        echo -n "."
    fi

    sleep 2
    WAIT_TIME=$((WAIT_TIME + 2))
done
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing npm dependencies..."
    npm install
    echo ""
fi

# Start Next.js frontend
echo "🌐 Starting Next.js frontend..."
npm run dev > logs/frontend.log 2>&1 &
FRONTEND_PID=$!

echo "   ✅ Frontend starting (PID: $FRONTEND_PID)"
echo "   📝 Logs: logs/frontend.log"
echo ""

# Wait for frontend to be ready
echo "⏳ Waiting for frontend to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        echo "   ✅ Frontend ready!"
        break
    fi
    sleep 2
    echo -n "."
done
echo ""

echo "✨ AskWRI is now running!"
echo ""
echo "📍 Access points:"
echo "   • Research Interface: http://localhost:3000"
echo "   • Document Management: http://localhost:3000/admin/documents"
echo "   • Hybrid Service: http://localhost:8002"
echo "   • API Health: http://localhost:8002/health"
echo ""
echo "📝 Logs:"
echo "   • Hybrid Service: tail -f logs/hybrid-service.log"
echo "   • Frontend: tail -f logs/frontend.log"
echo ""
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for processes
wait $HYBRID_PID $FRONTEND_PID