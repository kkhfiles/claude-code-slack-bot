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
  'cmd.model.current': { en: 'Current model: `{{model}}`\n_Use `-model <name>` to change (`sonnet`, `opus`, `haiku`)_', ko: '현재 모델: `{{model}}`\n_`-model <이름>`으로 변경 (`sonnet`, `opus`, `haiku`)_' },
  'cmd.model.set': { en: 'Model set to `{{model}}`', ko: '모델을 `{{model}}`(으)로 설정했습니다' },
  'cmd.model.default': { en: 'default (determined by Claude Code)', ko: '기본 (Claude Code가 자동 결정)' },

  // Budget
  'cmd.budget.current': { en: 'Max budget: ${{amount}} per query\n_Use `-budget <amount>` to change, `-budget off` to remove_', ko: '쿼리당 최대 예산: ${{amount}}\n_`-budget <금액>` 변경, `-budget off` 해제_' },
  'cmd.budget.none': { en: 'No budget limit set\n_Use `-budget <amount>` to set (e.g., `-budget 1.00`)_', ko: '예산 제한 없음\n_`-budget <금액>`으로 설정 (예: `-budget 1.00`)_' },
  'cmd.budget.removed': { en: 'Budget limit removed', ko: '예산 제한이 해제되었습니다' },
  'cmd.budget.set': { en: 'Max budget set to ${{amount}} per query', ko: '쿼리당 최대 예산을 ${{amount}}(으)로 설정했습니다' },

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
  'rateLimit.retryEstimate': { en: 'Estimated retry: *{{time}}* ({{minutes}} min later)', ko: '예상 재시도 시간: *{{time}}* ({{minutes}}분 후)' },
  'rateLimit.prompt': { en: '_Prompt: {{prompt}}_', ko: '_프롬프트: {{prompt}}_' },
  'rateLimit.schedule': { en: 'Schedule ({{time}})', ko: '예약 ({{time}})' },
  'rateLimit.cancel': { en: 'Cancel', ko: '취소' },
  'rateLimit.autoNotify': { en: '_You will be automatically notified when the limit resets._', ko: '_리셋 시간에 자동으로 알림을 보내드립니다._' },
  'rateLimit.notify': { en: '<@{{user}}> Rate limit lifted. You can send a new message to Claude.', ko: '<@{{user}}> Rate limit이 해제되었습니다. Claude에게 새 메시지를 보낼 수 있습니다.' },
  'rateLimit.scheduled': { en: 'Retry scheduled at {{time}}.', ko: '{{time}}에 재실행이 예약되었습니다.' },
  'rateLimit.retryExpired': { en: 'Retry info expired. Please resend your message manually.', ko: '재시도 정보가 만료되었습니다. 수동으로 메시지를 재전송해주세요.' },

  'rateLimit.continueWithApiKey': { en: 'Continue with API key', ko: 'API 키로 계속' },

  // Rate limit modal
  'rateLimit.modalTitle': { en: 'Schedule Retry', ko: '예약 재시도' },
  'rateLimit.modalSubmit': { en: 'Schedule ({{time}})', ko: '예약 ({{time}})' },
  'rateLimit.modalClose': { en: 'Cancel', ko: '취소' },
  'rateLimit.modalBody': { en: 'Will resend the prompt at *{{time}}*.\nEdit if needed.', ko: '*{{time}}*에 아래 프롬프트를 재전송합니다.\n필요하면 편집하세요.' },
  'rateLimit.modalLabel': { en: 'Prompt', ko: '프롬프트' },

  // API key
  'apiKey.modalTitle': { en: 'API Key', ko: 'API 키' },
  'apiKey.modalSubmit': { en: 'Save', ko: '저장' },
  'apiKey.modalClose': { en: 'Cancel', ko: '취소' },
  'apiKey.modalBody': { en: 'Enter your Anthropic API key. It will be stored locally and used when the subscription rate limit is reached.', ko: 'Anthropic API 키를 입력하세요. 로컬에 저장되며 구독 rate limit 초과 시 사용됩니다.' },
  'apiKey.modalLabel': { en: 'API Key', ko: 'API 키' },
  'apiKey.saved': { en: 'API key saved.', ko: 'API 키가 저장되었습니다.' },
  'apiKey.savedAndRetrying': { en: 'API key saved. Retrying with API key...', ko: 'API 키 저장됨. API 키로 재시도 중...' },
  'apiKey.switchingToApiKey': { en: 'Switching to API key. Retrying...', ko: 'API 키로 전환합니다. 재시도 중...' },
  'apiKey.switchingToSubscription': { en: 'Rate limit reset. Switching back to subscription auth.', ko: 'Rate limit이 해제되었습니다. 구독 인증 방식으로 전환합니다.' },
  'apiKey.noKey': { en: 'No API key registered. Enter one to continue.', ko: '등록된 API 키가 없습니다. 입력해주세요.' },

  // --- Schedule ---
  'schedule.sessionStart': { en: '🌅 Starting new Claude session...', ko: '🌅 새 Claude 세션을 시작합니다...' },
  'schedule.noConfig': { en: 'No session schedule configured. Use `-schedule add <hour>` to add a time (e.g., `-schedule add 6`).', ko: '설정된 세션 시작 시간이 없습니다. `-schedule add <시간>`으로 추가하세요 (예: `-schedule add 6`).' },
  'schedule.status.header': { en: '*Session Auto-Start*', ko: '*세션 자동 시작*' },
  'schedule.status.channel': { en: 'Target: <#{{channel}}>', ko: '대상 채널: <#{{channel}}>' },
  'schedule.status.times': { en: 'Times: {{times}} (auto-sent between :05~:25)', ko: '예약 시간: {{times}} (실제 전송: 매 정시 +5~25분)' },
  'schedule.status.next': { en: 'Next: `{{time}}` (~{{minutes}} min)', ko: '다음 전송: `{{time}}` 전후 (약 {{minutes}}분 후)' },
  'schedule.status.noTimes': { en: 'No times set.', ko: '설정된 시간 없음.' },
  'schedule.status.hint': { en: '_`-schedule add <hour>` to add, `-schedule remove <hour>` to remove, `-schedule clear` to reset_', ko: '_`-schedule add <시간>` 추가, `-schedule remove <시간>` 제거, `-schedule clear` 초기화_' },
  'schedule.added': { en: '✅ `{{hour}}` added. A greeting will be auto-sent between {{hour}}:05 and {{hour}}:25 to start the session. Target: <#{{channel}}>', ko: '✅ {{hour}}시 추가됨. {{hour}}시 세션 시작을 위해 {{hour}}:05~{{hour}}:25 사이에 첫 메시지가 자동 전송됩니다. 대상: <#{{channel}}>' },
  'schedule.alreadyExists': { en: '`{{time}}` is already configured.', ko: '`{{time}}`은 이미 설정되어 있습니다.' },
  'schedule.conflictWithExisting': { en: '`{{time}}` falls within the 5-hour session window of `{{existing}}`. Remove `{{existing}}` first with `-schedule remove {{existingHour}}`.', ko: '`{{time}}`은 `{{existing}}`의 5시간 세션 범위 안에 있어 의미가 없습니다. 먼저 `-schedule remove {{existingHour}}`로 기존 시간을 제거하세요.' },
  'schedule.removed': { en: '✅ Removed `{{time}}`.', ko: '✅ `{{time}}` 제거됨.' },
  'schedule.notFound': { en: '`{{time}}` not found.', ko: '`{{time}}`이 설정에 없습니다.' },
  'schedule.cleared': { en: '✅ All session start times cleared.', ko: '✅ 모든 세션 시작 시간이 초기화되었습니다.' },
  'schedule.invalidTime': { en: 'Invalid time. Use an hour (e.g., `6`, `16`).', ko: '잘못된 시간. 시(hour)를 입력하세요 (예: `6`, `16`).' },
  'schedule.channelUpdated': { en: '✅ Target channel updated to <#{{channel}}>.', ko: '✅ 대상 채널이 <#{{channel}}>으로 변경되었습니다.' },
  'schedule.noConfigForChannel': { en: 'No session start configured. Add a time first with `-schedule add <hour>`.', ko: '설정된 세션 시작이 없습니다. `-schedule add <시간>`으로 먼저 추가하세요.' },

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
    help += `\`-continue [메시지]\` — 마지막 CLI 세션 재개\n`;
    help += `\`-resume <세션ID>\` — 특정 세션 재개\n`;
    help += `\`-sessions\` — 현재 cwd의 세션 목록\n`;
    help += `\`-sessions all\` — 전체 프로젝트 세션 목록\n`;
    help += `\`-stop\` — 실행 중인 쿼리 중단 (graceful interrupt)\n`;
    help += `\`-reset\` — 세션 종료 (다음 메시지부터 새 대화)\n\n`;
    help += `*계획 및 권한*\n`;
    help += `\`-plan <프롬프트>\` — 계획만 수립 (읽기 전용, 실행 안 함)\n`;
    help += `\`-default\` — 기본 모드: 편집, Bash, MCP 승인 필요 (기본값)\n`;
    help += `\`-safe\` — 안전 모드: 편집 자동 승인, Bash/MCP 승인 필요\n`;
    help += `\`-trust\` — 신뢰 모드: 모든 도구 자동 승인\n\n`;
    help += `*설정*\n`;
    help += `\`-model [이름]\` — 모델 조회/설정 (\`sonnet\`, \`opus\`, \`haiku\`)\n`;
    help += `\`-budget [금액|off]\` — 쿼리당 최대 예산 조회/설정/해제 (USD)\n`;
    help += `\`-cost\` — 마지막 쿼리 비용 및 세션 ID\n\n`;
    help += `*MCP*\n`;
    help += `\`-mcp\` — MCP 서버 상태 표시\n`;
    help += `\`-mcp reload\` — MCP 설정 리로드\n`;
    help += `\`-apikey\` — API 키 등록/수정 (rate limit 시 자동 전환용)\n`;
    help += `\`-schedule\` — 세션 자동 시작 설정 조회\n`;
    help += `\`-schedule add <시간>\` — 세션 시작 시간 추가 (예: \`-schedule add 6\`)\n`;
    help += `\`-schedule remove <시간>\` — 시간 제거\n`;
    help += `\`-schedule clear\` — 전체 초기화\n`;
    help += `\`-schedule channel\` — 현재 채널을 대상으로 업데이트\n\n`;
    help += `*팁*\n`;
    help += `• 같은 쓰레드 = 세션 자동 연속 (명령어 불필요)\n`;
    help += `• 파일 드래그 앤 드롭으로 업로드 및 분석\n`;
    help += `• Rate limit → API 키 전환 또는 예약 재시도\n`;
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
  help += `\`-continue [message]\` — Resume last CLI session\n`;
  help += `\`-resume <session-id>\` — Resume a specific session\n`;
  help += `\`-sessions\` — List sessions for current cwd\n`;
  help += `\`-sessions all\` — List sessions across all projects\n`;
  help += `\`-stop\` — Cancel the running query (graceful interrupt)\n`;
  help += `\`-reset\` — End current session (next message starts fresh)\n\n`;
  help += `*Plan & Permissions*\n`;
  help += `\`-plan <prompt>\` — Plan only (read-only, no execution)\n`;
  help += `\`-default\` — Default: edits, bash, MCP require approval (default)\n`;
  help += `\`-safe\` — Safe: edits auto-approved, bash/MCP require approval\n`;
  help += `\`-trust\` — Trust: all tools auto-approved\n\n`;
  help += `*Settings*\n`;
  help += `\`-model [name]\` — Get/set model (\`sonnet\`, \`opus\`, \`haiku\`)\n`;
  help += `\`-budget [amount|off]\` — Get/set/remove max budget per query (USD)\n`;
  help += `\`-cost\` — Show last query cost and session ID\n\n`;
  help += `*MCP*\n`;
  help += `\`-mcp\` — Show MCP server status\n`;
  help += `\`-mcp reload\` — Reload MCP configuration\n`;
  help += `\`-apikey\` — Register/update API key (auto-switch on rate limit)\n`;
  help += `\`-schedule\` — View session auto-start settings\n`;
  help += `\`-schedule add <hour>\` — Add session start time (e.g., \`-schedule add 6\`)\n`;
  help += `\`-schedule remove <hour>\` — Remove a time\n`;
  help += `\`-schedule clear\` — Clear all scheduled times\n`;
  help += `\`-schedule channel\` — Set current channel as target\n\n`;
  help += `*Tips*\n`;
  help += `• Same thread = session auto-continues (no command needed)\n`;
  help += `• Drag & drop files to upload and analyze\n`;
  help += `• Rate limit → switch to API key or scheduled retry\n`;
  help += `• \`help\` or \`-help\` — Show this message\n`;
  return help;
}
