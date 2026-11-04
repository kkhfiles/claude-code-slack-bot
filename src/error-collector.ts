/**
 * Singleton error collector for the bot.
 * Components push errors here; the morning briefing reports and clears them.
 * Errors already communicated to the user (rate limit, token expiry Slack alerts) are excluded.
 *
 * **파일에도 쌓는다** (2026-10-30) — 메모리에만 들고 있어 봇을 다시 띄우면 브리핑 전에 사라졌다.
 * `~/.claude/state/bot-errors.jsonl` 에 한 줄씩 더하고, 브리핑이 가져가면 `{"cleared": …}` 한 줄을 남긴다.
 * 다시 뜰 때는 마지막 `cleared` 뒤의 줄을 되읽는다. 지우지 않으므로 이 파일이 곧 봇 실패의 기록이다.
 * 못 쓰거나 못 읽으면 메모리만으로 돈다(던지지 않는다).
 *
 * **실제 파일은 봇 본체만 쓴다** (2026-11-04) — 기본 경로를 아무나 쓰면 검사를 하나씩 따로 돌릴 때
 * 가짜 실패(PID 32 강제 종료, 「깨진 원장」, 「시험 — Claude error」)가 아침 브리핑에 실리고, 검사가 남긴
 * `cleared` 줄이 그 앞의 진짜 실패를 지운다(11/03 00:48 회의 알림 검사가 그랬다). `check-all` 만 임시 파일로
 * 돌려서는 못 막았다. 그래서 기본 경로는 `index.ts` 가 `useDefaultErrorsFile()` 을 부를 때만 쓰고,
 * 그 밖에는 `BOT_ERRORS_FILE` 이 있을 때만 파일을 쓴다 — 둘 다 없으면 메모리만.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface BotError {
  timestamp: string;
  source: string;
  message: string;
}

/** 한 줄 상한 — 오류 글에 긴 응답이 통째로 실리는 것을 막는다. */
const MAX_MESSAGE = 500;

let useDefault = false;

/** 봇 본체(`index.ts`)만 부른다 — 실제 오류 기록 파일을 쓰게 한다. */
export function useDefaultErrorsFile(): void {
  useDefault = true;
}

/** 쓸 파일 — 없으면 null(메모리만). */
export function errorsFile(): string | null {
  if (process.env.BOT_ERRORS_FILE) return process.env.BOT_ERRORS_FILE;
  return useDefault ? path.join(os.homedir(), '.claude', 'state', 'bot-errors.jsonl') : null;
}

class ErrorCollector {
  private errors: BotError[] = [];
  private readonly MAX_ERRORS = 50;
  private loaded = false;

  /** 마지막 `cleared` 뒤에 남은 것을 되읽는다 — 처음 쓰일 때 한 번. */
  private load(): void {
    if (this.loaded) return;
    const file = errorsFile();
    if (!file) return; // 아직 파일을 안 정함 — 본체가 정한 뒤 처음 쓰일 때 되읽는다
    this.loaded = true;
    try {
      const pending: BotError[] = [];
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (row && row.cleared) pending.length = 0;
        else if (row && row.source) pending.push({ timestamp: row.timestamp, source: row.source, message: row.message });
      }
      this.errors = [...pending, ...this.errors].slice(-this.MAX_ERRORS);
    } catch { /* 파일이 없거나 못 읽음 — 메모리만 */ }
  }

  private append(row: object): void {
    const file = errorsFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch { /* 기록은 덤 — 차례를 막지 않는다 */ }
  }

  add(source: string, message: string): void {
    this.load();
    const err = { timestamp: new Date().toISOString(), source, message: String(message).slice(0, MAX_MESSAGE) };
    this.errors.push(err);
    if (this.errors.length > this.MAX_ERRORS) this.errors.shift();
    this.append(err);
  }

  getAndClear(): BotError[] {
    this.load();
    const result = [...this.errors];
    this.errors = [];
    this.append({ cleared: new Date().toISOString(), n: result.length });
    return result;
  }

  hasErrors(): boolean {
    this.load();
    return this.errors.length > 0;
  }
}

export const errorCollector = new ErrorCollector();
