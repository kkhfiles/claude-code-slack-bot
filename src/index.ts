import * as path from 'path';
import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { CliHandler } from './cli-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';
import { installActivityLog, tagApp, tagToken } from './activity-log';
import { installPrivacyGuard } from './privacy-guard';
import { getVersionInfo, checkForUpdates } from './version';
import { ReportServer } from './report-server';

const logger = new Logger('Main');

// **봇이 띄운 세션이라는 표시** (2026-10-13). 세션이 이 프로세스의 환경을 물려받으므로
// 여기 한 번 심으면 대화·예약 세션 모두에 실린다. 사용자 설정의 훅이 이 표시를 보고
// 사람이 앉은 터미널에서만 할 일을 건너뛴다 — 세션 끝 동기화가 그랬다. Claude Code 는
// 세션 끝 훅을 1.5초까지 기다리고 봇 대화는 차례마다 세션이 끝나서, 답 뒤처리가 차례마다
// 1.76초(중앙) 늘어져 있었다.
process.env.CLAUDE_BOT_SESSION = '1';

async function start() {
  try {
    // Validate configuration
    validateConfig();

    const versionInfo = getVersionInfo();
    const versionTag = versionInfo.gitHash
      ? `v${versionInfo.version} (${versionInfo.gitHash}, ${versionInfo.gitDate})`
      : `v${versionInfo.version}`;

    logger.info(`Starting Claude Code Slack bot ${versionTag}`, {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // 봇이 한 일을 로컬에 남긴다. **슬랙에 붙기 전에** 길목을 감싸야 첫 말부터 잡힌다.
    installActivityLog();
    // 개인 글 문 — **활동 기록 다음에** 걸어야 가장 바깥이 된다(막힌 글은 활동 기록에도 안 남게).
    // 실장 2026-09-30 「DM 이나 콩에게 전달한 말이 타인이나 채널에 공유되면 절대 안 됨」.
    if (config.chat.turnScript) {
      const bots = path.join(path.dirname(config.chat.turnScript), 'bots');
      installPrivacyGuard({
        ownerUserId: config.letter.managerUserId,
        botsDir: bots,
        registryPath: path.join(bots, '_shared', 'data', 'private-registry.jsonl'),
        keyPath: path.join(bots, '_shared', 'data', 'private-registry.key'),
      });
    }

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });
    tagApp(app, 'assistant');
    tagToken(config.slack.botToken, 'assistant');

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();

    // Optionally start the local HTTP server (127.0.0.1) — 업무 칸반 · 수동 분석 실행
    let reportServer: ReportServer | undefined;
    if (config.reports.localServer.enabled && config.assistant.configDir) {
      const server = new ReportServer();
      try {
        await server.start(config.reports.localServer.port);
        reportServer = server;
      } catch (error) {
        logger.warn('Failed to start report server, continuing without it', error);
      }
    }

    // Initialize handlers
    const cliHandler = new CliHandler(mcpManager);
    const slackHandler = new SlackHandler(app, cliHandler, mcpManager, reportServer);

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();
    logger.info(`⚡️ Claude Code Slack bot ${versionTag} is running!`);
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });

    // Fire-and-forget update check (no startup delay)
    checkForUpdates().then((result) => {
      if (result && result.behindBy > 0) {
        logger.warn(`Update available: ${result.behindBy} commit(s) behind origin/main (latest: ${result.latestHash}). Run update.sh or update.bat to update.`);
      } else if (result && result.behindBy === 0) {
        logger.info('Up to date with origin/main.');
      }
    }).catch(() => {
      // Silently ignore update check failures
    });
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();