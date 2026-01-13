#!/bin/bash
# AskWRI - Stop all services

echo "🛑 Stopping AskWRI services..."

# Kill Python hybrid service
if lsof -Pi :8002 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "   Stopping hybrid service (port 8002)..."
    kill $(lsof -t -i:8002) 2>/dev/null
    echo "   ✅ Hybrid service stopped"
else
    echo "   ℹ️  Hybrid service not running"
fi

# Kill Next.js frontend
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "   Stopping frontend (port 3000)..."
    kill $(lsof -t -i:3000) 2>/dev/null
    echo "   ✅ Frontend stopped"
else
    echo "   ℹ️  Frontend not running"
fi

echo ""
echo "✅ All services stopped"