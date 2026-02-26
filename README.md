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

### Rate Limit Handling & API Key Fallback

When Claude subscription limits are reached:

1. **Continue with API key** — Switch to your registered API key immediately
2. **Schedule retry** — Slack delivers your message at the estimated reset time
3. **Cancel** — Discard the pending message

Pre-register your API key with `-apikey` so it's ready when needed. The modal also lets you set an optional **spending limit** — the bot auto-deactivates API key mode when the limit is reached. The bot automatically reverts to subscription auth when the rate limit resets. A `@mention` notification is scheduled at the reset time (auto-cancelled if you retry or cancel).

When API key mode is active, each query's cost is tracked and shown in the completion message (`✅ Task completed (Grep ×3) | 🔑 $0.0023 (total: $0.0145)`). Use `-limit` to view or adjust the spending limit at any time.

### Session Auto-Start

Claude Pro/Max subscriptions have daily session limits (e.g., 3 sessions × 5-hour windows). Register a single time — about **3 hours before your workday starts** — and the bot covers two session windows automatically:

```
-schedule add 4        # For early starters (sessions ~4:10 and ~9:10)
-schedule add 5        # For typical starters (sessions ~5:10 and ~10:10)
-schedule add 6        # For late starters   (sessions ~6:10 and ~11:10)
```

**How it works:**
- At the scheduled hour, the bot sends a minimal greeting to Claude (randomized message, randomized timing within +5~25 min of the set hour)
- **Auto follow-up**: 5 hours after the first trigger fires, the bot automatically sends a second greeting to start the next session window — no need to register multiple times
- Uses `claude-haiku-4-5-20251001` model for minimal token cost
- Schedule repeats daily, persisted in `.schedule-config.json`

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
| `-model [name]` | Get/set model (`sonnet`, `opus`, `haiku`, or full name) |
| `-cost` | Show last query cost and session ID |
| `-apikey` | Register API key for rate limit fallback; optional spending limit field |
| `-limit [amount]` | View/set API key spending limit (e.g., `-limit 2.00`) |
| `-limit clear` | Remove spending limit |
| `-version` | Show bot version and check for updates |

### Session Auto-Start

| Command | Description |
|---------|-------------|
| `-schedule` | Show current settings (times, target channel, next fire) |
| `-schedule add <hour>` | Add a session start hour (e.g., `-schedule add 6`) |
| `-schedule remove <hour>` | Remove a time |
| `-schedule clear` | Clear all session start times |

```
-schedule add 5         # ~3h before 9am start → auto-triggers at ~5:10 and ~10:10
-schedule               # Show status (times + next fire)
-schedule remove 5      # Remove
-schedule clear         # Clear all
```

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

## Project Structure

```
src/
├── index.ts                     # Entry point
├── config.ts                    # Environment variables and config
├── types.ts                     # TypeScript type definitions
├── cli-handler.ts               # Claude CLI process management (stream-json)
├── slack-handler.ts             # Slack event handling, command parsing
├── working-directory-manager.ts # Working directory management (persistence)
├── schedule-manager.ts          # Session auto-start scheduler
├── file-handler.ts              # File upload handling
├── session-scanner.ts           # Cross-project session scanning
├── messages.ts                  # i18n translation catalog (ko/en)
├── todo-manager.ts              # Task list management
├── mcp-manager.ts               # MCP server management
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
