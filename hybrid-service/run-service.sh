#!/bin/bash
# Auto-restart wrapper for AskWRI Hybrid Retrieval Service
# Runs service in a loop, restarting on crashes

cd ~/askwri/hybrid-service
source venv/bin/activate

while true; do
    echo "========================================="
    echo "Starting service at $(date)"
    echo "========================================="
    python main.py
    EXIT_CODE=$?
    echo ""
    echo "Service stopped with exit code: $EXIT_CODE at $(date)"
    echo "Restarting in 5 seconds..."
    echo ""
    sleep 5
done
