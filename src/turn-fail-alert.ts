/**
 * 봇 차례가 한도가 아닌 오류로 연달아 끝나면 실장 DM 한 줄(2026-11-19 사용자 결정 「연속실패알림」).
 *
 * 그날 08:47~11:09 같은 대화의 차례 여섯이 같은 오류(「No message found with message.uuid」)로 끝났는데, 그 오류는
 * 봇 로그와 다음 날 아침 브리핑 「시스템 이슈」(`error-collector.ts`)에만 있어 서랍을 보고서야 알았다.
 * - **대화마다 센다** — 다른 대화가 성공했다고 망가진 대화의 줄이 끊기면 안 된다(그날 사이사이 다른 차례가 성공했다)
 * - **성공하면 0, 한도와 과부하는 세지도 끊지도 않음** — 한도는 엔진 안내가 따로 말한다
 * - **같은 오류는 하루 한 번** — 오류 글의 번호(uuid, 숫자)를 지운 모양으로 가른다. 알린 날은 파일에 남겨 재시작에도 유지
 * - **기본은 꺼짐**(`TURN_FAIL_ALERT=on` 일 때만 보냄) — 꺼져 있으면 보낼 줄을 로그에만 남긴다
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 몇 차례 연달아 실패하면 알리나. */
export const FAIL_STREAK = 3;

export type TurnEnd = 'ok' | 'error' | 'limited' | 'overload';

/** 알린 날을 적는 파일 — 시험은 `TURN_FAIL_ALERT_FILE` 로 돌린다. */
export function alertFile(): string {
  return process.env.TURN_FAIL_ALERT_FILE
    || path.join(os.homedir(), '.claude', 'state', 'turn-fail-alert.json');
}

/** 오류 글의 모양 — 번호가 달라도 같은 오류로 묶는다. */
export function signature(text: string): string {
  return String(text || '')
    .split('\n')[0]
    .replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '#')
    .replace(/\b[0-9a-f]{16,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 160);
}

/** 이 PC 의 날짜(YYYY-MM-DD). */
function today(now: Date): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

/** 알림 한 줄 — 로직이 내는 알림이라 말투 없이 「무엇 — 대상 — 할 일」. */
export function alertText(count: number, where: string, error: string): string {
  const first = String(error || '').split('\n')[0].trim().slice(0, 140) || '오류 글 없음';
  return `⚠️ 봇 차례 ${count}회 연속 오류 — ${where} — 「${first}」 — 봇 로그 확인`;
}

export class TurnFailAlert {
  private streaks = new Map<string, number>();

  constructor(private readonly opts: {
    post: (text: string) => Promise<void>;
    log?: (text: string) => void;
    enabled?: () => boolean;
    now?: () => Date;
  }) { }

  private enabled(): boolean {
    return this.opts.enabled ? this.opts.enabled() : process.env.TURN_FAIL_ALERT === 'on';
  }

  /** 알린 날 — 못 읽으면 빈 것(그때는 하루 한 번이 재시작 뒤 한 번 더가 될 뿐). */
  private readSent(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(alertFile(), 'utf-8')) || {}; } catch { return {}; }
  }

  private writeSent(sent: Record<string, string>): void {
    try {
      fs.mkdirSync(path.dirname(alertFile()), { recursive: true });
      fs.writeFileSync(alertFile(), JSON.stringify(sent, null, 1));
    } catch { /* 기록은 덤 — 차례를 막지 않는다 */ }
  }

  /**
   * 차례 하나의 끝 — 알릴 줄을 냈으면 그 글(꺼져 있어도 로그로 남긴 글), 아니면 null.
   * **던지지 않는다** — 차례 끝의 `finally` 에서 부른다.
   */
  async record(key: string, end: TurnEnd, where: string, error = ''): Promise<string | null> {
    try {
      if (end === 'limited' || end === 'overload') return null;
      if (end === 'ok') { this.streaks.delete(key); return null; }
      const n = (this.streaks.get(key) ?? 0) + 1;
      this.streaks.set(key, n);
      if (n < FAIL_STREAK) return null;
      const now = this.opts.now ? this.opts.now() : new Date();
      const sig = signature(error);
      const sent = this.readSent();
      if (sent[sig] === today(now)) return null;
      const text = alertText(n, where, error);
      if (!this.enabled()) {
        this.opts.log?.(`연속 오류 알림(꺼져 있어 안 보냄): ${text}`);
        return text;
      }
      await this.opts.post(text);
      // 지난날 것은 지운다 — 파일이 쌓이지 않게
      const keep: Record<string, string> = {};
      for (const [k, v] of Object.entries(sent)) if (v === today(now)) keep[k] = v;
      keep[sig] = today(now);
      this.writeSent(keep);
      return text;
    } catch (err) {
      this.opts.log?.(`연속 오류 알림 실패: ${(err as Error).message}`);
      return null;
    }
  }
}
