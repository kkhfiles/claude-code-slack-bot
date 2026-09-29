import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { Logger } from './logger';
import { errorCollector } from './error-collector';
import { t, Locale } from './messages';

const execAsync = promisify(exec);

/** Process info from OS query */
interface ProcessInfo {
  pid: number;
  name: string;
  commitMB: number;
  /** 프로세스 인스턴스 식별자. PID 는 재사용되므로 이것과 짝지어야 같은 놈인지 안다.
   *
   *  **문자열이다.** ticks 는 19자리라 JS 의 안전 정수 범위(2^53)를 넘어, 숫자로 받으면
   *  값이 뭉개져 원래 값과 다시 비교했을 때 늘 어긋난다 — 그러면 감시기가 겉보기엔
   *  멀쩡한데 아무것도 못 죽인다(실측으로 잡았다).
   *  빈 문자열·'0' = 읽지 못함(권한). 확인 못 한 것은 죽이지 않는다. */
  startTicks: string;
}

/** Pending kill confirmation state */
interface PendingKill {
  pid: number;
  name: string;
  commitMB: number;
  startTicks: string;
  messageTs: string;
  timer: ReturnType<typeof setTimeout>;
}

/** System commit memory status */
export interface CommitStatus {
  committedMB: number;
  limitMB: number;
  usagePct: number;
}

/** Callback types */
type SendMessageFn = (text: string, blocks?: any[]) => Promise<string>;
type UpdateMessageFn = (ts: string, text: string, blocks?: any[]) => Promise<void>;
type OnProcessKilledFn = (pid: number, name: string) => void;

/**
 * 알림에 붙는 조치 버튼. **한 번 눌러 되돌릴 수 있는 것만** 버튼으로 낸다.
 *
 * 없는 것에 이유가 있다 — 핸들 누수(`winhealth-handles`)는 2026-08-28 사건에서
 * 누수 주체가 사내 네트워크 접근 제어 서비스였고 표준 사용자에게 중지 권한이
 * 없었다. 버튼으로 끊으면 네트워크가 잠깐 끊기므로 사람이 절차를 보고 판단한다.
 * 메모리 고갈 이벤트도 이미 일어난 일의 기록이라 되돌릴 대상이 아니다.
 *
 * **가동 일수에는 알림 자체가 없다**(2026-08-28 폐기). 오래 켜 둔 것은 고장이 아니라
 * 상관 지표라, 실제로 나빠진 것이 없는데도 재부팅할 때까지 계속 뜨는 경고가 됐다.
 * 재시작 버튼은 재시작이 실제로 고치는 항목(커밋 압박)에만 남긴다.
 *
 * 재시작은 두 단계다. 슬랙 버튼은 휴대폰에서 잘못 눌리고, 그 한 번이 저장 안 한
 * 작업을 날린다. 예약 뒤에도 지연 시간 안에는 취소 버튼이 남는다.
 */
const HEALTH_FIX_BUTTONS: Record<string, Array<{
  label: string; actionId: string; style?: 'primary' | 'danger';
}>> = {
  'winhealth-explorer': [
    { label: '🧹 유령 Explorer 정리', actionId: 'health_fix_explorer', style: 'primary' },
  ],
  'winhealth-watchers': [
    { label: '🧹 오래된 감시 프로세스 정리', actionId: 'health_fix_watchers', style: 'primary' },
  ],
  'winhealth-commit': [
    { label: '🧹 유령 Explorer 정리', actionId: 'health_fix_explorer', style: 'primary' },
    { label: '🧹 감시 프로세스 정리', actionId: 'health_fix_watchers' },
    { label: '🔄 재시작 예약', actionId: 'health_reboot_ask', style: 'danger' },
  ],
};

// System processes that must never be killed
const PROTECTED_PROCESSES = new Set([
  'system', 'idle', 'smss', 'csrss', 'wininit', 'winlogon',
  'lsass', 'services', 'svchost', 'dwm', 'fontdrvhost',
  'sihost', 'ctfmon', 'conhost', 'wudfhost', 'taskhostw',
  'runtimebroker', 'searchhost', 'startmenuexperiencehost',
  'textinputhost', 'shellexperiencehost', 'memory compression',
  'registry', 'secure system', 'ntoskrnl',
]);

// ── 종료 대상 판정 (2026-09-29) ────────────────────────────────────────
//
// **목적은 이 PC 에서 상시 도는 작업이 메모리 고갈로 넘어지지 않게 하는 것이다.** 감시기가 그
// 작업을 직접 죽이는 것도 같은 사고다. 4~9월 실측으로 두 경로가 갈렸다.
//   - 실제 가상 메모리 부족(윈도 이벤트 2004) 22일 중 19일은 한 프로세스가 혼자 8~65GB 로
//     부푼 폭주였다 — 프로세스 기준(7GB)이 그 대부분을 먼저 잡았다.
//   - 시스템 90% 는 5/20 이후 33번 울렸는데 실제 부족과 겹친 것은 4번이다. 나머지는 자정 ·
//     정오 동기화의 봉우리였고, 「가장 큰 것」으로 고른 대상은 대개 그 동기화의 python 이었다
//     (sync-v2 커밋 데몬을 겨눈 것만 6번 · 그중 4번이 반영 미완으로 끝났다).
// 그래서 — 폭주는 빨리 끊고, 상시 작업은 폭주가 아닌 한 끊지 않고(계보로 판정 · 기계),
// 그 사이 애매한 판단은 AI 검토(Opus · medium)에 맡긴다.

export type Role = 'host' | 'stanley' | 'pipeline';
export type Path = 'runaway' | 'system';

/** 프로세스 표 한 줄 — 계보를 따라가려고 부모와 명령줄을 같이 받는다. */
export interface ProcRow { pid: number; ppid: number; name: string; cmd: string }

export interface Candidate {
  pid: number;
  name: string;
  commitMB: number;
  startTicks: string;
  role: Role | null;
  /** 최근 몇 회차(3분 간격) 사이 늘어난 MB · 기록이 없으면 null */
  growthMB: number | null;
  parent: string;
  cmd: string;
}

export interface Verdict { action: 'kill' | 'wait'; pid: number | null; reason: string }

export interface Decision {
  kind: 'kill' | 'alert';
  target?: Candidate;
  delaySec: number;
  source: 'ai' | 'rule' | 'none';
  reason: string;
}

const ROLE_LABEL: Record<Role, string> = {
  host: '스탠리를 띄운 쪽', stanley: '스탠리 세션', pipeline: '자정 · 정오 동기화',
};

/**
 * 상시 작업의 계보를 가른다 — 스탠리의 조상(`host` · 죽이면 감시기도 같이 죽는다), 스탠리의
 * 자손(`stanley` · 예약 분석 · 처리 제안 세션 등), 파이프라인 러너와 그 자손(`pipeline`).
 * 러너는 세션 밖에서 떨어져 돌아(DETACHED) 스탠리 계보에 안 걸리므로 잠금 파일의 PID 로 잡는다.
 */
export function classifyRoles(rows: ProcRow[], roots: { botPid: number; pipelinePid?: number | null }):
    Map<number, Role> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.ppid === r.pid) continue;
    const list = children.get(r.ppid) || [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const roles = new Map<number, Role>();
  const descend = (root: number, role: Role) => {
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      if (roles.has(pid) && pid !== root) continue;
      roles.set(pid, role);
      for (const c of children.get(pid) || []) if (!roles.has(c)) stack.push(c);
    }
  };
  if (roots.pipelinePid && byPid.has(roots.pipelinePid)) descend(roots.pipelinePid, 'pipeline');
  descend(roots.botPid, 'stanley');
  roles.delete(roots.botPid);
  // 조상은 마지막에 덮는다 — 무엇보다 먼저 지켜야 한다
  let cur = byPid.get(roots.botPid);
  for (let i = 0; cur && i < 50; i += 1) {
    const parent = byPid.get(cur.ppid);
    if (!parent || parent.pid === cur.pid) break;
    roles.set(parent.pid, 'host');
    cur = parent;
  }
  return roles;
}

/** AI 답 → 판정. 모양이 어긋나면 null(= 실패로 처리). */
export function parseVerdict(text: string | null | undefined): Verdict | null {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const d = JSON.parse(text.slice(s, e + 1));
    if (d.action !== 'kill' && d.action !== 'wait') return null;
    const pid = d.pid === null || d.pid === undefined ? null : Number(d.pid);
    if (d.action === 'kill' && !Number.isInteger(pid)) return null;
    return { action: d.action, pid: d.action === 'kill' ? pid : null, reason: String(d.reason || '').slice(0, 300) };
  } catch {
    return null;
  }
}

/**
 * 판정 규칙 — AI 답이 있든 없든 여기서 최종 결정한다(AI 는 규칙 안에서만 고른다).
 *
 * | 경로 | 죽일 수 있는 것 | AI 가 kill | AI 가 wait | AI 실패 |
 * |---|---|---|---|---|
 * | 폭주 | 기준 넘은 것(스탠리 조상 빼고) | 그것 | 시스템도 기준 넘었으면 거절 → 규칙 | 가장 큰 폭주 |
 * | 시스템 | 상시 작업 계보 밖 | 그것 | 알림만 | 알림만 |
 */
export function decide(input: {
  path: Path; candidates: Candidate[]; verdict: Verdict | null; systemHigh: boolean;
  processThresholdMB: number; runawayDelaySec: number; systemDelaySec: number;
  /** 프로세스 표를 읽었나. 못 읽었으면 누가 상시 작업인지 모르므로 시스템 경로는 아무것도 안 죽인다. */
  lineageKnown: boolean;
}): Decision {
  const { path: p, candidates, verdict } = input;
  const killable = p === 'runaway'
    ? candidates.filter((c) => c.commitMB >= input.processThresholdMB && c.role !== 'host')
    : input.lineageKnown ? candidates.filter((c) => c.role === null) : [];
  const delaySec = p === 'runaway' ? input.runawayDelaySec : input.systemDelaySec;
  if (verdict?.action === 'kill') {
    const hit = killable.find((c) => c.pid === verdict.pid);
    if (hit) return { kind: 'kill', target: hit, delaySec, source: 'ai', reason: verdict.reason };
  }
  if (verdict?.action === 'wait' && !(p === 'runaway' && input.systemHigh)) {
    return { kind: 'alert', delaySec: 0, source: 'ai', reason: verdict.reason };
  }
  // 여기부터는 AI 가 없거나 · 실패했거나 · 규칙 밖을 골랐다
  const why = !input.lineageKnown && p === 'system' ? '프로세스 계보를 못 읽음'
    : !verdict ? 'AI 검토 실패'
      : verdict.action === 'kill' ? `AI 가 고른 PID ${verdict.pid} 는 종료할 수 없는 대상`
        : '폭주 중에 시스템도 기준을 넘어 기다릴 수 없음';
  if (p === 'runaway' && killable.length) {
    const top = [...killable].sort((a, b) => b.commitMB - a.commitMB)[0];
    return { kind: 'kill', target: top, delaySec, source: 'rule', reason: `${why} — 가장 큰 폭주를 규칙대로` };
  }
  return { kind: 'alert', delaySec: 0, source: 'none', reason: `${why} — 상시 작업을 지키려고 자동 종료하지 않음` };
}

/** 자동 종료 직전 — 그 사이 압박이 풀렸으면 쏘지 않는다(2026-09-29: 종료 순간 89.4% 였다). */
export function stillWarranted(p: Path, now: { usagePct: number | null; targetMB: number | null },
                               th: { thresholdPct: number; processThresholdMB: number }): boolean {
  if (p === 'system') return now.usagePct !== null && now.usagePct >= th.thresholdPct;
  return now.targetMB !== null && now.targetMB >= th.processThresholdMB;
}

export function buildReviewPrompt(ctx: {
  path: Path; status: CommitStatus; thresholdPct: number; processThresholdMB: number;
  candidates: Candidate[]; pipelineRunning: boolean; delaySec: number;
}): string {
  const row = (c: Candidate) => `| ${c.pid} | ${c.name} | ${c.commitMB} | `
    + `${c.growthMB === null ? '?' : (c.growthMB >= 0 ? '+' : '') + c.growthMB} | `
    + `${c.role ? `보호 — ${ROLE_LABEL[c.role]}` : '-'} | ${c.parent} | ${c.cmd.replace(/\|/g, '/').slice(0, 160)} |`;
  return [
    '이 PC 의 메모리 감시기가 자동 종료 대상을 정하려 한다. 도구 없이 아래 자료만으로 판정해 JSON 하나로 답한다.',
    '',
    '목적: 이 PC 에서 상시 도는 작업(스탠리 봇과 그 세션 · 자정 · 정오 동기화 파이프라인)이 메모리 고갈로 넘어지지 않게 지킨다. 감시기가 그 작업을 직접 죽이는 것도 같은 사고다.',
    '',
    `경로: ${ctx.path === 'runaway'
      ? `폭주 — 한 프로세스가 ${ctx.processThresholdMB} MB 이상`
      : `시스템 — 커밋 ${ctx.thresholdPct}% 이상 · 기준을 넘은 단일 프로세스는 없음`}`,
    `시스템 커밋: ${ctx.status.committedMB}/${ctx.status.limitMB} MB (${ctx.status.usagePct}%) · 페이지 파일이 고정이라 100% 에서 메모리 할당이 실패한다`,
    `동기화 파이프라인: ${ctx.pipelineRunning ? '지금 도는 중' : '안 돎'} · 판정이 kill 이면 ${Math.round(ctx.delaySec / 60)}분 뒤 다시 재서 여전히 넘으면 종료`,
    '',
    '| PID | 이름 | 메모리 MB | 최근 변화 MB | 역할 | 부모 | 명령줄 |',
    '|---|---|---|---|---|---|---|',
    ...ctx.candidates.map(row),
    '',
    '판정 규칙',
    '- 폭주: 한 프로세스가 기준 이상이거나 다른 것보다 몇 배 크고 계속 커지면 그것이 주범이다. 지난 1년 실제 고갈 22일 중 19일이 폭주 하나(8~65GB)였다.',
    '- 폭주 경로는 원칙적으로 kill. wait 는 시스템 커밋이 기준 미만이고 그 프로세스가 커지지 않을 때만(정상 작업의 큰 메모리).',
    '- 시스템 경로에서 「보호」 표시가 있는 것은 고르지 않는다(골라도 거절된다). 사용자가 쓰는 대화형 프로그램(터미널 안의 claude · 편집기)보다 백그라운드 부가 프로그램(브라우저 · 장치 에이전트 · 디스크 분석기 등)을 먼저 고른다.',
    '- 뚜렷한 주범 없이 여러 프로세스가 고르게 쓰면 wait — 동기화 봉우리는 대개 10~20분 안에 스스로 내려온다.',
    '- pid 는 위 표에 있는 것만.',
    '',
    '답(다른 글 없이 JSON 하나): {"action": "kill" 또는 "wait", "pid": 숫자 또는 null, "reason": "사람에게 보일 한 줄"}',
  ].join('\n');
}

/** 감시기 판정 기록 — 나중에 판정이 맞았는지 대조한다. 자동 종료도 여기 남는다(전에는 로그에 없었다). */
export function watchdogEventsFile(): string {
  return process.env.MEMORY_WATCHDOG_EVENTS_FILE
    || path.join(os.homedir(), '.claude', 'state', 'memory-watchdog-events.jsonl');
}

export interface WatchdogOptions {
  /** 판정 세션 — 프롬프트를 받아 답 글을 돌려준다(실패하면 null). 없으면 규칙만. */
  reviewer?: (prompt: string) => Promise<string | null>;
  /** 파이프라인 러너 잠금 파일(`{"pid": …}`) — 러너 계보를 잡는 근거 */
  pipelineLockFile?: string;
  /** 폭주 경로 자동 종료 유예(초). 시스템 경로는 생성자의 autoKillDelaySec. */
  runawayDelaySec?: number;
}

export class ProcessMemoryWatchdog {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private pendingKills: Map<number, PendingKill> = new Map();
  private excludedPids: Set<number> = new Set();
  private cachedCommitLimitMB: number = 0;
  private logger = new Logger('MemoryWatchdog');
  private locale: Locale = 'ko';
  /** PID → 최근 메모리(MB) · 3분 간격 몇 회차. 시작 시각이 바뀌면(번호 재사용) 새로 시작. */
  private history: Map<number, { ticks: string; mb: number[] }> = new Map();
  /** 판정 세션이 도는 중 — 겹쳐 띄우지 않는다. */
  private reviewing = false;
  /** 시스템 경로는 한 번 오른 봉우리에 한 번만 판정한다(전에는 3분마다 다음 큰 것을 겨눴다). */
  private systemEpisodeOpen = false;
  /** 폭주 경로에서 「기다림」을 받은 PID → 그때 크기. 1GB 넘게 더 커지기 전엔 다시 안 묻는다. */
  private waitedAt: Map<number, { mb: number; at: number }> = new Map();

  constructor(
    private thresholdPct: number,
    private checkIntervalSec: number,
    private autoKillDelaySec: number,
    private processThresholdMB: number,
    private sendMessage: SendMessageFn,
    private updateMessage: UpdateMessageFn,
    private onProcessKilled?: OnProcessKilledFn,
    private opts: WatchdogOptions = {},
  ) {}

  start(): void {
    if (process.platform !== 'win32') {
      this.logger.info('Memory watchdog is Windows-only, skipping');
      return;
    }
    this.logger.info(`Memory watchdog started (threshold: ${this.thresholdPct}%, processThreshold: ${this.processThresholdMB} MB, interval: ${this.checkIntervalSec}s, autoKill: ${this.autoKillDelaySec}s)`);
    // Run first check after a short delay
    setTimeout(() => this.checkMemory().catch(e => this.logger.error('Memory check failed', e)), 10_000);
    this.checkTimer = setInterval(
      () => this.checkMemory().catch(e => this.logger.error('Memory check failed', e)),
      this.checkIntervalSec * 1000,
    );
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    for (const [, pending] of this.pendingKills) {
      clearTimeout(pending.timer);
    }
    this.pendingKills.clear();
    this.logger.info('Memory watchdog stopped');
  }

  /**
   * 알림 버튼 처리. 실제 조치는 파이썬 쪽(`windows_health_fix`)이 한다 — 대상을
   * 고르는 규칙(주 탐색기 보존·나이 기준)이 점검 쪽과 한 벌이어야 하는데, 여기에
   * 옮겨 적으면 둘이 갈라진다.
   *
   * 결과는 원래 메시지를 **고쳐서** 보여 준다. 새 메시지를 붙이면 버튼이 남아 두 번
   * 눌리고, 이미 정리한 것을 또 정리하려 든다.
   */
  async handleHealthFixAction(actionId: string, messageTs: string): Promise<void> {
    const ACTIONS: Record<string, { arg: string; apply: boolean; label: string }> = {
      health_fix_explorer: { arg: 'explorer', apply: true, label: '유령 Explorer 정리' },
      health_fix_watchers: { arg: 'watchers', apply: true, label: '감시 프로세스 정리' },
      health_reboot_confirm: { arg: 'reboot', apply: true, label: '재시작 예약' },
      health_reboot_cancel: { arg: 'reboot-cancel', apply: true, label: '재시작 취소' },
    };
    const spec = ACTIONS[actionId];
    if (!spec) return;

    await this.updateMessage(messageTs, `⏳ ${spec.label} 중…`).catch(() => {});

    let line: string;
    try {
      line = await this.runHealthFix(spec.arg, spec.apply);
    } catch (e) {
      line = `⚠️ ${spec.label} 실패 — ${(e as Error).message}`;
    }

    // 재시작을 예약했으면 지연 시간 안에 되돌릴 길을 같은 메시지에 남긴다.
    const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: line } }];
    if (actionId === 'health_reboot_confirm' && !line.startsWith('⚠️')) {
      blocks.push({ type: 'actions', elements: [{
        type: 'button', text: { type: 'plain_text', text: '↩️ 재시작 취소' },
        action_id: 'health_reboot_cancel', value: 'cancel',
      }] });
    }
    await this.updateMessage(messageTs, line, blocks).catch(e =>
      this.logger.error('Failed to update health fix message', e as Error));
    this.logger.info('Health fix action done', { actionId, result: line });

    // **정리한 뒤 다시 잰다.** 정리 스크립트는 `windows-health-latest.json` 을 안
    // 건드리고 다음 측정은 정오·자정이라, 자정 알림에서 버튼을 누른 날도 08:00
    // 브리핑은 이미 없어진 유령을 「잔존 🔴」로 냈다. 정오 재측정을 둔 이유(「해제」)
    // 와 같은 것을 버튼 뒤에도 둔다. 기다리지 않는다 — 카드 갱신이 먼저다.
    if ((actionId === 'health_fix_explorer' || actionId === 'health_fix_watchers')
        && !line.startsWith('⚠️')) {
      this.refreshHealthSnapshot().catch(e =>
        this.logger.warn('정리 뒤 재측정 실패 — 다음 정기 측정까지 옛 값이 남는다', e as Error));
    }
  }

  /** 읽기 전용 측정 한 번 — `windows-health-latest.json` 을 지금 상태로 바꾼다. */
  private refreshHealthSnapshot(): Promise<void> {
    const repo = process.env.MYCELIUM_REPO || 'P:/github/claude-workflow';
    const argv = ['-X', 'utf8', '-m', 'mycelium.batch.windows_health_check', '--brief', '--exit-zero'];
    return execAsync(`python ${argv.join(' ')}`, { cwd: repo, timeout: 180_000 })
      .then(() => { this.logger.info('정리 뒤 재측정 완료'); });
  }

  /** 재시작은 두 단계. 첫 버튼은 묻기만 하고 아무것도 예약하지 않는다. */
  async handleRebootAsk(messageTs: string): Promise<void> {
    const text = [
      '🔄 *재시작을 예약할까요?*',
      '',
      '예약하면 60초 뒤에 이 PC가 재시작합니다. 저장 안 한 작업이 있으면 먼저 저장하세요.',
      '예약 뒤에도 60초 안에는 취소 버튼으로 되돌릴 수 있습니다.',
    ].join('\n');
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: '🔄 60초 뒤 재시작' },
          style: 'danger', action_id: 'health_reboot_confirm', value: 'confirm' },
        { type: 'button', text: { type: 'plain_text', text: '취소' },
          action_id: 'health_dismiss', value: 'dismiss' },
      ] },
    ];
    await this.updateMessage(messageTs, text, blocks).catch(e =>
      this.logger.error('Failed to ask reboot', e as Error));
  }

  /** 버튼을 거둔다. 조치는 안 한다. */
  async handleHealthDismiss(messageTs: string): Promise<void> {
    await this.updateMessage(messageTs, '조치하지 않았습니다. 아침 브리핑에 계속 뜹니다.')
      .catch(() => {});
  }

  private runHealthFix(action: string, apply: boolean): Promise<string> {
    const repo = process.env.MYCELIUM_REPO || 'P:/github/claude-workflow';
    const argv = ['-X', 'utf8', '-m', 'mycelium.batch.windows_health_fix', action];
    if (apply) argv.push('--apply');
    return new Promise((resolve, reject) => {
      execAsync(`python ${argv.join(' ')}`, { cwd: repo, timeout: 180_000 })
        .then(({ stdout }) => resolve(stdout.trim() || '(출력 없음)'))
        .catch(err => reject(err));
    });
  }

  /** Called from Slack action handler when user clicks [Kill] */
  async handleKillAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    // 버튼은 그 메시지가 남아 있는 한 언제든 눌린다 — 잡아 둘 때와 같은 프로세스인지
    // 지금 다시 본다.
    const outcome = this.killIfSame(pid, pending.name, pending.startTicks);
    const text = outcome === 'killed'
      ? t('watchdog.killed', this.locale, { pid: String(pid), name: pending.name, commitMB: String(pending.commitMB) })
      : outcome === 'gone'
        ? t('watchdog.alreadyGone', this.locale, { pid: String(pid), name: pending.name })
        : outcome === 'recycled'
          ? `PID ${pid} 은 이제 다른 프로세스입니다 — ${pending.name} 은 이미 끝났고 번호가 재사용됐습니다. 죽이지 않았습니다.`
          : `PID ${pid} (${pending.name}) 종료 실패 — 권한이거나 확인이 안 됐습니다.`;

    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );

    if (outcome === 'killed') {
      this.onProcessKilled?.(pid, pending.name);
      this.logger.info(`Process killed by user: ${pending.name} (PID ${pid}, ${pending.commitMB} MB)`);
    }
  }

  /** Called from Slack action handler when user clicks [Ignore] */
  async handleIgnoreAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    const text = t('watchdog.ignored', this.locale, { pid: String(pid), name: pending.name });
    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );
    this.logger.info(`Process kept by user: ${pending.name} (PID ${pid})`);
  }

  /** Called from Slack action handler when user clicks [Exclude] */
  async handleExcludeAction(pid: number): Promise<void> {
    const pending = this.pendingKills.get(pid);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingKills.delete(pid);

    this.excludedPids.add(pid);

    const text = t('watchdog.excluded', this.locale, { pid: String(pid), name: pending.name });
    await this.updateMessage(pending.messageTs, text).catch(e =>
      this.logger.error('Failed to update watchdog message', e),
    );
    this.logger.info(`PID ${pid} (${pending.name}) excluded from watchdog`);
  }

  // --- Private methods ---

  /**
   * 데일리 시스템 점검(`mycelium.batch.windows_health_check`)이 남긴 큐를 읽어
   * **이미 메모리에 진단·절차가 적힌 문제**만 알린다.
   *
   * 왜 여기냐 — 이 감시기가 이미 「시스템 이상 → 스탠리」 경로를 갖고 있다. 두 번째
   * 발송 경로를 만들면 토큰과 채널 설정이 두 군데가 된다.
   *
   * 왜 나눠 보나 — 이 감시기가 보는 것은 **한 프로세스가 임계를 넘는 급성 상태**다.
   * 커밋 80%에 140MB짜리 프로세스가 55개인 상태는 여기 안 걸린다(2026-08-28 사건이
   * 그랬고, 이 감시기는 그때 `— OK`를 찍었다). 그 축은 파이썬 점검이 재고 결과만
   * 여기로 온다.
   *
   * 처음 보는 증상은 큐에 안 들어온다 — 절차가 없으면 즉시 알려도 할 수 있는 일이
   * 조사뿐이라, 그건 아침 브리핑 몫이다.
   */
  private async reportKnownIssues(): Promise<void> {
    const stateDir = path.join(
      process.env.USERPROFILE || process.env.HOME || '', '.claude', 'state');
    const queueFile = path.join(stateDir, 'windows-health-latest.json');
    const sentFile = path.join(stateDir, 'stanley-notified.json');

    let queue: any;
    try {
      queue = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
    } catch {
      return;   // 점검이 아직 안 돌았거나 파일이 깨졌다. 알림은 부수 신호라 조용히 넘긴다.
    }
    const items: any[] = Array.isArray(queue?.notify) ? queue.notify : [];
    if (items.length === 0) return;

    // 보낸 표시는 **봇만** 쓴다. 파이썬이 같은 파일을 고치면 어느 쪽 쓰기가 이기는지가
    // 타이밍에 달리고, 그러면 알림이 사라지거나 두 번 간다.
    let sent: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(sentFile, 'utf-8'));
      if (Array.isArray(parsed)) sent = parsed;
    } catch {
      sent = [];
    }
    const sentSet = new Set(sent);
    const fresh = items.filter(i => i?.key && !sentSet.has(i.key));
    if (fresh.length === 0) return;

    for (const item of fresh) {
      const mark = item.severity === 'action' ? '🔴' : '🟡';
      const refs: string[] = (item.refs || [])
        .map((r: any) => `• 진단·복구 절차: \`${r.path}\``);
      const text = [
        `${mark} *시스템 점검 — 전에 진단해 둔 문제가 다시 잡혔습니다*`,
        '',
        `*${item.title}*`,
        item.detail,
        '',
        `현재 상태: ${item.summary}`,
        ...refs,
      ].join('\n');

      const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
      const buttons = HEALTH_FIX_BUTTONS[item.id];
      if (buttons?.length) {
        blocks.push({ type: 'actions', elements: buttons.map(b => ({
          type: 'button',
          text: { type: 'plain_text', text: b.label },
          ...(b.style ? { style: b.style } : {}),
          action_id: b.actionId,
          value: item.key,
        })) });
      }

      try {
        await this.sendMessage(text, blocks.length > 1 ? blocks : undefined);
        sentSet.add(item.key);
        this.logger.info('Known issue reported to Slack', { key: item.key });
      } catch (e) {
        // 못 보냈으면 보낸 표시를 하지 않는다 — 다음 회차에 다시 시도한다.
        this.logger.error('Failed to report known issue', e as Error);
      }
    }

    // 키에 날짜가 들어 있어 무한히 늘지 않지만, 지난 날짜가 쌓이면 파일만 커진다.
    const today = new Date();
    const cutoff = new Date(today.getTime() - 14 * 86_400_000)
      .toISOString().slice(0, 10);
    const kept = Array.from(sentSet).filter(k => (k.split(':')[1] || '') >= cutoff);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(sentFile, JSON.stringify(kept, null, 2), 'utf-8');
    } catch {
      // 표시를 못 남기면 다음 회차에 한 번 더 간다. 안 가는 것보다 낫다.
    }
  }

  private async checkMemory(): Promise<void> {
    // 파이썬 점검 결과를 먼저 흘려보낸다. 아래 급성 판정과는 보는 축이 달라
    // 서로의 결과에 기대지 않는다 — 한쪽이 실패해도 다른 쪽은 그대로 돈다.
    await this.reportKnownIssues().catch(e =>
      this.logger.error('Known issue report failed', e as Error));

    // Clean up pendingKills for processes that have already exited
    for (const [pid, pending] of this.pendingKills) {
      const alive = await this.isProcessAlive(pid);
      if (!alive) {
        clearTimeout(pending.timer);
        this.pendingKills.delete(pid);
        await this.updateMessage(pending.messageTs,
          t('watchdog.alreadyGone', this.locale, { pid: String(pid), name: pending.name }),
        ).catch(() => {});
      }
    }

    const status = await this.getSystemCommitStatus();
    if (!status) return;

    const systemHigh = status.usagePct >= this.thresholdPct;

    const processes = await this.getTopProcesses(20);
    if (processes.length === 0) {
      if (!systemHigh) {
        this.logger.debug(`System commit: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — OK`);
      }
      return;
    }

    // Clean up excluded PIDs for processes that have exited
    for (const pid of this.excludedPids) {
      if (!processes.some(p => p.pid === pid)) {
        this.excludedPids.delete(pid);
      }
    }

    this.remember(processes);

    // Filter out protected processes, excluded PIDs, our own PID, and already-pending PIDs
    const myPid = process.pid;
    const base = processes.filter(p =>
      p.pid !== myPid &&
      !PROTECTED_PROCESSES.has(p.name.toLowerCase()) &&
      !this.excludedPids.has(p.pid) &&
      !this.pendingKills.has(p.pid),
    );
    const runaways = base.filter(p => p.commitMB >= this.processThresholdMB && !this.waitStillHolds(p));

    // 봉우리가 내려오면(기준 −3%p) 다음 봉우리에 다시 판정한다
    if (!systemHigh && status.usagePct < this.thresholdPct - 3) this.systemEpisodeOpen = false;

    const route: Path | null = runaways.length ? 'runaway'
      : (systemHigh && !this.systemEpisodeOpen) ? 'system' : null;
    if (!route) {
      this.logger.debug(`System commit: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — ${systemHigh ? 'HIGH · 이미 판정한 봉우리' : 'OK'}`);
      return;
    }
    if (this.reviewing) return;

    if (systemHigh) {
      this.logger.warn(`System commit HIGH: ${status.committedMB.toLocaleString()}/${status.limitMB.toLocaleString()} MB (${status.usagePct}%) — threshold ${this.thresholdPct}%`);
    }
    if (route === 'runaway') {
      this.logger.warn(`Process commit HIGH: ${runaways[0].name} (PID ${runaways[0].pid}, ${runaways[0].commitMB} MB) — threshold ${this.processThresholdMB} MB`);
    }

    this.reviewing = true;
    try {
      if (route === 'system') this.systemEpisodeOpen = true;
      await this.judge(route, status, base, systemHigh);
    } finally {
      this.reviewing = false;
    }
  }

  /** 상시 작업 계보를 붙이고 · AI 에게 묻고 · 규칙으로 최종 결정해 · 종료 예약이나 알림을 낸다. */
  private async judge(route: Path, status: CommitStatus, base: ProcessInfo[], systemHigh: boolean): Promise<void> {
    const rows = await this.getProcessTable();
    const pipelinePid = this.readPipelinePid();
    const roles = classifyRoles(rows, { botPid: process.pid, pipelinePid });
    const byPid = new Map(rows.map(r => [r.pid, r]));
    const candidates: Candidate[] = base.slice(0, 10).map(p => {
      const row = byPid.get(p.pid);
      return {
        pid: p.pid, name: p.name, commitMB: p.commitMB, startTicks: p.startTicks,
        role: roles.get(p.pid) ?? null, growthMB: this.growth(p.pid),
        parent: row ? (byPid.get(row.ppid)?.name ?? `PID ${row.ppid}`) : '?',
        cmd: row?.cmd ?? '',
      };
    }).filter(c => c.role !== 'host');   // 스탠리의 조상은 후보로도 안 보인다 — 죽이면 감시기도 죽는다

    const delaySec = route === 'runaway' ? (this.opts.runawayDelaySec ?? 180) : this.autoKillDelaySec;
    let verdict: Verdict | null = null;
    let reviewMs = 0;
    if (this.opts.reviewer && candidates.length && (route === 'runaway' || rows.length > 0)) {
      const t0 = Date.now();
      const prompt = buildReviewPrompt({
        path: route, status, thresholdPct: this.thresholdPct, processThresholdMB: this.processThresholdMB,
        candidates, pipelineRunning: !!pipelinePid && byPid.has(pipelinePid), delaySec,
      });
      verdict = parseVerdict(await this.opts.reviewer(prompt).catch(() => null));
      reviewMs = Date.now() - t0;
    }
    const decision = decide({
      path: route, candidates, verdict, systemHigh, processThresholdMB: this.processThresholdMB,
      runawayDelaySec: this.opts.runawayDelaySec ?? 180, systemDelaySec: this.autoKillDelaySec,
      lineageKnown: rows.length > 0,
    });
    this.record({
      phase: 'decide', route, pct: status.usagePct, verdict, reviewMs, decision: {
        kind: decision.kind, source: decision.source, reason: decision.reason,
        target: decision.target ? { pid: decision.target.pid, name: decision.target.name, mb: decision.target.commitMB, role: decision.target.role } : null,
      },
      candidates: candidates.slice(0, 6).map(c => ({ pid: c.pid, name: c.name, mb: c.commitMB, role: c.role, growth: c.growthMB })),
    });
    this.logger.info(`판정 ${route} → ${decision.kind}(${decision.source}) ${decision.target ? `${decision.target.name} PID ${decision.target.pid}` : ''} — ${decision.reason}`);

    if (decision.kind === 'kill' && decision.target) {
      await this.sendKillConfirmation(decision.target, status, route, decision);
      return;
    }
    if (route === 'runaway') {
      // 기다리기로 한 폭주 — 1GB 넘게 더 커지기 전엔 다시 안 묻는다(3분마다 같은 DM 방지)
      for (const c of candidates.filter(x => x.commitMB >= this.processThresholdMB)) {
        this.waitedAt.set(c.pid, { mb: c.commitMB, at: Date.now() });
      }
    }
    await this.sendAlert(status, decision, candidates);
  }

  private async sendAlert(status: CommitStatus, decision: Decision, candidates: Candidate[]): Promise<void> {
    const top = candidates.slice(0, 3)
      .map(c => `\`${c.name}\` ${c.commitMB.toLocaleString()} MB${c.role ? `(${ROLE_LABEL[c.role]})` : ''}`).join(' · ');
    const text = t('watchdog.alertOnly', this.locale, {
      committedMB: status.committedMB.toLocaleString(),
      limitMB: status.limitMB.toLocaleString(),
      pct: String(status.usagePct),
      review: t('watchdog.review', this.locale, { source: decision.source, reason: decision.reason }),
      top: top || '-',
    });
    await this.sendMessage(text).catch(e => this.logger.error('Failed to send watchdog alert', e));
  }

  private async sendKillConfirmation(target: Candidate, status: CommitStatus, route: Path,
                                     decision: Decision): Promise<void> {
    const delaySec = decision.delaySec;
    const text = t(route === 'runaway' ? 'watchdog.confirmProcess' : 'watchdog.confirm', this.locale, {
      committedMB: status.committedMB.toLocaleString(),
      limitMB: status.limitMB.toLocaleString(),
      pct: String(status.usagePct),
      pid: String(target.pid),
      name: target.name,
      commitMB: String(target.commitMB.toLocaleString()),
      processThresholdMB: this.processThresholdMB.toLocaleString(),
      minutes: String(Math.max(1, Math.round(delaySec / 60))),
    }) + '\n' + t('watchdog.review', this.locale, { source: decision.source, reason: decision.reason })
      + (target.role ? `\n역할: ${ROLE_LABEL[target.role]} — 폭주로 판정돼 예외적으로 종료 대상` : '');

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔴 Kill' },
            style: 'danger',
            action_id: 'watchdog_kill',
            value: String(target.pid),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '⏸️ Ignore' },
            action_id: 'watchdog_ignore',
            value: String(target.pid),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🚫 Exclude' },
            action_id: 'watchdog_exclude',
            value: String(target.pid),
          },
        ],
      },
    ];

    const messageTs = await this.sendMessage(text, blocks);

    // Auto-kill timer
    const timer = setTimeout(async () => {
      const pending = this.pendingKills.get(target.pid);
      if (!pending) return;
      this.pendingKills.delete(target.pid);

      // **쏘기 직전에 다시 잰다.** 그 사이 압박이 풀렸으면 쏘지 않는다 — 9/29 00:15 에는
      // 커밋이 이미 89.4% 로 기준 아래였는데 그대로 동기화 커밋 데몬을 죽였다.
      const now = route === 'system'
        ? { usagePct: (await this.getSystemCommitStatus())?.usagePct ?? null, targetMB: null }
        : { usagePct: null, targetMB: await this.getProcessMB(target.pid) };
      if (!stillWarranted(route, now, { thresholdPct: this.thresholdPct, processThresholdMB: this.processThresholdMB })) {
        const shown = route === 'system' ? `커밋 ${now.usagePct ?? '측정 실패'}%` : `${now.targetMB ?? '측정 실패'} MB`;
        await this.updateMessage(pending.messageTs,
          t('watchdog.cancelled', this.locale, { pid: String(target.pid), name: target.name, now: shown }),
        ).catch(() => {});
        this.record({ phase: 'cancel', route, pid: target.pid, name: target.name, now });
        this.logger.info(`자동 종료 취소 — ${target.name} (PID ${target.pid}) · ${shown}`);
        return;
      }

      // 그 사이 PID 가 재사용됐으면 쏘지 않는다.
      const outcome = this.killIfSame(target.pid, target.name, target.startTicks);
      const autoText = outcome === 'killed'
        ? t('watchdog.autoKill', this.locale, { pid: String(target.pid), name: target.name, commitMB: String(target.commitMB), minutes: String(Math.max(1, Math.round(delaySec / 60))) })
        : outcome === 'gone'
          ? t('watchdog.alreadyGone', this.locale, { pid: String(target.pid), name: target.name })
          : outcome === 'recycled'
            ? `PID ${target.pid} 은 이제 다른 프로세스입니다 — ${target.name} 은 이미 끝났습니다. 죽이지 않았습니다.`
            : `PID ${target.pid} (${target.name}) 자동 종료 실패.`;

      await this.updateMessage(pending.messageTs, autoText).catch(e =>
        this.logger.error('Failed to update watchdog auto-kill message', e),
      );
      // 자동 종료 결과를 남긴다 — 전에는 로그에 없어 「죽였나 · 스스로 끝났나」를 가를 수 없었다
      this.record({ phase: 'auto-kill', route, pid: target.pid, name: target.name, mb: target.commitMB, outcome });
      this.logger.info(`자동 종료 ${outcome} — ${target.name} (PID ${target.pid}, ${target.commitMB} MB)`);

      if (outcome === 'killed') {
        this.onProcessKilled?.(target.pid, target.name);
        errorCollector.add('MemoryWatchdog', `Auto-killed ${target.name} (PID ${target.pid}, ${target.commitMB} MB) after ${delaySec}s timeout`);
      }
    }, delaySec * 1000);

    this.pendingKills.set(target.pid, {
      pid: target.pid,
      name: target.name,
      commitMB: target.commitMB,
      startTicks: target.startTicks,
      messageTs,
      timer,
    });

    this.logger.info(`Kill confirmation sent for ${target.name} (PID ${target.pid}, ${target.commitMB} MB)`);
  }

  /** 회차마다 상위 프로세스 크기를 적어 둔다 — 「계속 커지는가」가 폭주를 가르는 재료다. */
  private remember(processes: ProcessInfo[]): void {
    const seen = new Set<number>();
    for (const p of processes) {
      seen.add(p.pid);
      const h = this.history.get(p.pid);
      if (!h || h.ticks !== p.startTicks) {
        this.history.set(p.pid, { ticks: p.startTicks, mb: [p.commitMB] });
      } else {
        h.mb.push(p.commitMB);
        if (h.mb.length > 5) h.mb.shift();
      }
    }
    for (const pid of [...this.history.keys()]) if (!seen.has(pid)) this.history.delete(pid);
    for (const pid of [...this.waitedAt.keys()]) if (!seen.has(pid)) this.waitedAt.delete(pid);
  }

  private growth(pid: number): number | null {
    const h = this.history.get(pid);
    return h && h.mb.length > 1 ? h.mb[h.mb.length - 1] - h.mb[0] : null;
  }

  /** 기다리기로 한 폭주가 그 뒤 1GB 넘게 더 커지지 않았으면 다시 묻지 않는다(최대 30분). */
  private waitStillHolds(p: ProcessInfo): boolean {
    const w = this.waitedAt.get(p.pid);
    if (!w) return false;
    if (p.commitMB - w.mb >= 1024 || Date.now() - w.at > 30 * 60_000) {
      this.waitedAt.delete(p.pid);
      return false;
    }
    return true;
  }

  /** 전체 프로세스 표(부모 · 명령줄) — 판정할 때만 부른다(3분마다 부르기엔 무겁다). */
  private async getProcessTable(): Promise<ProcRow[]> {
    try {
      const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`,
        { timeout: 30_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
      const data = JSON.parse(stdout || '[]');
      return (Array.isArray(data) ? data : [data]).map((r: any) => ({
        pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId),
        name: String(r.Name || '').replace(/\.exe$/i, ''), cmd: String(r.CommandLine || ''),
      }));
    } catch (e) {
      // 빈 표 = 계보를 모름. 부르는 쪽(`decide` 의 lineageKnown)이 시스템 경로 종료를 막는다 —
      // 모두 계보 밖으로 보이면 동기화 프로세스가 후보가 되기 때문이다.
      this.logger.warn('프로세스 표를 못 읽음', e as Error);
      return [];
    }
  }

  /** 자정 · 정오 파이프라인 러너 PID — 잠금 파일에서. 없거나 못 읽으면 null. */
  private readPipelinePid(): number | null {
    const f = this.opts.pipelineLockFile;
    if (!f) return null;
    try {
      const pid = Number(JSON.parse(fs.readFileSync(f, 'utf-8')).pid);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private async getProcessMB(pid: number): Promise<number | null> {
    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.PM }"`,
        { timeout: 15_000, windowsHide: true },
      );
      const b = parseInt(stdout.trim(), 10);
      return Number.isFinite(b) ? Math.round(b / (1024 * 1024)) : null;
    } catch {
      return null;
    }
  }

  private record(ev: Record<string, unknown>): void {
    try {
      const f = watchdogEventsFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n', 'utf-8');
    } catch (e) {
      this.logger.warn('감시기 판정 기록 실패', e as Error);
    }
  }

  private async getSystemCommitStatus(): Promise<CommitStatus | null> {
    // Cache commit limit (doesn't change without reboot/pagefile resize)
    if (this.cachedCommitLimitMB === 0) {
      const limit = await this.queryCommitLimit();
      if (limit === null) return null;
      this.cachedCommitLimitMB = limit;
    }

    const committed = await this.queryCommittedBytes();
    if (committed === null) return null;

    const usagePct = Math.round(committed / this.cachedCommitLimitMB * 1000) / 10;
    return { committedMB: Math.round(committed), limitMB: Math.round(this.cachedCommitLimitMB), usagePct };
  }

  private async queryCommitLimit(): Promise<number | null> {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize"',
        { timeout: 10_000, windowsHide: true },
      );
      const kb = parseInt(stdout.trim(), 10);
      if (isNaN(kb)) return null;
      return kb / 1024; // KB → MB
    } catch (e) {
      this.logger.error('Failed to query commit limit', e);
      return null;
    }
  }

  private async queryCommittedBytes(): Promise<number | null> {
    try {
      // Use Get-CimInstance (faster than Get-Counter, no admin needed)
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; $os.TotalVirtualMemorySize - $os.FreeVirtualMemory"',
        { timeout: 10_000, windowsHide: true },
      );
      const kb = parseInt(stdout.trim(), 10);
      if (isNaN(kb)) return null;
      return kb / 1024; // KB → MB
    } catch (e) {
      this.logger.error('Failed to query committed bytes', e);
      return null;
    }
  }

  private async getTopProcesses(count: number): Promise<ProcessInfo[]> {
    try {
      // StartTime 을 함께 걷는다 — 죽일 때 같은 프로세스인지 확인할 유일한 근거다.
      // 보호 프로세스는 StartTime 읽기가 거부되는데, 그건 0 으로 두고 죽이지 않는다.
      const ps = `Get-Process | Where-Object { $_.PM -gt 100MB } | Sort-Object PM -Descending | Select-Object -First ${count} | ForEach-Object { $tk = 0; try { $tk = $_.StartTime.Ticks } catch { }; '{0}|{1}|{2}|{3}' -f $_.Id, $_.Name, $_.PM, $tk }`;
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`,
        { timeout: 15_000, windowsHide: true },
      );
      const results: ProcessInfo[] = [];
      for (const raw of stdout.trim().split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const match = line.match(/^(\d+)\|(.+)\|(\d+)\|(\d+)$/);
        if (match) {
          results.push({
            pid: parseInt(match[1], 10),
            name: match[2],
            commitMB: Math.round(parseInt(match[3], 10) / (1024 * 1024)),
            startTicks: match[4],   // 문자열 그대로 — 숫자로 바꾸면 정밀도가 깨진다
          });
        }
      }
      return results;
    } catch (e) {
      this.logger.error('Failed to query top processes', e);
      return [];
    }
  }

  /**
   * **PID 만으로 쏘지 않는다.** 이 감시기는 후보를 잡아 두고 한참 뒤에 죽인다 —
   * 자동 종료는 기본 10분 뒤이고, 슬랙 버튼은 그 메시지가 남아 있는 한 언제든
   * 눌린다. 그 사이에 대상이 스스로 끝나고 Windows 가 같은 번호를 다른 프로세스에
   * 내주면, PID 로 쏜 `SIGKILL`/`taskkill /F` 가 그것을 맞힌다.
   *
   * 이름과 시작시각이 잡아 둘 때와 같을 때만 죽인다. 시작시각을 못 읽었으면(0)
   * 신원 확인이 안 된 것이라 죽이지 않는다.
   *
   * 반환값은 무슨 일이 있었는지 그대로 낸다 — 예전에는 `taskkill` 이 도는 데
   * 성공했는지만 봐서, 이미 사라진 것도 「죽였다」로 보고했다.
   */
  private killIfSame(pid: number, name: string, startTicks: string):
      'killed' | 'gone' | 'recycled' | 'failed' {
    if (!startTicks || startTicks === '0') return 'recycled';   // 확인 못 한 것은 건드리지 않는다
    try {
      const check = require('child_process').execSync(
        `powershell -NoProfile -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
        + `if (-not $p) { 'gone' } else { $tk = 0; try { $tk = $p.StartTime.Ticks } catch { }; `
        + `if ($p.Name -ne '${name.replace(/'/g, "''")}' -or $tk -ne ${startTicks}) { 'recycled' } else { 'same' } }"`,
        { timeout: 15_000, encoding: 'utf-8', windowsHide: true },
      ).toString().trim();
      if (check === 'gone') return 'gone';
      if (check !== 'same') return 'recycled';
    } catch {
      return 'failed';   // 확인 자체가 실패했으면 쏘지 않는다
    }
    return this.killProcess(pid) ? 'killed' : 'failed';
  }

  private killProcess(pid: number): boolean {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      // process.kill failed (might be elevated or already dead), try taskkill
      try {
        require('child_process').execSync(`taskkill /PID ${pid} /F`, {
          timeout: 10_000,
          stdio: 'ignore',
        });
        return true;
      } catch {
        this.logger.warn(`Failed to kill PID ${pid} — process may have already exited`);
        return false;
      }
    }
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0); // Signal 0 = check existence
      return true;
    } catch {
      return false;
    }
  }

}
