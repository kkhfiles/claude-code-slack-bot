import { App } from '@slack/bolt';
import { config, validateConfig } from './config';
import { CliHandler } from './cli-handler';
import { SlackHandler } from './slack-handler';
import { McpManager } from './mcp-manager';
import { Logger } from './logger';
import { getVersionInfo, checkForUpdates } from './version';

const logger = new Logger('Main');

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

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();

    // Initialize handlers
    const cliHandler = new CliHandler(mcpManager);
    const slackHandler = new SlackHandler(app, cliHandler, mcpManager);

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