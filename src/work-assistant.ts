/**
 * 개인 업무 비서(work-assistant) 브리지.
 *
 * 채널 분담이 이 모듈의 설계를 전부 결정한다:
 *   슬랙 = 얇은 양방향 — 한 줄 캡처·짧은 요약. **놓치지 않게 하는 곳**
 *   Claude Code 세션 = 두꺼운 채널 — 판단·협의·실제 처리
 * 그래서 여기에는 판단이 없다. 목록을 옮겨오지도 않는다.
 *
 * 두 방향의 신뢰도가 다르다는 점이 중요하다:
 *   - **캡처(입력)는 절대 실패하면 안 된다.** 그래서 파이썬을 거치지 않고
 *     inbox.jsonl 에 직접 append 한다. 안전망일수록 의존 부품이 적어야 한다
 *     (work-assistant/CLAUDE.md). 파이썬·노션이 죽어 있어도 원문은 남는다.
 *   - **요약(출력)은 실패해도 된다.** 노션 왕복이 필요하니 파이썬 CLI 를 부르고,
 *     실패하면 그 사실만 알린다.
 */
import { spawn, execSync, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { Logger } from './logger';
import { withoutApiKey } from './child-env';
import { engineState, type EngineState } from './engine-state';
import { classifyCodexErrorText } from './rate-limit-utils';
import { STEP_INPUT_MAX, STEP_MAX } from './turn-outcome';
import type { HeldItem, HoldExtra } from './hold-replay';
import { codexDrill, drillBlockUntil, type DrillScope } from './engine-drill';
import { serviceCodex } from './model-ladder';

export type { HoldExtra };

const logger = new Logger('WorkAssistant');

/** 업무 비서 레포 루트. 없으면 관련 기능을 켜지 않는다. */
export function workAssistantRoot(): string | null {
  const root = config.workAssistant.root;
  if (!root) return null;
  return fs.existsSync(path.join(root, 'bin', 'tasks.py')) ? root : null;
}

export function isWorkAssistantEnabled(): boolean {
  return workAssistantRoot() !== null;
}

// ---------------------------------------------------------------- 캡처 (입력)

export interface InboxRecord {
  id: string;
  ts: string;
  source: string;
  text: string;
  thread: string | null;
  status: 'open' | 'filed' | 'dropped';
  task: string | null;
  note: string | null;
  /** 받은 대화방 · 메시지 — 밀린 것을 **받은 자리에서** 다시 돌린다(보류 v2). 옛 파이썬은 그대로 둔다. */
  channel?: string;
  msg_ts?: string;
}

/** `2026-08-05T09:12:33+09:00` — 파이썬 쪽 형식과 맞춘다. */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

function randomId(): string {
  return Array.from({ length: 8 },
    () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * 캡처 큐 파일. **파이썬과 같은 규칙** — `WORK_ASSISTANT_HOME` 이 있으면 그 아래, 없으면 레포 루트
 * (`tasks.py` 의 `HOME = WORK_ASSISTANT_HOME or ROOT`). 둘이 다른 파일을 보면 잠금도 다른 파일을 잡는다.
 */
export function inboxFile(root: string): string {
  return path.join(process.env.WORK_ASSISTANT_HOME || root, 'inbox.jsonl');
}

// 캡처 큐 잠금 (2026-10-14) — 파이썬(`tasks.py` `_inbox_lock`)과 **같은 파일 · 같은 규칙**이다.
// 파이썬은 `inbox.jsonl` 을 통째로 다시 쓰는데, 그 사이에 여기서 덧붙인 줄은 **사라진다**(받은 말을
// 잃는다). 이름·묵은 기준을 바꾸면 둘을 같이 바꾼다.
// ⚠️ **못 잡으면 잠금 없이 덧붙이지 않는다**(2026-10-15 검토) — 잠금을 쥔 쪽이 이미 읽은 뒤면 그 줄은 다시
// 쓰기에 덮인다. 대기실(`inbox.spool/<id>.json`)에 두고, 파이썬의 다음 잠긴 고치기가 합친 뒤 지운다.
/** 이보다 오래된 잠금은 죽은 프로세스가 남긴 것으로 보고 지운다 — `INBOX_LOCK_STALE_S`. */
export const INBOX_LOCK_STALE_MS = 30_000;
/** 덧붙이기는 이만큼만 기다리고 못 잡으면 대기실에 둔다 — `INBOX_ADD_WAIT_S`. */
export const INBOX_ADD_WAIT_MS = 2_000;

/** 잠금을 못 잡은 캡처의 대기실 — `inbox.jsonl` 옆 `inbox.spool/`(파이썬 `_inbox_spool_dir` 와 같은 규칙). */
export function inboxSpoolDir(file: string): string {
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.spool`);
}

/** 캡처 하나를 대기실에 둔다 — 임시 파일에 다 쓰고 이름을 바꿔 읽는 쪽이 반쪽을 안 보게. */
function spoolCapture(file: string, rec: InboxRecord): void {
  const dir = inboxSpoolDir(file);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${rec.id}.json`);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec), 'utf-8');
  fs.renameSync(tmp, dest);
}
/** 다시 해 보는 간격 — `time.sleep(0.02)`. */
const INBOX_LOCK_POLL_MS = 20;

/** 동기로 잠깐 잔다 — 캡처는 동기 함수라(부르는 쪽이 기다리지 않는다) 이벤트 루프를 짧게 세운다. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 잠금 파일을 만들어 잡는다(`O_CREAT|O_EXCL` = `'wx'`, 안에 pid). 못 잡으면 `false`.
 * 묵은 잠금은 지우고 바로 다시 해 본다.
 */
function takeInboxLock(lock: string, waitMs: number): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try { fs.writeSync(fd, `${process.pid}\n`); } finally { fs.closeSync(fd); }
      return true;
    } catch (err: any) {
      // 있다(EEXIST) · 윈도에서 지우는 중인 파일(EPERM) — 기다릴 일이다. 그 밖(폴더가 없음 등)은
      // 기다려도 안 풀리므로 바로 손을 뗀다.
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') return false;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > INBOX_LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
    } catch {
      /* 그 사이에 풀렸다 — 아래에서 다시 해 본다 */
    }
    if (Date.now() >= deadline) return false;
    sleepSync(INBOX_LOCK_POLL_MS);
  }
}

/**
 * 슬랙에서 받은 원문을 캡처 큐에 적는다. **해석하지 않는다.**
 *
 * 순서가 규칙이다 — 원문 저장(결정론) → 해석(세션) → 닫기. 해석이 실패해도
 * 원문은 이미 안전하다. 그래서 여기서는 파이썬도 노션도 부르지 않는다.
 *
 * 슬랙 원문에는 따옴표·줄바꿈·한글이 섞이는데, 이걸 CLI 인자로 넘기면
 * win32 `shell:true` spawn 에서 깨지거나 주입 위험이 생긴다. 파일에 직접
 * 쓰면 그 문제 자체가 없어진다.
 *
 * **덧붙일 때 파이썬과 같은 잠금을 잡는다**(`<inbox>.lock`) — 파이썬이 파일을 통째로 다시 쓰는
 * 사이에 덧붙인 줄은 덮여 사라진다. 2초 안에 못 잡으면 경고를 남기고 대기실(`inboxSpoolDir`)에 둔다 —
 * 파이썬이 읽을 때 같이 보고 다음 잠긴 고치기에 합친다. 대기실에도 못 두면 마지막 수단으로 덧붙인다.
 */
export function captureToInbox(
  text: string, source = 'slack', thread?: string, where?: { channel?: string; msgTs?: string },
): InboxRecord | null {
  const root = workAssistantRoot();
  if (!root) return null;
  const rec: InboxRecord = {
    id: randomId(),
    ts: localIso(new Date()),
    source,
    text,
    thread: thread ?? null,
    status: 'open',
    task: null,
    note: null,
    ...(where?.channel ? { channel: where.channel } : {}),
    ...(where?.msgTs ? { msg_ts: where.msgTs } : {}),
  };
  const file = inboxFile(root);
  const lock = `${file}.lock`;
  // 잠금을 짧게 기다리고 **못 잡으면 대기실에 둔다** — 받은 말을 잃지 않는 것이 먼저다.
  const locked = takeInboxLock(lock, INBOX_ADD_WAIT_MS);
  try {
    if (!locked) {
      try {
        spoolCapture(file, rec);
        logger.warn('캡처 큐 잠금을 못 잡아 대기실에 둡니다', { waitedMs: INBOX_ADD_WAIT_MS });
        return rec;
      } catch (err) {
        // 대기실에도 못 두면 덧붙인다 — 덮일 수 있어도 아무 데도 안 남는 것보다 낫다.
        logger.warn('캡처 대기실에 못 둬 잠금 없이 덧붙입니다', { err: String((err as Error)?.message ?? err) });
      }
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { encoding: 'utf-8' });
    return rec;
  } catch (err) {
    logger.error('inbox capture failed', err);
    return null;
  } finally {
    if (locked) {
      try { fs.rmSync(lock, { force: true }); } catch { /* 다음 잡는 쪽이 묵은 것으로 지운다 */ }
    }
  }
}

/**
 * 그 차례가 처리 못 하고 끝났다고 캡처에 적는다.
 *
 * **이유를 안 가린다** (2026-08-31 사용자) — 한도든 서버 장애든 재시작이든
 * 「정상 종료 못 했다」 하나로 묶는다. 이유별 장치를 따로 두었더니 실제로
 * 어긋났다: 한도 큐가 08/24 의 서버 과부하(529)를 5시간짜리 한도로 잡아
 * 이레를 들고 있는 동안, 캡처 큐는 같은 건을 그날 안에 제대로 닫았다.
 *
 * ⚠️ **캡처를 붙일 때와 달리 파이썬을 거친다.** 붙이기는 이어 쓰기라 잠금만 같이 잡으면
 * 봇이 직접 해도 되는데, 이것은 **파일 전체를 다시 쓰는 일**이라 소유자가 하나여야 한다.
 * 느리지만(0.4초) 이 길은 드물게 돈다 — 로그 전체에서 실제로 막힌 것이 1건이다.
 *
 * ⚠️ **닫힌 캡처에도 적는다.** 「닫힘」은 「다 했다」가 아니라 「무언가 썼다」라서
 * (첫 쓰기에 닫힌다), 일하다 끊긴 차례가 닫힌 채로 남는다. 옛 규칙은 다시 돌리지 않고
 * 아침 브리핑이 한 줄로 알린다 · 보류 v2 는 세션이 적혀 있으면 그 세션으로 이어 간다.
 *
 * **보류 칸(`extra`)은 파일로 넘긴다** — 슬랙에서 온 글이 섞여 셸 인자로는 못 넘긴다
 * (`quoteForShell`). 옛 파이썬은 `--extra-file` · `partial` 을 모른다(rc 2) — 그러면 옛 모양
 * (`limit`)으로 한 번 더 적는다. 표시가 안 남는 것이 칸을 잃는 것보다 나쁘다.
 */
export async function markCaptureFailed(
  id: string, why: 'limit' | 'error' | 'interrupted' | 'partial', extra?: HoldExtra,
): Promise<void> {
  if (!id || !isWorkAssistantEnabled()) return;
  let extraFile = '';
  try {
    const args = ['inbox', 'fail', '--id', id, '--why', why];
    if (extra && Object.keys(extra).length) {
      extraFile = path.join(os.tmpdir(), `hold-extra-${randomId()}.json`);
      fs.writeFileSync(extraFile, JSON.stringify(extra), 'utf-8');
      args.push('--extra-file', extraFile);
    }
    let { code, stderr, stdout } = await runTasks(args, 30_000);
    if (code !== 0 && (extraFile || why === 'partial')) {
      logger.warn('보류 칸과 함께 못 적어 옛 모양으로 적습니다', { id, why, out: (stderr || stdout).slice(-200) });
      ({ code, stderr, stdout } = await runTasks(
        ['inbox', 'fail', '--id', id, '--why', why === 'partial' ? 'limit' : why], 30_000));
    }
    if (code !== 0) logger.error('캡처에 실패를 못 적었습니다', { id, why, out: (stderr || stdout).slice(-200) });
  } catch (err) {
    // 안전망이라 실패해도 본 차례를 막지 않는다 — 대신 조용히 지나가지 않게 남긴다.
    logger.error('캡처에 실패를 못 적었습니다', err);
  } finally {
    if (extraFile) {
      try { fs.rmSync(extraFile, { force: true }); } catch { /* 임시 파일 — 남아도 해가 없다 */ }
    }
  }
}

/** 밀린 것 한 건 — 칸은 `hold-replay.ts` 의 `HeldItem`(옛 파이썬이면 앞 넷만 있다). */
export type PendingCapture = HeldItem;

/**
 * 다시 돌릴 것 — 가르는 규칙은 파이썬(`drain_list`)에 있다.
 *
 * **규칙을 여기 옮겨 적지 않는다.** 두 곳에 두면 한쪽이 낡고, 낡은 쪽이
 * 조용히 이긴다 — 오늘 아침에 캡처 id 를 읽는 규칙이 갈려 메일 캡처 여섯 건이
 * 통째로 안 닫혔다. 봇은 목록을 받아 넘기기만 한다.
 */
export async function pendingCaptures(limit = 5): Promise<PendingCapture[]> {
  if (!isWorkAssistantEnabled()) return [];
  try {
    const { code, stdout } = await runTasks(['inbox', 'pending', '--limit', String(limit)], 30_000);
    if (code !== 0) return [];
    return JSON.parse(stdout).run ?? [];
  } catch (err) {
    logger.error('밀린 캡처를 못 읽었습니다', err);
    return [];
  }
}

/** 다시 돌릴 것과 사람에게 낼 것 둘 다 — 보류 v2 가 7일 지난 것을 묻는 데 쓴다. */
export async function pendingHeld(limit = 5): Promise<{ run: HeldItem[]; tell: HeldItem[] }> {
  if (!isWorkAssistantEnabled()) return { run: [], tell: [] };
  try {
    const { code, stdout } = await runTasks(['inbox', 'pending', '--limit', String(limit)], 30_000);
    if (code !== 0) return { run: [], tell: [] };
    const j = JSON.parse(stdout);
    return { run: Array.isArray(j.run) ? j.run : [], tell: Array.isArray(j.tell) ? j.tell : [] };
  } catch (err) {
    logger.error('밀린 캡처를 못 읽었습니다', err);
    return { run: [], tell: [] };
  }
}

/** 7일 지난 것을 사람에게 물었다고 적는다 — 같은 것을 두 번 안 묻게. */
export async function markCaptureTold(ids: string[]): Promise<void> {
  if (!ids.length || !isWorkAssistantEnabled()) return;
  try {
    const { code, stderr } = await runTasks(['inbox', 'told', ...ids.flatMap((id) => ['--id', id])], 30_000);
    if (code !== 0) logger.error('물었다는 표시를 못 적었습니다', { ids, out: stderr.slice(-200) });
  } catch (err) {
    logger.error('물었다는 표시를 못 적었습니다', err);
  }
}

/**
 * 다시 돌린 차례가 끝까지 갔다 — 실패 자국과 보류 칸을 걷는다.
 *
 * ⚠️ **안 걷으면 닫힌 채 이어 간 것이 다음 드레인에 또 돈다** — 닫힌 캡처는 닫는 쪽이 자국을
 * 못 지운다(이미 닫혀 있다).
 */
export async function markCaptureReplayed(id: string): Promise<void> {
  if (!id || !isWorkAssistantEnabled()) return;
  try {
    const { code, stderr } = await runTasks(['inbox', 'replayed', '--id', id], 30_000);
    if (code !== 0) logger.error('다시 돌림 끝을 못 적었습니다', { id, out: stderr.slice(-200) });
  } catch (err) {
    logger.error('다시 돌림 끝을 못 적었습니다', err);
  }
}

/**
 * 다시 돌려 봤다고 적는다 — **넘기기 전에** 부른다.
 *
 * ⚠️ 뒤에 부르면 그 차례가 또 터졌을 때 세지 못해, **같은 것을 끝없이 다시
 * 돌린다.** 상한이 있는 이유가 그것이라 순서가 규칙이다.
 */
export async function markCaptureTried(id: string): Promise<void> {
  if (!id || !isWorkAssistantEnabled()) return;
  try {
    await runTasks(['inbox', 'tried', '--id', id], 30_000);
  } catch (err) {
    logger.error('시도 횟수를 못 적었습니다', err);
  }
}

/**
 * 캡처를 버린다 — 사람이 「취소」를 눌렀을 때.
 *
 * **안 버리면 취소해 놓고도 회복 시각에 드레인이 다시 돌린다.**
 */
export async function dropCapture(id: string, why: string): Promise<void> {
  if (!id || !isWorkAssistantEnabled()) return;
  try {
    // **사람이 고른 것이라 `--force`** (2026-10-19) — `inbox resolve` 는 답을 기다리는 메일 물음이 남은
    // 캡처를 안 닫는데, 그 막음은 세션이 닫으려 할 때를 위한 것이다. 안 붙이면 취소가 조용히 실패하고
    // 회복 때 드레인이 그 캡처를 다시 돌린다.
    const r = await runTasks(['inbox', 'resolve', '--id', id, '--drop', why, '--force'], 30_000);
    if (r.code !== 0) logger.warn('캡처를 못 버렸습니다', { id, code: r.code, stderr: r.stderr.slice(-200) });
  } catch (err) {
    logger.error('캡처를 못 버렸습니다', err);
  }
}

/** 아직 세션이 처리하지 않은 캡처 수. 브리핑 꼬리에 붙인다. */
export function openCaptureCount(): number {
  const root = workAssistantRoot();
  if (!root) return 0;
  const file = inboxFile(root);
  const ids = new Set<string>();
  let n = 0;
  const see = (raw: string) => {
    try {
      const r = JSON.parse(raw);
      if (ids.has(r.id)) return;
      ids.add(r.id);
      if (r.status === 'open') n += 1;
    } catch { /* 깨진 줄은 안 센다 */ }
  };
  try {
    if (fs.existsSync(file)) fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).forEach(see);
  } catch { /* 못 읽으면 대기실만 센다 */ }
  // 대기실(잠금을 못 잡은 캡처) — 파이썬의 `_inbox_read` 처럼 합쳐 센다. 파일에 있는 id 는 한 번만.
  try {
    const dir = inboxSpoolDir(file);
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (name.endsWith('.json')) see(fs.readFileSync(path.join(dir, name), 'utf-8'));
    }
  } catch { /* 대기실을 못 읽으면 파일 것만 */ }
  return n;
}

// ---------------------------------------------------------------- 요약 (출력)

/**
 * **`shell: true` 는 인자를 공백에서 쪼갠다.** 윈도우에서 셸을 끼우면 node 가
 * argv 를 따옴표 없이 한 줄로 이어 붙여 cmd.exe 에 넘기므로, 값 안의 공백이
 * 인자 경계가 된다 — `--ts 2026-08-19 06:55` 가 `--ts 2026-08-19` + 떠도는
 * `06:55` 로 도착해 argparse 가 rc 2 로 죽는다. **하루 동안 조용히 그랬다**
 * (2026-08-18: 메일 워터마크가 한 번도 안 찍혀 같은 후보가 다섯 번 나갔다).
 *
 * 그래서 공백이 든 인자만 따옴표로 감싼다. 셸을 걷어내는 쪽이 더 깨끗하지만
 * 모든 호출자가 걸리는 변경이라, 지금 틀린 것만 고친다.
 */
export function quoteForShell(arg: string): string {
  // 공백만 보면 모자란다 — cmd.exe 는 `&`·`|`·`<`·`>` 에서도 줄을 끊는다.
  // 「R&D회의」처럼 공백 없이 붙어 오는 값이 실제로 있다(메일 제목).
  // ⚠️ `%VAR%` 는 따옴표로 못 막는다(치환이 먼저 일어난다) — 여기 인자에는
  // 그런 값이 안 오지만, 오게 되면 셸을 걷어내는 쪽으로 가야 한다.
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  if (arg.includes('"')) throw new Error(`셸에 못 넘기는 인자입니다(따옴표 포함): ${arg}`);
  return `"${arg}"`;
}

/**
 * 판에서 누른 것을 반영할 때 넘기는 표시(2026-10-02) — 값은 **환경변수로** 간다(인자로 주면
 * cmd.exe 를 지난다). `src` 는 체크인 답과 판 버튼을 가르고, `press` 는 누름 번호(쉼표로 이음)라
 * 그 쓰기가 띄운 판 올리기가 「누름 → 화면」 시간을 남긴다(`upload_board.py` 의 `press_note`).
 */
export function boardEnv(press?: string): Record<string, string> {
  return press ? { WORK_ASSISTANT_SRC: 'board', WORK_ASSISTANT_PRESS: press } : {};
}

export function runTasks(
  args: string[],
  timeoutMs = 60_000,
  script = 'bin/tasks.py',
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = workAssistantRoot();
  const useShell = process.platform === 'win32';
  const argv = useShell ? args.map(quoteForShell) : args;
  return new Promise((resolve, reject) => {
    if (!root) { reject(new Error('work-assistant root not found')); return; }
    const proc = spawn('python', ['-X', 'utf8', script, ...argv], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      env: { ...process.env, ...extraEnv, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const killTimer = setTimeout(() => {
      // shell:true 래퍼(cmd.exe)만 죽이면 python 자식이 고아로 남는다 — 트리 kill.
      try {
        if (process.platform === 'win32' && proc.pid) {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* 이미 끝난 프로세스 */ }
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    proc.on('close', (code) => { clearTimeout(killTimer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/*
 * `briefShort()` (`tasks.py brief --short`) 는 2026-09-02 에 지웠다.
 * 유일한 소비처가 아침 브리핑 꼬리였고 그 블록을 뺐다(assistant-scheduler.ts
 * 「업무 (work-assistant)」 주석 참조). 조망은 Dispatch 판이 들고 있다.
 */

/**
 * 08:55 넛지 본문. 급한 근거가 없으면 **빈 문자열** — 그러면 보내지 않는다.
 * 판정은 `tasks.py` 가 한다. 봇은 비었는지만 본다(로직 복제 금지).
 */
export async function briefNudge(): Promise<string> {
  const { code, stdout, stderr } = await runTasks(['brief', '--nudge'], 60_000);
  if (code !== 0) {
    throw new Error(`tasks.py brief --nudge 실패 (rc=${code}): ` +
      (stderr || stdout).trim().split('\n').slice(-3).join('\n'));
  }
  return stdout.trim();
}

/**
 * **노션에서 직접 고친 것을 따라잡는다.**
 *
 * 수정은 판과 스탠리에서 한다는 것이 규율이지만, 노션은 막을 수 없다
 * (자기 워크스페이스다). 막는 대신 따라잡는다 — 안 따라잡으면 화면이 최대
 * 8시간 낡고, **낡은 화면은 조용히 틀린다.**
 *
 * 싸다: 바뀐 게 없으면 `tasks.py` 가 1행 질의(실측 0.5초)만 하고 끝낸다.
 * 바뀐 때만 전체를 읽어 다시 그리고 올린다. 판정도 갱신도 전부 파이썬이 한다.
 *
 * **「조용히」와 무관하다** — 화면을 최신으로 두는 것은 미는 알림이 아니다.
 * 출장 중에도 열어 보면 최신이어야 한다.
 */
export async function refreshBoardIfChanged(): Promise<boolean> {
  const { code, stdout, stderr } = await runTasks(['board', '--if-changed'], 120_000);
  if (code !== 0) {
    throw new Error(`tasks.py board --if-changed 실패 (rc=${code}): ` +
      (stderr || stdout).trim().split('\n').slice(-3).join('\n'));
  }
  return stdout.trim().length > 0;   // 출력이 있으면 다시 그렸다는 뜻
}

/**
 * 「조용히」 기간인가. **판정은 `tasks.py` 한 곳이 든다** — 봇은 물어보기만 한다.
 *
 * 문구가 아니라 **기호**로 가른다(🔕 / 🔔). 문구는 다듬다 바뀌지만 이 둘은
 * 뜻 자체라, 여기서 문장을 견주면 그쪽을 고칠 때 조용히 어긋난다.
 *
 * **모르면 「조용히 아님」으로 답한다.** 판단이 안 서는 것을 조용히로 읽으면
 * 무언가 깨졌을 때 자동으로 도는 것이 통째로 멈추고, 그게 정상으로 보인다.
 */
/**
 * 업무 정본이 어디인가 — `notion` 또는 `vault`.
 *
 * **노션을 버린 뒤에는 「밖에서 고친 것 따라잡기」가 할 일이 없다.** 쓰는 주체가
 * `tasks.py` 하나뿐이라 감시할 대상 자체가 사라진다. 판정은 파이썬 한 곳이고
 * 봇은 물어보기만 한다(조용히 여부와 같은 규율).
 *
 * **모르면 `notion` 으로 답한다** — 감시자를 괜히 켜 두는 쪽이, 정말 필요한데
 * 꺼 두는 쪽보다 낫다(후자는 화면이 조용히 낡는다).
 */
export async function currentStore(): Promise<string> {
  try {
    const { code, stdout } = await runTasks(['store'], 20_000);
    const v = (stdout || '').trim();
    return code === 0 && v ? v : 'notion';
  } catch {
    return 'notion';
  }
}

/**
 * PC 밖으로 사본을 내보낸다 — **백업 전용**. 매일 20:00 + 봇이 뜰 때 한 번.
 * 대상은 업무 볼트와 이 비서 레포 둘이고, **목록의 정본은 파이썬 쪽 `config.json`** 이다.
 *
 * **말을 걸지 않는다.** 성공은 조용하고, 실패해도 여기서 DM 을 보내지 않는다 —
 * 밀렸다는 사실은 `brief` 맨 위 ⛔ 가 말하고 **그 판정은 봇 밖에 있다**(봇이
 * 죽으면 이 타이머도 같이 죽으므로, 죽음을 알리는 쪽은 봇에 두지 않는다).
 *
 * 나갈 것이 없으면 원격에 닿지도 않고 끝난다 — 그래서 뜰 때마다 불러도 싸다.
 */
export async function offsitePush(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { code, stdout, stderr } = await runTasks([], 120_000, 'bin/offsite_push.py');
    // 저장소마다 한 줄이 나온다 — 마지막 줄만 집으면 앞엣것이 조용히 사라진다.
    const detail = (stdout || stderr).trim().split('\n')
      .map((l) => l.trim()).filter(Boolean).join(' · ');
    return { ok: code === 0, detail };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

/**
 * 작업 디렉터리의 **내 커밋**을 진행 로그로 걷는다 (하루 한 번).
 *
 * **무엇을 어느 업무에 적을지는 여기서 안 정한다** — 거슬러 읽는 창·겹침을 막는
 * 자국·「누가 나인가」가 전부 파이썬 한 곳에 있다. 여기는 부르고 결과 한 줄을
 * 로그에 남길 뿐이다.
 *
 * **사람에게 아무 말도 안 간다.** 카드를 열면 보이는 것이라 또 알릴 이유가 없다.
 * 그래서 「조용히」 기간과 쉬는 날에도 그냥 돈다 — 미는 장치가 아니고 돈도 안
 * 드는데, 쉬는 날 커밋했다면 그것이야말로 적어 둘 한 일이다.
 */
export async function commitHarvest(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { code, stdout, stderr } = await runTasks(['commits'], 180_000);
    const lines = (stdout || stderr).trim().split('\n')
      .map((l) => l.trim()).filter(Boolean);
    // **마지막 줄이 아니라 우리 줄을 집는다** — 쓰기 뒤에 판 링크(`🗂`)가 한 줄
    // 더 붙어서, 꼬리만 집으면 로그에 「몇 건 걷었나」 대신 주소가 남는다.
    const detail = lines.find((l) => l.startsWith('커밋 ')) || lines.pop() || '';
    return { ok: code === 0, detail };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

/** 울릴 때가 된 알림 하나. **뜻은 파이썬만 안다** — 여기서는 나르기만 한다. */
export interface RemindItem {
  id: string;
  title: string;
  at: string;
  next: string;
}

/**
 * 시각이 지났는데 아직 안 울린 알림.
 *
 * **되풀이가 아니다** — 한 업무의 한 번짜리 약속이고(「금요일 오전 11시에 ~
 * 요청하기」), 되풀이는 정기 업무가 맡는다. 못 읽으면 빈 목록이라 그 회차는
 * 조용히 넘어간다 — 없는 것을 지어내 울리는 것보다 안 울리는 편이 싸다.
 */
export async function remindDue(): Promise<RemindItem[]> {
  try {
    const { code, stdout } = await runTasks(['remind'], 60_000);
    if (code !== 0) return [];
    const r = JSON.parse(stdout) as { items?: RemindItem[] };
    return Array.isArray(r.items) ? r.items : [];
  } catch {
    return [];
  }
}

/**
 * 그 업무의 알림을 울린 것으로 표시한다.
 *
 * ⚠️ **넘긴 뒤에 찍는다** — 먼저 찍고 보내다 실패하면 그 알림은 영영 안 울린다.
 * 반대로 두면 최악이 「한 번 더 울림」이라 값이 훨씬 싸다(메일 표시와 같은 결).
 */
export async function remindDone(id: string, at?: string): Promise<boolean> {
  try {
    // **그 시각 하나만 찍는다**(`--at` · 2026-10-16 업무마다 알림 여러 개) — 업무 번호만 넘기면 지금 때가 된
    // 시각을 다 찍어, 목록을 읽은 뒤 몇 초 사이에 때가 된 다른 알림이 안 보낸 채로 찍힌다.
    const { code } = await runTasks(['remind', '--done', id, ...(at ? ['--at', at] : [])], 60_000);
    return code === 0;
  } catch {
    return false;
  }
}

/** 요약을 다시 쓸 업무 하나. **뜻은 파이썬만 안다** — 여기서는 나르기만 한다. */
export interface SummaryItem {
  id: string;
  title: string;
  why: string;
  material: string;
}

/**
 * 요약을 다시 쓸 업무와 그 재료.
 *
 * **무엇을 다시 쓸지는 여기서 안 정한다** — 「사람이 고친 것은 안 덮는다」를
 * 비롯한 규칙이 전부 파이썬 한 곳에 있다. 못 읽으면 빈 목록이라 그 회차는
 * 조용히 넘어간다(없는 것을 지어내 부르는 것보다 안 부르는 편이 싸다).
 */
export async function summaryCandidates(): Promise<SummaryItem[]> {
  try {
    const { code, stdout, stderr } = await runTasks(['summary'], 90_000);
    if (code !== 0) {
      logger.warn(`tasks.py summary 실패 (rc=${code})`, (stderr || stdout).slice(-300));
      return [];
    }
    const d = JSON.parse(stdout) as { items?: SummaryItem[] };
    return Array.isArray(d.items) ? d.items : [];
  } catch (err) {
    logger.warn('summary 후보를 못 읽었습니다', err);
    return [];
  }
}

/**
 * 받은 요약을 **한 번에** 앉힌다.
 *
 * ⚠️ **건마다 부르지 않는다** — 쓰기마다 판을 다시 그리고 올리므로, 열 건이면
 * 열 번 올라가고 열려 있는 화면은 올라온 판 수만큼 통째로 다시 읽는다(판의
 * 묶어 보내기를 만든 것과 같은 이유). 파이썬이 건별로 쓰되 다시 그리기는
 * 마지막 한 번이다.
 *
 * 원문은 파일로 넘긴다 — 여러 줄과 한글이 인자로 오면 win32 `shell:true`
 * spawn 에서 깨진다(`quick`·`note` 와 같은 이유).
 */
/** 요약(그리고 단계가 넘어갔으면 제목)을 한 번에 앉힌다. **뜻은 파이썬만 안다.** */
export async function summaryApply(
  got: Record<string, { summary: string }>,
): Promise<string> {
  const file = path.join(os.tmpdir(), `wa-sum-${randomId()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(got), { encoding: 'utf-8' });
    const { code, stdout, stderr } = await runTasks(
      ['summary', '--apply', file], 120_000);
    if (code !== 0) {
      logger.warn(`요약을 못 썼습니다 (rc=${code})`, (stderr || stdout).slice(-300));
      return '';
    }
    // **마지막 줄이 아니라 우리 줄을 집는다** — 쓰기 뒤에 판 링크(`🗂`)가 한 줄
    // 더 붙어서, 꼬리만 집으면 로그에 「몇 건 썼나」 대신 주소가 남는다.
    const lines = (stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => l.startsWith('요약 ')) || lines.pop() || '';
  } catch (err) {
    logger.warn('요약 쓰기가 터졌습니다', err);
    return '';
  } finally {
    try { fs.unlinkSync(file); } catch { /* 이미 없다 */ }
  }
}

// ---------------------------------------------------------------- 매일 개선 제안
//
// **업무일 06:30 에 만들고 08:00 브리핑 뒤에 올린다** (2026-10-02 사용자 · 하루 최대 셋).
// 재료 모으기 · 결과 검사 · 장부 · 승인 시 업무 등록은 전부 `bin/improve.py` 가 한다 — 여기는 나른다.

export interface ImproveEvidence { label: string; value: string; compare?: string; key?: string }
export interface ImproveItem {
  id: string; date: string; title: string; area: string; evidence: ImproveEvidence[];
  why: string; next: string; est: number; state: string;
}
export interface ImproveDay { date: string; posted: string | null; note: string; items: ImproveItem[] }

/** `improve.py` 한 번 — 마지막 줄의 JSON 을 돌려준다. 못 읽으면 null(부르는 쪽이 물러난다). */
async function improveRun(args: string[], timeoutMs = 120_000): Promise<any | null> {
  try {
    const { code, stdout, stderr } = await runTasks(args, timeoutMs, 'bin/improve.py');
    const last = (stdout || '').trim().split('\n').pop() || '';
    try { return JSON.parse(last); } catch { /* 아래 */ }
    if (code !== 0) logger.warn(`improve.py ${args[0]} 실패 (rc=${code})`, (stderr || stdout).slice(-300));
    return null;
  } catch (err) {
    logger.warn(`improve.py ${args[0]} 가 터졌습니다`, err);
    return null;
  }
}

/** 재료(지난 7일 하루 활동 요약 + 지난 제안 장부)를 JSON 글로. 못 만들면 빈 글. */
export async function improveGather(): Promise<string> {
  const file = path.join(os.tmpdir(), `wa-imp-${randomId()}.json`);
  try {
    const { code, stderr } = await runTasks(['gather', '--out', file], 180_000, 'bin/improve.py');
    if (code !== 0 || !fs.existsSync(file)) {
      logger.warn(`개선 제안 재료를 못 모았습니다 (rc=${code})`, (stderr || '').slice(-300));
      return '';
    }
    return fs.readFileSync(file, 'utf-8');
  } catch (err) {
    logger.warn('개선 제안 재료 모으기가 터졌습니다', err);
    return '';
  } finally {
    try { fs.unlinkSync(file); } catch { /* 이미 없다 */ }
  }
}

/** 세션이 낸 글을 넘겨 검사 · 장부에 올린다. 결과 그대로(`ok` · `items` · `skipped` · `why`). */
export async function improveAccept(reply: string): Promise<any | null> {
  const file = path.join(os.tmpdir(), `wa-imp-out-${randomId()}.txt`);
  try {
    fs.writeFileSync(file, reply, { encoding: 'utf-8' });
    return await improveRun(['accept', '--file', file]);
  } finally {
    try { fs.unlinkSync(file); } catch { /* 이미 없다 */ }
  }
}

export async function improveShow(): Promise<ImproveDay | null> {
  return improveRun(['show']);
}

export async function improvePosted(): Promise<void> {
  await improveRun(['posted']);
}

/** 버튼 결정 — 등록이면 `tasks.py add` 까지 돈다(판을 다시 그리므로 넉넉히 기다린다). */
export async function improveDecide(id: string, decision: string):
    Promise<{ ok: boolean; note: string; task?: string }> {
  const r = await improveRun(['decide', '--id', id, '--decision', decision], 240_000);
  return r ?? { ok: false, note: '⚠️ 결정을 기록하지 못했습니다' };
}

/** `bin/mail.py` 가 내는 스레드 하나. 뜻은 파이썬만 알고 여기서는 나르기만 한다. */
export interface MailThread {
  subject: string;
  count: number;
  last: string;
  people: string[];
  folders: string[];
  exec: boolean;
  ask: string[];
  dates: string[];
  tasks: { id: string; title: string; score: number }[];
}

/**
 * 메일에서 뽑은 업무 후보. **판단은 여기서 하지 않는다** — 무엇을 등록할지·어느
 * 업무에 붙일지는 비서 세션이 정하고 사람이 컨펌한다.
 *
 * `--push` 는 「조용히」 기간이면 빈손으로 돌아온다(판정은 파이썬이 한다).
 * **워터마크는 여기서 안 옮긴다** — 넘긴 뒤에 `mailMark` 로 따로 찍는다.
 */
export async function mailCandidates(days = 1): Promise<{
  ok: boolean; threads: MailThread[]; newest: string; text: string; lead: string; detail: string;
}> {
  const none = { ok: false, threads: [] as MailThread[], newest: '', text: '', lead: '' };
  try {
    const { code, stdout, stderr } = await runTasks(
      ['candidates', '--days', String(days), '--push', '--json'], 90_000, 'bin/mail.py');
    if (code !== 0) return { ...none, detail: (stderr || stdout).trim() };
    const r = JSON.parse(stdout);
    // `text` 는 파이썬이 그린 것을 그대로 나른다 — 여기서 다시 그리지 않는다.
    // `lead` 는 **사람이 읽을 한 줄**이고 `text` 는 세션이 읽을 본문이다. 파이썬이
    // 둘 다 그려 주므로 여기서 다시 그리지 않는다 — 두 번째 렌더러를 두면 한쪽이 낡는다.
    return {
      ok: true, threads: r.threads ?? [], newest: r.newest ?? '',
      text: r.text ?? '', lead: r.lead ?? '', detail: '',
    };
  } catch (err) {
    return { ...none, detail: String(err) };
  }
}

/**
 * 여기까지 봤다고 표시. **Outlook 을 다시 안 읽는다** — 다시 읽으면 그 사이
 * 도착한 메일까지 본 것으로 찍혀 조용히 건너뛴다.
 */
export async function mailMark(ts: string): Promise<boolean> {
  try {
    const { code } = await runTasks(['mark', '--ts', ts], 20_000, 'bin/mail.py');
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * 판에서 누른 것의 출력 중 **사람이 봐야 하는 줄만** 남긴다.
 *
 * ✅ 줄과 칸반 링크는 판이 이미 보여 준다 — 같은 사실을 슬랙에 또 적으면 알림만
 * 는다. 하지만 **경고는 판에 없는 말이다**: 「3회 연기 — 추정이 틀렸거나 버려야
 * 할 업무인지 다시 본다」가 이 출력에 실려 오는데, 통째로 삼키면 **일부러 만든
 * 신호가 조용히 사라진다**(2026-08-19 검토에서 잡았다 — 처음 고친 판이 그랬다).
 *
 * 기호로 고른다. 새 경고가 늘어도 여기 손댈 것이 없다.
 *
 * **좁은 길이 쓰는 기호 둘을 더 받는다** (2026-09-02) — `❓` 되물음 · `💬` 알림.
 * 좁은 길은 **세션 자리를 대신하므로 스스로 말해야 한다.** 세션은 자기 방에서
 * 답했지만 좁은 길에는 그 자리가 없다 — 안 받으면 **되물음이 통째로 사라지고
 * 그 건은 닫힌다**(실측 81건 중 여섯이 되물음이라 7%다).
 */
export function boardOutputToTell(output: string): string {
  // ⚠️ **`u` 플래그가 없으면 안 된다.** `💬`(U+1F4AC)는 BMP 밖이라 문자 클래스가
  // **대리 쌍을 낱개로 쪼갠다** — 앞쪽 `\uD83D` 가 `🗂`(U+1F5C2)와도 맞아
  // 칸반 링크까지 새어 나갔다(2026-09-02 · `check:args` 가 잡았다).
  return (output || '').split('\n').filter((l) => /[⚠⛔❓💬]/u.test(l)).join('\n').trim();
}

export async function isQuietPeriod(): Promise<boolean> {
  try {
    const { code, stdout } = await runTasks(['quiet'], 20_000);
    return code === 0 && stdout.includes('🔕');
  } catch {
    return false;
  }
}

/**
 * 내가 일하지 않는 날 — `YYYY-MM-DD` 집합.
 *
 * **정본은 `work-assistant/config.json` 의 `holidays` 한 줄**이다. 이름은
 * 공휴일이지만 뜻은 「내가 일하지 않는 날」이라 **개인 휴가·건강검진도 여기
 * 들어간다**(2026-08-11 확정). 파이썬 쪽 마감 역산·용량·「N영업일 경과」가
 * 전부 이 목록을 본다.
 *
 * **봇이 이것을 안 읽어서 실제로 틀렸다** (2026-08-21 발견). 봇은 `date-holidays`
 * 의 한국 공휴일만 봤고, 그 달력에 없는 **개인 휴가는 업무일로 보였다** — 2026-08-20
 * 건강검진일에 메일 후보가 세 번 나갔고 사용자가 손으로 「조용히」를 켜야 했다.
 * 파이썬은 같은 날을 쉬는 날로 세고 있었으니 **두 쪽이 서로 다른 달력을 보고 있었다.**
 *
 * `date-holidays` 는 그대로 둔다 — 둘은 겹치는 것이 아니라 **합쳐진다**(설·추석처럼
 * 매년 바뀌는 것은 그쪽이 알고, 개인 휴가는 이쪽만 안다).
 *
 * 못 읽으면 **빈 집합**을 준다 — 그러면 `date-holidays` 만 보던 예전 행동으로
 * 돌아갈 뿐이라 조용히 더 시끄러워질 뿐 아무것도 안 깨진다.
 */
let offDaysCache: { key: string; days: Set<string> } | null = null;

export function offDays(): Set<string> {
  const root = workAssistantRoot();
  if (!root) return new Set();
  const file = path.join(root, 'config.json');
  try {
    // **고친 파일을 곧 반영하되 30초마다 읽지는 않는다.** 이 함수는
    // `isWorkingHours()` 를 거쳐 30초 타이머에 걸려 있어 하루 2,880번 불린다.
    // 크기·수정시각이 그대로면 내용도 그대로다 — 휴가를 넣으면 둘 다 바뀐다.
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    if (offDaysCache && offDaysCache.key === key) return offDaysCache.days;
    const list = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { holidays?: unknown }).holidays;
    const days = Array.isArray(list)
      ? new Set(list.filter((d): d is string => typeof d === 'string'))
      : new Set<string>();
    offDaysCache = { key, days };
    return days;
  } catch {
    return new Set();
  }
}

/** `2026-08-20` — 로컬 달력 기준. `toISOString()` 은 UTC 로 밀려 하루가 어긋난다. */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 사람과 이야기하고 적은 「지금 집중할 것」이 아직 이 차례 안에 있는가.
 *
 * **아침에 같이 정한 순서를 두 시간 뒤 자동 실행이 모른 채 덮는다** — 그쪽은
 * 데이터만 보므로 대화에서 정한 것을 알 길이 없다. 그 한 차례는 건너뛴다.
 * 다음 차례부터는 평소대로 돈다(사람이 적은 줄도 그만큼 낡는다).
 *
 * **모르면 「없음」으로 답한다** — 판단이 안 서는 것을 「사람이 적었다」로 읽으면
 * 자동 갱신이 통째로 멈추고 그게 정상으로 보인다.
 */
export async function sessionFocusWithin(hours: number): Promise<boolean> {
  try {
    const { code, stdout } = await runTasks(['focus'], 20_000);
    const body = stdout.trim();
    if (code !== 0 || !body.startsWith('{')) return false;
    const f = JSON.parse(body);
    if (f?.by !== 'session' || typeof f?.at !== 'string') return false;
    const age = Date.now() - new Date(f.at).getTime();
    return age >= 0 && age < hours * 3600_000;
  } catch {
    return false;
  }
}

// ------------------------------------------------- 체크인 (진행이 들어오는 입구)


/**
 * 중간 체크인 — 사람이 부른 것이라 래치도 침묵도 없다. 방금까지를 묻는다.
 * 노션을 읽지만 0.7초라 진행 표시 없이 바로 답해도 된다(2026-08-06 실측).
 */
export async function checkinNow(): Promise<string> {
  try {
    const { code, stdout, stderr } = await runTasks(['checkin', '--now', '--slack'], 60_000);
    if (code !== 0) {
      logger.error(`tasks.py checkin --now 실패 (rc=${code})`, (stderr || stdout).trim());
      return '⚠️ 체크인을 못 만들었습니다 — 노션 연결을 확인하세요.';
    }
    return stdout.trim();
  } catch (err) {
    logger.error('checkin --now failed', err);
    return '⚠️ 체크인을 못 만들었습니다 — 노션 연결을 확인하세요.';
  }
}

/**
 * 화면에 떠 있는 체크인의 번호 대응표. 없으면 빈 문자열.
 *
 * **질문은 봇이 세션 없이 내고 답은 세션이 받는다.** 그 사이에 번호의 뜻을
 * 넘기지 않으면 세션은 추측하고, 업무 ID 가 `TSK-3`·`TSK-10` 이라 숫자가 겹쳐
 * 그럴듯하게 틀린다(2026-08-06 실제 사고).
 */
export async function checkinMap(): Promise<string> {
  try {
    const { code, stdout } = await runTasks(['checkin', '--map'], 20_000);
    return code === 0 ? stdout.trim() : '';
  } catch {
    return '';
  }
}

export type QuickOutcome =
  | { kind: 'ok'; output: string }
  /**
   * 이 문법이 아니다 — 평소대로 세션이 받는다.
   *
   * `detail` 은 **왜 아닌지**다. 사람에게 보낼 말이 아니라(원인을 좁혀 말하지
   * 않는다는 규율은 그대로) **로그에 남길 것**이다 — 판에서 누른 것이 버려졌을 때
   * 이유가 어디에도 안 남아 다음에 또 못 짚는다(2026-08-18).
   */
  | { kind: 'not-quick'; detail?: string;
      /** 좁은 길이 못 받은 까닭의 짧은 이름 — 관찰 기록에 그대로 실린다(`detail` 은 글이라 안 싣는다). */
      code?: string }
  /** 문법은 맞는데 쓰기가 깨졌다 — 조용히 넘기면 갱신이 사라진 줄 모른다. */
  | { kind: 'failed'; message: string };

/**
 * 짧은 갱신 문법(「1 완료 · 2 1h」 · 「TSK-5: 진행 내용」)을 세션 없이 처리한다.
 *
 * **판정을 봇이 하지 않는다.** 문법을 고칠 자리가 `tasks.py` 한 곳이어야 하고,
 * 이 레포는 공개라 업무 로직이 나가면 안 되며, 터미널도 같은 단축을 쓴다.
 * 봇이 보는 것은 종료 코드뿐이다 — rc 2 면 "내 문법 아님", 그 외 비정상이면 실패.
 *
 * 원문은 파일로 넘긴다. 따옴표·줄바꿈·한글이 섞인 문자열을 인자로 주면
 * win32 `shell:true` spawn 에서 깨지거나 주입 위험이 생긴다(캡처와 같은 이유).
 */
export async function quickUpdate(text: string, press?: string): Promise<QuickOutcome> {
  return byFile('quick', text, press);
}

/**
 * 여러 줄 글을 한 칸에 앉힌다 — 판의 요약·메모 칸이 이리로 온다.
 *
 * **짧은 문법과 갈라 둔 이유는 봇이 아니라 파이썬 쪽에 있다**(`tasks.py` 의
 * `cmd_note`): 자유 서술에 「완료」·「2h」가 들어 있으면 짧은 문법이 그것을
 * 지시로 읽고, 줄바꿈과 `·` 는 그 문법의 조각 구분자다. 여기서는 여전히
 * **종료 코드만** 본다 — 뜻은 저쪽 한 곳에만 있다.
 */
export async function noteUpdate(text: string, press?: string): Promise<QuickOutcome> {
  return byFile('note', text, press);
}

/**
 * 판에서 온 원문을 **세션에 넘기기 전에** 진행 로그에 먼저 박는다 (2026-08-29).
 *
 * **왜** — 칸반 기준으로 프롬프트 한 줄이 카드에 닿기까지 21.9초이고 그중
 * 17.9초가 세션이다(실측). 그동안 판은 아무 일도 없던 것처럼 보인다. 원문을
 * 먼저 남기면 사람은 자기 말이 들어온 것을 3초 안에 본다.
 *
 * ⚠️ **판단은 세션이 그대로 한다** — 파이썬 쪽이 속성을 한 칸도 안 건드린다.
 * 정확도에 영향이 없어야 이 장치를 켤 수 있다(2026-08-29 사용자: 정확도 우선).
 *
 * rc 2 는 「여기 앉힐 것이 아니다」 — 정기 업무·새 업무처럼 볼트 파일이 없는 것.
 * 그때는 아무 일도 안 일어나고 세션이 평소대로 받는다.
 */
export async function stageUpdate(text: string): Promise<QuickOutcome> {
  return byFile('stage', text);
}

/**
 * 원문을 파일로 넘겨 `tasks.py` 한 서브커맨드를 부른다.
 *
 * 파일로 넘기는 이유 — 따옴표·줄바꿈·한글이 섞인 문자열을 인자로 주면
 * win32 `shell:true` spawn 에서 깨지거나 주입 위험이 생긴다(캡처와 같은 이유).
 */
async function byFile(cmd: 'quick' | 'note' | 'stage', text: string,
                      press?: string): Promise<QuickOutcome> {
  const root = workAssistantRoot();
  if (!root) return { kind: 'not-quick' };
  const file = path.join(os.tmpdir(), `wa-${cmd}-${randomId()}.txt`);
  try {
    fs.writeFileSync(file, text, { encoding: 'utf-8' });
    const { code, stdout, stderr } = await runTasks([cmd, '--file', file], 90_000,
      undefined, boardEnv(press));
    if (code === 0) return { kind: 'ok', output: stdout.trim() };
    if (code === 2) {
      return { kind: 'not-quick', detail: (stderr || stdout).trim().split('\n').slice(-2).join(' / ') };
    }
    const tail = (stderr || stdout).trim().split('\n').slice(-3).join('\n');
    logger.error(`tasks.py ${cmd} 실패 (rc=${code})`, tail);
    return { kind: 'failed', message: tail || `rc=${code}` };
  } catch (err) {
    logger.error(`${cmd} update failed`, err);
    return { kind: 'failed', message: String(err) };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 이미 없다 */ }
  }
}


/** 판에서 온 말의 말머리에서 업무를 뽑는다. 없으면 좁은 길이 못 받는다. */
export function narrowTask(text: string): string | null {
  const head = text.split('\n', 1)[0];
  const m = /^\[[^\]]*\]\s*(TSK-\d+)\b/.exec(head.trim());
  return m ? m[1] : null;
}

/**
 * 좁은 길에 넣을 재료 — 그 카드가 지금 들고 있는 값.
 *
 * **`tasks.py` 가 낸다.** 여기서 앞머리를 읽으면 칸 이름·순서가 두 곳으로
 * 갈라지고, 순서가 바뀌면 그 프롬프트로 잰 성적이 그대로 안 나온다.
 */
export async function narrowCard(
  task: string,
): Promise<{ task: string; title: string; card: string } | null> {
  const { code, stdout } = await runTasks(['narrow', '--card', task], 60_000);
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout.trim().split('\n').pop() || '');
  } catch {
    return null;
  }
}

/**
 * 좁은 길이 낸 JSON 을 앉힌다.
 *
 * ⛔ **빈 값은 파이썬 쪽 문이 거른다** — 지운 값은 어디에도 안 남아 되돌리기가
 * 사람의 기억에 걸린다. 여기서 또 막지 않는다(문이 둘이면 한쪽이 낡는다).
 *
 * rc 2 는 「좁은 길이 못 냈다」 — 봇이 평소 경로(세션)로 넘긴다.
 */
export async function narrowApply(json: string, task: string,
                                  press?: string): Promise<QuickOutcome> {
  const root = workAssistantRoot();
  if (!root) return { kind: 'not-quick' };
  const file = path.join(os.tmpdir(), `wa-narrow-${randomId()}.json`);
  try {
    fs.writeFileSync(file, json, { encoding: 'utf-8' });
    const { code, stdout, stderr } = await runTasks(
      ['narrow', '--apply', file, '--task', task], 90_000, undefined, boardEnv(press));
    if (code === 0) return { kind: 'ok', output: stdout.trim() };
    if (code === 2) {
      return { kind: 'not-quick', code: 'reject',
               detail: (stderr || stdout).trim().split('\n').slice(-2).join(' / ') };
    }
    return { kind: 'failed', message: (stderr || stdout).trim().slice(0, 300) };
  } catch (err) {
    logger.error('narrow apply failed', err);
    return { kind: 'failed', message: String(err) };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 이미 없다 */ }
  }
}


// ---------------------------------------------------------------- 좁은 길 폴백
//
// **Agent SDK 를 못 쓸 때 같은 일을 대신 한다** (2026-09-03). 좁은 길은
// 「글 → JSON → 결정론이 반영」이라 **엔진을 갈아 끼워도 반영은 마지막에 한
// 번뿐이다** — 세션 경로와 달리 두 번 하기 위험이 없다.
//
// 실측(판 프롬프트 81건 · 프롬프트 11판 · 운영이 실제로 바꾼 칸과 대조):
//   Agent SDK opus-5   값칸 63~66% · 중앙 3.0~3.2초  (같은 프롬프트 두 판의 폭)
//   codex gpt-5.6-sol  값칸 64%    · 중앙 9.5초
// 그 폭 안이라 **나아진 것도 나빠진 것도 아니고 같은 일을 한다.** 틀린 값은
// 오히려 적고(8 대 10·11) 대신 빈칸을 더 남긴다 — 「틀린 값이 카드에 앉으면
// 아무도 안 고친다」는 이 판의 규칙에서 그쪽이 안전한 실패다.
//
// ⚠️ **사고 깊이를 올리지 않는다** — high 는 값칸이 그대로고 1.8배 느렸다.
// ⚠️ **폴백이 실제로 필요한 빈도는 낮다** — 로그 7개월(2026-02-11~09-03)에
//    `SDK query 실패` 0건 · rate_limit 5건 · Overloaded 6건. 자주 쓰려고 둔 것이
//    아니라 **터지면 전부 멈추기 때문에** 둔다.

/** 좁은 길 폴백 엔진. 값을 바꾸려면 여기 한 줄 — 잰 것은 `sol` · `low` 다. */
const NARROW_CODEX_MODEL = 'gpt-6.1-sol';   // 2026-09-23 5.6 → 6 · 09-30 → 6.1 (위 측정은 5.6 때 것)

/**
 * 좁은 길 폴백 모델 — 환경 변수(`BOARD_NARROW_CODEX_MODEL`)가 이기고, 없으면 서비스 폴백 대응표
 * (`service_fallback` · 1차 Claude 모델에 맞춘 칸), 표가 없으면 위 기본값(2026-10-14).
 */
export function narrowCodexModel(claudeModel?: string): string {
  return process.env.BOARD_NARROW_CODEX_MODEL || serviceCodex(claudeModel)?.model || NARROW_CODEX_MODEL;
}
const NARROW_CODEX_EFFORT = 'low';

/** 좁은 길 폴백 깊이 — 환경 변수가 이기고, 없으면 1차 깊이(low)를 대응표대로(luna 면 한 단계 위). */
export function narrowCodexEffort(claudeModel?: string): string {
  return process.env.BOARD_NARROW_CODEX_EFFORT || serviceCodex(claudeModel, NARROW_CODEX_EFFORT)?.effort || NARROW_CODEX_EFFORT;
}

/**
 * 주 작업 폴백 엔진 — **좁은 길과 상수를 나눠 둔다.**
 *
 * 좁은 길은 판을 재는 실험이라 `sol`·`low` 가 그 실험의 조건이다. 여기서 같이
 * 쓰면 주 작업 쪽 사정으로 실험 조건이 바뀌어 앞뒤 회차를 못 비교한다.
 *
 * 등급 대응은 **Opus 5.5 ↔ GPT-6.1 Sol**(2026-09-23 둘 다 한 세대 올림 · Sol 은 09-30 에 6.1) 이고 effort 는 부르는 쪽 값을 그대로
 * 받는다(2026-09-08 사용자). 정기 작업에 Astra·Fable 급은 쓰지 않는다.
 */
export const SESSION_CODEX_MODEL = process.env.SESSION_FALLBACK_CODEX_MODEL || 'gpt-6.1-sol';
const SESSION_CODEX_EFFORT = process.env.SESSION_FALLBACK_CODEX_EFFORT || 'low';

/**
 * 마지막 답의 모양을 codex 에게 강제한다.
 *
 * SDK 쪽은 프롬프트로만 시키는데 여기는 문이 하나 더 있다 — 재는 자리에서는
 * 유리한 조건이지만, **실제로 쓸 때는 이 문이 있는 편이 맞다**(파싱이 안 깨진다).
 */
const NARROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['log', 'sets', 'ask', 'say'],
  properties: {
    log: { type: ['string', 'null'] },
    sets: { type: ['object', 'null'], additionalProperties: { type: ['string', 'null'] } },
    ask: { type: ['string', 'null'] },
    say: { type: ['string', 'null'] },
  },
};

/**
 * 좁은 길을 codex 로 한 번. 못 하면 **빈 글자**를 돌려준다 — 부르는 쪽이
 * 오늘까지와 같은 길(세션)로 떨어뜨린다.
 *
 * ⚠️ **여기서 던지지 않는다.** 폴백이 터져서 본 경로까지 막으면 안 되므로
 * 무엇이 나든 빈 글자로 물러난다.
 *
 * `BOARD_NARROW_FALLBACK=off` 로 끈다.
 */
export async function narrowCodex(
  system: string, user: string, timeoutMs = 90_000, claudeModel?: string,
): Promise<string> {
  if (process.env.BOARD_NARROW_FALLBACK === 'off') return '';
  try {
    // `codexTurn` 한 곳을 지난다 — 한도에 걸리면 엔진 상태에 적히고(되면 「됐다」도) 예약 세션 폴백이 그것을 본다.
    const r = await codexTurn(user, {
      // 시스템 프롬프트를 앞에 이어 붙인다 — `codex exec` 에 그 칸이 따로 없다.
      appendSystemPrompt: system,
      // 읽기 전용 — 이 호출은 파일을 건드릴 일이 없다. 쓰는 것은 파이썬이 한다.
      sandbox: 'read-only',
      // 이 저장소를 작업 뿌리로 주지 않는다 — 규칙은 위 `system` 이 다 들고 있고,
      // 주면 `CLAUDE.md` 가 따라 들어와 좁은 길이 아니게 된다.
      workingDirectory: os.tmpdir(),
      model: narrowCodexModel(claudeModel),
      effort: narrowCodexEffort(claudeModel),
      outputSchema: NARROW_SCHEMA,
      timeoutMs,
    });
    if (r.kind !== 'ok') {
      logger.warn(`좁은 길 폴백(codex) ${r.kind}${r.detail ? ` — ${r.detail}` : ''}`);
      return '';
    }
    return r.text;
  } catch (err) {
    logger.warn('좁은 길 폴백(codex)이 터졌습니다 — 세션으로 갑니다', err);
    return '';
  }
}

/** `codex exec --json` 이 내보내는 이벤트를 읽은 것 — 한 줄씩 받아 쌓는다(출력 전체를 쥐지 않는다). */
interface CodexEvents {
  /** 마지막 `agent_message` — `-o` 파일이 비었을 때의 답. */
  text: string;
  steps: CodexStep[];
  /** 명령 · 파일 바꾸기 · MCP 호출이 하나라도 **시작했나**(결과가 안 왔어도 셈). */
  touched: boolean;
  /** `turn.completed` 를 봤나. */
  completed: boolean;
  /** `turn.failed` 를 봤나. */
  failed: boolean;
  /** `turn.failed` · `error` · 오류 항목의 글 — 실패를 가를 때만 읽는다. */
  errors: string[];
  /** JSON 이벤트를 하나라도 봤나 — 못 봤으면 옛 판처럼 rc 와 `-o` 파일로 가른다. */
  sawEvents: boolean;
}

class CodexEventReader {
  readonly ev: CodexEvents = {
    text: '', steps: [], touched: false, completed: false, failed: false, errors: [], sawEvents: false,
  };
  private rest = '';
  private byId = new Map<string, CodexStep>();

  push(chunk: string): void {
    const lines = (this.rest + chunk).split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    for (const l of lines) this.line(l);
  }

  end(): CodexEvents {
    if (this.rest) this.line(this.rest);
    this.rest = '';
    return this.ev;
  }

  private line(raw: string): void {
    const s = raw.trim();
    if (!s.startsWith('{')) return;
    let e: any;
    try { e = JSON.parse(s); } catch { return; }
    if (!e || typeof e.type !== 'string') return;
    const ev = this.ev;
    ev.sawEvents = true;
    const msg = (x: any) => String(x?.message ?? x ?? '');
    if (e.type === 'turn.completed') { ev.completed = true; return; }
    if (e.type === 'turn.failed') { ev.failed = true; ev.errors.push(msg(e.error ?? e)); return; }
    if (e.type === 'error') { ev.errors.push(msg(e.error ?? e)); return; }
    if (!e.type.startsWith('item.')) return;
    const it = e.item ?? {};
    const done = e.type === 'item.completed';
    if (it.type === 'agent_message') {
      if (done && typeof it.text === 'string') ev.text = it.text;
    } else if (it.type === 'error') {
      ev.errors.push(msg(it));
    } else if (it.type === 'command_execution' || it.type === 'file_change' || it.type === 'mcp_tool_call') {
      ev.touched = true;
      const id = String(it.id ?? `#${this.byId.size}`);
      let st = this.byId.get(id);
      if (!st) {
        st = { cmd: clipLine(describeCodexItem(it), STEP_INPUT_MAX), done: false };
        this.byId.set(id, st);
        if (ev.steps.length < STEP_MAX) ev.steps.push(st);
      }
      // 끝났어도 실패면 「완료」가 아니다(2026-10-15 검토) — 종료 코드 · 상태(`failed` · `declined`)로 가른다.
      if (done) {
        const bad = it.status === 'failed' || it.status === 'declined'
          || (typeof it.exit_code === 'number' && it.exit_code !== 0);
        if (bad) st.failed = true;
        else st.done = true;
      }
    }
  }
}

function describeCodexItem(it: any): string {
  if (it.type === 'command_execution') {
    return Array.isArray(it.command) ? it.command.join(' ') : String(it.command ?? '');
  }
  if (it.type === 'file_change') {
    const paths = Array.isArray(it.changes) ? it.changes.map((c: any) => String(c?.path ?? '')).filter(Boolean) : [];
    return `파일 바꿈 ${paths.join(', ')}`.trim();
  }
  return `mcp ${it.server ?? ''}.${it.tool ?? ''}`;
}

function clipLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * `codex` 를 띄운다. 답은 `-o` 파일로, 이벤트는 표준 출력(`--json`)으로 받는다.
 *
 * ⚠️ **인자를 셸에 그대로 넘기지 않는다** — `shell:true` 는 공백에서 인자를
 * 쪼갠다(이 레포가 한 번 겪었다). `runTasks` 와 같은 따옴표 함수를 쓴다.
 * ⚠️ **환경 변수는 부르는 쪽 것을 얹는다** — 전에는 `process.env` 만 넘겨 예약 세션의
 * `CLAUDE_SCHEDULED` · `WORK_ASSISTANT_CAPTURE_FILE` 가 codex 쪽에서 사라졌다. API 키는 뺀다(`child-env.ts`).
 */
function runCodex(
  args: string[], stdinFile: string,
  o: { timeoutMs: number; env?: Record<string, string>; onSpawn?: (kill: () => void) => void },
): Promise<{ code: number; stderr: string; timedOut: boolean; events: CodexEvents }> {
  const useShell = process.platform === 'win32';
  const argv = useShell ? args.map(quoteForShell) : args;
  const reader = new CodexEventReader();
  return new Promise((resolve) => {
    // 실행체 이름을 바꿀 수 있게 둔다 — **검사가 없는 이름이나 가짜 codex 를 넣어**
    // 「폴백이 터져도 빈손으로 물러나나」 · 「이벤트를 어떻게 읽나」를 실제로 재려면 이 문이 필요하다.
    const bin = process.env.BOARD_NARROW_CODEX_BIN || 'codex';
    let fd: number | null = null;
    let proc: ReturnType<typeof spawn>;
    try {
      fd = fs.openSync(stdinFile, 'r');
      proc = spawn(bin, argv, {
        stdio: [fd, 'pipe', 'pipe'],
        shell: useShell,
        env: withoutApiKey({ ...process.env, ...(o.env ?? {}) }),
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, stderr: String(err), timedOut: false, events: reader.end() });
      return;
    } finally {
      // 자식이 제 사본을 들고 있다 — 이쪽 손잡이는 닫는다(전에는 회차마다 하나씩 남았다).
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* 이미 닫힘 */ } }
    }
    let err = '';
    let timedOut = false;
    // 글자로 받는다 — 덩어리 경계에서 한글이 반쪽으로 잘려 깨지지 않게.
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (c: string) => reader.push(c));
    proc.stderr?.on('data', (c: string) => { if (err.length < 20_000) err += c; });
    const kill = () => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* 이미 끝난 프로세스 */ }
    };
    try { o.onSpawn?.(kill); } catch { /* 손잡이를 받는 쪽의 사고가 차례를 막지 않는다 */ }
    const killTimer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    proc.on('error', (e) => {
      clearTimeout(killTimer);
      resolve({ code: -1, stderr: err + String(e), timedOut, events: reader.end() });
    });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && err) logger.warn(`codex stderr: ${err.slice(0, 300)}`);
      resolve({ code: code ?? -1, stderr: err, timedOut, events: reader.end() });
    });
  });
}


/**
 * 업무 볼트 위치 — **`tasks.py` 의 `VAULT_DIR` 과 같은 규칙**이다. 설정 파일은 `WORK_ASSISTANT_HOME` 이 있으면
 * 그 아래, 없으면 레포 루트(`HOME = WORK_ASSISTANT_HOME or ROOT`). 그래서 가짜 홈을 쓰는 시험은 진짜 볼트에 안 닿는다.
 * git 저장소가 아니면 `null`.
 */
export function workVaultDir(): string | null {
  const home = process.env.WORK_ASSISTANT_HOME || workAssistantRoot();
  if (!home) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf-8'));
    const raw = typeof cfg.vault_dir === 'string' ? cfg.vault_dir : '';
    const dir = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    return dir && fs.existsSync(path.join(dir, '.git')) ? dir : null;
  } catch {
    return null;
  }
}

/** `tasks.py` 의 `_GIT_ENV_DROP` 과 같은 목록 — 남은 값이 있으면 엉뚱한 저장소에 커밋한다. */
const GIT_ENV_DROP = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX',
  'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

export type VaultCommitResult = 'committed' | 'nothing' | 'skipped' | 'failed';

/**
 * **codex 가 쓴 볼트를 봇이 대신 커밋한다** (2026-10-19).
 *
 * codex 의 쓰기 모래상자(workspace-write)는 쓰기를 연 폴더 안에서도 **`.git` 을 읽기 전용으로 둔다.**
 * 그래서 GPT 차례의 `tasks.py` 는 업무 md 를 다 쓰고 커밋에서만 넘어졌고(`.git/index.lock: Permission denied` ·
 * `codex sandbox` 로 재현), 그 변경은 다른 쓰기가 올 때까지 커밋 없이 남았다(2026-10-19 Claude 주간 한도 동안).
 * 봇은 모래상자 밖에 있으므로 차례가 끝난 뒤 여기서 한 번 `add -A` → 바뀐 것이 있을 때만 `commit`.
 *
 * **절대 안 던진다** — 실패는 WARN 한 줄. 커밋을 못 해도 파일은 이미 볼트에 있고, 다음 `tasks.py` 쓰기가 담는다.
 */
export async function commitVaultAfterCodex(label: string, vaultDir: string | null = workVaultDir()): Promise<VaultCommitResult> {
  if (!vaultDir) return 'skipped';
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const k of GIT_ENV_DROP) delete env[k];
  const git = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile('git', ['-C', vaultDir, ...args], { env, windowsHide: true, timeout: 30_000, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)));
  });
  try {
    await git(['add', '-A']);
    if (!(await git(['status', '--porcelain'])).trim()) return 'nothing';
    await git(['commit', '-q', '-m', `[GPT 대신 커밋] ${label}`.slice(0, 200)]);
    logger.info('codex 차례가 쓴 볼트를 대신 커밋했습니다', { label });
    return 'committed';
  } catch (err) {
    logger.warn(`볼트 대신 커밋 실패(${label}) — ${clipLine(String((err as Error)?.message ?? err), 200)}`);
    return 'failed';
  }
}

/**
 * 예약 세션 폴백이 **작업 디렉터리 밖에서** 써야 하는 곳.
 *
 * 셋뿐이고 다 업무 비서 설정에서 나온다 — 손으로 적으면 설정을 옮겼을 때
 * 조용히 낡는다. 없는 곳은 안 넘긴다(codex 가 없는 경로에 걸려 죽는다).
 *
 * **내보내는 이유는 검사가 세기 위해서다** — 여기가 비면 폴백이 도는 것처럼
 * 보이면서 `tasks.py` 마다 넘어진다.
 */
export function codexWritableDirs(): string[] {
  const out: string[] = [];
  const add = (d?: string | null) => {
    if (d && fs.existsSync(d) && !out.includes(d)) out.push(d);
  };
  // 상태 파일 — `tasks.py` 의 `STATE` 와 같은 규칙으로 찾는다.
  add(process.env.WORK_ASSISTANT_STATE
    || path.join(os.homedir(), '.claude', 'state'));
  const root = workAssistantRoot();
  if (root) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf-8'));
      add(cfg.vault_dir);            // 업무 md 가 사는 곳
      add(cfg.board_publish_dir);    // 쓰기 뒤 판을 올리는 곳
    } catch {
      // 설정을 못 읽어도 상태 폴더만으로 돈다 — 여기서 멈추지 않는다.
    }
  }
  return out;
}

/**
 * **codex 한 차례** — 예약 세션 폴백 · 좁은 길 폴백이 다 여기를 지난다 (2026-10-14 · 엔진 폴백 4단계).
 *
 * 전에는 rc 하나만 봤다. 그래서 「한도에 걸렸나 · 무엇을 돌렸나 · 썼을 수 있나」를 몰랐고,
 * 한도에 걸린 codex 를 다음 차례도 그대로 불렀다. 이제 `--json` 이벤트를 읽는다.
 *   - 답 — `-o` 파일이 정본 · 비면 마지막 `agent_message`
 *   - 한 일 — `command_execution` 마다 한 줄(≤120자) · 끝났나(`item.completed`)
 *   - 썼을 수 있나(`writeRan`) — 쓰기 모래상자에서 명령 · 파일 바꾸기 · MCP 가 **하나라도 시작했으면** 참.
 *     명령은 무엇이든 쓰기로 본다(읽기만 하는 명령을 가려낼 길이 없다 · 모르면 쓰기 쪽)
 *   - 끝 — `ok`(차례가 끝남) · `usage`(사용량 소진 · 엔진 상태에 막힘으로 적음) · `fail`(그 밖 · 막힘으로 안 적음)
 *
 * **모래상자는 둘 중 하나다** — 읽기 전용은 `-s read-only`, 쓰기는 `--approve-for-me`(그 깃발이
 * workspace-write 로 돈다). ⚠️ **둘을 같이 주지 않는다** — `--sandbox` 와 `--approve-for-me` 를 같이 주면
 * codex 가 rc 2 로 **매번 죽는다**(2026-09-04 실측).
 *
 * **규칙을 codex 가 스스로 읽는다** — `~/.codex/config.toml` 의
 * `project_doc_fallback_filenames = ["CLAUDE.md"]` 와 `~/.agents/skills` 투영이
 * 이미 있어, 작업 디렉터리만 주면 같은 규칙·같은 스킬로 돈다.
 * ⚠️ **그 파일이 `project_doc_max_bytes` 를 넘으면 조용히 잘린다** — 한도는
 * 바이트로 센다(2026-10-02 84,954바이트 대 131,072바이트 · 65%). 넘기 시작하면
 * 이 폴백이 반쪽 규칙으로 돈다.
 *
 * **절대 안 던진다** — 무엇이 나든 `fail` 로 물러난다. 폴백이 터져서 본 경로까지 막으면 안 된다.
 */
export type CodexSandbox = 'read-only' | 'workspace-write';

export interface CodexTurnOpts {
  workingDirectory: string;
  sandbox: CodexSandbox;
  appendSystemPrompt?: string;
  /** 기본 600초 — 넘으면 트리째 죽인다. */
  timeoutMs?: number;
  /** 1차가 쓰던 것과 같은 깊이로 돈다. 생략하면 `SESSION_CODEX_EFFORT`. */
  effort?: string;
  model?: string;
  /** 쓰기 차례에서 작업 폴더 밖에 쓰기를 열 곳. **주면 이것만** — 생략하면 `codexWritableDirs()`.
   *  읽기 전용 차례는 아무 데도 안 연다. */
  writableDirs?: string[];
  /** 자식에게 얹을 환경 변수 — 1차 세션에 주던 것 그대로(`CLAUDE_SCHEDULED` 등). */
  env?: Record<string, string>;
  /** 마지막 답의 모양(JSON Schema) — 좁은 길이 쓴다. */
  outputSchema?: object;
  /** 띄운 직후 죽이는 손잡이를 넘긴다. */
  onSpawn?: (kill: () => void) => void;
  /** 엔진 상태 — 시험이 바꿔 끼운다. */
  store?: EngineState;
  /** 엔진 연습을 받는 차례인가 — 대화 차례(DM 폴백)는 `interactive`(생략하면 예약 일 · `engine-drill.ts`). */
  drillScope?: DrillScope;
  /** 볼트 대신 커밋의 메시지 이름(`[GPT 대신 커밋] <이름>`) — 사람 이름 · 글을 넣지 않는다. 생략하면 `codex 차례`. */
  label?: string;
}

/** codex 가 돌린 것 하나 — `done` 성공으로 끝남 · `failed` 실패로 끝남(종료 코드 · 상태) · 둘 다 없으면 결과 모름. */
export interface CodexStep { cmd: string; done: boolean; failed?: boolean }

export type CodexTurnKind = 'ok' | 'usage' | 'fail';

export interface CodexTurnResult {
  /** `ok` 일 때만 채운다 — 한도 · 실패 글이 답으로 새지 않게. */
  text: string;
  kind: CodexTurnKind;
  steps: CodexStep[];
  writeRan: boolean;
  /** 사용량 소진이면 풀리는 시각(epoch 초 · 글에서 읽었을 때만). */
  resetsAt?: number;
  ms: number;
  /** 실패 까닭 한 줄 — 로그 · 관찰 기록용. */
  detail?: string;
}

/** `codexTurn` 이 넘기는 깃발 묶음. **내보내는 이유는 검사가 모래상자 · 쓰기 범위를 세기 위해서다.** */
export function codexTurnArgs(opts: CodexTurnOpts, outFile: string, schemaFile?: string): string[] {
  const write = opts.sandbox === 'workspace-write';
  return [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check',
    // **작업 디렉터리 밖에도 쓸 곳이 있다.** codex 모래상자는 그 밖을 막는데,
    // `tasks.py` 는 `find` 조차 상태 파일을 쓴다(`analyze()` 가 체크인 스냅숏을
    // 남긴다) — 안 열어 주면 `PermissionError` 로 넘어진다(2026-09-04 실측).
    // 볼트와 판 배포 폴더도 같은 이유로 연다. 범위를 받은 회차(처리 흐름)는 그 범위만.
    ...(write ? (opts.writableDirs ?? codexWritableDirs()).flatMap((d) => ['--add-dir', d]) : []),
    // 쓰기 차례는 승인을 사람에게 묻지 않는다 — 아무도 안 보는 시각에 도는 길이라
    // 물으면 그대로 멈춘다. 이 깃발이 이미 workspace-write 로 돈다(도움말:
    // 「using the workspace-write sandbox」).
    ...(write ? ['--approve-for-me'] : ['-s', 'read-only']),
    '--color', 'never',
    '-C', opts.workingDirectory,
    '-m', opts.model ?? SESSION_CODEX_MODEL,
    '-c', `model_reasoning_effort=${opts.effort ?? SESSION_CODEX_EFFORT}`,
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-o', outFile, '-',
  ];
}

export async function codexTurn(prompt: string, opts: CodexTurnOpts): Promise<CodexTurnResult> {
  const t0 = Date.now();
  const store = opts.store ?? engineState;
  const id = randomId();
  const pf = path.join(os.tmpdir(), `wa-cx-${id}.txt`);
  const of = path.join(os.tmpdir(), `wa-cx-${id}.out.txt`);
  const sf = opts.outputSchema ? path.join(os.tmpdir(), `wa-cx-${id}.schema.json`) : undefined;
  const fail = (detail: string, steps: CodexStep[] = [], writeRan = false): CodexTurnResult =>
    ({ text: '', kind: 'fail', steps, writeRan, ms: Date.now() - t0, detail });
  // 엔진 연습 — codex 를 안 띄우고 막힌 모양만 낸다. 사용량 소진은 진짜처럼 엔진 상태에 적는다.
  const drill = codexDrill(opts.drillScope);
  if (drill === 'usage') {
    const until = drillBlockUntil();
    store.recordBlocked('codex', { kind: 'usage', until });
    return { text: '', kind: 'usage', steps: [], writeRan: false, resetsAt: until, ms: Date.now() - t0, detail: '연습 주입(usage)' };
  }
  if (drill === 'fail') return fail('연습 주입(fail)');
  try {
    const head = opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n----\n\n` : '';
    fs.writeFileSync(pf, head + prompt, 'utf-8');
    if (sf) fs.writeFileSync(sf, JSON.stringify(opts.outputSchema), 'utf-8');
    const run = await runCodex(codexTurnArgs(opts, of, sf), pf, {
      timeoutMs: opts.timeoutMs ?? 600_000, env: opts.env, onSpawn: opts.onSpawn,
    });
    const ev = run.events;
    const writeRan = opts.sandbox === 'workspace-write' && ev.touched;
    // 쓰기 차례의 `tasks.py` 는 모래상자 안에서 볼트 커밋을 못 한다(`.git` 읽기 전용) — 끝났든 끊겼든 봇이 대신.
    if (writeRan) await commitVaultAfterCodex(opts.label ?? 'codex 차례');
    let out = '';
    try { out = fs.existsSync(of) ? fs.readFileSync(of, 'utf-8').trim() : ''; } catch { /* 없으면 이벤트 쪽 */ }
    // 차례가 끝났나 — 이벤트를 봤으면 `turn.completed`, 못 봤으면(옛 판) rc 로.
    const finished = run.code === 0 && !run.timedOut && !ev.failed && (ev.completed || !ev.sawEvents);
    if (finished) {
      store.recordOk('codex');
      return { text: out || ev.text.trim(), kind: 'ok', steps: ev.steps, writeRan, ms: Date.now() - t0 };
    }
    // 실패 글에서만 한도를 가린다 — 끝난 차례의 답 본문은 안 본다(한도를 이야기한 답이 막힘으로 둔갑한다).
    const why = [...ev.errors, run.stderr].join('\n');
    const c = run.timedOut ? null : classifyCodexErrorText(why);
    if (c) {
      store.recordBlocked('codex', c);
      return {
        text: '', kind: 'usage', steps: ev.steps, writeRan, ms: Date.now() - t0,
        ...(c.until ? { resetsAt: c.until } : {}), detail: clipLine(why, 200),
      };
    }
    return fail(run.timedOut ? `시간 초과(${opts.timeoutMs ?? 600_000}ms)` : `rc ${run.code} ${clipLine(why, 200)}`.trim(),
      ev.steps, writeRan);
  } catch (err) {
    logger.warn('codex 한 차례가 터졌습니다 — 물러납니다', err);
    return fail(String((err as Error)?.message ?? err));
  } finally {
    for (const f of [pf, of, sf]) {
      if (f) { try { fs.unlinkSync(f); } catch { /* 이미 없다 */ } }
    }
  }
}
