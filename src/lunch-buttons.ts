import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import { tagApp, tagToken } from './activity-log';

/**
 * Listens for button clicks on the lunch bot's recruitment message.
 *
 * The lunch bot is a *separate* Slack app with its own identity and token, so
 * this opens its own Socket Mode connection rather than reusing this bot's.
 * Only the app-level token comes from the environment — the bot token is read
 * from the lunch bot's own `config.json`, so the secret has a single home.
 *
 * Buttons are used only for one-shot actions. Participation stays on emoji
 * reactions: Slack keeps the reaction list on the message (that list *is* the
 * roster), but it does not record who pressed a button.
 */
/**
 * 점심봇의 봇 토큰은 그 봇의 config.json 에 있다 — 비밀은 집이 하나여야 한다.
 * 버튼 수신부와 채널 대화부가 같이 쓰므로 여기 한 벌만 둔다.
 */
export function readLunchBotToken(scriptPath: string): string | null {
  const configPath = path.join(path.dirname(scriptPath), 'config.json');
  try {
    const token = JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.bot_token;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * 점심봇이 **공지를 올리라고 넣어 둔 방.** 봇 설정에 이미 있으므로 여기서 읽는다 —
 * 같은 사실을 `.env` 에 또 적으면 한쪽만 고쳐진다.
 */
export function readLunchAnnounceChannel(scriptPath: string): string {
  const configPath = path.join(path.dirname(scriptPath), 'config.json');
  try {
    const room = JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.announce_channel_id;
    return typeof room === 'string' ? room : '';
  } catch {
    return '';
  }
}

export class LunchButtons {
  private app: App | null = null;
  private logger = new Logger('LunchButtons');

  constructor(
    private readonly pythonPath: string,
    private readonly scriptPath: string,
    private readonly appToken: string,
  ) {}

  /** Bot token lives in the lunch bot's config.json — one source of truth. */
  private readBotToken(): string | null {
    const token = readLunchBotToken(this.scriptPath);
    if (!token) this.logger.warn('Could not read the lunch bot token from its config.json');
    return token;
  }

  /**
   * Hang the button handler on an app someone else already owns.
   *
   * **One app token means one Socket Mode connection.** Slack hands each event
   * to exactly one open connection for an app, so a second connection does not
   * duplicate events — it steals about half of them. While the buttons ran on
   * their own connection, roughly every other @mention went to the button
   * listener, which has no message handler, and vanished without a trace: the
   * chat side logged nothing because the event never arrived there. Buttons
   * looked fine and mentions looked ignored, which reads like a sulking bot
   * rather than a wiring fault.
   */
  register(app: App): void {
    app.action('lunch_reco', async ({ ack, body }) => {
      // Slack drops the interaction if we do not answer within 3 seconds, so
      // acknowledge first and let the recommendation run on its own time.
      await ack();
      const user = (body as { user?: { id?: string } }).user?.id;
      this.logger.info(`Lunch recommendation requested by ${user ?? 'unknown'}`);
      // The script tells the clicker what is happening (a private "working on
      // it" line). Slack shows nothing on a button press, so without that
      // people assume it is broken and keep clicking.
      this.run('reco', 5 * 60 * 1000, user ? ['--user', user] : []);
    });
    this.logger.info('Lunch buttons attached (sharing the chat connection)');
  }

  /** Own connection. Only for when the channel chat host is not running. */
  async start(): Promise<void> {
    if (this.app) return;

    const botToken = this.readBotToken();
    if (!botToken) {
      this.logger.warn('Lunch buttons disabled: no bot token');
      return;
    }

    const app = new App({
      token: botToken,
      appToken: this.appToken,
      socketMode: true,
    });
    tagApp(app, 'lunch');
    tagToken(botToken, 'lunch');
    this.register(app);

    try {
      await app.start();
      this.app = app;
      this.logger.info('Lunch buttons listening (own Socket Mode connection)');
    } catch (error) {
      this.logger.warn('Failed to start lunch button listener', error);
    }
  }

  async stop(): Promise<void> {
    if (!this.app) return;
    try {
      await this.app.stop();
    } catch (error) {
      this.logger.warn('Failed to stop lunch button listener', error);
    }
    this.app = null;
  }

  /**
   * Fire the lunch bot command. Deliberately not awaited by the click handler:
   * the recommendation calls out to an AI model and takes a minute or two,
   * while the click must be acknowledged immediately.
   */
  private run(command: string, timeoutMs: number, args: string[] = []): void {
    const child = spawn(this.pythonPath, [this.scriptPath, command, ...args], {
      cwd: path.dirname(this.scriptPath),
      // The script prints Korean; without this Windows defaults to cp949.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const killTimer = setTimeout(() => child.kill(), timeoutMs);

    child.on('error', (error) => {
      clearTimeout(killTimer);
      this.logger.warn(`Failed to run lunch ${command}`, error);
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      const output = stdout.trim();
      if (code === 0) {
        if (output) this.logger.info(`Lunch ${command}: ${output}`);
      } else {
        this.logger.warn(`Lunch ${command} exited with ${code}`, {
          stdout: output,
          stderr: stderr.trim(),
        });
      }
    });
  }
}
