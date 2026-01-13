#!/bin/bash
# Startup script for AskWRI Hybrid Retrieval Service

# Set up environment
if [ -f .env ]; then
    export $(cat .env | xargs)
fi

# Create necessary directories
mkdir -p storage
mkdir -p evaluation
mkdir -p logs

# Install dependencies if needed
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
else
    source venv/bin/activate
fi

echo "Starting AskWRI Hybrid Retrieval Service..."
echo "Service will be available at http://127.0.0.1:8001"
echo "Health check: http://127.0.0.1:8001/health"
echo "API docs: http://127.0.0.1:8001/docs"

# Start the service
python main.py