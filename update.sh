#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Claude Code Slack Bot — Update ==="
echo

# Show current version
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "Current version: v${CURRENT_VERSION}"
echo

# Pull latest changes
echo "Pulling latest changes..."
git pull
echo

# Install dependencies
echo "Installing dependencies..."
npm install
echo

# Build
echo "Building..."
npm run build
echo

# Restart pm2 (if running)
if command -v pm2 &>/dev/null; then
  if pm2 describe claude-slack-bot &>/dev/null; then
    echo "Restarting bot..."
    pm2 restart claude-slack-bot
    pm2 save 2>/dev/null || true
  else
    echo "Bot is not running in pm2. Start it with ./start.sh"
  fi
else
  echo "pm2 not found. Start the bot manually."
fi
echo

# Show new version
NEW_VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "=== Updated to v${NEW_VERSION} ==="
