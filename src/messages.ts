export type Locale = 'en' | 'ko';

const messages: Record<string, Record<Locale, string>> = {
  // --- Status messages ---
  'status.thinking': { en: '*Thinking...*', ko: '*생각 중...*' },
  'status.planning': { en: '*Planning...*', ko: '*계획 수립 중...*' },
  'status.writing': { en: '*Writing...*', ko: '*작성 중...*' },
  'status.usingTool': { en: '*Using {{toolName}}...*', ko: '*{{toolName}} 사용 중...*' },
  'status.usingToolCount': { en: '*Using {{toolName}}... ({{count}})*', ko: '*{{toolName}} 사용 중... ({{count}})*' },
  'status.taskCompleted': { en: '*Task completed*', ko: '*작업 완료*' },
  'status.planReady': { en: '*Plan ready*', ko: '*계획 완료*' },
  'status.errorOccurred': { en: '*Error occurred*', ko: '*오류 발생*' },
  'status.cancelled': { en: '*Cancelled*', ko: '*취소됨*' },

  // --- Command responses ---
  'cmd.stop.stopped': { en: 'Stopped.', ko: '중단됨.' },
  'cmd.stop.noActive': { en: 'No active query to stop.', ko: '실행 중인 쿼리가 없습니다.' },
  'cmd.reset.done': { en: 'Session reset. Next message will start a new conversation.', ko: '세션이 초기화되었습니다. 다음 메시지부터 새 대화가 시작됩니다.' },

  // Model
  'cmd.model.current': { en: 'Current model: `{{model}}`\n_Change: `-opus`/`-o`, `-sonnet`/`-s`, `-haiku`/`-h`, `-m default`. One-time: prefix `!o `, `!s `, `!h `_', ko: '현재 모델: `{{model}}`\n_변경: `-opus`/`-o`, `-sonnet`/`-s`, `-haiku`/`-h`, `-m default`. 일회성: `!o `, `!s `, `!h ` 프리픽스_' },
  'cmd.model.set': { en: 'Model set to `{{model}}`', ko: '모델을 `{{model}}`(으)로 설정했습니다' },
  'cmd.model.default': { en: 'default', ko: '기본값' },


  // Cost
  'cmd.cost.header': { en: '*Last query*', ko: '*마지막 쿼리*' },
  'cmd.cost.costLine': { en: 'Cost: ${{cost}}', ko: '비용: ${{cost}}' },
  'cmd.cost.durationLine': { en: 'Duration: {{duration}}s', ko: '소요 시간: {{duration}}초' },
  'cmd.cost.modelLine': { en: 'Model: `{{model}}`', ko: '모델: `{{model}}`' },
  'cmd.cost.sessionLine': { en: 'Session ID: `{{sessionId}}`', ko: '세션 ID: `{{sessionId}}`' },
  'cmd.cost.noData': { en: 'No query cost data yet.', ko: '아직 쿼리 비용 데이터가 없습니다.' },

  // Permission modes
  'cmd.defaultMode': {
    en: 'Default mode — Bash, file edits, and MCP tools require approval.\nUse `-safe` to auto-approve edits, or `-trust` to auto-approve all.',
    ko: '기본 모드 — Bash, 파일 편집, MCP 도구에 승인이 필요합니다.\n`-safe`로 편집 자동 승인, `-trust`로 모든 도구 자동 승인.',
  },
  'cmd.safeMode': {
    en: 'Safe mode — File edits auto-approved, Bash and MCP tools require approval.\nUse `-default` for full approval, or `-trust` to auto-approve all.',
    ko: '안전 모드 — 파일 편집 자동 승인, Bash와 MCP 도구에 승인 필요.\n`-default`로 모든 승인 필요, `-trust`로 모든 도구 자동 승인.',
  },
  'cmd.trustMode': {
    en: 'Trust mode — All tools auto-approved.\nUse `-default` or `-safe` to require approvals.',
    ko: '신뢰 모드 — 모든 도구 자동 승인.\n`-default` 또는 `-safe`로 승인 필요 모드로 전환.',
  },

  // Sessions
  'cmd.sessions.noCwd': { en: 'Set a working directory first (`-cwd <path>`) to list sessions.', ko: '세션 목록을 보려면 먼저 작업 디렉터리를 설정하세요 (`-cwd <경로>`).' },

  // MCP
  'cmd.mcp.reloadSuccess': { en: 'MCP configuration reloaded successfully.', ko: 'MCP 설정이 성공적으로 리로드되었습니다.' },
  'cmd.mcp.reloadFailed': { en: 'Failed to reload MCP configuration. Check the mcp-servers.json file.', ko: 'MCP 설정 리로드 실패. mcp-servers.json 파일을 확인하세요.' },

  // --- Working directory ---
  'cwd.set': { en: 'Working directory set for {{context}}: `{{path}}`', ko: '{{context}} 작업 디렉터리 설정: `{{path}}`' },
  'cwd.context.thread': { en: 'this thread', ko: '이 쓰레드' },
  'cwd.context.dm': { en: 'this conversation', ko: '이 대화' },
  'cwd.context.channel': { en: 'this channel', ko: '이 채널' },

  'cwd.noCwd': { en: 'No working directory set. ', ko: '작업 디렉터리가 설정되지 않았습니다. ' },
  'cwd.noCwd.channel': { en: 'Please set a default working directory for this channel first using:', ko: '먼저 이 채널의 기본 작업 디렉터리를 설정해주세요:' },
  'cwd.noCwd.thread': { en: 'You can set a thread-specific working directory using:\n`-cwd /path/to/directory`', ko: '쓰레드별 작업 디렉터리를 설정할 수 있습니다:\n`-cwd /경로/디렉터리`' },
  'cwd.noCwd.generic': { en: 'Please set one first using:\n`-cwd /path/to/directory`', ko: '먼저 설정해주세요:\n`-cwd /경로/디렉터리`' },
  'cwd.noCwd.relativeHint': { en: '`-cwd project-name` or `-cwd /absolute/path`\n\nBase directory: `{{baseDir}}`', ko: '`-cwd 프로젝트명` 또는 `-cwd /절대경로`\n\n기본 디렉터리: `{{baseDir}}`' },
  'cwd.noCwd.absoluteHint': { en: '`-cwd /path/to/directory`', ko: '`-cwd /경로/디렉터리`' },

  // formatDirectoryMessage
  'cwd.current': { en: 'Current working directory for {{context}}: `{{directory}}`', ko: '{{context}} 현재 작업 디렉터리: `{{directory}}`' },
  'cwd.baseDir': { en: 'Base directory: `{{baseDir}}`', ko: '기본 디렉터리: `{{baseDir}}`' },
  'cwd.relativeHint': { en: 'You can use relative paths like `-cwd project-name` or absolute paths.', ko: '`-cwd 프로젝트명` 같은 상대 경로 또는 절대 경로를 사용할 수 있습니다.' },
  'cwd.notSet': { en: 'No working directory set for {{context}}. Please set one using:', ko: '{{context}}에 작업 디렉터리가 설정되지 않았습니다. 다음 명령어로 설정해주세요:' },
  'cwd.notSet.relativeOption': { en: '`-cwd project-name` (relative to base directory)', ko: '`-cwd 프로젝트명` (기본 디렉터리 기준)' },
  'cwd.notSet.absoluteOption': { en: '`-cwd /absolute/path/to/directory` (absolute path)', ko: '`-cwd /절대경로/디렉터리` (절대 경로)' },
  'cwd.notSet.absoluteOnly': { en: '`-cwd /path/to/directory`', ko: '`-cwd /경로/디렉터리`' },

  // formatChannelSetupMessage
  'cwd.channelSetup.title': { en: '**Channel Working Directory Setup**', ko: '**채널 작업 디렉터리 설정**' },
  'cwd.channelSetup.prompt': { en: 'Please set the default working directory for #{{channel}}:', ko: '#{{channel}}의 기본 작업 디렉터리를 설정해주세요:' },
  'cwd.channelSetup.options': { en: '**Options:**', ko: '**옵션:**' },
  'cwd.channelSetup.usage': { en: '**Usage:**', ko: '**사용법:**' },
  'cwd.channelSetup.relativeOption': { en: '• `-cwd project-name` (relative to: `{{baseDir}}`)', ko: '• `-cwd 프로젝트명` (기준: `{{baseDir}}`)' },
  'cwd.channelSetup.absoluteOption': { en: '• `-cwd /absolute/path/to/project` (absolute path)', ko: '• `-cwd /절대경로/프로젝트` (절대 경로)' },
  'cwd.channelSetup.absoluteOnly': { en: '• `-cwd /path/to/project`', ko: '• `-cwd /경로/프로젝트`' },
  'cwd.channelSetup.defaultNote': { en: 'This becomes the default for all conversations in this channel.', ko: '이 채널의 모든 대화에서 기본으로 사용됩니다.' },
  'cwd.channelSetup.overrideNote': { en: 'Individual threads can override this by mentioning me with a different `-cwd` command.', ko: '개별 쓰레드에서 `-cwd` 명령어로 변경할 수 있습니다.' },

  // --- File upload ---
  'file.processing': { en: 'Processing {{count}} file(s): {{names}}', ko: '{{count}}개 파일 처리 중: {{names}}' },

  // --- Tool approval ---
  'approval.approve': { en: 'Approve', ko: '승인' },
  'approval.deny': { en: 'Deny', ko: '거부' },
  'approval.bash': { en: '*Approve Bash command?*', ko: '*Bash 명령어를 실행할까요?*' },
  'approval.edit': { en: '*Approve edit to* `{{path}}`?', ko: '`{{path}}` *편집을 승인할까요?*' },
  'approval.write': { en: '*Approve creating* `{{path}}`?', ko: '`{{path}}` *파일 생성을 승인할까요?*' },
  'approval.notebook': { en: '*Approve notebook edit to* `{{path}}`?', ko: '`{{path}}` *노트북 편집을 승인할까요?*' },
  'approval.mcp': { en: '*Approve MCP tool* `{{tool}}` _({{server}})_?', ko: '*MCP 도구* `{{tool}}` _({{server}})_ *을(를) 승인할까요?*' },
  'approval.generic': { en: '*Approve {{toolName}}?*', ko: '*{{toolName}}을(를) 승인할까요?*' },
  'approval.approved': { en: 'Approved', ko: '승인됨' },
  'approval.alwaysAllow': { en: 'Always Allow {{toolName}}', ko: '{{toolName}} 항상 허용' },
  'approval.alwaysAllowed': { en: '{{toolName}} will be auto-approved in this channel. Use `-default` to reset.', ko: '이 채널에서 {{toolName}}이(가) 자동 승인됩니다. `-default`로 초기화 가능.' },
  'approval.denied': { en: 'Denied', ko: '거부됨' },
  'approval.expired': { en: 'Approval expired (already auto-approved)', ko: '승인 만료 (자동 승인됨)' },

  // --- Tool display ---
  'tool.editing': { en: '*Editing `{{path}}`*', ko: '*`{{path}}` 편집 중*' },
  'tool.creating': { en: '*Creating `{{path}}`*', ko: '*`{{path}}` 생성 중*' },
  'tool.running': { en: '*Running command:*', ko: '*명령어 실행:*' },
  'tool.using': { en: '*Using {{toolName}}*', ko: '*{{toolName}} 사용 중*' },
  'tool.taskUpdate': { en: '*Task Update:*', ko: '*작업 업데이트:*' },

  // --- Plan mode ---
  'plan.complete': { en: 'Plan complete. Execute?', ko: '계획 완료. 실행할까요?' },
  'plan.readyExecute': { en: '*Plan ready.* Execute this plan?', ko: '*계획 완료.* 이 계획을 실행할까요?' },
  'plan.execute': { en: 'Execute', ko: '실행' },
  'plan.cancel': { en: 'Cancel', ko: '취소' },
  'plan.expired': { en: 'Plan expired. Please re-run.', ko: '계획이 만료되었습니다. 다시 실행해주세요.' },
  'plan.executing': { en: '*Executing plan...*', ko: '*계획 실행 중...*' },
  'plan.cancelled': { en: 'Cancelled.', ko: '취소되었습니다.' },

  // --- Session picker ---
  'picker.title': { en: '*Recent Sessions*', ko: '*최근 세션*' },
  'picker.noSessions': { en: 'No sessions found. Start a new conversation or use `-continue` to resume the last CLI session.', ko: '세션을 찾을 수 없습니다. 새 대화를 시작하거나 `-continue`로 마지막 CLI 세션을 재개하세요.' },
  'picker.resume': { en: '▶ Resume', ko: '▶ 재개' },
  'picker.footer': { en: '_`-continue`: resume last session · expires in 5 min_', ko: '_`-continue`: 마지막 세션 재개 · 5분 후 자동 만료_' },
  'picker.expired': { en: '_Session picker expired._', ko: '_세션 피커가 만료되었습니다._' },
  'picker.expiredAction': { en: 'Session picker expired. Use `-r` again.', ko: '세션 피커가 만료되었습니다. `-r`을 다시 사용해주세요.' },
  'picker.resuming': { en: '*Resuming:* {{title}}', ko: '*재개 중:* {{title}}' },
  'picker.noTitle': { en: '(no title)', ko: '(제목 없음)' },
  'picker.showMore': { en: 'Show more ({{count}})', ko: '더보기 ({{count}})' },
  'picker.moreAvailable': {
    en: '_{{remaining}} more session(s) not shown. Use `-cwd <path>` to switch to the project, then `-sessions` to list and `-resume <id>` to resume._',
    ko: '_{{remaining}}개 세션이 더 있습니다. `-cwd <경로>`로 해당 프로젝트로 이동 후 `-sessions`로 세션 ID 확인, `-resume <id>`로 재개하세요._',
  },

  // --- Sessions list ---
  'sessions.title': { en: '*Recent Sessions*', ko: '*최근 세션*' },
  'sessions.noSessions': { en: 'No sessions found for this working directory.', ko: '이 작업 디렉터리에 세션이 없습니다.' },
  'sessions.noPreview': { en: '(no preview)', ko: '(미리보기 없음)' },
  'sessions.resumeHint': { en: '_Use `-resume <session-id>` to resume a session._', ko: '_`-resume <세션ID>`로 세션을 재개할 수 있습니다._' },

  // --- Rate limit ---
  'rateLimit.reached': { en: '*Rate limit reached.*', ko: '*Rate limit에 도달했습니다.*' },
  'rateLimit.overloaded': { en: '*Claude servers are overloaded.*', ko: '*Claude 서버가 과부하 상태입니다.*' },
  'rateLimit.retryEstimate': { en: 'Estimated retry: *{{time}}* ({{minutes}} min later)', ko: '예상 재시도 시간: *{{time}}* ({{minutes}}분 후)' },
  'rateLimit.prompt': { en: '_Prompt: {{prompt}}_', ko: '_프롬프트: {{prompt}}_' },
  'rateLimit.cancel': { en: 'Cancel', ko: '취소' },

  // --- Version ---
  'cmd.version.title': { en: '*Bot Version*', ko: '*봇 버전*' },
  'cmd.version.version': { en: 'Version: `{{version}}`', ko: '버전: `{{version}}`' },
  'cmd.version.commit': { en: 'Commit: `{{hash}}` ({{date}})', ko: '커밋: `{{hash}}` ({{date}})' },
  'cmd.version.commitUnknown': { en: 'Commit: unknown (not a git repo)', ko: '커밋: 알 수 없음 (git 저장소 아님)' },
  'cmd.version.upToDate': { en: '✅ Up to date', ko: '✅ 최신 버전' },
  'cmd.version.updateAvailable': { en: '⬆️ Update available: {{count}} commit(s) behind (latest: `{{hash}}`)\nRun `update.sh` or `update.bat` to update.', ko: '⬆️ 업데이트 있음: {{count}}개 커밋 뒤처짐 (최신: `{{hash}}`)\n`update.sh` 또는 `update.bat`으로 업데이트하세요.' },
  'cmd.version.checkFailed': { en: '_Could not check for updates._', ko: '_업데이트 확인에 실패했습니다._' },

  // OAuth token health (계정 전환 · API 키 명령은 2026-10-14 에 걷었다)
  'account.tokenExpired': { en: '⚠️ *Token expired* for {{accounts}}. Log in again from the terminal: run `claude`, then `/login`.', ko: '⚠️ {{accounts}}의 *토큰이 만료*되었습니다. 터미널에서 다시 로그인해 주세요 — `claude` 실행 후 `/login`.' },

  // --- Error ---
  'error.generic': { en: 'Error: {{message}}', ko: '오류: {{message}}' },
  'error.somethingWrong': { en: 'Something went wrong', ko: '오류가 발생했습니다' },

  // --- Welcome (channel join) ---
  'welcome.greeting': { en: "Hi! I'm Claude Code, your AI coding assistant.", ko: '안녕하세요! Claude Code 코딩 어시스턴트입니다.' },
  'welcome.needCwd': { en: 'To get started, I need to know the default working directory for #{{channel}}.', ko: '#{{channel}}의 기본 작업 디렉터리를 설정해주세요.' },
  'welcome.useRelative': { en: 'You can use:\n• `-cwd project-name` (relative to base directory: `{{baseDir}}`)\n• `-cwd /absolute/path/to/project` (absolute path)', ko: '다음 명령어를 사용할 수 있습니다:\n• `-cwd 프로젝트명` (기본 디렉터리 기준: `{{baseDir}}`)\n• `-cwd /절대경로/프로젝트` (절대 경로)' },
  'welcome.useAbsolute': { en: 'Please set it using:\n• `-cwd /path/to/project`', ko: '다음 명령어로 설정해주세요:\n• `-cwd /경로/프로젝트`' },
  'welcome.channelDefault': { en: 'This will be the default working directory for this channel. You can always override it for specific threads with `-cwd`.', ko: '이 채널의 기본 작업 디렉터리가 됩니다. 특정 쓰레드에서 `-cwd`로 변경할 수 있습니다.' },
  'welcome.helpHint': { en: 'Type `-help` to see all available commands.', ko: '`-help`를 입력하면 모든 명령어를 볼 수 있습니다.' },

  // --- Relative time ---
  'time.justNow': { en: 'just now', ko: '방금 전' },
  'time.minutesAgo': { en: '{{n}} min ago', ko: '{{n}}분 전' },
  'time.hoursAgo': { en: '{{n}}h ago', ko: '{{n}}시간 전' },
  'time.daysAgo': { en: '{{n}}d ago', ko: '{{n}}일 전' },

  // --- MCP info ---
  'mcp.noServers': { en: 'No MCP servers configured.', ko: 'MCP 서버가 설정되지 않았습니다.' },
  'mcp.title': { en: '**MCP Servers Configured:**', ko: '**MCP 서버 설정:**' },
  'mcp.toolsPattern': { en: 'Available tools follow the pattern: `mcp__serverName__toolName`', ko: '사용 가능한 도구 패턴: `mcp__서버명__도구명`' },
  'mcp.approvalHint': { en: 'MCP tools require approval by default. Use `-trust` to auto-approve.', ko: 'MCP 도구는 기본적으로 승인이 필요합니다. `-trust`로 자동 승인 가능.' },

  // --- Todo list ---
  'todo.title': { en: '*Task List*', ko: '*작업 목록*' },
  'todo.empty': { en: 'No tasks defined yet.', ko: '아직 정의된 작업이 없습니다.' },
  'todo.inProgress': { en: '*🔄 In Progress:*', ko: '*🔄 진행 중:*' },
  'todo.pending': { en: '*⏳ Pending:*', ko: '*⏳ 대기 중:*' },
  'todo.completed': { en: '*✅ Completed:*', ko: '*✅ 완료:*' },
  'todo.progress': { en: '*Progress:* {{completed}}/{{total}} tasks completed ({{percent}}%)', ko: '*진행률:* {{completed}}/{{total}} 작업 완료 ({{percent}}%)' },
  'todo.added': { en: '➕ Added: {{content}}', ko: '➕ 추가됨: {{content}}' },
  'todo.removed': { en: '➖ Removed: {{content}}', ko: '➖ 삭제됨: {{content}}' },

  // --- Permission denial (CLI mode) ---
  'permission.denied': {
    en: 'Permission denied for: {{tools}}. The task was paused.',
    ko: '권한 거부됨: {{tools}}. 작업이 일시 중지되었습니다.',
  },
  'permission.allowTool': {
    en: 'Allow {{toolName}}',
    ko: '{{toolName}} 허용',
  },
  'permission.allowAllAndResume': {
    en: 'Allow All & Resume',
    ko: '모두 허용 & 계속',
  },
  'permission.resuming': {
    en: 'Resuming with approved tools...',
    ko: '승인된 도구로 재개 중...',
  },

  // --- Misc ---
  'misc.continuePrompt': { en: 'Continue where you left off.', ko: '이전에 하던 작업을 이어서 진행하세요.' },
  'misc.cancelled': { en: 'Cancelled.', ko: '취소되었습니다.' },
  'hint.threadStart': {
    en: '`-stop` cancel · `-reset` new session · `-plan` plan first · `-help` all commands',
    ko: '`-stop` 중단 · `-reset` 새 세션 · `-plan` 계획 먼저 · `-help` 전체 명령어',
  },
  'hint.resumeTerminal': {
    en: '💡 If this session is open in a terminal, close the terminal window instead of `/exit` to preserve Slack work.',
    ko: '💡 이 세션이 터미널에서 열려있다면 `/exit` 대신 터미널 창을 닫아주세요. `/exit`는 Slack 작업 내역을 덮어씁니다.',
  },

  // --- Assistant ---
  'assistant.briefingRunning': {
    en: '📋 Running briefing...',
    ko: '📋 브리핑 실행 중...',
  },
  'assistant.briefingScheduled': {
    en: 'Next briefing: {{time}}',
    ko: '다음 브리핑: {{time}}',
  },
  'assistant.configUpdated': {
    en: 'Assistant config updated.',
    ko: '어시스턴트 설정 업데이트됨.',
  },
  'assistant.configShow': {
    en: 'Current assistant configuration:',
    ko: '현재 어시스턴트 설정:',
  },
  'assistant.reminderPaused': {
    en: '⚠️ Calendar auth renewal needed — reminders paused',
    ko: '⚠️ 캘린더 인증 갱신 필요 — 리마인더 일시 중지됨',
  },
  'report.archiveRetired': {
    en: 'The archive button is retired — reports now stay in report-log per run (see desk). Only action proposals need a decision.',
    ko: '보관 버튼은 폐지됐습니다 — 보고서는 report-log 에 회차별로 쌓이고(desk 에서 봄), 결정은 처리 제안에서만 합니다.',
  },
  'assistant.analysisRunning': {
    en: '📊 Running {{type}} analysis...',
    ko: '📊 {{type}} 분석 실행 중...',
  },
  'assistant.notConfigured': {
    en: 'Assistant not configured. Set `ASSISTANT_DM_CHANNEL` and `ASSISTANT_CONFIG_DIR` in `.env`',
    ko: '어시스턴트 미설정. `.env`에 `ASSISTANT_DM_CHANNEL`, `ASSISTANT_CONFIG_DIR` 설정 필요',
  },
  'actions.readFailed': {
    en: 'Could not read report-log — check the bot log for `[ActionPipeline]`.',
    ko: 'report-log 를 읽지 못했습니다 — 봇 로그의 `[ActionPipeline]` 줄을 확인하세요.',
  },
  'actions.unavailable': {
    en: 'Action proposals are not set up — the report-log clone (`~/.report-log/repo`) is missing.',
    ko: '처리 제안이 설정되지 않았습니다 — report-log 자동 기록 클론(`~/.report-log/repo`)이 없습니다.',
  },
  'actions.empty': {
    en: '🗂 No action proposals need a decision.',
    ko: '🗂 결정이 필요한 처리 제안이 없습니다.',
  },
  'actions.reviewStarted': {
    en: '🔍 Reviewing queued proposals now — the summary comes by DM when done.',
    ko: '🔍 검토 대기 제안을 지금 검토합니다 — 끝나면 요약을 DM 으로 보냅니다.',
  },
  'actions.runStarted': {
    en: '▶️ Resuming proposals in progress — results come by DM.',
    ko: '▶️ 진행 중인 제안을 이어 갑니다 — 결과는 DM 으로 보냅니다.',
  },
  'actions.queued': {
    en: '⏳ Another round is running — this one follows right after.',
    ko: '⏳ 다른 차례가 도는 중입니다 — 끝나는 대로 이어서 돕니다.',
  },
  'analysis.running': {
    en: '🔬 Running analysis: {{type}}...',
    ko: '🔬 분석 실행 중: {{type}}...',
  },

  // Memory watchdog
  'watchdog.confirm': {
    en: ':warning: *System Memory Warning*\nCommit memory: {{committedMB}} MB / {{limitMB}} MB ({{pct}}%)\n\nTarget: `{{name}}` (PID {{pid}}, {{commitMB}} MB)\nAuto-kill in {{minutes}} min if no response.',
    ko: ':warning: *시스템 메모리 경고*\n커밋 메모리: {{committedMB}} MB / {{limitMB}} MB ({{pct}}%)\n\n대상: `{{name}}` (PID {{pid}}, {{commitMB}} MB)\n{{minutes}}분 후 응답 없으면 자동 종료.',
  },
  'watchdog.confirmProcess': {
    en: ':warning: *Process Memory Warning*\n`{{name}}` (PID {{pid}}) is using {{commitMB}} MB — over the per-process threshold ({{processThresholdMB}} MB).\nSystem commit: {{committedMB}} MB / {{limitMB}} MB ({{pct}}%).\nAuto-kill in {{minutes}} min if no response.',
    ko: ':warning: *프로세스 메모리 경고*\n`{{name}}` (PID {{pid}}) 가 {{commitMB}} MB 사용 중 — 프로세스 임계치({{processThresholdMB}} MB) 초과.\n시스템 커밋: {{committedMB}} MB / {{limitMB}} MB ({{pct}}%).\n{{minutes}}분 후 응답 없으면 자동 종료.',
  },
  'watchdog.killed': {
    en: ':skull: `{{name}}` (PID {{pid}}) killed — {{commitMB}} MB reclaimed.',
    ko: ':skull: `{{name}}` (PID {{pid}}) 종료됨 — {{commitMB}} MB 회수.',
  },
  'watchdog.ignored': {
    en: ':white_check_mark: `{{name}}` (PID {{pid}}) — kept.',
    ko: ':white_check_mark: `{{name}}` (PID {{pid}}) — 유지.',
  },
  'watchdog.autoKill': {
    en: ':skull: `{{name}}` (PID {{pid}}) auto-killed — no response in {{minutes}} min ({{commitMB}} MB).',
    ko: ':skull: `{{name}}` (PID {{pid}}) 자동 종료됨 — {{minutes}}분간 응답 없음 ({{commitMB}} MB).',
  },
  'watchdog.alreadyGone': {
    en: ':white_check_mark: `{{name}}` (PID {{pid}}) — already exited.',
    ko: ':white_check_mark: `{{name}}` (PID {{pid}}) — 이미 종료됨.',
  },
  'watchdog.excluded': {
    en: ':no_entry_sign: `{{name}}` (PID {{pid}}) — excluded from future watchdog alerts.',
    ko: ':no_entry_sign: `{{name}}` (PID {{pid}}) — 향후 워치독 감시에서 제외됨.',
  },
  'watchdog.review': {
    en: ':robot_face: Review ({{source}}): {{reason}}',
    ko: ':robot_face: 검토({{source}}): {{reason}}',
  },
  'watchdog.alertOnly': {
    en: ':warning: *System Memory Warning — no auto-kill*\nCommit memory: {{committedMB}} MB / {{limitMB}} MB ({{pct}}%)\n{{review}}\nTop users: {{top}}',
    ko: ':warning: *시스템 메모리 경고 — 자동 종료 안 함*\n커밋 메모리: {{committedMB}} MB / {{limitMB}} MB ({{pct}}%)\n{{review}}\n많이 쓰는 것: {{top}}',
  },
  'watchdog.cancelled': {
    en: ':white_check_mark: `{{name}}` (PID {{pid}}) — pressure eased ({{now}}), not killed.',
    ko: ':white_check_mark: `{{name}}` (PID {{pid}}) — 압박이 풀려({{now}}) 종료하지 않았습니다.',
  },
};

/**
 * Translate a message key with optional parameter interpolation.
 * Falls back to English if the key is missing for the given locale,
 * and returns the key itself if not found at all.
 */
export function t(key: string, locale: Locale, params?: Record<string, string | number>): string {
  const template = messages[key]?.[locale] ?? messages[key]?.['en'] ?? key;
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? `{{${k}}}`));
}

/**
 * Format a date as locale-appropriate time string (HH:MM).
 */
export function formatTime(date: Date, locale: Locale): string {
  const loc = locale === 'ko' ? 'ko-KR' : 'en-US';
  return date.toLocaleString(loc, { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date as locale-appropriate short date + time string.
 */
export function formatDateTime(date: Date, locale: Locale): string {
  const loc = locale === 'ko' ? 'ko-KR' : 'en-US';
  return date.toLocaleString(loc, { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date as locale-appropriate short date string.
 */
export function formatShortDate(date: Date, locale: Locale): string {
  const loc = locale === 'ko' ? 'ko-KR' : 'en-US';
  return date.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' });
}

/**
 * Build the full help text for the given locale.
 */
export function getHelpText(locale: Locale): string {
  if (locale === 'ko') {
    let help = `*Claude Code Bot — 명령어*\n\n`;
    help += `*작업 디렉터리*\n`;
    help += `\`-cwd <경로>\` — 작업 디렉터리 설정 (상대/절대 경로)\n`;
    help += `\`-cwd\` — 현재 작업 디렉터리 표시\n\n`;
    help += `*세션*\n`;
    help += `\`-r\` / \`resume\` / \`continue\` / \`계속\` — 최근 세션 피커 (모바일 친화)\n`;
    help += `\`-c\` / \`-continue [메시지]\` — 마지막 CLI 세션 재개\n`;
    help += `\`-resume <세션ID>\` — 특정 세션 재개\n`;
    help += `\`-sessions\` / \`세션\` — 현재 cwd의 세션 목록\n`;
    help += `\`-sessions all\` / \`세션 전체\` — 전체 프로젝트 세션 목록\n`;
    help += `\`-stop\` — 실행 중인 쿼리 중단 (graceful interrupt)\n`;
    help += `\`-reset\` / \`초기화\` — 세션 종료 (다음 메시지부터 새 대화)\n\n`;
    help += `*계획 및 권한*\n`;
    help += `\`-plan <프롬프트>\` / \`계획 <프롬프트>\` — 계획만 수립 (읽기 전용, 실행 안 함)\n`;
    help += `\`-d\` / \`-default\` / \`기본\` — 기본 모드: 편집, Bash, MCP 승인 필요 (기본값)\n`;
    help += `\`-safe\` / \`안전\` — 안전 모드: 편집 자동 승인, Bash/MCP 승인 필요\n`;
    help += `\`-trust\` / \`신뢰\` — 신뢰 모드: 모든 도구 자동 승인\n\n`;
    help += `*설정*\n`;
    help += `\`-m\` / \`-model [이름]\` / \`모델\` — 모델 조회/설정 (\`sonnet\`, \`opus\`, \`haiku\`, \`default\`)\n`;
    help += `\`-opus\` / \`-o\`, \`-sonnet\` / \`-s\`, \`-haiku\` / \`-h\` — 채널 모델을 한 번에 전환\n`;
    help += `\`!o <prompt>\`, \`!s <prompt>\`, \`!h <prompt>\` — 이 메시지 한 번만 다른 모델로 실행\n`;
    help += `\`-cost\` / \`비용\` — 마지막 쿼리 비용 및 세션 ID\n`;
    help += `\`-engines\` — 엔진 상태 (막힘 · 풀리는 시각 · 마지막 성공 · 사용률 · 연습 중인가)\n`;
    help += `\`-v\` / \`-version\` / \`버전\` — 봇 버전 및 업데이트 확인\n\n`;
    help += `*MCP*\n`;
    help += `\`-mcp\` — MCP 서버 상태 표시\n`;
    help += `\`-mcp reload\` — MCP 설정 리로드\n\n`;

    help += `*어시스턴트*\n`;
    help += `\`-br\` / \`-briefing\` / \`브리핑\` — 브리핑 즉시 실행\n`;
    help += `\`-rp\` / \`-report [타입]\` — 처리 제안 요약 · desk 의 보고서 링크\n`;
    help += `\`-actions\` — 결정이 필요한 처리 제안 · \`-actions review\` 지금 검토 · \`-actions run\` 멈춘 제안 이어 가기\n`;
    help += `\`-as config\` / \`-assistant config\` — 어시스턴트 설정 표시\n`;
    help += `\`-as briefing HH:MM\` — 브리핑 시간 변경\n`;
    help += `\`-as reminder N\` — 리마인더 사전 알림 시간(분) 변경\n\n`;

    help += `*팁*\n`;
    help += `• 같은 쓰레드 = 세션 자동 연속 (명령어 불필요)\n`;
    help += `• 파일 드래그 앤 드롭으로 업로드 및 분석\n`;
    help += `• Rate limit → 풀리는 시각 안내 · 업무 비서가 연결돼 있으면 밀린 요청을 그때 다시 실행\n`;
    help += `• \`help\` 또는 \`-help\` — 이 메시지 표시\n`;
    return help;
  }

  // English (default)
  let help = `*Claude Code Bot — Commands*\n\n`;
  help += `*Working Directory*\n`;
  help += `\`-cwd <path>\` — Set working directory (relative or absolute)\n`;
  help += `\`-cwd\` — Show current working directory\n\n`;
  help += `*Session*\n`;
  help += `\`-r\` / \`resume\` / \`continue\` / \`계속\` — Recent sessions picker (mobile-friendly)\n`;
  help += `\`-c\` / \`-continue [message]\` — Resume last CLI session\n`;
  help += `\`-resume <session-id>\` — Resume a specific session\n`;
  help += `\`-sessions\` — List sessions for current cwd\n`;
  help += `\`-sessions all\` — List sessions across all projects\n`;
  help += `\`-stop\` — Cancel the running query (graceful interrupt)\n`;
  help += `\`-reset\` — End current session (next message starts fresh)\n\n`;
  help += `*Plan & Permissions*\n`;
  help += `\`-plan <prompt>\` — Plan only (read-only, no execution)\n`;
  help += `\`-d\` / \`-default\` — Default: edits, bash, MCP require approval (default)\n`;
  help += `\`-safe\` — Safe: edits auto-approved, bash/MCP require approval\n`;
  help += `\`-trust\` — Trust: all tools auto-approved\n\n`;
  help += `*Settings*\n`;
  help += `\`-m\` / \`-model [name]\` — Get/set model (\`sonnet\`, \`opus\`, \`haiku\`, \`default\`)\n`;
  help += `\`-opus\` / \`-o\`, \`-sonnet\` / \`-s\`, \`-haiku\` / \`-h\` — Switch channel model in one shot\n`;
  help += `\`!o <prompt>\`, \`!s <prompt>\`, \`!h <prompt>\` — Run this single message with a different model\n`;
  help += `\`-cost\` — Show last query cost and session ID\n`;
  help += `\`-engines\` — Engine status (blocked · resets · last success · usage · drill)\n`;
  help += `\`-v\` / \`-version\` — Show bot version and check for updates\n\n`;
  help += `*MCP*\n`;
  help += `\`-mcp\` — Show MCP server status\n`;
  help += `\`-mcp reload\` — Reload MCP configuration\n\n`;

  help += `*Assistant*\n`;
  help += `\`-br\` / \`-briefing\` — Run briefing now\n`;
  help += `\`-rp\` / \`-report [type]\` — Action proposal summary · link to reports on desk\n`;
  help += `\`-actions\` — Action proposals awaiting a decision · \`-actions review\` review now · \`-actions run\` resume stalled ones\n`;
  help += `\`-an\` / \`-analyze [type]\` — Run analysis (single type or all)\n`;
  help += `\`-as config\` / \`-assistant config\` — Show assistant configuration\n`;
  help += `\`-as briefing HH:MM\` — Change briefing time\n`;
  help += `\`-as reminder N\` — Change reminder lead time (minutes)\n\n`;

  help += `*Tips*\n`;
  help += `• Same thread = session auto-continues (no command needed)\n`;
  help += `• Drag & drop files to upload and analyze\n`;
  help += `• Rate limit → shows the reset time; with the work assistant connected, held requests re-run then\n`;
  help += `• \`help\` or \`-help\` — Show this message\n`;
  return help;
}
