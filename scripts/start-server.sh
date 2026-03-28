#!/bin/bash
# Start server with persistent logging
LOG_DIR="/Users/jordangk/Desktop/supert/supertrader/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/server-$(date +%Y%m%d-%H%M%S).log"

lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null
sleep 1

echo "Starting server, logging to $LOG_FILE"
node server.js 2>&1 | tee "$LOG_FILE" &
echo "PID: $!"
