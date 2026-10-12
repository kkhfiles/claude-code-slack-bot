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
/** `-report <이름 일부>` 가 여러 종류에 맞을 때 링크를 몇 개까지 — 한 줄 context 블록에 들어가게. */
const REPORT_LINKS_MAX = 8;
/** 한도 회복 시각 정각이 아니라 1분 뒤에 이어 간다 — 딱 맞춰 부르면 아직 안 풀린 채 또 막힌다
 *  (`slack-handler.ts` `armRateLimitRecovery` 와 같은 까닭). */
const RESUME_SLACK_MS = 60_000;
/** 세션이 회복 시각을 안 알려 줬을 때 다시 해 보는 간격 — 이어 가기 타이머와 같은 한 시간. */
const RESUME_UNKNOWN_MS = 60 * 60_000;
/** 같은 까닭으로 원격에 못 맞춘 것을 「시스템 이슈」에 다시 남기는 간격 — 하루 한 번 비우는 브리핑마다
 *  한 줄은 보이고, 한 시간마다 같은 줄이 쌓여 수집기 한도(50)에서 다른 이슈를 밀어내지는 않게. */
const SYNC_REPORT_EVERY_MS = 12 * 60 * 60_000;

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
  /** 상태별 제안 수 — `queued` 는 새벽 검토가 아직 못 본 권고. */
  counts?: Record<string, number>;
  error?: string;
}

export interface PipelineDeps {
  /** report-log 명령을 부르고 출력 JSON 을 돌려준다. 실패도 `{ error }` 로 — 던지지 않는다. */
  run: (script: 'flow' | 'report_log', args: string[]) => Promise<any>;
  /** 세션 한 번 — 스케줄러의 1차 · 폴백 경로. */
  session: (label: string, prompt: string, opts: SpawnOpts) => Promise<SessionResult>;
  /** 스탠리 DM 한 통. */
  post: (text: string, blocks?: unknown[]) => Promise<void>;
  /** 제안마다 바깥 메시지 하나 · 이어지는 일은 그 스레드(`ThreadApi`). 없으면 예전처럼 `post` 로 한 통씩. */
  thread?: ThreadApi;
  useSdk?: boolean;
  /** 한도 회복 뒤 이어 간 검토가 끝났을 때 — 스케줄러가 요약 DM 을 보낸다(`-actions review` 와 같은 끝맺음). */
  afterResume?: () => Promise<void>;
}

/**
 * 처리 제안 스레드에 쓰는 슬랙 통로 — DM 채널 고정.
 *
 * 제안마다 바깥 메시지 하나(제목 · 요약 · 지금 상태)를 두고 검토 결과 · 결정 요청 · 결과를 그 스레드에
 * 단다. 알림이 따로따로 뜨면 한 제안이 어떻게 흘러갔는지 이어 읽을 수 없었다(2026-10-12 사용자 결정).
 * 못 보내면 `null` · `false` 로 — 던지지 않는다(부르는 쪽이 예전처럼 한 통으로 물러난다).
 */
export interface ThreadApi {
  /** 바깥 메시지(`threadTs` 없음) 또는 그 스레드의 답글 — 보낸 메시지의 ts. */
  post: (text: string, blocks: unknown[], threadTs?: string) => Promise<string | null>;
  /**
   * 메시지 고쳐 쓰기 — **지워졌을 때만 false**(슬랙 `message_not_found`) · 다른 오류는 던진다.
   * 지워진 것을 아는 길은 이것 하나다 — 지운 바깥 메시지에 단 답글은 오류 없이 채널에 따로 뜬다(2026-10-12 실측).
   */
  update: (ts: string, text: string, blocks: unknown[]) => Promise<boolean>;
  permalink: (ts: string) => Promise<string | null>;
  /** 결정을 묻는 답글에 넣을 사용자 ID — 남이 연 스레드의 답글은 알림이 안 갈 수 있다. */
  mention?: string;
}

/** 제안 하나의 스레드 — 바깥 메시지를 다시 그릴 재료와 지금 열려 있는 결정 요청. */
interface ThreadEntry {
  ts: string;
  title: string;
  url: string;
  emoji: string;
  tier: string;
  summary: string;
  /** 바깥 메시지의 「지금」 — 마지막 일(예: 「✋ 두 번째 승인」 · 「진행 · 08:32」). */
  now: string;
  /** 지나온 일 — 바깥 메시지에 최근 몇 개만. */
  trail: string[];
  /**
   * 아직 안 누른 결정 요청 답글 — 같은 상태로 두 번 묻지 않게 · 지나가면 버튼을 빼고 고쳐 쓰게 본문(`text`)을 둔다.
   * `text` 가 없는 것은 이 필드가 생기기 전 기록이다.
   */
  ask?: { ts: string; state: string; text?: string };
  link?: string;
  at: string;
}

/** 대응 기록을 몇 날 남기나 — 오래된 제안은 다시 오면 새 바깥 메시지를 만든다. */
const THREAD_KEEP_DAYS = 90;

/** 제안 ↔ 스레드 대응 파일 — **재시작에도 남아야 한다**(같은 제안의 뒷일이 새 바깥 메시지로 갈라지지 않게). */
function threadsFile(): string {
  return process.env.ACTIONS_THREADS_FILE || path.join(__dirname, '..', '.actions-threads.json');
}

function readThreads(): Record<string, ThreadEntry> {
  try {
    const v = JSON.parse(fs.readFileSync(threadsFile(), 'utf-8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * 대응 파일 쓰기 — 임시 파일에 쓰고 이름을 바꾼다. 바로 덮어쓰다 끊기면 반쪽 파일이 빈 대응으로 읽혀
 * 모든 제안이 바깥 메시지를 새로 만든다. **부르는 쪽은 읽기와 쓰기 사이에 기다리지 않는다**
 * (기다리는 사이 다른 제안이 쓴 것을 덮는다 — `ensureThread` 는 쓰기 직전에 다시 읽는다).
 */
function writeThreads(map: Record<string, ThreadEntry>): void {
  const cut = Date.now() - THREAD_KEEP_DAYS * 86_400_000;
  const kept = Object.fromEntries(Object.entries(map).filter(([, e]) => Date.parse(e.at) >= cut));
  const file = threadsFile();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(kept, null, 1), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* 못 적으면 다음 알림이 새 바깥 메시지를 만든다 — 알림 자체는 나간다 */
  }
}

/** 한도에 끊겨 회복 뒤로 미룬 「사람이 시킨」 몫. */
interface Parked {
  review: boolean;
  ids: string[];
  /** 한도가 풀리는 시각(epoch 초). 모르면 null. */
  resetsAt: number | null;
}

/**
 * 미룬 몫을 적는 파일 — **스탠리가 재시작해도 남아야 한다**(10/2 에 한도로 끊긴 뒤 27분 만에
 * 재시작이 있었다). 검사가 운영 파일을 안 건드리게 자리를 옮길 수 있어야 한다.
 */
function resumeFile(): string {
  return process.env.ACTIONS_RESUME_FILE || path.join(__dirname, '..', '.actions-resume.json');
}

function readParked(): Parked {
  try {
    const v = JSON.parse(fs.readFileSync(resumeFile(), 'utf-8'));
    return {
      review: v.review === true,
      ids: Array.isArray(v.ids) ? v.ids.filter((x: unknown) => typeof x === 'string' && ACTION_ID_RE.test(x)) : [],
      resetsAt: typeof v.resetsAt === 'number' ? v.resetsAt : null,
    };
  } catch {
    return { review: false, ids: [], resetsAt: null };
  }
}

/** 미룬 몫 파일의 원문 — 이어 가는 동안 다른 쪽(다시 미룸 · 사람이 다시 시킴)이 손댔는지 가리는 도장. */
function parkedStamp(): string {
  try {
    return fs.readFileSync(resumeFile(), 'utf-8');
  } catch {
    return '';
  }
}

/** 사람이 시킨 검토인가 — 시간대(`until`)가 없는 검토. 밤 검토는 늘 시간대를 붙인다. */
function isManual(r: { until?: number } | null): boolean {
  return r !== null && r.until === undefined;
}

function writeParked(p: Parked | null): void {
  try {
    if (p && (p.review || p.ids.length)) {
      fs.writeFileSync(resumeFile(), JSON.stringify({ ...p, at: new Date().toISOString() }), 'utf-8');
    } else {
      fs.rmSync(resumeFile(), { force: true });
    }
  } catch {
    /* 못 적으면 회복 때 이어 갈 몫이 빈다 — 밤 검토나 `-actions review` 가 그 몫을 다시 집는다 */
  }
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

/** report-log 에 있는 보고서 종류(`reports/` 아래 폴더 이름). 못 읽으면 undefined — 부르는 쪽은 준 이름 그대로 쓴다. */
export function reportTypes(): string[] | undefined {
  try {
    return fs.readdirSync(path.join(reportLogRepo(), 'reports'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return undefined;
  }
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

/** 알림 머리 — 결과는 달성 · 미달로 가른다. */
function noticeHead(n: FlowNotice): string {
  return n.kind === 'result'
    ? (n.state === 'achieved' ? '✅ 달성' : n.state === 'queued' ? '↩️ 미달 — 다시 검토' : '❌ 미달')
    : (KIND_HEAD[n.kind] || n.kind);
}

/** 즉시 알림 한 건 — 급한 제안 · 두 번째 승인 · 멈춤 · 결과. 스레드 통로가 없을 때의 모양. */
export function buildNoticeBlocks(n: FlowNotice): unknown[] {
  return itemBlocks(n, noticeHead(n));
}

/** 제안 스레드의 바깥 메시지 — 제목 · 요약 · 지금 상태 · 지나온 일. 버튼은 없다(스레드 답글에 둔다). */
export function buildThreadRoot(id: string, e: Pick<ThreadEntry, 'title' | 'url' | 'emoji' | 'tier' | 'summary' | 'now' | 'trail'>): unknown[] {
  const tier = TIER_LABEL[e.tier] ? ` · ${TIER_LABEL[e.tier]}` : '';
  const trail = e.trail.slice(0, -1).slice(-5);
  const lines = [`${e.emoji ? `${e.emoji} ` : ''}*🗂 <${e.url}|${plain(clip(e.title, 140))}>*`, clip(e.summary, 600)].filter(Boolean);
  return [
    { type: 'section', block_id: `actp_${id}`, text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text:
      `지금 *${e.now}*${tier}${trail.length ? ` · 지나온 일 ${trail.join(' → ')}` : ''} · 이어지는 일은 스레드` }] },
  ];
}

/**
 * 제안 스레드의 답글 — 머리 · 본문 · 상태, 사람 차례면 버튼. 제목은 바깥 메시지에 있어 되풀이하지 않는다.
 * `mention` 을 주면 결정을 묻는 답글에 사용자를 부른다 — 봇이 연 스레드의 답글은 알림이 안 갈 수 있다.
 */
export function buildThreadReply(n: FlowNotice, head: string, mention?: string): unknown[] {
  const tier = TIER_LABEL[n.tier] ? ` · ${TIER_LABEL[n.tier]}` : '';
  const btns = buttonsBlock(n);
  const lines = [`*${head}*${btns && mention ? ` <@${mention}>` : ''}  _${n.state_label}${tier}_`, clip(n.text, 600)].filter(Boolean);
  const blocks: unknown[] = [{ type: 'section', block_id: `acts_${n.id}`, text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (btns) blocks.push(btns);
  return blocks;
}

/** 결정 요청 답글의 본문 — 지나간 뒤 버튼을 빼고 다시 그릴 때 쓴다(`buildClosedAsk`). */
function askText(blocks: unknown[]): string {
  return (blocks[0] as { text: { text: string } }).text.text;
}

/** 지나간 결정 요청 — 본문은 그대로 · 버튼 줄 대신 지나간 까닭 한 줄(`markDecided` 와 같은 모양). */
export function buildClosedAsk(id: string, text: string, note: string): unknown[] {
  return [
    { type: 'section', block_id: `acts_${id}`, text: { type: 'mrkdwn', text } },
    { type: 'context', block_id: `actd_${id}`, elements: [{ type: 'mrkdwn', text: note }] },
  ];
}

/** 요약 목록에 싣는 줄 수 — 넘친 것은 desk 로 안내. 줄 10개마다 블록 하나라 50블록 안. */
const DIGEST_MAX_LINES = 30;

/**
 * 아침 요약(스레드 방식) — 버튼 없는 목록 · 줄마다 그 제안 스레드 링크. 결정 버튼은 제안 스레드의 답글에 있다.
 * 머리 줄 · 검토 대기 설명 · 멈춤 줄은 `buildDigestBlocks` 와 같다. 보낼 것이 없으면 null.
 */
export function buildDigestLinkBlocks(d: FlowDigest, links: Record<string, string>): unknown[] | null {
  const need = d.need_you || [];
  const stuck = d.stuck || [];
  const queued = d.counts?.queued || 0;
  if (!need.length && !stuck.length && !queued) return null;
  const main = need.filter((n) => n.state !== 'reject-proposed');
  const rejects = need.filter((n) => n.state === 'reject-proposed');
  const first = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*🗂 처리 제안* — 결정 필요 ${main.length}건`
        + (rejects.length ? ` · 폐기 제안 ${rejects.length}건` : '')
        + (stuck.length ? ` · 멈춤 ${stuck.length}건` : '')
        + (queued ? ` · 검토 대기 ${queued}건` : '')
        + ` · <${d.site}/actions/|desk 에서 보기>`,
    },
  };
  const blocks: unknown[] = [first];
  if (queued) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: QUEUED_NOTE }] });
  const line = (n: FlowNotice) => {
    const tier = TIER_LABEL[n.tier] ? ` · ${TIER_LABEL[n.tier]}` : '';
    return `• ${n.emoji ? `${n.emoji} ` : ''}${n.state_label}${tier} — <${links[n.id] || n.url}|${plain(clip(n.title, 90))}>`;
  };
  const chunks = (rows: string[]) => {
    for (let i = 0; i < rows.length; i += 10) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rows.slice(i, i + 10).join('\n') } });
  };
  const shownMain = main.slice(0, DIGEST_MAX_LINES);
  chunks(shownMain.map(line));
  const shownRejects = rejects.slice(0, Math.max(0, DIGEST_MAX_LINES - shownMain.length));
  if (shownRejects.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '폐기 제안 — 사유를 보고 확정하거나 다시 엽니다' }] });
    chunks(shownRejects.map(line));
  }
  const tail: string[] = [];
  if (need.length) tail.push('결정 버튼은 제안마다 스레드에 있습니다 — 줄을 누르면 그 스레드');
  const rest = need.length - shownMain.length - shownRejects.length;
  if (rest > 0) tail.push(`그 외 ${rest}건 — <${d.site}/actions/|desk>`);
  for (const s of stuck.slice(0, 5)) tail.push(`⏸ <${links[s.id] || s.url}|${plain(clip(s.title, 80))}> — ${clip(s.text, 120)}`);
  if (stuck.length > 5) tail.push(`멈춘 제안 ${stuck.length - 5}건 더`);
  if (tail.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: tail.join('\n') }] });
  return blocks;
}

const QUEUED_NOTE = '검토 대기 = 새벽 검토(업무일 02:00~07:00)가 아직 못 본 권고 · 아침마다 남아 있으면 검토가 멈춘 것(사용량 한도 · 실패)';

/** 아침 요약 — 사람 차례인 제안(버튼)과 멈춘 제안. 둘 다 없으면 null(메시지를 안 보낸다). 스레드 통로가 없을 때의 모양. */
export function buildDigestBlocks(d: FlowDigest): unknown[] | null {
  const need = d.need_you || [];
  const stuck = d.stuck || [];
  // **검토 대기도 센다.** 새벽 검토가 못 돌면(사용량 한도 · 실패) 권고가 여기 쌓이는데, 결정 필요도
  // 멈춤도 아니라 세지 않으면 아침 요약이 아예 안 뜬다 — 브리핑 「📊 보고서」 절을 걷은 뒤로는 권고가
  // 있다는 사실이 어디에도 안 보이게 된다(report-log 4단계 검토 · 2026-10-01).
  const queued = d.counts?.queued || 0;
  if (!need.length && !stuck.length && !queued) return null;
  const main = need.filter((n) => n.state !== 'reject-proposed');
  const rejects = need.filter((n) => n.state === 'reject-proposed');
  const blocks: unknown[] = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*🗂 처리 제안* — 결정 필요 ${main.length}건`
        + (rejects.length ? ` · 폐기 제안 ${rejects.length}건` : '')
        + (stuck.length ? ` · 멈춤 ${stuck.length}건` : '')
        + (queued ? ` · 검토 대기 ${queued}건` : '')
        + ` · <${d.site}/actions/|desk 에서 보기>`,
    },
  }];
  if (queued) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: QUEUED_NOTE }] });
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

/**
 * `-report [종류]` 답 — 처리 제안 요약 + desk 의 보고서 링크 (report-log 4단계 · 읽는 쪽 전환).
 *
 * 사람이 보는 단위는 보고서가 아니라 검토를 거친 처리 제안이라 요약을 먼저 둔다. 보고서 본문은
 * desk 가 회차별로 보여 준다(회차가 끝나면 바로 저장됨). 결정할 것이 없어도 링크는 늘 준다.
 *
 * `types` 는 report-log 에 있는 보고서 종류 — 주면 `종류` 를 이름 일부로도 찾는다(예전 `-report kg` 가
 * kg-health · kg-regression 을 함께 찾던 동작). 없으면 준 이름 그대로 링크한다.
 */
export function buildReportReplyBlocks(
  d: FlowDigest, type?: string, types?: string[], digest: unknown[] | null = buildDigestBlocks(d),
): unknown[] {
  const blocks = digest ? [...digest] : [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*🗂 처리 제안* — 결정할 것 없음 · <${d.site}/actions/|desk 에서 보기>` },
  }];
  const link = (t: string) => `<${d.site}/reports/${encodeURIComponent(t)}/|${plain(t)} 회차 보기>`;
  const home = `<${d.site}/|desk 에서 보고서 보기>`;
  let where = home;
  if (type) {
    const hits = !types ? [type] : types.includes(type) ? [type] : types.filter((t) => t.includes(type));
    where = hits.length
      ? hits.slice(0, REPORT_LINKS_MAX).map(link).join(' · ')
        + (hits.length > REPORT_LINKS_MAX ? ` 외 ${hits.length - REPORT_LINKS_MAX}종` : '')
      : `「${plain(type)}」에 맞는 보고서 종류 없음 · ${home}`;
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `📚 ${where} · 새 보고서는 회차가 끝나면 바로 올라옵니다` }] });
  return blocks;
}

/** 버튼을 누른 뒤 그 제안의 버튼 줄만 결과 한 줄로 바꾼다. 같은 메시지의 다른 제안은 그대로. */
export function markDecided(blocks: any[], id: string, note: string): any[] {
  return (blocks || []).map((b) => (b && b.block_id === `actb_${id}`
    ? { type: 'context', block_id: `actd_${id}`, elements: [{ type: 'mrkdwn', text: note }] }
    : b));
}

/**
 * 결정 버튼의 답 — 받아들였으면 누른 제안의 줄만 결과로 바꾼 원래 메시지, 거절이면 누른 사람에게만
 * 보이는 알림(`noticeReply`). 처리 제안 🗂 과 개선 제안 💡 버튼이 같이 쓴다.
 */
export function decisionReply(
  r: { ok: boolean; note: string; stale?: boolean }, message: any, id: string, fallbackText: string,
): Record<string, any> {
  // 낡은 버튼(이미 결정된 제안)의 거절은 그 줄을 지금 상태 한 줄로 — 알림으로 두면 버튼이 남아 누를 때마다
  // 「나에게만 표시」가 쌓였다(2026-10-07 사용자 결정). 다시 누르면 될 수 있는 거절은 알림으로 두고 버튼을 남긴다.
  if (!r.ok && !r.stale) return noticeReply(r.note);
  return { replace_original: true, text: message?.text || fallbackText, blocks: markDecided(message?.blocks || [], id, r.note) };
}

/**
 * 버튼을 누른 사람에게만 보이는 알림 — **원래 메시지는 그대로 둔다.**
 *
 * `replace_original: false` 를 빼면 버튼 메시지의 `response_url` 로 보낸 답이 원래 메시지를 바꿔 쓴다
 * (`response_type: 'ephemeral'` 이어도). 이미 보류된 제안을 한 번 더 누른 거절 답이 🗂 요약 전체를
 * 한 줄 경고로 덮었다(2026-10-06 · 슬랙 기록 `edited`).
 */
export function noticeReply(text: string): Record<string, any> {
  return { response_type: 'ephemeral', replace_original: false, text };
}

// ── 실행기 ─────────────────────────────────────────────────────────

export class ActionPipeline {
  private logger = new Logger('ActionPipeline');
  private pumping: Promise<void> | null = null;
  private wantRun = false;
  private wantReview: { until?: number } | null = null;
  /** 한 건만 콕 집어 미는 요청 — 계획 없이 [진행]을 눌러 다시 검토로 간 제안. */
  private wantIds = new Set<string>();
  /** 방금 한도에 걸린 세션이 알려 준 회복 시각(epoch 초) — `runJob` 이 적고 `park` 가 읽는다. */
  private limitResetsAt: number | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 원격에 못 맞춘 까닭을 마지막으로 「시스템 이슈」에 남긴 것 — 맞추면 비운다(`sync`). */
  private syncReported: { why: string; at: number } | null = null;
  /** 제안별 스레드 일의 차례 — 끝난 것은 지운다(`inTurn`). */
  private threadTurns = new Map<string, Promise<unknown>>();

  constructor(private deps: PipelineDeps) {}

  /**
   * 차례를 청한다 — `run` 은 진행 중인 제안을 이어 가고, `review` 는 검토 대기 제안을 검토한다.
   * 이미 도는 중이면 지금 차례 뒤에 한 번 더 돈다(겹친 요청은 하나로 합친다).
   *
   * **시간대(`until`) 없는 `review` 와 `one` 은 사람이 시킨 것**이다(`-actions review` · 계획 없는
   * [진행]). 밤 검토는 늘 시간대를 붙여 부른다.
   */
  request(kind: 'run' | 'review' | 'one', arg?: number | string): Promise<void> {
    // 사람이 다시 시켰으면 미뤄 둔 같은 몫은 지금 돈다 — 남겨 두면 회복 때 한 번 더 돌고 요약도 두 번 온다.
    if ((kind === 'review' && arg === undefined) || kind === 'one') this.unpark(kind === 'one' ? arg as string : null);
    return this.enqueue(kind, arg);
  }

  /** 차례에 얹기만 한다 — 미룬 몫을 건드리지 않는다(`resume` 이 자기 몫을 지우지 않게). */
  private enqueue(kind: 'run' | 'review' | 'one', arg?: number | string): Promise<void> {
    if (kind === 'run') this.wantRun = true;
    else if (kind === 'review') {
      // **사람이 시킨 검토는 뒤에 온 밤 검토에 덮이지 않는다** — 덮이면 시간대가 붙어 한도에 끊길 때
      // 사람 몫으로 남지 않는다. 사람이 시킨 검토는 시간대 없이 끝까지 돈다.
      const manual = arg === undefined || isManual(this.wantReview);
      this.wantReview = { until: manual ? undefined : arg as number };
    } else this.wantIds.add(arg as string);
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
          if (await this.pass('run') === 'rate-limited') { this.park(isManual(this.wantReview), [...this.wantIds]); clear(); break; }
        }
        for (const id of [...this.wantIds]) {
          this.wantIds.delete(id);
          if (await this.drain(id) === 'rate-limited') { this.park(isManual(this.wantReview), [id, ...this.wantIds]); clear(); break; }
          await this.announce(id);
        }
        if (this.wantReview) {
          const r = this.wantReview;
          this.wantReview = null;
          // 도는 검토가 밤 검토여도 그사이 사람이 시킨 검토가 들어와 있으면 그 몫을 남긴다.
          if (await this.pass('review', r.until) === 'rate-limited') {
            this.park(isManual(r) || isManual(this.wantReview), [...this.wantIds]);
            clear();
            break;
          }
        }
      }
    } catch (err) {
      this.logger.error('처리 제안 차례가 터졌습니다', err);
      errorCollector.add('처리 제안', `차례 중단 — ${(err as Error).message}`);
      clear();
    }
  }

  /**
   * 한도에 끊긴 차례에서 **사람이 시킨 몫만** 남겨 회복 시각에 이어 간다(2026-10-02 사용자 결정).
   *
   * 밤 검토(시간대 있음)와 이어 가기는 남기지 않는다 — 제 타이머가 다시 부르고, 밤 검토를 낮까지
   * 끌고 오면 사람 작업과 한도를 다툰다. 남기지 않던 동안 `-actions review` 는 한도에 걸리는 순간
   * 사라졌고, 검토 대기는 다음 업무일 새벽까지 그대로 있었다(10/2 17:13 · 7건 · 주말을 넘김).
   */
  private park(manualReview: boolean, ids: string[]): void {
    const was = readParked();
    const next: Parked = {
      review: was.review || manualReview,
      ids: [...new Set([...was.ids, ...ids])],
      resetsAt: this.limitResetsAt ?? was.resetsAt,
    };
    if (!next.review && !next.ids.length) return;
    writeParked(next);
    this.armResume(next.resetsAt);
    this.logger.info('사람이 시킨 처리 제안 검토를 한도가 풀린 뒤로 미룹니다', next);
  }

  private unpark(id: string | null): void {
    const was = readParked();
    if (!was.review && !was.ids.length) return;
    const next: Parked = id === null
      ? { ...was, review: false }
      : { ...was, ids: was.ids.filter((x) => x !== id) };
    writeParked(next);
    if (!next.review && !next.ids.length) this.stopResume();
  }

  private armResume(resetsAt: number | null): void {
    this.stopResume();
    const delay = resetsAt
      ? Math.max(RESUME_SLACK_MS, resetsAt * 1000 + RESUME_SLACK_MS - Date.now())
      : RESUME_UNKNOWN_MS;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.resume().catch((err) => this.logger.error('한도 회복 뒤 이어 가기 실패', err));
    }, delay);
    this.resumeTimer.unref?.();
  }

  /** 기동 · 설정 저장 뒤 — 미뤄 둔 몫이 있으면 회복 시각에 다시 건다. 짝은 `stopResume`. */
  restoreResume(): void {
    const p = readParked();
    if (p.review || p.ids.length) this.armResume(p.resetsAt);
  }

  stopResume(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /**
   * 회복 시각 — 미뤄 둔 몫을 다시 청하고, 끝나면 요약을 한 번 보낸다.
   *
   * **파일은 일이 끝날 때까지 둔다** — 이어 가는 도중 재시작 · 오류가 나도 기동(`restoreResume`)이
   * 다시 건다. 끝났을 때 파일이 시작 때와 같을 때만 지우고 요약한다. 그사이 또 한도에 걸려 다시
   * 미뤘으면(`park`) 다음 회복이, 사람이 다시 시켰으면(`unpark`) 그 요청이 요약을 맡는다 — 둘이
   * 같은 차례를 기다렸다 요약을 두 번 보내지 않게.
   */
  async resume(): Promise<void> {
    const p = readParked();
    if (!p.review && !p.ids.length) return;
    const stamp = parkedStamp();
    this.logger.info('한도가 풀려 사람이 시킨 처리 제안 검토를 이어 갑니다', p);
    let done: Promise<void> = Promise.resolve();
    for (const id of p.ids) done = this.enqueue('one', id);
    if (p.review) done = this.enqueue('review');
    await done;
    if (parkedStamp() !== stamp) return;
    writeParked(null);
    await this.deps.afterResume?.();
  }

  /**
   * 원격에 맞춘다. 못 해도 멈추지 않는다 — 로컬에 있는 규칙으로 돈다.
   *
   * **못 맞춘 것은 「시스템 이슈」로 남긴다**(원인 코드가 오면 같이 · 예: `dirty`). 경고 로그뿐이던 동안
   * 자동 기록 클론에 커밋 안 된 파일 하나로 받아 얹기가 계속 실패했고, desk 갱신 · 규칙 반영이 조용히
   * 멈췄다(2026-10-07 검토 W1). 같은 까닭이 이어지면 `SYNC_REPORT_EVERY_MS` 마다 한 번만.
   */
  private async sync(): Promise<void> {
    const r = await this.deps.run('flow', ['sync']);
    if (!r?.error) {
      this.syncReported = null;
      return;
    }
    const why = `${r.code ? `(${r.code}) ` : ''}${String(r.error).slice(0, 200)}`;
    this.logger.warn(`report-log 당겨 오기 실패 — ${why}`);
    const last = this.syncReported;
    if (last && last.why === why && Date.now() - last.at < SYNC_REPORT_EVERY_MS) return;
    this.syncReported = { why, at: Date.now() };
    errorCollector.add('처리 제안', `자동 기록 클론을 원격에 못 맞춤 ${why} — desk 갱신 · 규칙 반영이 멈춤`);
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
        this.limitResetsAt = result.rateLimitResetsAt ?? null;
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
        let done = false;
        if (this.deps.thread) {
          try {
            done = await this.inTurn(n.id, () => this.tellThread(n));
          } catch (err) {
            this.logger.warn('처리 제안 스레드로 못 보냄 — 한 통으로 보냄', err);
          }
        }
        if (!done) await this.deps.post(`${KIND_HEAD[n.kind] || n.kind} — ${n.title}`, buildNoticeBlocks(n));
      } catch (err) {
        this.logger.warn('처리 제안 알림을 못 보냄', err);
      }
    }
  }

  // ── 제안 스레드(2026-10-12 사용자 결정) ─────────────────────────────

  /** 지금 상태를 한 칸 옮긴다 — 바깥 메시지의 「지금」과 지나온 일. */
  private static step(e: ThreadEntry, now: string): void {
    e.now = now;
    if (e.trail[e.trail.length - 1] !== now) e.trail.push(now);
    if (e.trail.length > 12) e.trail = e.trail.slice(-12);
    e.at = new Date().toISOString();
  }

  /**
   * 같은 제안의 스레드 일은 차례로 한다 — 아침 요약 · 즉시 알림 · 버튼 결정이 겹치면 둘 다 「처음」으로 보고
   * 바깥 메시지를 둘 만들거나 서로의 기록을 덮는다(2026-10-12 다시 검토). 다른 제안은 기다리지 않는다.
   */
  private inTurn<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.threadTurns.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.threadTurns.set(id, tail);
    void tail.then(() => { if (this.threadTurns.get(id) === tail) this.threadTurns.delete(id); });
    return run;
  }

  /**
   * 그 제안의 바깥 메시지를 찾아 지금 상태를 `now` 로 고쳐 쓰거나, 없으면(처음 · 지워짐) 새로 만든다.
   * 못 보내면 null — 부르는 쪽이 예전 모양으로 물러난다. 같은 제안의 차례(`inTurn`) 안에서 부른다.
   */
  private async ensureThread(n: FlowNotice, now: string): Promise<ThreadEntry | null> {
    const api = this.deps.thread;
    if (!api) return null;
    const map = readThreads();
    const old = map[n.id];
    const fields = {
      title: n.title || old?.title || n.id, url: n.url || old?.url || '', emoji: n.emoji ?? old?.emoji ?? '',
      tier: n.tier || old?.tier || '',
      // 요약은 제안 머리말의 요약이 실려 오는 것(아침 요약 · 다시 검토 끝)만 — 다른 알림의 글은 그 단계의 글이다
      summary: (n.kind === 'digest' || n.kind === 'reviewed') && n.text ? n.text : old?.summary || '',
    };
    let e: ThreadEntry | null = null;
    if (old) {
      e = { ...old, ...fields };
      ActionPipeline.step(e, now);
      let alive = true;
      try {
        alive = await api.update(e.ts, `🗂 ${e.title}`, buildThreadRoot(n.id, e));
      } catch (err) {
        // 지워진 것이 아닌 오류(한도 · 네트워크) — 스레드는 그대로 쓰고 「지금」 줄만 이번에 못 고침
        this.logger.warn(`${n.id} 바깥 메시지를 못 고침 — 스레드는 그대로`, err);
      }
      if (!alive) e = null;
    }
    if (!e) {
      // 처음이거나 바깥 메시지가 지워짐 — 지나온 일은 이어 받고 링크 · 열린 요청은 버린다
      const fresh: ThreadEntry = { ts: '', ...fields, now, trail: [...(old?.trail || [])], at: '' };
      ActionPipeline.step(fresh, now);
      const ts = await api.post(`🗂 ${fresh.title}`, buildThreadRoot(n.id, fresh));
      if (!ts) return null;
      fresh.ts = ts;
      e = fresh;
    }
    // 쓰기 직전에 다시 읽는다 — 슬랙을 기다리는 사이 다른 제안이 쓴 대응을 덮지 않게
    const cur = readThreads();
    cur[n.id] = e;
    writeThreads(cur);
    return e;
  }

  /** 대응 기록의 한 제안을 고친다(열린 요청 · 링크) — 파일에서 다시 읽어 고친다. */
  private static patchThread(id: string, patch: (e: ThreadEntry) => void): void {
    const map = readThreads();
    if (!map[id]) return;
    patch(map[id]);
    writeThreads(map);
  }

  /** 지나간 결정 요청 답글에서 버튼을 뺀다 — 한 스레드에 살아 있는 버튼이 여러 벌 쌓이지 않게. 못 고쳐도 넘어간다. */
  private async closeAsk(id: string, ask: ThreadEntry['ask'], note: string): Promise<void> {
    const api = this.deps.thread;
    if (!api || !ask?.text) return;
    try {
      await api.update(ask.ts, note, buildClosedAsk(id, ask.text, note));
    } catch (err) {
      this.logger.warn(`${id} 지나간 결정 요청을 못 고침`, err);
    }
  }

  /** 알림 한 건을 그 제안 스레드에 — 사람 차례면 버튼과 멘션. 못 하면 false(예전처럼 한 통으로). */
  private async tellThread(n: FlowNotice): Promise<boolean> {
    const api = this.deps.thread!;
    const head = noticeHead(n);
    const asks = buttonsBlock(n) !== null;
    const e = await this.ensureThread(n, head);
    if (!e) return false;
    const blocks = buildThreadReply(n, head, asks ? api.mention : undefined);
    // 답글이 안 가면 예전처럼 한 통으로 — 대응은 둔다. 지운 바깥 메시지에도 답글은 가므로(실측) 이것은 일시 오류다
    const ts = await api.post(`${head} — ${e.title}`, blocks, e.ts);
    if (!ts) return false;
    if (e.ask && e.ask.ts !== ts) {
      await this.closeAsk(n.id, e.ask, asks ? '지나간 요청 — 새 요청은 아래' : `지나간 요청 — 지금 「${n.state_label || n.state}」`);
    }
    ActionPipeline.patchThread(n.id, (x) => {
      if (asks) x.ask = { ts, state: n.state, text: askText(blocks) };
      else delete x.ask;
    });
    return true;
  }

  /** 요약의 한 제안 — 스레드를 갖추고 결정 요청을 단다. 링크(못 얻으면 '') · 못 갖추면 null(예전 모양으로). */
  private async digestItem(api: ThreadApi, n: FlowNotice): Promise<string | null> {
    const e = await this.ensureThread(n, n.state_label || n.state);
    if (!e) return null;
    if (buttonsBlock(n) && (!e.ask || e.ask.state !== n.state)) {
      // 요약 자체가 알림이라 멘션은 안 한다
      const blocks = buildThreadReply(n, '🗂 결정할 차례');
      const ts = await api.post(`결정할 차례 — ${e.title}`, blocks, e.ts);
      // 결정 요청을 못 달면 버튼이 어디에도 없다 — 요약에 버튼을 싣는 예전 모양으로
      if (!ts) return null;
      if (e.ask) await this.closeAsk(n.id, e.ask, '지나간 요청 — 새 요청은 아래');
      ActionPipeline.patchThread(n.id, (x) => { x.ask = { ts, state: n.state, text: askText(blocks) }; });
    }
    const link = e.link || (await api.permalink(e.ts));
    if (link && link !== e.link) ActionPipeline.patchThread(n.id, (x) => { x.link = link; });
    return link || '';
  }

  /**
   * 요약 블록 — 스레드 통로가 있으면 사람 차례인 제안마다 스레드를 갖추고(바깥 메시지 · 결정 요청 답글)
   * 링크 목록을 낸다. 통로가 없거나 못 갖추면 예전 모양(버튼 포함) — 결정할 길을 잃지 않게.
   */
  private async digestFrom(d: FlowDigest): Promise<unknown[] | null> {
    const api = this.deps.thread;
    const need = d.need_you || [];
    if (!api || (!need.length && !(d.stuck || []).length && !d.counts?.queued)) return buildDigestBlocks(d);
    const links: Record<string, string> = {};
    try {
      for (const n of need.slice(0, DIGEST_MAX_LINES)) {
        const link = await this.inTurn(n.id, () => this.digestItem(api, n));
        if (link === null) return buildDigestBlocks(d);
        if (link) links[n.id] = link;
      }
      const map = readThreads();
      for (const s of d.stuck || []) if (map[s.id]?.link) links[s.id] = map[s.id].link as string;
    } catch (err) {
      this.logger.warn('처리 제안 스레드를 못 갖춤 — 예전 모양으로', err);
      return buildDigestBlocks(d);
    }
    return buildDigestLinkBlocks(d, links);
  }

  /** 결정이 기록되면 바깥 메시지의 지금 상태를 그 결정으로 · 열린 요청은 닫힘. */
  private async markThread(id: string, now: string): Promise<void> {
    const api = this.deps.thread;
    if (!api) return;
    await this.inTurn(id, async () => {
      const map = readThreads();
      const e = map[id];
      if (!e) return;
      const ask = e.ask;
      ActionPipeline.step(e, now);
      delete e.ask;
      writeThreads(map);
      // 열린 결정 요청은 버튼을 뺀다 — 누른 답글이 그것이면 곧이어 버튼 답(`decisionReply`)이 같은 모양으로 덮는다
      await this.closeAsk(id, ask, `결정 — ${now}`);
      try {
        await api.update(e.ts, `🗂 ${e.title}`, buildThreadRoot(id, e));
      } catch (err) {
        this.logger.warn('처리 제안 바깥 메시지를 못 고침', err);
      }
    });
  }

  /** 사람이 불러 돈 제안이 다시 사람 차례가 됐으면 바로 알린다 — 아침 요약까지 기다리게 하지 않는다. */
  private async announce(id: string): Promise<void> {
    const d = await this.deps.run('flow', ['digest']);
    const n = (d?.need_you || []).find((x: FlowNotice) => x.id === id);
    if (n) await this.tell([{ ...n, kind: 'reviewed' }]);
  }

  /**
   * 아침 요약 블록 — 없으면 null. 못 읽으면 null 로 물러나 브리핑을 막지 않되 「시스템 이슈」로
   * 남긴다 — 둘 다 null 이라 남기지 않으면 못 읽은 날이 「결정할 것 없음」으로 읽힌다.
   */
  async digestBlocks(): Promise<unknown[] | null> {
    const d = await this.deps.run('flow', ['digest']);
    if (!d || d.error) {
      this.logger.warn(`처리 제안 요약을 못 읽음 — ${d?.error}`);
      errorCollector.add('처리 제안', `요약을 못 읽음 — ${String(d?.error ?? '답 없음').slice(0, 200)}`);
      return null;
    }
    return this.digestFrom(d as FlowDigest);
  }

  /** `-report` 답 블록. report-log 를 못 읽으면 null — 부르는 쪽이 그 사실을 알린다. */
  async reportReplyBlocks(type?: string): Promise<unknown[] | null> {
    const d = await this.deps.run('flow', ['digest']);
    if (!d || d.error || !d.site) {
      this.logger.warn(`보고서 안내를 못 만듦 — ${d?.error ?? 'site 없음'}`);
      return null;
    }
    return buildReportReplyBlocks(d as FlowDigest, type, type ? reportTypes() : undefined, await this.digestFrom(d as FlowDigest));
  }

  /** 버튼 결정. 진행이면 곧바로 차례를 청한다(승인 즉시 실행 · 2026-09-29 사용자 결정). */
  async decide(id: string, decision: string): Promise<{ ok: boolean; note: string; stale?: boolean }> {
    if (!ACTION_ID_RE.test(id) || !(DECISIONS as readonly string[]).includes(decision)) {
      return { ok: false, note: '⚠️ 버튼 값이 올바르지 않습니다' };
    }
    const r = await this.deps.run('report_log', ['decide', id, decision, '--by', 'slack']);
    if (r?.error && r.code === 'state') {
      // 지금 상태에서는 그 결정을 못 함 — 대개 이미 결정된 제안의 낡은 버튼(`decisionReply` 가 그 줄을 바꿈)
      const at = new Date().toTimeString().slice(0, 5);
      return { ok: false, stale: true, note: `⚠️ 이미 「${r.state_label ?? r.state}」 상태 · 바꾸지 않음 · ${at}` };
    }
    if (!r || r.error) return { ok: false, note: `⚠️ ${r?.error ?? '결정을 기록하지 못했습니다'}` };
    const label = DECISION_LABEL[decision as Decision];
    const at = new Date().toTimeString().slice(0, 5);
    let tail = '';
    // 스레드 방식이면 뒷일은 그 제안 스레드에 붙는다(`tellThread`)
    const where = this.deps.thread ? '결과는 이 제안 스레드' : '결과는 DM';
    if (decision === 'approve' && r.state === 'queued') {
      // 계획이 없던 제안 — 이 결정을 전제로 지금 다시 검토한다(report-log `cmd_decide`).
      void this.request('one', id);
      tail = ` — 계획이 없어 이 결정으로 다시 검토합니다 · ${where}`;
    } else if (decision === 'approve') {
      void this.request('run');
      tail = r.state === 'executing' ? ` — 실행합니다 · ${where}` : ` — 실행 준비를 시작합니다 · ${where}`;
    } else if (decision === 'reopen') {
      tail = ' — 다음 밤 검토에 다시 올라갑니다';
    }
    // 굵게 없이 — 바깥 메시지가 「지금 *…*」으로 감싼다(겹치면 별표가 그대로 보였다 · 2026-10-12 다시 검토)
    await this.markThread(id, `${label} · ${at}`);
    return { ok: true, note: `*${label}* · ${at}${tail}` };
  }
}
