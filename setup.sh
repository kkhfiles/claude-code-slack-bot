#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=== Claude Code Slack Bot — Setup ==="
echo

# --- Prerequisites ---
echo "Checking prerequisites..."

# Node.js 18+
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed. Please install Node.js 18+ first."
  exit 1
fi
NODE_VERSION=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v$(node -v))."
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  echo "ERROR: npm is not installed."
  exit 1
fi
echo "  ✓ npm $(npm -v)"

# git
if ! command -v git &>/dev/null; then
  echo "ERROR: git is not installed."
  exit 1
fi
echo "  ✓ git $(git --version | awk '{print $3}')"

# claude CLI
if ! command -v claude &>/dev/null; then
  echo "WARNING: claude CLI not found. Install it before running the bot."
  echo "  See: https://docs.anthropic.com/en/docs/claude-code/overview"
else
  echo "  ✓ claude CLI found"
fi

echo

# --- Install dependencies ---
echo "Installing dependencies..."
npm install
echo

# --- .env file ---
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "Created .env from .env.example — please edit it with your tokens."
  else
    echo "WARNING: No .env file found. Create one with your Slack tokens before starting."
  fi
else
  echo ".env already exists — skipping."
fi
echo

# --- pm2 ---
if ! command -v pm2 &>/dev/null; then
  echo "Installing pm2 globally..."
  npm install -g pm2
else
  echo "pm2 already installed — $(pm2 -v)"
fi
echo

# --- Build ---
echo "Building..."
npm run build
echo

echo "=== Setup complete ==="
echo
echo "Next steps:"
echo "  1. Edit .env with your Slack tokens"
echo "  2. Run ./start.sh to start the bot"
echo "  3. Run 'pm2 logs claude-slack-bot' to view logs"
