/**
 * 판에서 누른 것을 가져와 반영한다.
 *
 * **여기에는 업무 로직이 없다.** 큐에 담긴 것은 `tasks.py quick` 이 읽는 문자열
 * 하나뿐이고, 그것을 노션에 어떻게 쓸지는 파이썬만 안다. 이 모듈은 나르고,
 * 두 번 반영하지 않게 막고, 언제 버릴지만 정한다.
 *
 * **가져가는 것과 지우는 것이 나뉘어 있다.** `pull` 은 큐를 비우지 않고, 반영이
 * 끝난 것만 `ack` 이 지운다. 반영 도중에 프로세스가 죽으면 다음 폴에 다시 나오고,
 * 그때 두 번 쓰지 않게 하는 것이 처리한 id 파일이다.
 *
 * 실패를 두 가지로 가른다 — 이 구분이 이 파일의 핵심이다:
 *   **영구**(`not-quick`, rc 2) 문자열이 문법에 안 맞는다. 다시 시도해도 같다 →
 *     버리고 알린다. 안 버리면 폴링할 때마다 영원히 되돌아온다.
 *   **일시**(그 외 비정상) 노션이 안 열리는 등. 큐에 남겨 두면 복구된 뒤 저절로
 *     반영된다 → 아무것도 안 하고 다음 폴에 맡긴다.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { Logger } from './logger';

const logger = new Logger('BoardQueue');

const STATE = path.join(os.homedir(), '.claude', 'state');
const TOKEN_FILE = path.join(STATE, 'cf-access-service-token.json');
/** 자가 검사는 실제 상태 파일을 건드리면 안 되므로 여기만 바꿔 끼운다. */
const DONE_FILE = process.env.BOARD_QUEUE_DONE_FILE
  || path.join(STATE, 'board-queue-done.json');

/** 처리한 id 를 얼마나 들고 있나. 큐에 남을 수 있는 최대(100)보다 넉넉하면 된다. */
const DONE_KEEP = 500;

/**
 * 관찰 기록 — **파이썬과 같은 파일에 쌓는다**(`tasks.py` 의 `EVENTS`).
 * 검사가 실제 상태 파일을 건드리면 안 되므로 여기만 바꿔 끼운다.
 */
const EVENTS_FILE = process.env.WORK_EVENTS_FILE
  || path.join(STATE, 'work-events.jsonl');

/**
 * 관찰용 한 줄을 쌓는다 — 「판 「프롬프트」가 슬랙을 대신하는가」의 판정 근거.
 *
 * **판에서 온 말은 파이썬을 안 지난다.** 관찰 넷 중 이 갈래만 봇이 쓰는 이유다.
 *
 * ⚠️ **시각은 지역시각이다.** `toISOString()` 은 UTC 라 파이썬이 쓰는 줄과 9시간
 * 어긋나고, 그러면 `events` 의 날짜별 집계(「넛지 난 날에 세션이 열렸나」)가
 * 조용히 틀린 날에 붙는다. 같은 파일에 쌓으므로 형식이 같아야 한다.
 *
 * ⚠️ **계측이 반영을 막으면 안 된다** — 막는 순간 그 계측은 꺼야 하는 것이 되고,
 * 꺼진 계측은 없는 것과 같다. 그래서 무엇이 터져도 삼킨다.
 */
function event(kind: string, extra: Record<string, unknown> = {}): void {
  try {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts, kind, ...extra }) + '\n', 'utf-8');
  } catch {
    // 삼킨다 — 위 주석 참조.
  }
}

/**
 * ⚠️ **User-Agent 가 없으면 서비스 토큰이 맞아도 403 이다.** Cloudflare 가 Access
 * 앞에서 막는다 — 2026-08-07 에 이것을 토큰 문제로 오인했다.
 */
const UA = 'work-assistant-board-poller/1';

export interface QueueItem {
  id: string;
  text: string;
  /** 어디로 갈지. 없으면 짧은 문법이다 — 이 표시가 생기기 전에 담긴 것도 있다. */
  kind?: 'quick' | 'ask' | 'note';
  label?: string;
  ts: number;
  taken?: number;
}

/** `quick` 을 부르는 쪽. 봇은 실제 구현을, 검사는 가짜를 넘긴다. */
export type Apply = (text: string) =>
  Promise<{ kind: 'ok'; output: string }
    // `detail` 은 왜 문법이 아닌지 — 로그에만 쓴다(사람에게 가는 DM 은 원인을
    // 안 좁힌다). 검사가 가짜를 넘길 수 있게 여기 모양을 따로 적어 둔다.
    | { kind: 'not-quick'; detail?: string }
    | { kind: 'failed'; message: string }>;

/**
 * 사람 말을 비서에게 넘기는 쪽. **답도 되묻기도 비서가 자기 자리에서 한다** —
 * 여기서는 넘겼는지만 안다.
 */
export type Ask = (text: string) => Promise<void>;

export interface DrainResult {
  /** 반영에 성공해 지운 것 */
  applied: { item: QueueItem; output: string }[];
  /** 문법이 아니라 버린 것 — 사람에게 알려야 한다 */
  dropped: QueueItem[];
  /** 일시 실패라 큐에 남겨 둔 것 */
  retry: QueueItem[];
  /** 한 번만 시도하는 것이 실패했다 — 다시 못 부르므로 원문을 사람에게 돌려준다 */
  lost: QueueItem[];
  /** 이미 반영해 둔 것을 다시 만난 횟수(중복 방지가 실제로 일한 증거) */
  duplicates: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * 판의 이름. **주소와 같은 곳에서 읽는다** — `work-assistant` 의 `config.json`
 * 한 줄이 정본이라, 여기 글자로 박아 두면 이름을 바꿀 때 봇만 옛 이름을 말한다.
 *
 * 못 읽으면 「업무 판」으로 답한다 — 사람에게 가는 문장이라 비워 둘 수 없다.
 */
export function boardLabel(): string {
  const root = config.workAssistant.root;
  if (!root) return '업무 판';
  return readJson<{ board_label?: string }>(path.join(root, 'config.json'), {})
    .board_label || '업무 판';
}

/** 판 주소는 `work-assistant` 의 `config.json` 한 곳에만 있다. */
export function boardOrigin(): string | null {
  const root = config.workAssistant.root;
  if (!root) return null;
  const url = readJson<{ board_url?: string }>(path.join(root, 'config.json'), {}).board_url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function token(): { id: string; secret: string } | null {
  const t = readJson<{ id?: string; secret?: string }>(TOKEN_FILE, {});
  return t.id && t.secret ? { id: t.id, secret: t.secret } : null;
}

export function boardQueueEnabled(): boolean {
  return !!boardOrigin() && !!token();
}

async function call(op: string, body?: unknown, base?: string): Promise<any> {
  const origin = base ?? boardOrigin();
  if (!origin) throw new Error('판 주소가 없습니다');
  const t = token();
  const headers: Record<string, string> = { 'user-agent': UA };
  // 열쇠는 Access 뒤에 있을 때만 필요하다. 없으면 안 붙이고 그대로 간다 —
  // 로컬 dev 서버에는 Access 가 없고, 운영에서는 열쇠가 없으면 폴러 자체가
  // 안 뜬다(`boardQueueEnabled`).
  if (t) {
    headers['CF-Access-Client-Id'] = t.id;
    headers['CF-Access-Client-Secret'] = t.secret;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-board'] = '1';
  }
  const res = await fetch(`${origin}/api/${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`/api/${op} → ${res.status}`);
  return res.json();
}

function loadDone(): string[] {
  return readJson<string[]>(DONE_FILE, []);
}

function saveDone(ids: string[]): void {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(DONE_FILE, JSON.stringify(ids.slice(-DONE_KEEP)), 'utf-8');
  } catch (err) {
    // 여기서 실패하면 다음 폴에 같은 것을 또 반영한다 — 조용히 넘기면 안 된다.
    logger.error('처리한 id 를 못 적었습니다 — 중복 반영 위험', err);
  }
}

/**
 * 한 판 돈다. 큐가 비어 있으면 아무것도 안 하고 조용히 끝난다.
 *
 * `base` 는 검사에서 로컬 dev 서버를 가리키려고 있다.
 *
 * `note` 는 여러 줄 글(요약·메모)을 받는 쪽이다. **뒤에 붙인 이유**는 앞에
 * 끼우면 `base` 를 세 번째로 넘기던 자리가 조용히 어긋나서다 — 부르는 쪽이
 * 둘(스케줄러·자가 검사)뿐이라도 인자 순서가 바뀌면 검사가 먼저 거짓말을 한다.
 */
export async function drain(apply: Apply, ask: Ask | null, base?: string,
                            note?: Apply | null): Promise<DrainResult> {
  const out: DrainResult = { applied: [], dropped: [], retry: [], lost: [], duplicates: 0 };
  // `pull` 은 「가져간 표시」를 남기므로 읽기가 아니다 — 워커가 POST 만 받는다.
  const { items } = (await call('pull', {}, base)) as { items: QueueItem[] };
  if (!items.length) return out;
  // **가져갔다는 사실을 남긴다.** 이게 없으면 「누른 것이 큐에 안 들어갔다」와
  // 「들어갔는데 여기서 사라졌다」를 나중에 못 가른다 — 2026-08-18 에 그래서
  // 원인을 못 짚었다. 성공은 DM 으로만 알렸고 로그는 비어 있었다.
  logger.info(`큐에서 ${items.length}건 가져옴: ` +
    items.map((i) => `${i.id}(${i.kind || 'quick'}) ${i.text}`).join(' | '));

  const done = loadDone();
  const seen = new Set(done);
  const ack: string[] = [];
  /** 짧은 문법은 모았다 한 번에 보낸다 — 아래 「한 번에 묶는 이유」 참조. */
  const quicks: QueueItem[] = [];
  /** 여러 줄 글. **모으지 않는다** — 아래 `note` 갈래의 주석 참조. */
  const notes: QueueItem[] = [];

  /** 반영됐다고 적고 지운다. **적는 것이 먼저다** — 순서가 바뀌면 그 사이에 죽었을 때 두 번 쓴다. */
  const settle = (item: QueueItem, output: string) => {
    done.push(item.id);
    seen.add(item.id);
    saveDone(done);
    ack.push(item.id);
    logger.info(`반영 — ${item.id} ${item.text}`);
    out.applied.push({ item, output });
  };

  const drop = (item: QueueItem, why?: string) => {
    done.push(item.id);
    seen.add(item.id);
    saveDone(done);
    ack.push(item.id);
    // **버린 이유를 남긴다.** 사람에게 가는 DM 은 원인을 안 좁히지만(규율 그대로),
    // 로그까지 비워 두면 다음에 또 「왜 안 됐나」에서 막힌다.
    logger.warn(`버림 — ${item.id} ${item.text} · ${why || '이유 없음'}`);
    out.dropped.push(item);
  };

  for (const item of items) {
    if (seen.has(item.id)) {
      // 반영은 끝났는데 ack 이 못 갔던 것. 지우기만 하면 된다.
      out.duplicates += 1;
      ack.push(item.id);
      continue;
    }
    if (item.kind === 'ask') {
      // 받을 곳이 없으면 아무것도 안 하고 큐에 남긴다 — 사람 말은 다시 만들 수 없다.
      if (!ask) { out.retry.push(item); continue; }
      // **한 번만 시도한다.** 짧은 문법과 달리 이쪽은 노션에 쓰고 슬랙에 답하는
      // 부작용이 있어, 되풀이하면 그 일이 두 번 일어난다. 그래서 부르기 **전에**
      // 처리한 것으로 적는다 — 도중에 죽어도 다시 나오지 않는다. 잃는 쪽을 택한
      // 대가로, 실패하면 원문을 사람에게 돌려준다.
      done.push(item.id);
      seen.add(item.id);
      saveDone(done);
      ack.push(item.id);
      try {
        await ask(item.text);
        logger.info(`비서에게 넘김 — ${item.id} ${item.text.slice(0, 80)}`);
        event('ask', { ok: true });
        out.applied.push({ item, output: '' });
      } catch (err) {
        logger.error('판에서 온 말을 비서에게 못 넘겼습니다', err);
        // **못 넘긴 것도 센다** — 성공만 세면 비율이 늘 100%가 되어 「한 번만
        // 시도하는 대가가 실제로 나오는가」를 영영 못 본다.
        event('ask', { ok: false });
        out.lost.push(item);
      }
      continue;
    }

    if (item.kind === 'note') {
      // **묶지 않는다.** 짧은 문법은 `·` 로 이어 한 번에 보내는데, 사람이 쓴 글에는
      // 그 글자와 줄바꿈이 그대로 들어 있어 이으면 조각이 쪼개진다.
      //
      // **한 번만 시도하는 경로가 아니다** — 같은 칸에 같은 글을 두 번 앉히면
      // 결과가 같다(진행 로그처럼 쌓이지 않는다). 그래서 일시 실패는 큐에 남겨
      // 두고 다음 판에 맡긴다. 사람이 쓴 글은 다시 만들 수 없어, 잃는 쪽보다
      // 늦는 쪽이 싸다.
      if (!note) { out.retry.push(item); continue; }
      notes.push(item);
      continue;
    }

    quicks.push(item);
  }

  await applyQuicks();
  if (notes.length && note) await applyEach(notes, note);

  if (ack.length) await call('ack', { ids: ack }, base);
  return out;

  /**
   * **한 번에 묶는 이유.** 건마다 `quick` 을 부르면 건마다 볼트 쓰기·다시 그리기·
   * 올리기가 돌고, 열려 있는 화면은 **올라온 판 수만큼 통째로 다시 읽는다** —
   * 두 건이면 2초 간격으로 두 번 깜빡였다(2026-08-18 실측 · 올리기 로그
   * 18:15:07 과 18:15:09). `quick` 은 원래 여러 조각을 한 줄로 받으므로
   * (「TSK-5 완료 · TSK-18 2h」) 이어 붙이면 쓰기도 올리기도 한 번이다.
   *
   * ⚠️ **묶으면 전부 아니면 전무다** — 한 조각이 문법에 안 맞으면 덩어리 전체가
   * rc 2 라 성한 것까지 버려진다. 그래서 **묶음이 rc 2 면 건별로 다시 시도한다**.
   * 그때만 느려지고, 버려지는 것은 진짜 틀린 하나뿐이다.
   */
  async function applyQuicks(): Promise<void> {
    if (!quicks.length) return;
    if (quicks.length === 1) { await applyEach(quicks, apply); return; }
    const r = await apply(quicks.map((i) => i.text).join(' · '));
    if (r.kind === 'ok') {
      // **답은 한 번만 낸다** — 건마다 같은 글을 DM 으로 보내면 소음이다.
      quicks.forEach((item, i) => settle(item, i === 0 ? r.output : ''));
    } else if (r.kind === 'failed') {
      logger.warn(`묶음 반영 실패 — 큐에 남겨 둡니다 (${quicks.length}건)`, r.message);
      out.retry.push(...quicks);
    } else {
      logger.warn(`묶음이 문법에 안 맞아 건별로 다시 시도합니다 (${quicks.length}건) · ` +
        (r.detail || '이유 없음'));
      await applyEach(quicks, apply);
    }
  }

  async function applyEach(list: QueueItem[], fn: Apply): Promise<void> {
    for (const item of list) {
      const r = await fn(item.text);
      if (r.kind === 'ok') settle(item, r.output);
      else if (r.kind === 'not-quick') drop(item, r.detail);
      else {
        logger.warn(`반영 실패 — 큐에 남겨 둡니다: ${item.text}`, r.message);
        out.retry.push(item);
      }
    }
  }
}
