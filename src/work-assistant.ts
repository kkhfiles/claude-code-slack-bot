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
import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { Logger } from './logger';

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
 * 슬랙에서 받은 원문을 캡처 큐에 적는다. **해석하지 않는다.**
 *
 * 순서가 규칙이다 — 원문 저장(결정론) → 해석(세션) → 닫기. 해석이 실패해도
 * 원문은 이미 안전하다. 그래서 여기서는 파이썬도 노션도 부르지 않는다.
 *
 * 슬랙 원문에는 따옴표·줄바꿈·한글이 섞이는데, 이걸 CLI 인자로 넘기면
 * win32 `shell:true` spawn 에서 깨지거나 주입 위험이 생긴다. 파일에 직접
 * 쓰면 그 문제 자체가 없어진다.
 */
export function captureToInbox(text: string, source = 'slack', thread?: string): InboxRecord | null {
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
  };
  try {
    fs.appendFileSync(path.join(root, 'inbox.jsonl'),
      JSON.stringify(rec) + '\n', { encoding: 'utf-8' });
    return rec;
  } catch (err) {
    logger.error('inbox capture failed', err);
    return null;
  }
}

/** 아직 세션이 처리하지 않은 캡처 수. 브리핑 꼬리에 붙인다. */
export function openCaptureCount(): number {
  const root = workAssistantRoot();
  if (!root) return 0;
  const file = path.join(root, 'inbox.jsonl');
  if (!fs.existsSync(file)) return 0;
  try {
    return fs.readFileSync(file, 'utf-8').split('\n')
      .filter(Boolean)
      .filter(line => { try { return JSON.parse(line).status === 'open'; } catch { return false; } })
      .length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- 요약 (출력)

function runTasks(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const root = workAssistantRoot();
  return new Promise((resolve, reject) => {
    if (!root) { reject(new Error('work-assistant root not found')); return; }
    const proc = spawn('python', ['-X', 'utf8', 'bin/tasks.py', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
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

/**
 * 슬랙용 짧은 업무 요약. 인자에 사용자 입력이 들어가지 않으므로 CLI 로 부른다.
 * 노션 왕복이 있어 몇 초 걸린다.
 */
export async function briefShort(): Promise<string> {
  const { code, stdout, stderr } = await runTasks(['brief', '--short'], 60_000);
  if (code !== 0) {
    throw new Error(`tasks.py brief --short 실패 (rc=${code}): ` +
      (stderr || stdout).trim().split('\n').slice(-3).join('\n'));
  }
  return stdout.trim();
}

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

// ------------------------------------------------- 체크인 (진행이 들어오는 입구)

/**
 * 어제 진행 체크인. 물을 게 없거나 슬랙에서 오늘 이미 물었으면 **빈 문자열**.
 *
 * 하루 1회 래치는 `tasks.py` 가 든다 — 봇은 비었는지만 본다. 실패해도 조용히
 * 넘어간다: 매 메시지마다 도는 자리라 여기서 시끄러우면 아무도 안 읽게 된다
 * (넛지·브리핑 실패는 여전히 시끄럽게 알린다 — 그쪽은 하루 한 번이다).
 */
export async function checkinOnce(): Promise<string> {
  try {
    const { code, stdout, stderr } = await runTasks(
      ['checkin', '--once', '--surface', 'slack', '--slack'], 20_000);
    if (code !== 0) {
      logger.error(`tasks.py checkin 실패 (rc=${code})`, (stderr || stdout).trim());
      return '';
    }
    return stdout.trim();
  } catch (err) {
    logger.error('checkin failed', err);
    return '';
  }
}

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
  /** 이 문법이 아니다 — 평소대로 세션이 받는다. */
  | { kind: 'not-quick' }
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
export async function quickUpdate(text: string): Promise<QuickOutcome> {
  const root = workAssistantRoot();
  if (!root) return { kind: 'not-quick' };
  const file = path.join(os.tmpdir(), `wa-quick-${randomId()}.txt`);
  try {
    fs.writeFileSync(file, text, { encoding: 'utf-8' });
    const { code, stdout, stderr } = await runTasks(['quick', '--file', file], 90_000);
    if (code === 0) return { kind: 'ok', output: stdout.trim() };
    if (code === 2) return { kind: 'not-quick' };
    const tail = (stderr || stdout).trim().split('\n').slice(-3).join('\n');
    logger.error(`tasks.py quick 실패 (rc=${code})`, tail);
    return { kind: 'failed', message: tail || `rc=${code}` };
  } catch (err) {
    logger.error('quick update failed', err);
    return { kind: 'failed', message: String(err) };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 이미 없다 */ }
  }
}
