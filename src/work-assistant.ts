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

/**
 * 그 차례가 처리 못 하고 끝났다고 캡처에 적는다.
 *
 * **이유를 안 가린다** (2026-08-31 사용자) — 한도든 서버 장애든 재시작이든
 * 「정상 종료 못 했다」 하나로 묶는다. 이유별 장치를 따로 두었더니 실제로
 * 어긋났다: 한도 큐가 08/24 의 서버 과부하(529)를 5시간짜리 한도로 잡아
 * 이레를 들고 있는 동안, 캡처 큐는 같은 건을 그날 안에 제대로 닫았다.
 *
 * ⚠️ **캡처를 붙일 때와 달리 파이썬을 거친다.** 붙이기는 이어 쓰기라 봇이 직접
 * 해도 안전한데, 이것은 **파일 전체를 다시 쓰는 일**이라 소유자가 하나여야 한다.
 * 느리지만(0.4초) 이 길은 드물게 돈다 — 로그 전체에서 실제로 막힌 것이 1건이다.
 *
 * ⚠️ **닫힌 캡처에도 적는다.** 「닫힘」은 「다 했다」가 아니라 「무언가 썼다」라서
 * (첫 쓰기에 닫힌다), 일하다 끊긴 차례가 닫힌 채로 남는다. 다시 돌리지는 않고
 * 아침 브리핑이 한 줄로 알린다.
 */
export async function markCaptureFailed(
  id: string, why: 'limit' | 'error' | 'interrupted',
): Promise<void> {
  if (!id || !isWorkAssistantEnabled()) return;
  try {
    const { code, stderr, stdout } = await runTasks(
      ['inbox', 'fail', '--id', id, '--why', why], 30_000);
    if (code !== 0) logger.error('캡처에 실패를 못 적었습니다', { id, why, out: (stderr || stdout).slice(-200) });
  } catch (err) {
    // 안전망이라 실패해도 본 차례를 막지 않는다 — 대신 조용히 지나가지 않게 남긴다.
    logger.error('캡처에 실패를 못 적었습니다', err);
  }
}

export interface PendingCapture {
  id: string;
  text: string;
  thread: string | null;
  tries: number;
}

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
    await runTasks(['inbox', 'resolve', '--id', id, '--drop', why], 30_000);
  } catch (err) {
    logger.error('캡처를 못 버렸습니다', err);
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
  // 공백만 보면 모자란다 — cmd.exe 는 `&`·`|`·`<`·`>` 에서도 줄을 끊는다.
  // 「R&D회의」처럼 공백 없이 붙어 오는 값이 실제로 있다(메일 제목).
  // ⚠️ `%VAR%` 는 따옴표로 못 막는다(치환이 먼저 일어난다) — 여기 인자에는
  // 그런 값이 안 오지만, 오게 되면 셸을 걷어내는 쪽으로 가야 한다.
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
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
export async function remindDone(id: string): Promise<boolean> {
  try {
    const { code } = await runTasks(['remind', '--done', id], 60_000);
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
  return byFile('quick', text);
}

/**
 * 여러 줄 글을 한 칸에 앉힌다 — 판의 요약·메모 칸이 이리로 온다.
 *
 * **짧은 문법과 갈라 둔 이유는 봇이 아니라 파이썬 쪽에 있다**(`tasks.py` 의
 * `cmd_note`): 자유 서술에 「완료」·「2h」가 들어 있으면 짧은 문법이 그것을
 * 지시로 읽고, 줄바꿈과 `·` 는 그 문법의 조각 구분자다. 여기서는 여전히
 * **종료 코드만** 본다 — 뜻은 저쪽 한 곳에만 있다.
 */
export async function noteUpdate(text: string): Promise<QuickOutcome> {
  return byFile('note', text);
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
async function byFile(cmd: 'quick' | 'note' | 'stage', text: string): Promise<QuickOutcome> {
  const root = workAssistantRoot();
  if (!root) return { kind: 'not-quick' };
  const file = path.join(os.tmpdir(), `wa-${cmd}-${randomId()}.txt`);
  try {
    fs.writeFileSync(file, text, { encoding: 'utf-8' });
    const { code, stdout, stderr } = await runTasks([cmd, '--file', file], 90_000);
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
export async function narrowApply(json: string, task: string): Promise<QuickOutcome> {
  const root = workAssistantRoot();
  if (!root) return { kind: 'not-quick' };
  const file = path.join(os.tmpdir(), `wa-narrow-${randomId()}.json`);
  try {
    fs.writeFileSync(file, json, { encoding: 'utf-8' });
    const { code, stdout, stderr } = await runTasks(
      ['narrow', '--apply', file, '--task', task], 90_000);
    if (code === 0) return { kind: 'ok', output: stdout.trim() };
    if (code === 2) {
      return { kind: 'not-quick', detail: (stderr || stdout).trim().split('\n').slice(-2).join(' / ') };
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

/** 폴백 엔진. 값을 바꾸려면 여기 한 줄 — 잰 것은 `sol` · `low` 다. */
const NARROW_CODEX_MODEL = process.env.BOARD_NARROW_CODEX_MODEL || 'gpt-5.6-sol';
const NARROW_CODEX_EFFORT = process.env.BOARD_NARROW_CODEX_EFFORT || 'low';

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
  system: string, user: string, timeoutMs = 90_000,
): Promise<string> {
  if (process.env.BOARD_NARROW_FALLBACK === 'off') return '';
  const id = randomId();
  const pf = path.join(os.tmpdir(), `wa-cx-${id}.txt`);
  const sf = path.join(os.tmpdir(), `wa-cx-${id}.schema.json`);
  const of = path.join(os.tmpdir(), `wa-cx-${id}.out.txt`);
  try {
    // 시스템 프롬프트를 앞에 이어 붙인다 — `codex exec` 에 그 칸이 따로 없다.
    fs.writeFileSync(pf, `${system}\n\n----\n\n${user}`, 'utf-8');
    fs.writeFileSync(sf, JSON.stringify(NARROW_SCHEMA), 'utf-8');
    const args = [
      'exec', '--ephemeral', '--skip-git-repo-check',
      // 읽기 전용 — 이 호출은 파일을 건드릴 일이 없다. 쓰는 것은 파이썬이 한다.
      '-s', 'read-only', '--color', 'never',
      // 이 저장소를 작업 뿌리로 주지 않는다 — 규칙은 위 `system` 이 다 들고 있고,
      // 주면 `CLAUDE.md` 가 따라 들어와 좁은 길이 아니게 된다.
      '-C', os.tmpdir(),
      '-m', NARROW_CODEX_MODEL,
      '-c', `model_reasoning_effort=${NARROW_CODEX_EFFORT}`,
      '--output-schema', sf, '-o', of, '-',
    ];
    const code = await runCodex(args, pf, timeoutMs);
    if (code !== 0) {
      logger.warn(`좁은 길 폴백(codex) rc ${code}`);
      return '';
    }
    return fs.existsSync(of) ? fs.readFileSync(of, 'utf-8').trim() : '';
  } catch (err) {
    logger.warn('좁은 길 폴백(codex)이 터졌습니다 — 세션으로 갑니다', err);
    return '';
  } finally {
    for (const f of [pf, sf, of]) {
      try { fs.unlinkSync(f); } catch { /* 이미 없다 */ }
    }
  }
}

/**
 * `codex` 를 띄우고 rc 만 돌려준다. 답은 `-o` 파일로 받는다.
 *
 * ⚠️ **인자를 셸에 그대로 넘기지 않는다** — `shell:true` 는 공백에서 인자를
 * 쪼갠다(이 레포가 한 번 겪었다). `runTasks` 와 같은 따옴표 함수를 쓴다.
 */
function runCodex(args: string[], stdinFile: string, timeoutMs: number): Promise<number> {
  const useShell = process.platform === 'win32';
  const argv = useShell ? args.map(quoteForShell) : args;
  return new Promise((resolve) => {
    // 실행체 이름을 바꿀 수 있게 둔다 — **검사가 없는 이름을 넣어**
    // 「폴백이 터져도 빈손으로 물러나나」를 실제로 재려면 이 문이 필요하다.
    const bin = process.env.BOARD_NARROW_CODEX_BIN || 'codex';
    const proc = spawn(bin, argv, {
      stdio: [fs.openSync(stdinFile, 'r'), 'ignore', 'pipe'],
      shell: useShell,
      env: { ...process.env },
      windowsHide: true,
    });
    let err = '';
    proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    const killTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* 이미 끝난 프로세스 */ }
    }, timeoutMs);
    proc.on('error', () => { clearTimeout(killTimer); resolve(-1); });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0 && err) logger.warn(`codex stderr: ${err.slice(0, 300)}`);
      resolve(code ?? -1);
    });
  });
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
 * **주 작업용 폴백** — 예약 세션을 codex 로 한 번 돌린다 (2026-09-03).
 *
 * `narrowCodex` 와 다른 점 둘.
 *   - **도구를 쓴다.** 좁은 길은 읽기도 쓰기도 파이썬이 하지만 예약 작업은
 *     세션이 스스로 `bin/tasks.py` 를 돌린다 — 그래서 `workspace-write` 다.
 *   - **답의 모양을 강제하지 않는다.** 산출물이 사람이 읽을 글이라 스키마가 없다.
 *
 * **규칙을 codex 가 스스로 읽는다** — `~/.codex/config.toml` 의
 * `project_doc_fallback_filenames = ["CLAUDE.md"]` 와 `~/.codex/skills` 투영이
 * 이미 있어, 작업 디렉터리만 주면 같은 규칙·같은 스킬로 돈다.
 * ⚠️ **그 파일이 `project_doc_max_bytes` 를 넘으면 조용히 잘린다** — 지금
 * 110,583자 대 131,072자(84%)다. 넘기 시작하면 이 폴백이 반쪽 규칙으로 돈다.
 *
 * 못 하면 **빈 글자**를 돌려준다 — 부르는 쪽이 오늘까지와 같이 물러난다.
 * `SESSION_FALLBACK=off` 로 끈다.
 */
export async function codexSession(
  prompt: string,
  opts: { workingDirectory: string; appendSystemPrompt?: string; timeoutMs?: number },
): Promise<string> {
  if (process.env.SESSION_FALLBACK === 'off') return '';
  const id = randomId();
  const pf = path.join(os.tmpdir(), `wa-cs-${id}.txt`);
  const of = path.join(os.tmpdir(), `wa-cs-${id}.out.txt`);
  try {
    const head = opts.appendSystemPrompt ? `${opts.appendSystemPrompt}\n\n----\n\n` : '';
    fs.writeFileSync(pf, head + prompt, 'utf-8');
    const args = [
      'exec', '--ephemeral', '--skip-git-repo-check',
      // **작업 디렉터리 밖에도 쓸 곳이 있다.** codex 모래상자는 그 밖을 막는데,
      // `tasks.py` 는 `find` 조차 상태 파일을 쓴다(`analyze()` 가 체크인 스냅숏을
      // 남긴다) — 안 열어 주면 `PermissionError` 로 넘어진다(2026-09-04 실측).
      // 볼트와 판 배포 폴더도 같은 이유로 연다.
      ...codexWritableDirs().flatMap((d) => ['--add-dir', d]),
      // 승인을 사람에게 묻지 않는다 — 아무도 안 보는 시각에 도는 길이라
      // 물으면 그대로 멈춘다.
      //
      // ⚠️ ** 를 같이 주면 안 된다** — codex 가 `--sandbox 는 --approve-for-me
      // 와 같이 못 쓴다` 로 rc 2 를 내며 **매번 죽는다**(2026-09-04 실측).
      // 이 깃발이 이미 workspace-write 로 돈다(도움말: 「using the
      // workspace-write sandbox」)라 따로 줄 필요가 없다.
      '--approve-for-me',
      '--color', 'never',
      '-C', opts.workingDirectory,
      '-m', NARROW_CODEX_MODEL,
      '-c', `model_reasoning_effort=${NARROW_CODEX_EFFORT}`,
      '-o', of, '-',
    ];
    const code = await runCodex(args, pf, opts.timeoutMs ?? 600_000);
    if (code !== 0) {
      logger.warn(`주 작업 폴백(codex) rc ${code}`);
      return '';
    }
    return fs.existsSync(of) ? fs.readFileSync(of, 'utf-8').trim() : '';
  } catch (err) {
    logger.warn('주 작업 폴백(codex)이 터졌습니다 — 물러납니다', err);
    return '';
  } finally {
    for (const f of [pf, of]) {
      try { fs.unlinkSync(f); } catch { /* 이미 없다 */ }
    }
  }
}
