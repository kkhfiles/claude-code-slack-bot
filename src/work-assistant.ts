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
  if (!/[\s"]/.test(arg)) return arg;
  if (arg.includes('"')) throw new Error(`셸에 못 넘기는 인자입니다(따옴표 포함): ${arg}`);
  return `"${arg}"`;
}

function runTasks(
  args: string[],
  timeoutMs = 60_000,
  script = 'bin/tasks.py',
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

/**
 * **노션에서 직접 고친 것을 따라잡는다.**
 *
 * 수정은 Work Board와 스탠리에서 한다는 것이 규율이지만, 노션은 막을 수 없다
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
  ok: boolean; threads: MailThread[]; newest: string; text: string; detail: string;
}> {
  const none = { ok: false, threads: [] as MailThread[], newest: '', text: '' };
  try {
    const { code, stdout, stderr } = await runTasks(
      ['candidates', '--days', String(days), '--push', '--json'], 90_000, 'bin/mail.py');
    if (code !== 0) return { ...none, detail: (stderr || stdout).trim() };
    const r = JSON.parse(stdout);
    // `text` 는 파이썬이 그린 것을 그대로 나른다 — 여기서 다시 그리지 않는다.
    return {
      ok: true, threads: r.threads ?? [], newest: r.newest ?? '',
      text: r.text ?? '', detail: '',
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

export async function isQuietPeriod(): Promise<boolean> {
  try {
    const { code, stdout } = await runTasks(['quiet'], 20_000);
    return code === 0 && stdout.includes('🔕');
  } catch {
    return false;
  }
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
 * **미는 체크인.** 정해진 시각에 봇이 먼저 묻는다 — 물을 게 없거나, 오늘 이미
 * 답을 받았거나, 「조용히」 기간이면 **빈 문자열**이다. 판정은 전부 `tasks.py`
 * 가 한다(봇에 규칙을 복제하지 않는다).
 *
 * 오전은 저장된 질문(어제 것, 파일만 읽어 즉시), 오후는 다시 고른 질문(오늘 것,
 * 노션 왕복). **같은 질문을 두 번 밀지 않는다** — 묻는 대상이 다르다.
 *
 * 실패는 조용히 넘긴다. 이 자리는 "물을 게 없으면 침묵" 이라 시끄럽게 만들면
 * 침묵과 구분이 안 되는데, 같은 시각의 넛지(`briefNudge`)가 실패를 알린다.
 */
export async function checkinNudge(afternoon: boolean): Promise<string> {
  const args = afternoon
    ? ['checkin', '--nudge', '--now', '--surface', 'slack', '--slack']
    : ['checkin', '--nudge', '--once', '--surface', 'slack', '--slack'];
  try {
    const { code, stdout, stderr } = await runTasks(args, afternoon ? 60_000 : 20_000);
    if (code !== 0) {
      logger.error(`tasks.py checkin --nudge 실패 (rc=${code})`, (stderr || stdout).trim());
      return '';
    }
    return stdout.trim();
  } catch (err) {
    logger.error('checkin --nudge failed', err);
    return '';
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
  | { kind: 'not-quick'; detail?: string }
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
    if (code === 2) {
      return { kind: 'not-quick', detail: (stderr || stdout).trim().split('\n').slice(-2).join(' / ') };
    }
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
