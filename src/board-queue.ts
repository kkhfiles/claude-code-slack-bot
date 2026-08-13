/**
 * 진행판에서 누른 것을 가져와 반영한다.
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
 * ⚠️ **User-Agent 가 없으면 서비스 토큰이 맞아도 403 이다.** Cloudflare 가 Access
 * 앞에서 막는다 — 2026-08-07 에 이것을 토큰 문제로 오인했다.
 */
const UA = 'work-assistant-board-poller/1';

export interface QueueItem {
  id: string;
  text: string;
  /** 어디로 갈지. 없으면 짧은 문법이다 — 이 표시가 생기기 전에 담긴 것도 있다. */
  kind?: 'quick' | 'ask';
  label?: string;
  ts: number;
  taken?: number;
}

/** `quick` 을 부르는 쪽. 봇은 실제 구현을, 검사는 가짜를 넘긴다. */
export type Apply = (text: string) =>
  Promise<{ kind: 'ok'; output: string } | { kind: 'not-quick' } | { kind: 'failed'; message: string }>;

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

/** 진행판 주소는 `work-assistant` 의 `config.json` 한 곳에만 있다. */
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
  if (!origin) throw new Error('진행판 주소가 없습니다');
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
 */
export async function drain(apply: Apply, ask: Ask | null, base?: string): Promise<DrainResult> {
  const out: DrainResult = { applied: [], dropped: [], retry: [], lost: [], duplicates: 0 };
  // `pull` 은 「가져간 표시」를 남기므로 읽기가 아니다 — 워커가 POST 만 받는다.
  const { items } = (await call('pull', {}, base)) as { items: QueueItem[] };
  if (!items.length) return out;

  const done = loadDone();
  const seen = new Set(done);
  const ack: string[] = [];

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
        out.applied.push({ item, output: '' });
      } catch (err) {
        logger.error('진행판에서 온 말을 비서에게 못 넘겼습니다', err);
        out.lost.push(item);
      }
      continue;
    }

    const r = await apply(item.text);
    if (r.kind === 'ok') {
      // **지우기 전에 적는다.** 순서가 바뀌면 그 사이에 죽었을 때 두 번 쓴다.
      done.push(item.id);
      seen.add(item.id);
      saveDone(done);
      ack.push(item.id);
      out.applied.push({ item, output: r.output });
    } else if (r.kind === 'not-quick') {
      done.push(item.id);
      seen.add(item.id);
      saveDone(done);
      ack.push(item.id);
      out.dropped.push(item);
    } else {
      logger.warn(`반영 실패 — 큐에 남겨 둡니다: ${item.text}`, r.message);
      out.retry.push(item);
    }
  }

  if (ack.length) await call('ack', { ids: ack }, base);
  return out;
}
