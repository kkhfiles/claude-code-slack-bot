#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "Building..."
npm run build
if [ $? -ne 0 ]; then
  echo "Build failed!"
  exit 1
fi

if pm2 describe claude-slack-bot &>/dev/null; then
  echo "Restarting bot..."
  pm2 restart claude-slack-bot
else
  echo "Starting bot..."
  pm2 start ecosystem.config.js
fi

pm2 save 2>/dev/null || true
echo
echo "Bot is running. Commands:"
echo "  pm2 logs claude-slack-bot    View logs (live)"
echo "  pm2 status                   Process status"
echo "  ./stop.sh                    Stop the bot"
