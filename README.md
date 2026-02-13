# Claude Code Slack Bot

Run Claude Code on your local machine remotely from Slack and receive results in real time.
Forked from [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) with additional features.

## Features

- DM / channel mention / threaded conversations (automatic session continuity)
- Streaming responses (real-time message updates)
- File uploads (images, text, PDF, code files)
- CLI session resume/continue (`-sessions`, `-resume`, `-continue`)
- Mobile-friendly session picker (`resume`, `계속`) — browse and resume recent sessions with buttons
- Working directory management (persisted to disk, survives restarts)
- Model selection / cost control (`-model`, `-budget`, `-cost`)
- Plan mode (`-plan`) — review plans before execution
- Permission modes (Default / Safe / Trust) — interactive tool approval via Slack buttons
- Real-time progress display (current tool name + usage summary on completion)
- Rate limit detection with scheduled retry and automatic reset-time mention notification
- Automatic Korean/English UI based on Slack locale
- MCP server integration
- AWS Bedrock / Google Vertex AI support (optional)

### Fork Changes

- All commands use `-` prefix (`-cwd`, `-help`, `-sessions`, etc.)
- CLI session resume/continue (resume sessions started outside Slack)
- Mobile-friendly session picker across all projects (button selection, auto cwd switch)
- Model selection, cost limits, cost inquiry
- Plan mode: review-only plan → Execute button to proceed
- Permission modes: Default (interactive approval) / Safe (auto-approve edits) / Trust (auto-approve all)
- `-stop`: graceful interrupt via SDK `Query.interrupt()` (preserves session state)
- Real-time progress (`stream_event` for current tool name, usage summary on completion)
- Rate limit → Slack scheduled message retry + automatic mention notification at reset time
- i18n: Auto-detect Korean/English from Slack user locale (`users.info` API)
- Working directory persistence (`.working-dirs.json`)
- DM thread `-cwd` creates DM-level fallback automatically
- pm2-based process management

## Prerequisites

- Node.js 18+
- Claude Code CLI installed and logged in (`claude login`)
- Slack workspace admin access

## Installation

### 1. Clone and Install

```bash
git clone https://github.com/kkhfiles/claude-code-slack-bot.git
cd claude-code-slack-bot
git checkout custom
npm install              # macOS / Linux
npm install --ignore-scripts  # Windows (bypasses SDK platform check)
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

> No API key needed: Claude Code SDK uses local `claude login` authentication. Usage is billed to your Claude subscription (Pro/Max).

## Running

Uses [pm2](https://pm2.keymetrics.io/) for background execution. No separate terminal window needed, auto-restarts on crash.

```bash
npm install -g pm2   # One-time setup

# macOS / Linux
npm run build && pm2 start ecosystem.config.js

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

## Slack Commands

All commands start with `-` prefix. Use `-help` to see the full list.
Some commands also work without `-` for mobile convenience (e.g., `resume`, `계속`, `help`).

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
| `-r` / `resume` / `계속` | Recent sessions picker (mobile-friendly) |
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
| `-default` | Default mode: edits, bash, MCP require approval (default) |
| `-safe` | Safe mode: edits auto-approved, bash/MCP require approval |
| `-trust` | Trust mode: all tools auto-approved |

```
-plan analyze dependencies in pom.xml   # Plan only → Execute button
-safe                                    # Switch to safe mode
-trust                                   # Switch to trust mode
-default                                 # Back to default mode
```

**Plan mode flow:**
1. `-plan <prompt>` → Claude generates a plan (no file modifications)
2. Review the plan → click **Execute** to proceed
3. Or click **Cancel** to discard

**Permission modes:**
- **Default**: Edit, Write, Bash, MCP tools require Slack button approval (waits until user responds)
- **Safe**: Edit/Write auto-approved, Bash/MCP require approval
- **Trust**: All tools auto-approved (no prompts)

### Settings

| Command | Description |
|---------|-------------|
| `-model [name]` | Get/set model (`sonnet`, `opus`, `haiku`, or full name) |
| `-budget [amount\|off]` | Get/set/remove per-query cost limit (USD) |
| `-cost` | Show last query cost and session ID |

```
-model                # Show current model
-model sonnet         # Switch to sonnet (fast/cheap)
-model opus           # Switch to opus (high performance)
-budget 1.00          # Set $1.00 per-query limit
-budget off           # Remove limit
-cost                 # Show last cost
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

### Other

| Command | Description |
|---------|-------------|
| `help` or `-help` | Show full command list |

### Conversations

```
# Direct message
Explain the structure of this project

# Channel mention
@ClaudeBot analyze pom.xml

# Continue in thread (automatic session continuity)
Check for dependency conflicts
```

### File Uploads

Drag & drop or attach files for analysis:

- **Images**: JPG, PNG, GIF, WebP, SVG
- **Text**: TXT, MD, JSON, JS, TS, PY, Java, etc.
- **Documents**: PDF, DOCX (limited)
- **Code**: Most programming languages

### Rate Limit Retry

When Claude usage limits are reached, the bot automatically detects and offers retry via Slack scheduled messages:

1. Rate limit error → shows estimated wait time
2. Automatic `@mention` notification scheduled at reset time
3. Click "Schedule" → Slack delivers message at the specified time (mention notification auto-cancelled)
4. Bot receives the scheduled message and auto-executes

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
├── claude-handler.ts            # Claude Code SDK integration
├── slack-handler.ts             # Slack event handling
├── working-directory-manager.ts # Working directory management (persistence)
├── file-handler.ts              # File upload handling
├── session-scanner.ts           # Cross-project session scanning
├── messages.ts                  # i18n translation catalog (ko/en)
├── todo-manager.ts              # Task list management
├── mcp-manager.ts               # MCP server management
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
git checkout custom && git merge main
npm install --ignore-scripts
npm run build
```

## License

MIT
