# Google Calendar MCP Setup Guide

This guide walks you through connecting Google Calendar to the Slack bot via a local MCP server (`@cocal/google-calendar-mcp`).

## Why Local MCP?

Claude Code's platform MCP tools (`mcp__claude_ai_*`) are not available in `-p` (pipe/non-interactive) mode. A local stdio MCP server works reliably in all modes.

## Prerequisites

- Node.js 18+
- A Google account with Calendar access
- Access to [Google Cloud Console](https://console.cloud.google.com/)

## Step 1: Create a GCP Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **Select a project** > **New Project**
3. Name: `claude-slack-bot-calendar` (or any name)
4. Click **Create**

## Step 2: Enable Google Calendar API

1. In your new project, go to **APIs & Services** > **Library**
2. Search for **Google Calendar API**
3. Click **Enable**

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Select **External** (or **Internal** if using Google Workspace)
3. Fill in required fields:
   - App name: `Claude Slack Bot`
   - User support email: your email
   - Developer contact: your email
4. Click **Save and Continue**
5. **Scopes**: Add `https://www.googleapis.com/auth/calendar` (full calendar access)
6. **Test users**: Add your Google account email
7. Click **Save and Continue**

> **Important**: In test mode, OAuth refresh tokens expire after 7 days (`invalid_grant` error). You **must** publish the app to production to avoid this:
>
> Go to **Audience** (left sidebar) → click **Publish app**. This is free and does not require Google verification for personal-use apps. After publishing, re-authenticate (Step 7) to get a non-expiring refresh token.

## Step 4: Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **+ Create Credentials** > **OAuth client ID**
3. Application type: **Desktop app**
4. Name: `claude-slack-bot`
5. Click **Create**
6. Click **Download JSON**

## Step 5: Save Credentials

Save the downloaded JSON file to the Claude config directory:

```bash
# Windows
copy downloaded-file.json %USERPROFILE%\.claude\google-calendar-credentials.json

# macOS/Linux
cp downloaded-file.json ~/.claude/google-calendar-credentials.json
```

> **Important**: Never commit this file to git. It contains your OAuth client secret.

## Step 6: Configure MCP Server

Create `mcp-servers.json` in the project root (already in `.gitignore`):

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "npx",
      "args": ["-y", "@cocal/google-calendar-mcp"],
      "env": {
        "GOOGLE_OAUTH_CREDENTIALS": "C:/Users/yourname/.claude/google-calendar-credentials.json"
      }
    }
  }
}
```

Replace the path with your actual credentials file location.

## Step 7: Authenticate (One-Time)

Run the authentication flow interactively:

```bash
npx -y @cocal/google-calendar-mcp auth
```

This opens a browser window for Google OAuth consent. After granting access, tokens are cached locally (`~/.google-calendar-mcp/` or similar).

For multiple accounts:
```bash
npx -y @cocal/google-calendar-mcp auth work
npx -y @cocal/google-calendar-mcp auth personal
```

## Step 8: Verify

Test that the MCP server loads correctly in Claude Code:

```bash
echo "list my calendar events for today" | claude -p --mcp-config mcp-servers.json --output-format stream-json --verbose --max-turns 1 2>/dev/null | python -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        event = json.loads(line)
        if event.get('type') == 'system' and event.get('subtype') == 'init':
            tools = event.get('tools', [])
            gcal = [t for t in tools if 'google-calendar' in t]
            print(f'Google Calendar tools ({len(gcal)}):')
            for t in sorted(gcal):
                print(f'  {t}')
            break
    except: pass
"
```

Expected output:
```
Google Calendar tools (11):
  mcp__google-calendar__create-event
  mcp__google-calendar__delete-event
  mcp__google-calendar__get-current-time
  mcp__google-calendar__get-event
  mcp__google-calendar__get-freebusy
  mcp__google-calendar__list-calendars
  mcp__google-calendar__list-colors
  mcp__google-calendar__list-events
  mcp__google-calendar__manage-accounts
  mcp__google-calendar__respond-to-event
  mcp__google-calendar__search-events
  mcp__google-calendar__update-event
```

## Step 9: Restart the Bot

```bash
npm run build && pm2 restart claude-slack-bot
```

Test with `-briefing` command in Slack.

## Available Tools

| Tool | Description |
|------|-------------|
| `list-events` | List calendar events in a date range |
| `list-calendars` | List available calendars |
| `get-event` | Get details of a specific event |
| `search-events` | Search events by query |
| `get-freebusy` | Check free/busy status |
| `get-current-time` | Get current time (timezone-aware) |
| `create-event` | Create a new event |
| `update-event` | Update an existing event |
| `delete-event` | Delete an event |
| `respond-to-event` | Accept/decline/tentative |
| `list-colors` | List available calendar colors |
| `manage-accounts` | Manage multi-account setup |

## Troubleshooting

### Token Expired (`invalid_grant`)

If you see `invalid_grant` errors, your refresh token has expired. This happens when the GCP app is in **Testing** mode (7-day token expiry).

**Fix:**
1. Publish the app: Google Cloud Console → Audience → **Publish app**
2. Re-authenticate:
   ```bash
   GOOGLE_OAUTH_CREDENTIALS="$HOME/.claude/google-calendar-credentials.json" npx -y @cocal/google-calendar-mcp auth
   ```

After publishing, refresh tokens do not expire (unless manually revoked).

### Wrong Calendar

The default calendar is `primary`. To specify calendars, update the assistant config's `briefing.calendars` array with calendar IDs (found via `list-calendars` tool).

### MCP Server Not Loading

1. Check `mcp-servers.json` exists in project root
2. Verify the credentials path is correct and absolute
3. Check pm2 logs: `pm2 logs claude-slack-bot`
4. Test manually: `npx -y @cocal/google-calendar-mcp start`

### Windows Path Issues

Use forward slashes in `mcp-servers.json`:
```json
"GOOGLE_OAUTH_CREDENTIALS": "C:/Users/yourname/.claude/google-calendar-credentials.json"
```

### Scope Insufficient

If calendar access is denied, re-run auth and ensure you grant full calendar access (not just read-only).
