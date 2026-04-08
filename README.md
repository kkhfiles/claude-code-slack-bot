# Claude Code Slack Bot

Start Claude Code tasks on your local machine from Slack — on your phone, on the go, from anywhere.
Resume previous sessions, switch between projects, and manage everything through conversation threads.

> Forked from [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot). Uses Claude Code CLI (`claude -p`) with Socket Mode (no public URL needed). Cross-platform: Windows / macOS / Linux.

## Key Features

### Start Tasks Remotely

Point the bot at any directory on your local machine with `-cwd`, then send a message — Claude starts working on your codebase immediately. No SSH, no tunnels, just Slack.

### Resume Any Session from Anywhere

Use `-r` to browse all previous Claude Code sessions across your machine — including ones started from the terminal. Select a session, and the bot automatically switches to the correct directory and resumes where you left off. No need to remember paths or session IDs.

### File Attachment Analysis

Drag & drop files into Slack for Claude to analyze:
- **Images**: JPG, PNG, GIF, WebP, SVG (multimodal analysis)
- **Text/Code**: TXT, MD, JSON, JS, TS, PY, Java, and more (content embedded inline, up to 50MB)
- **Documents**: PDF, DOCX (metadata-level analysis)

### Permission Modes

Three levels of trust, switchable at any time:

| Mode | Behavior |
|------|----------|
| **Default** (`-default`) | Read-only tools auto-allowed. Edit/Bash/MCP → Slack button approval → auto-resume |
| **Safe** (`-safe`) | Read + Edit auto-allowed. Bash/MCP → Slack button approval |
| **Trust** (`-trust`) | All tools auto-approved (`--dangerously-skip-permissions`) |

When a tool is denied, a Slack button appears to approve it individually or allow all — the session resumes automatically.

### Plan Mode

`-plan <prompt>` generates a read-only plan without modifying any files. Review it, then click **Execute** to proceed or **Cancel** to discard.

### Multi-Account Support

Register up to 3 Claude accounts and switch between them. Each query uses `CLAUDE_CODE_OAUTH_TOKEN` env var injection, and `~/.claude/.credentials.json` is automatically synced so your terminal CLI also picks up the active account.

- `-account` — View all accounts with Set/Use/Unset buttons
- Tokens are auto-refreshed on expiry (OAuth refresh flow)
- Rate limit triggers automatic account rotation: account-1 → account-2 → account-3 → API key fallback

### Rate Limit Handling & API Key Fallback

When Claude subscription limits are reached:

1. **Auto account switch** — If multiple accounts are registered, the bot tries the next account automatically
2. **Continue with API key** — Switch to your registered API key
3. **Schedule retry** — Slack delivers your message at the estimated reset time
4. **Cancel** — Discard the pending message

Pre-register your API key with `-apikey` so it's ready when needed. The modal also lets you set an optional **spending limit** — the bot auto-deactivates API key mode when the limit is reached. The bot automatically reverts to subscription auth when the rate limit resets.

When API key mode is active, each query's cost is tracked and shown in the completion message (`✅ Task completed (Grep ×3) | 🔑 $0.0023 (total: $0.0145)`). Use `-limit` to view or adjust the spending limit at any time.

### Session Auto-Start

Claude Pro/Max subscriptions have session limits with 5-hour windows. Schedule automatic session starts to keep your sessions running:

```
-schedule    # Block-based UI with per-account add/remove buttons
```

**How it works:**
- Each schedule entry is tied to a specific account — use the `[+ email]` buttons to add times per account
- At the scheduled hour, the bot sends a minimal greeting using the assigned account's token (randomized message, +5~25 min jitter)
- **Auto follow-up**: 5 hours later, a second greeting fires automatically to cover the next session window (persisted to disk — survives restarts)
- Different accounts can have overlapping times; conflict checking is per-account only (5-hour window)
- Uses `claude-haiku-4-5-20251001` model for minimal token cost
- **Non-working day skip**: Weekends and Korean public holidays (including lunar calendar) are automatically skipped
- Schedule repeats daily, persisted in `.schedule-config.json`

### Assistant Scheduler (Optional)

Automate daily briefings, calendar reminders, and weekly analysis reports. Requires external config directory with prompt templates.

- **Morning briefing** — Scheduled on working days, skips weekends and Korean holidays
- **Calendar reminders** — Polls Google Calendar via MCP during working hours, dedup per event
- **Weekly analysis** — Runs configurable analysis types (competitors, dependencies, etc.) and saves reports
- Configure via environment variables: `ASSISTANT_DM_CHANNEL` and `ASSISTANT_CONFIG_DIR`

### Additional Features

- **i18n**: Automatic Korean/English UI based on Slack user locale
- **MCP**: Integrate MCP servers via `mcp-servers.json` (`-mcp`, `-mcp reload`)
- **Model selection**: `-model sonnet`, `-model opus`, `-model haiku`
- **Cost tracking**: API key mode shows per-query and cumulative cost in completion messages; `-cost` for last query details
- **Spending limit**: Set via `-apikey` modal or `-limit <amount>`; auto-deactivates API key mode when reached
- **Streaming**: Real-time response updates with tool progress display
- **Tool summary**: Completion message shows tools used (`✅ Task completed (Grep ×5, Read ×2)`)

## Prerequisites

- Node.js 18+
- Claude Code CLI installed and logged in (`claude login`)
- Slack workspace admin access

## Installation

### Quick Start

```bash
git clone https://github.com/kkhfiles/claude-code-slack-bot.git
cd claude-code-slack-bot

# macOS / Linux
./setup.sh

# Windows
setup.bat
```

The setup script checks prerequisites (Node.js 18+, git, claude CLI), installs dependencies, creates `.env` from template, installs pm2, and builds.

### Manual Install

### 1. Clone and Install

```bash
git clone https://github.com/kkhfiles/claude-code-slack-bot.git
cd claude-code-slack-bot
npm install              # macOS / Linux
npm install --ignore-scripts  # Windows
```

### 2. Create a Slack App

**Each user must create their own Slack App** (Socket Mode maintains one connection per app).

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. Select your workspace and paste the contents of `slack-app-manifest.json`
3. After creating the app:

**Generate tokens:**
- **OAuth & Permissions** → Install app to workspace → Copy Bot User OAuth Token (`xoxb-...`)
- **Basic Information** → App-Level Tokens → Create with `connections:write` scope (`xapp-...`)
- **Basic Information** → Copy Signing Secret

### 3. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:
```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret
BASE_DIRECTORY=P:\your\base\directory
# DEBUG=true

# Optional: Assistant scheduler
# ASSISTANT_DM_CHANNEL=D0123456789
# ASSISTANT_CONFIG_DIR=/path/to/assistant/config
```

> No API key needed: Claude Code CLI uses local `claude login` authentication. Usage is billed to your Claude subscription (Pro/Max).

## Running

Uses [pm2](https://pm2.keymetrics.io/) for background execution. No separate terminal window needed, auto-restarts on crash.

```bash
npm install -g pm2   # One-time setup

# macOS / Linux
./start.sh           # Build → start via pm2 (restarts if already running)
./stop.sh            # Stop

# Windows
start.bat            # Build → start via pm2 (restarts if already running)
stop.bat             # Stop
```

### pm2 Commands

```bash
pm2 logs claude-slack-bot             # Live logs
pm2 logs claude-slack-bot --lines 50  # Last 50 lines
pm2 status                            # Process status
pm2 restart claude-slack-bot          # Restart
pm2 stop claude-slack-bot             # Stop
pm2 delete claude-slack-bot           # Remove
```

### Auto-Start on Boot

**macOS / Linux:**
```bash
pm2 startup          # Generate OS-specific startup script
pm2 save             # Save current process list
```

**Windows:**
```bash
autostart-setup.bat  # Registers pm2-resurrect.vbs in Windows Startup folder
```

### Manual Run (without pm2)

```bash
npm run build
node dist/index.js            # Foreground (Ctrl+C to stop)
```

## Updating

```bash
# macOS / Linux
./update.sh

# Windows
update.bat
```

The update script pulls the latest code, installs dependencies, rebuilds, and restarts pm2. Use `-version` in Slack to check if an update is available.

## Slack Commands

All commands start with `-` prefix. Use `-help` to see the full list.
Some commands also work without `-` for mobile convenience (e.g., `resume`, `continue`, `계속`, `help`).

### Working Directory

| Command | Description |
|---------|-------------|
| `-cwd <path>` | Set working directory (relative or absolute) |
| `-cwd` | Show current setting |

```
-cwd my-project/subdir          # Relative to BASE_DIRECTORY
-cwd P:\projects\my-app          # Absolute path
-cwd                             # Show current setting
```

**Scope:**
- **DM**: Applies to the entire DM conversation
- **Channel**: Applies to the entire channel (setup prompt on bot join)
- **Thread**: Applies to that thread only (also creates DM-level fallback)

Settings are persisted to disk and survive bot restarts.

### Session Management

| Command | Description |
|---------|-------------|
| `-r` / `resume` / `continue` / `계속` | Recent sessions picker (mobile-friendly) |
| `-sessions` | List sessions for current cwd (ID + summary) |
| `-sessions all` | List sessions across all projects |
| `-continue [message]` | Resume last CLI session |
| `-resume <session-id> [message]` | Resume a specific session |
| `-stop` | Cancel running query (graceful interrupt) |
| `-reset` | End current session (next message starts fresh) |

```
-r                               # Session picker with buttons
resume                           # Same (no prefix needed)
-sessions                        # Session list
-resume 6449c0ab-...             # Resume specific session
-continue summarize current state # Resume last session with message
-stop                            # Cancel running task
-reset                           # Reset session
```

Conversations in the same thread automatically continue the session (no command needed).

### Plan & Permissions

| Command | Description |
|---------|-------------|
| `-plan <prompt>` | Read-only plan generation (no execution) |
| `-default` | Default mode: edits, bash, MCP require approval |
| `-safe` | Safe mode: edits auto-approved, bash/MCP require approval |
| `-trust` | Trust mode: all tools auto-approved |

```
-plan analyze dependencies in pom.xml   # Plan only → Execute button
-safe                                    # Switch to safe mode
-trust                                   # Switch to trust mode
-default                                 # Back to default mode
```

### Settings

| Command | Description |
|---------|-------------|
| `-account` | Multi-account status (Set/Use/Unset buttons) |
| `-account 1/2/3` | Switch to specific account |
| `-model [name]` | Get/set model (`sonnet`, `opus`, `haiku`, or full name) |
| `-cost` | Show last query cost and session ID |
| `-apikey` | Register API key for rate limit fallback; optional spending limit field |
| `-limit [amount]` | View/set API key spending limit (e.g., `-limit 2.00`) |
| `-limit clear` | Remove spending limit |
| `-version` | Show bot version and check for updates |

### Session Auto-Start

| Command | Description |
|---------|-------------|
| `-schedule` | Show schedule status with per-account add/remove buttons |

```
-schedule               # Block-based UI: add via modal, remove via ✕ button, clear all
```

### Assistant

| Command | Description |
|---------|-------------|
| `-briefing` / `-br` | Run morning briefing now |
| `-report [type]` / `-rp` | View latest analysis report |
| `-assistant config` / `-as config` | Show assistant configuration |
| `-assistant briefing HH:MM` | Change briefing time |
| `-assistant reminder N` | Change reminder lead time (minutes) |

### MCP Servers

| Command | Description |
|---------|-------------|
| `-mcp` | Show MCP server status |
| `-mcp reload` | Reload MCP configuration |

Configure via `mcp-servers.json`:
```bash
cp mcp-servers.example.json mcp-servers.json
```

### Conversations & File Uploads

```
# Direct message
Explain the structure of this project

# Channel mention
@ClaudeBot analyze pom.xml

# Continue in thread (automatic session continuity)
Check for dependency conflicts

# Attach files: drag & drop images, code, or text files
```

## Multi-User Setup

For multiple users in the same Slack workspace:

1. **Each user creates their own Slack App** (Socket Mode = one connection per app)
2. Each user runs the bot on their machine (`claude login` → `.env` setup → `start.bat`)
3. Usage billed to each user's Claude subscription

> You can also run a single bot on a shared server. In this case, all team members share one Claude subscription.

## Advanced Configuration

### AWS Bedrock
```env
CLAUDE_CODE_USE_BEDROCK=1
# Requires AWS CLI or IAM role authentication
```

### Google Vertex AI
```env
CLAUDE_CODE_USE_VERTEX=1
# Requires Google Cloud authentication
```

## Optional Features Setup

All optional features are **gracefully disabled** when not configured — the core bot works out of the box with just Slack tokens and `BASE_DIRECTORY`.

### Assistant Scheduler (Briefing, Reminders, Analysis)

Automates daily briefings, Google Calendar reminders, and weekly analysis reports.

**Requirements:**
- `ASSISTANT_DM_CHANNEL` — Slack DM channel ID for bot notifications (find via right-click channel > Copy link)
- `ASSISTANT_CONFIG_DIR` — Path to a directory containing `config.json` and prompt templates

**Config directory structure:**
```
assistant/
├── config.json              # Main configuration
└── prompts/
    ├── morning-briefing.md  # Briefing prompt template
    ├── calendar-judgment.md # Calendar reminder AI judgment prompt
    └── analysis-*.md        # Weekly analysis prompts (one per type)
```

**Example `config.json`:**
```json
{
  "briefing": {
    "time": "08:00",
    "enabled": true,
    "maxBudgetUsd": 1.00,
    "excludeCalendars": ["Holidays", "Birthdays"]
  },
  "reminders": {
    "beforeMinutes": 15,
    "pollingIntervalMinutes": 5,
    "enabled": true,
    "maxBudgetUsd": 0.05,
    "workingHoursStart": "08:00",
    "workingHoursEnd": "20:00"
  },
  "analysis": {
    "schedule": "wednesday-20:00",
    "deliveryTime": "08:30",
    "budgetUsd": 5.00,
    "defaults": {
      "allowedTools": ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write"],
      "writablePaths": ["reports/"]
    },
    "types": {
      "ai-practice": { "enabled": true },
      "competitors": { "enabled": true },
      "session-efficiency": { "enabled": true },
      "dependency-health": { "enabled": true }
    }
  }
}
```

Changes to `config.json` are auto-detected (file watcher, 10s interval) — no restart needed.

### Google Calendar Integration

Enables calendar event creation, reminders, and briefing with calendar data. See [docs/google-calendar-setup.md](docs/google-calendar-setup.md) for the full setup guide.

**Quick summary:**
1. Create a GCP project and enable Google Calendar API
2. Create OAuth credentials (Desktop app) and save to `~/.claude/google-calendar-credentials.json`
3. **Publish the app** in Google Cloud Console → Audience → Publish app (otherwise refresh tokens expire after 7 days)
4. Authenticate: `GOOGLE_OAUTH_CREDENTIALS="$HOME/.claude/gcp-oauth.keys.json" npx @cocal/google-calendar-mcp auth`
5. Create `mcp-servers.json` in project root (see [docs/google-calendar-setup.md](docs/google-calendar-setup.md#step-6-configure-mcp-server))

**Features unlocked:**
- Ask Claude to create/update/delete events on any of your calendars via natural language
- `CalendarPoller`: 5-min polling with AI-powered reminders during working hours
- Morning briefing includes today's calendar agenda

### Multi-Account Management

Register up to 3 Claude accounts for rate limit rotation and seamless switching.

**Setup:**
1. Log in to your first Claude account: `claude login`
2. In Slack, run `-account` → click **Set** on a slot → credentials are captured from `~/.claude/.credentials.json`
3. Repeat for additional accounts (log in via terminal, then capture in Slack)

**How it works:**
- Tokens are stored in `~/.claude/.bot-accounts.json` (auto-created, in `.gitignore`)
- Active account is injected via `CLAUDE_CODE_OAUTH_TOKEN` environment variable
- Token health is checked hourly with auto-refresh (OAuth rotation)
- Terminal CLI and bot stay in sync via bidirectional file watching

### System Memory Watchdog (Windows only)

Monitors system commit memory to prevent OOM crashes from runaway processes.

**Requirements:**
- Windows only (uses PowerShell `Get-CimInstance`)
- `ASSISTANT_DM_CHANNEL` must be set (notifications go to this channel)

**Environment variables (all optional):**
```env
MEMORY_WATCHDOG_ENABLED=1           # 0 to disable (default: enabled)
MEMORY_WATCHDOG_THRESHOLD_PCT=80    # System commit % to trigger alert
MEMORY_WATCHDOG_INTERVAL_SEC=300    # Check interval (default: 5 min)
MEMORY_WATCHDOG_AUTO_KILL_SEC=300   # Auto-kill if no response (default: 5 min)
```

When triggered, sends a Slack message with Kill/Ignore buttons. Auto-kills the largest non-system process after the timeout if no response.

### Session Auto-Start

Schedule automatic session starts to maximize Claude Pro/Max session windows.

**Setup:** Use `-schedule` in Slack — no environment variables needed. The block-based UI lets you add/remove times per account.

**Behavior:**
- Randomized jitter (+5~25 min) to avoid automation detection
- Auto follow-up 5 hours later for the next session window
- Non-working day skip (weekends + public holidays)
- Persisted in `.schedule-config.json`

## Known Limitations & Customization Notes

### Holiday Calendar

Public holiday detection is currently hardcoded to **South Korea** (`Holidays('KR')`) in `assistant-scheduler.ts` and `schedule-manager.ts`. To use a different country:

1. Edit `src/assistant-scheduler.ts` line 121: `new Holidays('KR')` → `new Holidays('US')` (or your [ISO 3166-1 country code](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2))
2. Edit `src/schedule-manager.ts` line 37: same change
3. Rebuild: `npm run build && pm2 restart claude-slack-bot`

> **Future improvement**: This should be configurable via environment variable (e.g., `HOLIDAYS_COUNTRY=US`). Contributions welcome.

### Platform-Specific Features

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Core bot | ✅ | ✅ | ✅ |
| Session management | ✅ | ✅ | ✅ |
| Assistant scheduler | ✅ | ✅ | ✅ |
| Calendar integration | ✅ | ✅ | ✅ |
| Memory watchdog | ✅ | — | — |

### Prompt Templates

The assistant scheduler requires prompt template files in `ASSISTANT_CONFIG_DIR/prompts/`. These are not included in the repository since they contain user-specific instructions (work context, preferences, etc.). You need to write your own prompts for:

- **Morning briefing** (`morning-briefing.md`) — What information to include in your daily summary
- **Calendar judgment** (`calendar-judgment.md`) — How to decide which events need reminders
- **Analysis types** (`analysis-*.md`) — What to analyze weekly (one file per analysis type)

## Project Structure

```
src/
├── index.ts                     # Entry point
├── config.ts                    # Environment variables and config
├── types.ts                     # TypeScript type definitions
├── cli-handler.ts               # Claude CLI process management (stream-json)
├── slack-handler.ts             # Slack event handling, command parsing
├── working-directory-manager.ts # Working directory management (persistence)
├── account-manager.ts           # Multi-account OAuth token management
├── schedule-manager.ts          # Session auto-start scheduler
├── assistant-scheduler.ts       # Assistant scheduler (briefing, reminders, analysis)
├── file-handler.ts              # File upload handling
├── session-scanner.ts           # Cross-project session scanning
├── messages.ts                  # i18n translation catalog (ko/en)
├── todo-manager.ts              # Task list management
├── mcp-manager.ts               # MCP server management
├── calendar-poller.ts           # Google Calendar direct HTTP polling
├── error-collector.ts           # Error collection for briefing reports
├── rate-limit-utils.ts          # Shared rate limit detection
├── process-memory-watchdog.ts   # System memory watchdog (Windows)
├── version.ts                   # Version info and update checker
└── logger.ts                    # Logging utility
```

## Troubleshooting

### Bot not responding
1. Restart: `pm2 restart claude-slack-bot` (or `stop.bat` → `start.bat` on Windows)
2. Check logs: `pm2 logs claude-slack-bot`
3. Verify `.env` token validity
4. Ensure bot is added to the channel

### "No working directory set" error
Set a working directory first with `-cwd <path>`.

### `npm install` fails on Windows
```bash
npm install --ignore-scripts
```

## Upstream Updates

```bash
git fetch upstream
git checkout main && git merge upstream/main
```

## License

MIT
