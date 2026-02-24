#!/usr/bin/env bash
pm2 stop claude-slack-bot 2>/dev/null || true
echo "Bot stopped."
