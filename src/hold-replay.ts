/**
 * 보류 재실행 v2 — 모든 엔진이 막혔을 때 받은 말을 모아 두고, 풀리면 **받은 자리에서** 차례로
 * 처리한다(2026-10-14 사용자 결정). 켜는 문은 `HOLD_V2=on` 하나 · 꺼져 있으면 옛 드레인 그대로.
 *
 * 옛 드레인(`drainStuck` v1)이 놓친 것:
 *   - **다시 막혀도 계속 집었다** — 건마다 시도 횟수만 탔다(상한 3이라 두 번 재시작하면 사람 손으로)
 *   - **늘 비서 DM 맨 위에 올렸다** — 받은 대화방 · 스레드를 잃었다
 *   - **결과를 몰랐다** — 대화 처리기가 결과를 안에서 삼켰다
 *   - **처음부터 다시 돌렸다** — 쓰기를 하다 끊긴 차례면 같은 쓰기가 두 번 들어갔다
 *
 * 규칙(가르는 것은 파이썬 `drain_list` · 여기는 돌리는 순서와 멈추는 조건):
 *   - Claude 가 막혀 있으면 아무것도 안 한다 — 시도도 안 센다
 *   - 막힌 뒤 한 번도 된 적이 없으면 아주 작은 호출 하나로 먼저 떠 본다(`canary`)
 *   - 오래된 것부터 **한 줄로** — 도는 동안 같은 방의 새 차례는 기다린다(`ChannelGate`)
 *   - **다시 막히면 그 자리에서 멈춘다** — 뒤의 것은 손대지 않는다(시도도 안 센다)
 *   - 받은 지 7일이 지난 것은 건마다 [실행]·[버림] 을 **한 번** 묻는다
 *
 * 이 파일은 슬랙도 파이썬도 직접 안 부른다 — 부르는 쪽이 넘긴 함수(`DrainDeps`)로만 움직여,
 * 검사가 가짜를 끼워 순서를 잰다(`scripts/check-hold-replay.mjs`).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { EngineState } from './engine-state';
import { doneStepLines, isHeldOutcome, type TurnOutcome, type TurnStep } from './turn-outcome';

/** 켜는 문 — 부를 때마다 읽는다(검사가 환경 변수를 바꿔 끼운다). */
export function holdV2On(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HOLD_V2 === 'on';
}

/** 30분마다 쓸어 본다 — 회복 타이머가 놓친 것(오류로 밀린 것 · 시각을 모르는 막힘)을 줍는다. */
export const HOLD_SWEEP_MS = 30 * 60_000;
/** 같은 방의 새 차례가 다시 돌리기를 기다리는 상한 — 넘으면 그냥 들어간다(멈춘 차례가 방을 영영 막지 않게). */
export const GATE_MAX_WAIT_MS = 15 * 60_000;
/** 7일 지난 것을 한 번에 묻는 건수 상한 — 블록 50개 제한 안. */
export const OLD_LIST_MAX = 15;
/**
 * 드레인이 한 번에 읽어 오는 후보 수 — 돌리는 상한(`DRAIN_MAX`)과 따로 둔다. 앞의 건들이 지금 맡을 엔진이
 * 없어 남겨져도 뒤의 돌릴 수 있는 건이 목록에 들게(2026-10-15 검토).
 */
export const PENDING_WINDOW = 50;

export interface HeldFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  size: number;
}

/** 실패 표시와 함께 파이썬에 넘기는 보류 칸(`tasks.py inbox fail --extra-file`). */
export interface HoldExtra {
  hold?: 'v2';
  session_id?: string;
  done_steps?: string[];
  files?: HeldFile[];
  hold_note?: string;
  /** agy 칸이 「Claude·GPT 몫」으로 남긴 차례(6단계 · `needs_full`) — agy 만 남았을 때는 다시 안 돌린다. */
  needs?: 'full';
}

/** `tasks.py inbox pending` 의 한 건. 칸은 새 파이썬만 싣는다 — 옛 파이썬이면 비어 있다. */
export interface HeldItem {
  id: string;
  text: string;
  thread: string | null;
  tries: number;
  /** 받은 시각(지역 ISO). */
  ts?: string;
  reason?: string;
  channel?: string;
  msg_ts?: string;
  /** 일하다 끊긴 차례의 세션 — 있으면 처음부터가 아니라 이어서 돌린다. */
  session_id?: string;
  done_steps?: string[];
  files?: HeldFile[];
  told_at?: string;
  /** agy 칸이 「Claude·GPT 몫」으로 남긴 것(6단계). */
  needs?: 'full';
  /** `tell` 쪽에만 — 사람에게 내는 까닭 · 7일 지남인가. */
  why?: string;
  old?: boolean;
}

// ---------------------------------------------------------------- 문구

/** 받은 시각을 `MM/DD HH:mm` 로 — 적힌 지역 시각 그대로 자른다(시간대 계산을 안 한다). */
export function receivedLabel(ts?: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts ?? '');
  return m ? `${m[1]}/${m[2]} ${m[3]}:${m[4]}` : '앞서';
}

/** 받은 시각(슬랙 ts 초) — 메시지 ts 가 있으면 그것, 없으면 캡처 시각. */
export function receivedSec(item: HeldItem): number | undefined {
  const n = Number(item.msg_ts);
  if (item.msg_ts && Number.isFinite(n)) return n;
  const t = Date.parse(item.ts ?? '');
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}

function firstLine(text: string, max: number): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 슬랙 mrkdwn 에서 기호로 읽히는 세 글자만 바꾼다. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 다시 돌릴 때 받은 자리에 먼저 올리는 줄. */
export function leadLine(item: HeldItem): string {
  return `↻ ${receivedLabel(item.ts)} 에 받은 요청을 이제 처리합니다`;
}

/** 머리 줄 + 원문 첫 줄 — 대화방 위쪽으로 밀려 올라간 원문을 다시 안 찾아도 되게. */
export function leadText(item: HeldItem): string {
  const head = firstLine(item.text, 80);
  return head ? `${leadLine(item)}\n> ${esc(head)}` : leadLine(item);
}

/** 이어 갈 때 붙이는 메모 — 이미 한 것을 다시 하지 않게. */
export function resumeNote(steps: readonly string[]): string {
  return [
    '이 요청은 앞에서 하다 끊겼습니다. 이미 한 것(다시 하지 말 것):',
    ...(steps.length ? steps.map((s) => `- ${s}`) : ['- (적힌 것 없음)']),
    '결과를 못 받은 것(「결과 모름」)은 됐는지 먼저 확인하고, 안 됐을 때만 다시 한다.',
    '오류로 끝난 것(「실패」)은 결과를 확인하고 필요하면 다시 해도 된다.',
    '「안 함」은 앞 엔진이 못 돌린 것이다 — 필요하면 한다.',
  ].join('\n');
}

/** `readUnseen` 에 넘기는 머리 · 꼬리 — 다시 돌릴 때는 「바로 위 글에 대한 답」 안내가 맞지 않는다. */
export const REPLAY_FRAME = {
  header: '[받은 뒤 이 대화방에 올라온 글 — 봇이 슬랙에서 읽어 붙임 · 오래된 것부터]',
  footer: [] as string[],
  withDate: true,
};

/**
 * 세션 앞에 붙이는 메모 — 언제 받았나 · 그 뒤 무슨 글이 올라왔나 · (이어 가면) 이미 한 것.
 * 세션이 「그 사이 뒤집혔거나 이미 처리됐는지」를 가린다.
 */
export function replayNote(item: HeldItem, unseen: string): string {
  const lines = [
    '[밀린 요청 — 봇이 다시 넘김]',
    `이 요청은 ${receivedLabel(item.ts)} 에 받았는데 그때 처리하지 못해(사용량 한도 · 재시작 등) 지금 처리한다.`,
    unseen.trim() || '받은 뒤 이 대화방에 올라온 글은 없다.',
    '받은 뒤 올라온 글에서 이 요청이 뒤집혔거나 이미 처리됐으면 다시 하지 말고 그렇다고 한 줄로 알린다.',
  ];
  // 세션이 없어도 「이미 한 것」이 있으면 싣는다 — GPT · agy 가 쓰다 끊긴 것은 새 차례로 이어 간다(2026-10-15 검토).
  if (item.session_id || item.done_steps?.length) lines.push('', resumeNote(item.done_steps ?? []));
  lines.push('', '[받았던 사람 말]');
  return lines.join('\n');
}

/**
 * 어디에 다시 올리나 — 받은 대화방 · 스레드. 대화방을 모르면(옛 캡처) 비서 DM 맨 위.
 * DM 맨 위에서 받은 것은 맨 위로(DM 은 스레드를 안 만든다) · 채널은 그 메시지의 스레드로.
 */
export function replayTarget(item: HeldItem, dmChannel: string): { channel: string; thread?: string } {
  if (!item.channel) return { channel: dmChannel };
  const isDM = item.channel.startsWith('D');
  const thread = item.thread || (isDM ? undefined : item.msg_ts) || undefined;
  return thread ? { channel: item.channel, thread } : { channel: item.channel };
}

export interface DrainReport {
  /** 끝까지 돈 건수(다시 막힌 것은 빼고). */
  ran: number;
  done: number;
  check: number;
  /** 안 돌리고 남긴 건수(다시 막힌 것 포함). */
  left: number;
  stopped: '' | 'blocked' | 'canary' | 'relimit';
  /** 지금 맡을 엔진이 없어 건너뛴 건수(6단계 — 첨부 · Claude·GPT 몫). 시도는 안 셈. */
  skipped?: number;
}

/** 다 돌고 한 줄 — 「▶ 밀린 N건 처리 — 완료 a · 확인 필요 b」. */
export function summaryLine(r: DrainReport): string {
  const tail = r.left && r.stopped ? ` · 다시 막혀 ${r.left}건은 회복 뒤에` : '';
  const skip = r.skipped ? ` · ${r.skipped}건은 맡을 엔진이 돌아온 뒤에` : '';
  return `▶ 밀린 ${r.ran}건 처리 — 완료 ${r.done} · 확인 필요 ${r.check}${tail}${skip}`;
}

/** 7일 지난 것 — 건마다 [실행]·[버림]. */
export function oldListMessage(items: readonly HeldItem[]): { text: string; blocks: any[] } {
  const head = `⏳ 받은 지 7일이 지나 자동으로 다시 처리하지 않은 요청 ${items.length}건 — 건마다 골라 주세요`;
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: head } }];
  for (const it of items) {
    blocks.push({
      type: 'section', block_id: `held_item_${it.id}`,
      text: { type: 'mrkdwn', text: `• ${receivedLabel(it.ts)} 받음 「${esc(firstLine(it.text, 60))}」` },
    });
    blocks.push({
      type: 'actions', block_id: `held_act_${it.id}`,
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '실행' }, action_id: 'held_run',
          value: JSON.stringify({ id: it.id }), style: 'primary' },
        { type: 'button', text: { type: 'plain_text', text: '버림' }, action_id: 'held_drop',
          value: JSON.stringify({ id: it.id }) },
      ],
    });
  }
  return { text: head, blocks };
}

/** 누른 건의 버튼을 결과 한 줄로 바꾼다 — 같은 것을 두 번 못 누르게. */
export function markChoice(blocks: readonly any[], id: string, label: string): any[] {
  return blocks.map((b) => (b?.block_id === `held_act_${id}`
    ? { type: 'context', block_id: `held_done_${id}`, elements: [{ type: 'mrkdwn', text: label }] }
    : b));
}

// ---------------------------------------------------------------- 한 줄로 세우기

/**
 * 방마다 문 하나 — 다시 돌리는 동안 같은 방의 새 차례는 기다린다.
 *
 * 대화 처리기는 같은 대화의 새 차례가 오면 **앞 차례를 끊는다**(`interrupt`). 다시 돌리는 차례가
 * 끊기면 반쯤 쓴 채로 남는다 — 그래서 끊지 않고 기다리게 한다.
 */
export class ChannelGate {
  private held = new Map<string, { count: number; done: Promise<void>; release: () => void }>();

  /** 이 방들을 잡는다. 돌려준 함수로 놓는다(두 번 불러도 한 번만 놓는다). */
  hold(channels: Iterable<string>): () => void {
    const mine: string[] = [];
    for (const ch of new Set(channels)) {
      if (!ch) continue;
      let h = this.held.get(ch);
      if (!h) {
        let release!: () => void;
        const done = new Promise<void>((r) => { release = r; });
        h = { count: 0, done, release };
        this.held.set(ch, h);
      }
      h.count += 1;
      mine.push(ch);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const ch of mine) {
        const h = this.held.get(ch);
        if (!h) continue;
        h.count -= 1;
        if (h.count <= 0) {
          this.held.delete(ch);
          h.release();
        }
      }
    };
  }

  isHeld(channel: string): boolean {
    return this.held.has(channel);
  }

  /**
   * 비면 잡고, 잡혀 있으면 놓일 때까지 기다렸다 잡는다 — 돌려준 함수로 놓는다.
   *
   * **보고 잡는 것을 한 덩어리로** 한다(`await` 없이 이어서). `wait` 뒤에 따로 `hold` 하면 같은 문을
   * 기다리던 둘이 함께 깨어나 둘 다 잡는다 — DM 폴백(GPT 차례)이 같은 방에서 둘 겹쳐 돈다.
   * 상한을 넘기면 그냥 잡는다(`wait` 와 같은 규칙 — 멈춘 차례가 방을 영영 막지 않게).
   */
  async acquire(channel: string, maxMs: number = GATE_MAX_WAIT_MS): Promise<() => void> {
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (!this.held.has(channel)) return this.hold([channel]);
      const left = deadline - Date.now();
      if (left <= 0 || await this.wait(channel, left) === 'timeout') return this.hold([channel]);
    }
  }

  /** 잡혀 있으면 놓일 때까지 기다린다(상한 `maxMs`). */
  async wait(channel: string, maxMs: number = GATE_MAX_WAIT_MS): Promise<'free' | 'waited' | 'timeout'> {
    if (!this.held.has(channel)) return 'free';
    const deadline = Date.now() + maxMs;
    while (this.held.has(channel)) {
      const left = deadline - Date.now();
      if (left <= 0) return 'timeout';
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), left); });
      const r = await Promise.race([this.held.get(channel)!.done.then(() => 'done' as const), late]);
      if (timer) clearTimeout(timer);
      if (r === 'late') return 'timeout';
    }
    return 'waited';
  }
}

// ---------------------------------------------------------------- 드레인

export interface DrainDeps {
  /** 다시 돌릴 엔진이 하나도 없나 — DM 폴백이 꺼져 있으면 Claude 막힘, 켜져 있으면 사다리 전부 막힘. */
  blocked(): boolean;
  /**
   * 이 건을 지금 맡을 엔진이 없나(6단계) — 시도도 안 세고 남긴다. 첨부 · 「Claude·GPT 몫」은
   * agy 칸이 못 맡는다. 없으면 다 돌린다(예전 그대로).
   */
  skip?(item: HeldItem): boolean;
  /** 막힌 뒤 된 적이 없나 — 그러면 작은 호출로 먼저 떠 본다. */
  needsCanary(): boolean;
  /** 작은 호출 하나 — 결과는 전송 탭이 엔진 상태에 적는다. */
  canary(): Promise<unknown>;
  pending(limit: number): Promise<{ run: HeldItem[]; tell: HeldItem[] }>;
  /** 시도 +1 — **실제로 돌리기 직전에만** 부른다. */
  tried(id: string): Promise<void>;
  /** 받은 자리에서 다시 돌린다 — 차례 결과를 돌려준다(빈 값이면 별일 없이 끝난 것). */
  replay(item: HeldItem): Promise<TurnOutcome | void | undefined>;
  /** 끝까지 갔다 — 실패 자국 · 보관한 첨부를 걷는다. */
  replayed(item: HeldItem): Promise<void>;
  summary(text: string): Promise<void>;
  /** 7일 지난 것을 묻고 물었다고 적는다. */
  askOld(items: HeldItem[]): Promise<void>;
  gate: ChannelGate;
  /** 그 건이 다시 올라갈 방 — 문을 잡는 데 쓴다. */
  channelOf(item: HeldItem): string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * 한 판 돈다. 무엇을 했는지 돌려준다.
 *
 * ⚠️ **시도는 실제로 돌리기 직전에만 센다** — 막혀서 건너뛴 것까지 세면 회복 전에 상한이 차서
 * 사람 손으로 넘어간다(옛 드레인이 그랬다).
 *
 * ⚠️ **상한(`limit`)은 실제로 돌린 건수에 건다 — 읽어 온 건수가 아니다**(2026-10-15 검토). 목록은 넉넉히
 * (`PENDING_WINDOW`) 읽는다 — 앞의 건들이 지금 맡을 엔진이 없어 남겨지면(`skip`) 앞에서 몇 건만 읽어서는
 * 뒤의 돌릴 수 있는 건이 영영 목록에 안 든다.
 */
export async function drainHeld(deps: DrainDeps, limit: number): Promise<DrainReport> {
  const rep: DrainReport = { ran: 0, done: 0, check: 0, left: 0, stopped: '' };
  const log = deps.log ?? (() => { /* 조용히 */ });
  if (deps.blocked()) {
    rep.stopped = 'blocked';
    log('맡을 엔진이 다 막혀 있어 밀린 것을 안 돌립니다');
    return rep;
  }
  const { run, tell } = await deps.pending(Math.max(limit, PENDING_WINDOW));
  const old = tell.filter((t) => t.old && !t.told_at).slice(0, OLD_LIST_MAX);
  if (old.length) {
    try {
      await deps.askOld(old);
    } catch (err) {
      log('7일 지난 것을 못 물었습니다 — 다음 판에 다시', { err: String((err as Error)?.message ?? err) });
    }
  }
  if (!run.length) return rep;

  if (deps.needsCanary()) {
    try {
      await deps.canary();
    } catch (err) {
      log('떠 보는 호출이 터졌습니다 — 막힘 여부만 봅니다', { err: String((err as Error)?.message ?? err) });
    }
    if (deps.blocked()) {
      rep.stopped = 'canary';
      rep.left = run.length;
      log('떠 보니 아직 막혀 있습니다 — 밀린 것을 안 돌립니다', { count: run.length });
      return rep;
    }
  }

  const release = deps.gate.hold(run.map((it) => deps.channelOf(it)));
  let attempts = 0;
  try {
    for (const [i, it] of run.entries()) {
      // 상한은 돌린 건수 — 남긴 것(`skip`)은 안 센다(위 ⚠️).
      if (attempts >= limit) break;
      if (deps.blocked()) {
        rep.stopped = 'blocked';
        rep.left = run.length - i;
        break;
      }
      // **맡을 엔진이 없는 건은 시도를 안 세고 남긴다**(6단계) — 세면 agy 만 남은 동안 판마다 상한이 차서
      // 사람 손으로 넘어간다. 뒤의 것은 계속 본다(이 건이 못 맡는 까닭은 그 건의 것이다).
      if (deps.skip?.(it)) {
        rep.skipped = (rep.skipped ?? 0) + 1;
        log('맡을 엔진이 없어 남깁니다', { id: it.id });
        continue;
      }
      attempts += 1;
      await deps.tried(it.id);
      let out: TurnOutcome | void | undefined;
      try {
        out = await deps.replay(it);
      } catch (err) {
        // 한 건이 터져도 나머지는 간다 — 여기서 멈추면 뒤가 통째로 밀린다.
        rep.ran += 1;
        rep.check += 1;
        log('밀린 것을 다시 돌리다 터졌습니다', { id: it.id, err: String((err as Error)?.message ?? err) });
        continue;
      }
      // **다시 막히면 그 자리에서 멈춘다** — 뒤의 것은 시도도 안 센다.
      if (isHeldOutcome(out)) {
        rep.stopped = 'relimit';
        rep.left = run.length - i;
        log('다시 막혀 멈춥니다', { id: it.id, left: rep.left });
        break;
      }
      rep.ran += 1;
      if (!out || out.outcome === 'ok') {
        rep.done += 1;
        await deps.replayed(it);
      } else {
        rep.check += 1;
      }
    }
  } finally {
    release();
  }
  if (rep.ran) await deps.summary(summaryLine(rep));
  return rep;
}

/**
 * 막힌 뒤 한 번도 된 적이 없나 — 그러면 밀린 것을 집기 전에 작은 호출로 먼저 떠 본다.
 * 막힘이 지났어도(회복 시각) 성공이 지우기 전까지는 적혀 있다(`engine-state.ts`).
 */
export function needsCanary(store: EngineState): boolean {
  const r = store.load().engines.claude;
  return !!r.blocked && (r.lastOkAt === null || r.lastOkAt < r.blocked.since);
}

/**
 * 실패 표시와 함께 넘길 보류 칸을 짓는다.
 *
 * - **쓰기가 돌았으면**(이번 차례의 쓰기 도구 · 앞 차례에서 이어 온 「이미 한 것」) 이미 한 것을 싣고,
 *   세션이 있으면 세션도 — 다시 돌릴 때 처음부터가 아니라 그 세션으로 이어 간다
 * - **이미 한 것은 세션과 따로 싣는다**(2026-10-15 검토) — GPT · agy 가 쓰다 끊긴 것은 Claude 세션이 없다.
 *   전에는 세션이 없으면 아무것도 안 실려 그 건이 사람에게만 갔다(파이썬 `_hold_carries` 가 이것으로 돌린다)
 * - 첨부가 있으면 보관 폴더로 옮겨 싣는다 · 못 옮기면 `hold_note`(사람에게 냄)
 */
export function buildHoldExtra(
  captureId: string, steps: readonly TurnStep[], prior: readonly string[],
  sessionId: string | undefined, files: readonly HeldFile[],
): { extra: HoldExtra; writeRan: boolean } {
  const writeRan = steps.some((s) => s.write) || prior.length > 0;
  const extra: HoldExtra = { hold: 'v2' };
  if (writeRan) {
    if (sessionId) extra.session_id = sessionId;
    extra.done_steps = [...prior, ...doneStepLines(steps)];
  }
  if (files.length) {
    const h = holdFiles(captureId, files);
    if (h.note) extra.hold_note = h.note;
    else extra.files = h.files;
  }
  return { extra, writeRan };
}

// ---------------------------------------------------------------- 첨부 보관

/** 보관 폴더 — 저장소 안 · Git 추적 제외(`.held-files/`). 검사는 `HELD_FILES_DIR` 로 옮긴다. */
export function heldRoot(): string {
  return process.env.HELD_FILES_DIR || path.join(__dirname, '..', '.held-files');
}

function safePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
}

/**
 * 막힌 차례의 첨부를 보관한다 — 임시 파일은 차례가 끝나면 지워지므로, 안 옮기면 다시 돌릴 때
 * 원문이 없는 파일을 가리킨다. **동기로 한다** — 바로 뒤에서 임시 파일을 지운다.
 *
 * 못 옮기면 `note` 를 돌려준다 — 파이썬이 그 건을 자동으로 안 돌리고 사람에게 낸다.
 */
export function holdFiles(captureId: string, files: readonly HeldFile[]): { files: HeldFile[]; note?: string } {
  if (!captureId || !files.length) return { files: [] };
  try {
    const dir = path.join(heldRoot(), safePart(captureId));
    fs.mkdirSync(dir, { recursive: true });
    const out: HeldFile[] = [];
    for (const [i, f] of files.entries()) {
      const dest = path.join(dir, `${i}-${safePart(f.name)}`);
      if (path.resolve(f.path) !== path.resolve(dest)) fs.copyFileSync(f.path, dest);
      out.push({ path: dest, name: f.name, mimetype: f.mimetype, isImage: f.isImage, isText: f.isText, size: f.size });
    }
    return { files: out };
  } catch {
    return { files: [], note: '첨부를 못 보관함' };
  }
}

/** 보관한 첨부를 지운다 — 끝까지 갔거나 버렸을 때. */
export function dropHeldFiles(captureId: string): void {
  if (!captureId) return;
  try {
    fs.rmSync(path.join(heldRoot(), safePart(captureId)), { recursive: true, force: true });
  } catch {
    /* 남아도 해가 없다 — 다음 정리에서 지운다 */
  }
}
