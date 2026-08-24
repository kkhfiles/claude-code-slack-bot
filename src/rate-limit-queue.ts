/**
 * 구독 한도에 막힌 요청을 쌓아 두고, 한도가 풀리면 꺼내 준다.
 *
 * **왜 파일인가** — 구독 한도는 보통 몇 시간 뒤에 풀린다. 그때까지 메모리에
 * 들고 있으면 봇이 한 번만 재시작해도 통째로 사라지고, 보낸 사람은 무시당한
 * 것과 구분하지 못한다. 기존 재시도 정보(`pendingRetries`)가 10분 뒤 지워지는
 * 것도 같은 이유로 한도 회복까지 살아남지 못했다.
 *
 * **왜 자동 실행이 아닌가** — 회복 시각에 밀린 것을 그냥 다 돌리면, 몇 시간 전
 * 지시가 그사이 뒤집힌 채로 실행된다(「그거 말고 회의 메모로」가 앞 지시를
 * 취소한 경우 둘 다 돌아간다). 그래서 목록을 보여 주고 사람이 고른다.
 *
 * 파일에는 사용자가 보낸 원문이 들어간다 — 이 레포는 공개이므로 커밋되지
 * 않게 `.gitignore` 에 넣어 둔다.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * **검사가 이 자리를 옮길 수 있어야 한다.** 자가 검사가 운영 파일에 그대로 쓰면
 * 밀린 요청이 있는 동안에는 검사를 못 돌린다 — 지우면 사용자가 보낸 원문이 날아가서
 * 지울 수도 없다. 그 검사가 푸시 전 관문에 걸려 있어서, **한도에 걸려 요청이 밀린
 * 동안에는 무관한 변경까지 푸시가 통째로 막힌다.** 2026-08-24 에 실제로 막혔다.
 */
const FILE = process.env.RATE_LIMIT_QUEUE_FILE
  || path.join(__dirname, '..', '.rate-limit-queue.json');

export interface QueuedRequest {
  id: string;
  /** 받은 시각 (epoch 초) — 목록에 「22:14」로 보여 준다 */
  ts: number;
  channel: string;
  threadTs: string;
  user: string;
  text: string;
}

interface QueueState {
  /** 한도가 풀리는 시각 (epoch 초). 이 시각에 사람에게 묻는다. */
  resetsAt: number | null;
  items: QueuedRequest[];
}

const EMPTY: QueueState = { resetsAt: null, items: [] };

function read(): QueueState {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return { resetsAt: s.resetsAt ?? null, items: Array.isArray(s.items) ? s.items : [] };
  } catch {
    return { ...EMPTY, items: [] };
  }
}

function write(state: QueueState): void {
  try {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    /* 안전망이라 실패해도 본 작업을 막지 않는다 — 대신 조용히 지나가지 않게
       부르는 쪽이 로그를 남긴다 */
  }
}

/**
 * 막힌 요청을 쌓는다.
 *
 * `resetsAt` 은 **더 늦은 쪽으로만** 민다. 여러 요청이 연달아 막히면 각자 조금씩
 * 다른 회복 시각을 들고 오는데, 이른 쪽을 잡으면 아직 안 풀린 채로 깨워 그
 * 자리에서 또 막힌다.
 *
 * @returns 이번이 첫 건인지 — 첫 건에만 안내를 올리고 나머지는 조용히 쌓는다
 */
export function enqueue(item: Omit<QueuedRequest, 'id' | 'ts'>, resetsAt: number | null):
    { id: string; first: boolean; size: number; resetsAt: number | null } {
  const s = read();
  const first = s.items.length === 0;
  const id = `rlq-${Date.now()}-${s.items.length}`;
  s.items.push({ ...item, id, ts: Math.floor(Date.now() / 1000) });
  if (resetsAt && (!s.resetsAt || resetsAt > s.resetsAt)) s.resetsAt = resetsAt;
  write(s);
  return { id, first, size: s.items.length, resetsAt: s.resetsAt };
}

export function peek(): QueueState {
  return read();
}

/** 꺼내면서 비운다 — 다시 막히면 그쪽에서 새로 쌓는다. */
export function takeAll(): QueuedRequest[] {
  const s = read();
  write({ resetsAt: null, items: [] });
  return s.items;
}

export function clear(): void {
  write({ resetsAt: null, items: [] });
}

/** 한 건만 뺀다 — 한도 안내에서 「취소」를 누른 경우. 안 빼면 회복 때 다시 뜬다. */
export function remove(id: string): void {
  const s = read();
  s.items = s.items.filter((it) => it.id !== id);
  if (s.items.length === 0) s.resetsAt = null;
  write(s);
}
