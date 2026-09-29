/**
 * 처리 제안 실행기 — report-log 의 규칙 엔진(`tools/flow.py`)이 정한 대로 세션을 띄운다.
 *
 * **규칙은 report-log 에 있다.** 여기는 `next` 가 준 사양대로 세션을 띄우고, 끝나면
 * `complete` 를 부르고, 사람 차례 · 대기 · 끝이 나올 때까지 되풀이할 뿐이다. 상태 전환 ·
 * 등급 · 시도 횟수를 여기 옮겨 적지 않는다 — 두 곳에 적은 규칙은 한쪽이 조용히 낡는다.
 *
 * **세션 결과는 파일로만 받는다.** 세션이 돌려주는 글은 마지막 턴뿐이라, `next` 가 정한
 * 결과 파일이 이 세션 시작 뒤에 쓰였는지만 본다. 형식 검사는 `complete` 가 한다.
 *
 * **한 번에 한 차례.** 버튼 · 타이머 · 명령이 겹쳐도 세션은 하나씩 돈다. 두 제안이 같은
 * 저장소를 동시에 고치지 않게 하려는 것이고, report-log 의 작업 잡기 파일이 두 번째 문이다.
 *
 * 설계: report-log `docs/design.md` 「실행 구조」.
 */
import { spawn, execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { errorCollector } from './error-collector';
import { isSessionRateLimited } from './rate-limit-utils';
import { quoteForShell } from './work-assistant';
import type { SessionResult, SpawnOpts } from './assistant-scheduler';

export const ACTION_ID_RE = /^a-\d{8}-\d{2,}$/;
export const DECISIONS = ['approve', 'hold', 'reject', 'reopen'] as const;
export type Decision = typeof DECISIONS[number];

/** 한 제안을 한 차례에 몇 단계까지 밀고 가나. 넘으면 다음 차례에 이어 간다 — 도는 고리 차단. */
const MAX_STEPS = 16;
/** 요약 메시지에 싣는 제안 수. 제안 하나가 블록 둘이라 슬랙 한 메시지 50블록 안에 머문다. */
const DIGEST_MAX_ITEMS = 18;

/** 사람이 없는 세션에 붙이는 한 줄 — 분석 세션의 같은 지시와 같은 까닭(`SCHEDULED_SESSION_DIRECTIVE`). */
const DIRECTIVE = '이 세션은 사람이 없는 예약 실행이다. 프롬프트는 설명이 아니라 지금 수행할 절차다. '
  + '되묻지 않는다. 결과는 프롬프트가 정한 결과 파일에 쓴다 — 결과 파일 없이 끝나면 이 단계는 실패로 친다.';

export interface FlowNotice {
  kind: string;
  id: string;
  title: string;
  emoji: string;
  state: string;
  state_label: string;
  tier: string;
  text: string;
  url: string;
  buttons: string[];
}

/** `flow.py next` 의 답. 세션을 띄울 때만 `prompt` 부터 아래가 있다. */
export interface FlowSpec {
  job: string;
  error?: string;
  who?: string;
  state?: string;
  notify?: FlowNotice[];
  title?: string;
  seq?: number;
  prompt?: string;
  model?: string;
  effort?: SpawnOpts['effort'];
  cwd?: string;
  add_dirs?: string[];
  tools?: string[];
  timeout_min?: number;
  out?: string;
  fallback?: { allowed: boolean; cwd: string; writable: string[] };
}

export interface FlowDigest {
  need_you: FlowNotice[];
  stuck: FlowNotice[];
  site: string;
  error?: string;
}

export interface PipelineDeps {
  /** report-log 명령을 부르고 출력 JSON 을 돌려준다. 실패도 `{ error }` 로 — 던지지 않는다. */
  run: (script: 'flow' | 'report_log', args: string[]) => Promise<any>;
  /** 세션 한 번 — 스케줄러의 1차 · 폴백 경로. */
  session: (label: string, prompt: string, opts: SpawnOpts) => Promise<SessionResult>;
  /** 스탠리 DM 한 통. */
  post: (text: string, blocks?: unknown[]) => Promise<void>;
  useSdk?: boolean;
}

type DrainEnd = 'stop' | 'busy' | 'rate-limited' | 'error';

// ── report-log 위치 · 명령 ─────────────────────────────────────────

/** 자동 기록 상태 폴더. report-log 의 `state_root()` 와 같은 규칙 — **경로는 홈에서 계산한다**(공개 저장소). */
export function reportLogState(): string {
  return process.env.REPORT_LOG_STATE || path.join(os.homedir(), '.report-log');
}

/** 자동 기록 전용 클론. 개발용 클론이 아니다 — 자동 커밋과 개발 작업이 한 폴더에서 부딪히지 않게. */
export function reportLogRepo(): string {
  return process.env.REPORT_LOG_REPO || path.join(reportLogState(), 'repo');
}

export function reportLogAvailable(): boolean {
  return fs.existsSync(path.join(reportLogRepo(), 'tools', 'flow.py'));
}

/** cmd.exe 로 넘기는 글에서 따옴표로 못 막는 글자를 뺀다(`quoteForShell` 주석). */
function shellSafe(text: string): string {
  return text.replace(/["%\r\n]/g, ' ').slice(0, 300);
}

export function runReportLog(script: 'flow' | 'report_log', args: string[],
                             timeoutMs = 300_000): Promise<any> {
  const useShell = process.platform === 'win32';
  const argv = useShell ? args.map(quoteForShell) : args;
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn('python', ['-X', 'utf8', `tools/${script}.py`, ...argv], {
        cwd: reportLogRepo(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ error: `실행 못 함 — ${(err as Error).message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const killTimer = setTimeout(() => {
      try {
        // shell:true 래퍼(cmd.exe)만 죽이면 python 자식이 고아로 남아 잠금을 쥔다 — 트리 kill.
        if (process.platform === 'win32' && proc.pid) {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* 이미 끝났다 */ }
    }, timeoutMs);
    proc.on('error', (err: Error) => { clearTimeout(killTimer); resolve({ error: err.message }); });
    proc.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        const tail = (stderr || stdout).trim().split('\n').slice(-3).join(' / ');
        resolve({ error: `rc ${code ?? '?'} · ${tail.slice(0, 300)}` });
      }
    });
  });
}

/** 이 세션이 시작된 뒤에 결과 파일이 쓰였나. 존재만 보면 앞 시도가 남긴 파일을 이번 성과로 읽는다. */
function writtenSince(file: string, sinceMs: number): boolean {
  try {
    return fs.statSync(file).mtimeMs >= sinceMs - 1000;
  } catch {
    return false;
  }
}

/** 밤 검토 시간대 `"02:00-07:00"` → 자정부터 분. 못 읽으면 null — 검토를 안 켠다. */
export function parseWindow(text: string | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec((text || '').trim());
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from < to && to <= 24 * 60 ? [from, to] : null;
}

// ── 메시지 ─────────────────────────────────────────────────────────

const KIND_HEAD: Record<string, string> = {
  urgent: '🔴 급한 처리 제안',
  reapproval: '🔁 다시 승인 필요',
  'second-approval': '✋ 두 번째 승인',
  'merge-waiting': '⏳ 병합 대기',
  stuck: '⚠️ 판단 필요',
  result: '📋 실행 결과',
  reviewed: '🔍 다시 검토 끝',
};
const TIER_LABEL: Record<string, string> = { light: '가벼움', normal: '보통', critical: '중대' };
const DECISION_LABEL: Record<Decision, string> = {
  approve: '진행', hold: '보류', reject: '폐기', reopen: '다시 열기',
};

function clip(text: string, n: number): string {
  const t = (text || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 제목 글자는 링크 표기(`<주소|글>`)를 깨지 않게 꺾쇠를 뺀다. */
function plain(text: string): string {
  return (text || '').replace(/[<>|]/g, ' ');
}

function buttonsBlock(n: FlowNotice): unknown | null {
  const ids = n.buttons.filter((b): b is Decision => (DECISIONS as readonly string[]).includes(b));
  if (!ids.length) return null;
  return {
    type: 'actions',
    block_id: `actb_${n.id}`,
    elements: ids.map((d) => ({
      type: 'button',
      // 두 번째 승인의 「진행」은 곧 실제 반영이라 말을 바꾼다.
      text: { type: 'plain_text', text: d === 'approve' && n.state === 'awaiting-second-approval' ? '실행' : DECISION_LABEL[d] },
      action_id: `actions_${d}`,
      value: n.id,
      ...(d === 'approve' ? { style: 'primary' } : d === 'reject' ? { style: 'danger' } : {}),
    })),
  };
}

function itemBlocks(n: FlowNotice, head?: string): unknown[] {
  const tier = TIER_LABEL[n.tier] ? ` · ${TIER_LABEL[n.tier]}` : '';
  const lines = [
    head ? `*${head}*` : '',
    `${n.emoji ? `${n.emoji} ` : ''}*<${n.url}|${plain(clip(n.title, 120))}>*  _${n.state_label}${tier}_`,
    clip(n.text, 600),
  ].filter(Boolean);
  const blocks: unknown[] = [{
    type: 'section', block_id: `acts_${n.id}`, text: { type: 'mrkdwn', text: lines.join('\n') },
  }];
  const btns = buttonsBlock(n);
  if (btns) blocks.push(btns);
  return blocks;
}

/** 즉시 알림 한 건 — 급한 제안 · 두 번째 승인 · 멈춤 · 결과. */
export function buildNoticeBlocks(n: FlowNotice): unknown[] {
  const head = n.kind === 'result'
    ? (n.state === 'achieved' ? '✅ 달성' : n.state === 'queued' ? '↩️ 미달 — 다시 검토' : '❌ 미달')
    : (KIND_HEAD[n.kind] || n.kind);
  return itemBlocks(n, head);
}

/** 아침 요약 — 사람 차례인 제안(버튼)과 멈춘 제안. 둘 다 없으면 null(메시지를 안 보낸다). */
export function buildDigestBlocks(d: FlowDigest): unknown[] | null {
  const need = d.need_you || [];
  const stuck = d.stuck || [];
  if (!need.length && !stuck.length) return null;
  const main = need.filter((n) => n.state !== 'reject-proposed');
  const rejects = need.filter((n) => n.state === 'reject-proposed');
  const blocks: unknown[] = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*🗂 처리 제안* — 결정 필요 ${main.length}건`
        + (rejects.length ? ` · 폐기 제안 ${rejects.length}건` : '')
        + (stuck.length ? ` · 멈춤 ${stuck.length}건` : '')
        + ` · <${d.site}/actions/|desk 에서 보기>`,
    },
  }];
  let shown = 0;
  for (const n of main) {
    if (shown >= DIGEST_MAX_ITEMS) break;
    blocks.push(...itemBlocks(n));
    shown += 1;
  }
  // 폐기 제안은 뒤로 — 검토가 이미 「하지 말자」고 본 것이라 확정만 하면 된다.
  if (rejects.length && shown < DIGEST_MAX_ITEMS) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '폐기 제안 — 사유를 보고 확정하거나 다시 엽니다' }] });
    for (const n of rejects) {
      if (shown >= DIGEST_MAX_ITEMS) break;
      blocks.push(...itemBlocks(n));
      shown += 1;
    }
  }
  const rest = need.length - shown;
  const tail: string[] = [];
  if (rest > 0) tail.push(`그 외 ${rest}건 — <${d.site}/actions/|desk>`);
  for (const s of stuck.slice(0, 5)) tail.push(`⏸ <${s.url}|${plain(clip(s.title, 80))}> — ${clip(s.text, 120)}`);
  if (stuck.length > 5) tail.push(`멈춘 제안 ${stuck.length - 5}건 더`);
  if (tail.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tail.join('\n') }] });
  return blocks;
}

/** 버튼을 누른 뒤 그 제안의 버튼 줄만 결과 한 줄로 바꾼다. 같은 메시지의 다른 제안은 그대로. */
export function markDecided(blocks: any[], id: string, note: string): any[] {
  return (blocks || []).map((b) => (b && b.block_id === `actb_${id}`
    ? { type: 'context', block_id: `actd_${id}`, elements: [{ type: 'mrkdwn', text: note }] }
    : b));
}

// ── 실행기 ─────────────────────────────────────────────────────────

export class ActionPipeline {
  private logger = new Logger('ActionPipeline');
  private pumping: Promise<void> | null = null;
  private wantRun = false;
  private wantReview: { until?: number } | null = null;
  /** 한 건만 콕 집어 미는 요청 — 계획 없이 [진행]을 눌러 다시 검토로 간 제안. */
  private wantIds = new Set<string>();

  constructor(private deps: PipelineDeps) {}

  /**
   * 차례를 청한다 — `run` 은 진행 중인 제안을 이어 가고, `review` 는 검토 대기 제안을 검토한다.
   * 이미 도는 중이면 지금 차례 뒤에 한 번 더 돈다(겹친 요청은 하나로 합친다).
   */
  request(kind: 'run' | 'review' | 'one', arg?: number | string): Promise<void> {
    if (kind === 'run') this.wantRun = true;
    else if (kind === 'review') this.wantReview = { until: arg as number | undefined };
    else this.wantIds.add(arg as string);
    if (!this.pumping) {
      this.pumping = this.pump().finally(() => { this.pumping = null; });
    }
    return this.pumping;
  }

  isBusy(): boolean {
    return this.pumping !== null;
  }

  /** 타이머 한 번 — 이어 가기는 늘 · 검토는 업무일의 시간대 안에서만. */
  tick(opts: { review: boolean; window: [number, number] | null; workingDay: boolean },
       now: Date = new Date()): Promise<void> {
    const p = this.request('run');
    if (opts.review && opts.window && opts.workingDay) {
      const mins = now.getHours() * 60 + now.getMinutes();
      if (mins >= opts.window[0] && mins < opts.window[1]) {
        const until = new Date(now);
        until.setHours(0, opts.window[1], 0, 0);
        return this.request('review', until.getTime());
      }
    }
    return p;
  }

  private async pump(): Promise<void> {
    const clear = () => { this.wantRun = false; this.wantReview = null; this.wantIds.clear(); };
    try {
      while (this.wantRun || this.wantReview || this.wantIds.size) {
        await this.sync();
        if (this.wantRun) {
          this.wantRun = false;
          if (await this.pass('run') === 'rate-limited') { clear(); break; }
        }
        for (const id of [...this.wantIds]) {
          this.wantIds.delete(id);
          if (await this.drain(id) === 'rate-limited') { clear(); break; }
          await this.announce(id);
        }
        if (this.wantReview) {
          const r = this.wantReview;
          this.wantReview = null;
          if (await this.pass('review', r.until) === 'rate-limited') { clear(); break; }
        }
      }
    } catch (err) {
      this.logger.error('처리 제안 차례가 터졌습니다', err);
      errorCollector.add('처리 제안', `차례 중단 — ${(err as Error).message}`);
      clear();
    }
  }

  /** 원격에 맞춘다. 못 해도 멈추지 않는다 — 로컬에 있는 규칙으로 돈다. */
  private async sync(): Promise<void> {
    const r = await this.deps.run('flow', ['sync']);
    if (r?.error) this.logger.warn(`report-log 당겨 오기 실패 — ${r.error}`);
  }

  private async pass(kind: 'run' | 'review', until?: number): Promise<DrainEnd | 'done'> {
    const p = await this.deps.run('flow', ['pending', '--kind', kind]);
    if (p?.error) {
      this.logger.warn(`대기 목록을 못 읽음 — ${p.error}`);
      return 'error';
    }
    for (const id of (p.ids || []) as string[]) {
      if (until && Date.now() >= until) {
        this.logger.info('검토 시간대가 끝나 남은 제안은 다음 밤으로');
        break;
      }
      const end = await this.drain(id);
      if (end === 'rate-limited' || end === 'busy') return end;
    }
    return 'done';
  }

  /** 제안 하나를 사람 차례 · 대기 · 끝까지 밀고 간다. */
  async drain(id: string): Promise<DrainEnd> {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const spec: FlowSpec = await this.deps.run('flow', ['next', id]);
      if (!spec || spec.error) {
        this.logger.warn(`${id} 다음 할 일을 못 받음 — ${spec?.error}`);
        errorCollector.add('처리 제안', `${id} next 실패 — ${spec?.error}`);
        return 'error';
      }
      await this.tell(spec.notify);
      if (spec.job === 'again') continue;
      if (spec.job === 'busy') return 'busy';
      if (spec.job === 'wait' || spec.job === 'done') return 'stop';
      if (!spec.prompt || !spec.out || spec.seq === undefined || !spec.cwd) {
        this.logger.warn(`${id} 사양이 모자람 — ${spec.job}`);
        return 'error';
      }
      const end = await this.runJob(id, spec);
      if (end !== 'next') return end;
    }
    this.logger.warn(`${id} — 한 차례에 ${MAX_STEPS} 단계를 넘겨 멈춤 · 다음 차례에 이어 감`);
    return 'stop';
  }

  private spawnOpts(spec: FlowSpec): SpawnOpts {
    const fb = spec.fallback;
    return {
      workingDirectory: spec.cwd!,
      additionalDirectories: spec.add_dirs,
      model: spec.model,
      effort: spec.effort,
      permissionMode: 'default',
      allowedTools: spec.tools,
      appendSystemPrompt: DIRECTIVE,
      env: { ASSISTANT_MODE: 'actions', CLAUDE_SCHEDULED: '1' },
      skipMcp: true,
      maxDurationMs: (spec.timeout_min ?? 30) * 60_000,
      useSdk: this.deps.useSdk,
      // 폴백도 이 작업의 범위만 쓴다 — `null` 이면 폴백을 안 한다.
      fallbackScope: fb && fb.allowed ? { cwd: fb.cwd, writable: fb.writable } : null,
    };
  }

  private async runJob(id: string, spec: FlowSpec): Promise<'next' | DrainEnd> {
    const started = Date.now();
    let result: SessionResult | null = null;
    let crash = '';
    this.logger.info(`${id} ${spec.title} 시작`, { job: spec.job, effort: spec.effort, cwd: spec.cwd });
    try {
      result = await this.deps.session(`처리 제안 ${spec.title}`, spec.prompt!, this.spawnOpts(spec));
    } catch (err) {
      crash = (err as Error).message || String(err);
    }
    const args = ['complete', id, '--seq', String(spec.seq)];
    if (!writtenSince(spec.out!, started)) {
      if (result && isSessionRateLimited(result)) {
        args.push('--rate-limited');
      } else {
        const why = crash ? `스탠리 오류 — ${crash}` : `세션 ${result?.subtype ?? '?'} — 결과 파일 없음`;
        args.push('--failed', shellSafe(why));
      }
    }
    const done = await this.deps.run('flow', args);
    if (!done || done.error) {
      // 작업 잡기 표시가 남아 있으면 제한 시간이 지나야 풀린다 — 알린다.
      this.logger.error(`${id} 결과 반영 실패 — ${done?.error}`);
      errorCollector.add('처리 제안', `${id} complete 실패 — ${done?.error}`);
      return 'error';
    }
    this.logger.info(`${id} ${spec.title} → ${done.result} · ${done.state}`);
    await this.tell(done.notify);
    return done.result === 'rate-limited' ? 'rate-limited' : 'next';
  }

  private async tell(notes?: FlowNotice[]): Promise<void> {
    for (const n of notes || []) {
      try {
        await this.deps.post(`${KIND_HEAD[n.kind] || n.kind} — ${n.title}`, buildNoticeBlocks(n));
      } catch (err) {
        this.logger.warn('처리 제안 알림을 못 보냄', err);
      }
    }
  }

  /** 사람이 불러 돈 제안이 다시 사람 차례가 됐으면 바로 알린다 — 아침 요약까지 기다리게 하지 않는다. */
  private async announce(id: string): Promise<void> {
    const d = await this.deps.run('flow', ['digest']);
    const n = (d?.need_you || []).find((x: FlowNotice) => x.id === id);
    if (n) await this.tell([{ ...n, kind: 'reviewed' }]);
  }

  /** 아침 요약 블록 — 없으면 null. 못 읽으면 null 로 물러나 브리핑을 막지 않는다. */
  async digestBlocks(): Promise<unknown[] | null> {
    const d = await this.deps.run('flow', ['digest']);
    if (!d || d.error) {
      this.logger.warn(`처리 제안 요약을 못 읽음 — ${d?.error}`);
      return null;
    }
    return buildDigestBlocks(d as FlowDigest);
  }

  /** 버튼 결정. 진행이면 곧바로 차례를 청한다(승인 즉시 실행 · 2026-09-29 사용자 결정). */
  async decide(id: string, decision: string): Promise<{ ok: boolean; note: string }> {
    if (!ACTION_ID_RE.test(id) || !(DECISIONS as readonly string[]).includes(decision)) {
      return { ok: false, note: '⚠️ 버튼 값이 올바르지 않습니다' };
    }
    const r = await this.deps.run('report_log', ['decide', id, decision, '--by', 'slack']);
    if (!r || r.error) return { ok: false, note: `⚠️ ${r?.error ?? '결정을 기록하지 못했습니다'}` };
    const label = DECISION_LABEL[decision as Decision];
    const at = new Date().toTimeString().slice(0, 5);
    let tail = '';
    if (decision === 'approve' && r.state === 'queued') {
      // 계획이 없던 제안 — 이 결정을 전제로 지금 다시 검토한다(report-log `cmd_decide`).
      void this.request('one', id);
      tail = ' — 계획이 없어 이 결정으로 다시 검토합니다 · 결과는 DM';
    } else if (decision === 'approve') {
      void this.request('run');
      tail = r.state === 'executing' ? ' — 실행합니다 · 결과는 DM' : ' — 실행 준비를 시작합니다 · 결과는 DM';
    } else if (decision === 'reopen') {
      tail = ' — 다음 밤 검토에 다시 올라갑니다';
    }
    return { ok: true, note: `*${label}* · ${at}${tail}` };
  }
}
