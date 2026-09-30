import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WebClient } from '@slack/web-api';
import { Logger } from './logger';
import { botOfToken, note, setRedactor } from './activity-log';

/**
 * **개인 글이 남에게·방으로 나가는 것을 슬랙으로 가는 마지막 길목에서 막는다.**
 *
 * 실장 2026-09-30: 「DM 이나 콩에게 전달한 말이 타인이나 채널에 공유되면 절대 안 됨」.
 * 그 전까지는 기능마다 제각각 조심하는 구조였다 — 커피콩·소인만 해도 슬랙으로 글을 보내는
 * 곳이 스무 군데가 넘고, 방 답을 보는 파이썬 빗장(`privacy_gate.py`)은 모델 답만 본다.
 * 한 곳에 버그가 나면 막을 것이 없었다. 그래서 **모든 호출이 지나는 한 곳**
 * (`WebClient.prototype.apiCall` — 활동 기록과 같은 길목)에 문을 둔다. 새 기능이 생겨도
 * 저절로 이 문을 지난다.
 *
 * ## 무엇을 막나
 *
 * 개인 글의 조각이 실린 글은 **실장 DM 과 그 글에 딸린 사람의 DM**(쓴 사람 · 칭찬을 받을
 * 사람)으로만 나간다. 방(공개·비공개)·여럿이 있는 DM·남의 DM 은 막는다. 조각의 기준은
 * 파이썬 빗장과 같다 — 이어진 10자(1:1 대화는 12자), 짧은 원문은 통째(8자 이상 · 넘긴 DM 과
 * 1on1 은 6자 이상). 두 겹이 서로 다른 자로 재면 한쪽만 고쳐진다.
 *
 * 개인 글 — 어디서 읽나(`bots/<봇>/data/`)
 *   1on1 신청의 편한 때·메모 · 커피챗 원문 · 칭찬 전달 머리 · 1:1 대화의 사람 말 ·
 *   명단 밖 DM 을 실장에게 넘긴 말(`rememberPrivate` — **원문 대신 지문만** 적는다)
 * **실장이 쓴 말은 뺀다** — 실장이 방에 올리라고 한 글(전할 말)이 실장 말에서 나온다.
 *
 * ## 지키는 것
 *
 *   1. **조각이 없으면 아무것도 안 한다** — 대부분의 호출은 여기서 끝난다(받는 곳도 안 묻는다).
 *   2. **조각이 있는데 받는 곳을 모르면 막는다** — 모르는 채로 내보내지 않는다.
 *      점검 자체가 넘어져도 실장 DM 말고는 막는다.
 *   3. **막은 글의 내용은 어디에도 안 적는다** — 로그·활동 기록·실장 알림 모두 「막았다」와
 *      봇·받는 곳·길만. 지문도 원문을 되살릴 수 없게 비밀 열쇠를 섞는다(HMAC).
 *   4. **창(모달)은 안 본다** — 창은 누른 사람에게만 보이고, 누가 눌렀는지는 이 길목에서 모른다.
 *      창을 여는 쪽이 누른 사람을 가린다(`/1on1-list` 는 실장만).
 *   5. **가장 바깥에 건다**(활동 기록 다음에 설치) — 막힌 글은 활동 기록에도 안 남는다.
 *
 * 이 문 밖에 있는 것 — 파이썬이 슬랙에 직접 보내는 셋(주간 한 조각 · 옛 아침 사례 ·
 * 커피챗 독려)은 정해진 글이나 골라 둔 통만 보낸다. 점심 모집 봇(`lunch-party`)도 따로 돈다.
 */

/** 이어진 글자 수 — 파이썬 빗장(`privacy_gate.NGRAM`·`NGRAM_DM`·`SHORT`)과 같게. */
const NGRAM = 10;
const NGRAM_DM = 12;
const SHORT = 8;
/** 넘긴 DM·1on1 은 짧아도 본다 — 「면담 요청드려요」 같은 말이 통째로 짧다. */
const SHORT_STRICT = 6;

/** 글을 남에게 보이게 하는 부름. 창(`views.*`)은 뺀다(위 4). */
const SEND = new Set([
  'chat.postMessage', 'chat.update', 'chat.postEphemeral', 'chat.scheduleMessage',
  'chat.meMessage', 'files.completeUploadExternal', 'files.upload',
]);

/** 같은 봇이 막힐 때마다 알리면 알림이 사고를 덮는다. 그 사이 막힌 것은 세어 두었다가 같이 적는다. */
const ALERT_GAP_MS = 10 * 60 * 1000;

export interface PrivacyGuardOptions {
  /** 실장 — 언제나 받을 수 있고, 막히면 알림을 받는다. 비면 문을 안 건다. */
  ownerUserId: string;
  /** `chatbot/bots` — 그 아래 봇마다 `data/` 의 기록을 읽는다. */
  botsDir: string;
  /** 넘긴 DM 의 지문을 적는 곳(원문 없음). */
  registryPath: string;
  /** 지문에 섞는 비밀 열쇠. 없으면 만든다. */
  keyPath: string;
}

type Index = Map<number, Map<string, Set<string>>>;   // 창 길이 → 지문 → 받을 수 있는 사람

const logger = new Logger('개인글문');
let opts: PrivacyGuardOptions | null = null;
let key: Buffer | null = null;
let index: Index = new Map();
let stamp = '';
const dmPerson = new Map<string, string>();
const lastAlert = new Map<string, number>();
const heldAlerts = new Map<string, number>();

const norm = (s: string): string => s.replace(/\s+/g, '');
const mac = (s: string): string => crypto.createHmac('sha256', key!).update(s).digest('base64url').slice(0, 22);

/** 글 하나를 지문들로. 길면 이어진 `n` 자 창마다, 짧으면 통째(창 길이 = 글 길이). */
function prints(text: string, n: number, short: number): [number, string][] {
  const t = norm(text);
  if (t.length >= n) {
    const out = new Set<string>();
    for (let i = 0; i + n <= t.length; i++) out.add(mac(t.slice(i, i + n)));
    return [...out].map((h) => [n, h]);
  }
  return t.length >= short ? [[t.length, mac(t)]] : [];
}

function put(ix: Index, pairs: [number, string][], allow: (string | undefined)[]): void {
  const who = allow.filter((u): u is string => typeof u === 'string' && u.length > 0);
  for (const [n, h] of pairs) {
    let m = ix.get(n);
    if (!m) ix.set(n, m = new Map());
    const cur = m.get(h);
    // 같은 조각이 여러 사람 글에 있으면 **그중 누구에게나** 보낼 수 있다 — 그 조각은 한 사람만의 것이 아니다.
    if (cur) for (const u of who) cur.add(u); else m.set(h, new Set(who));
  }
}

function rows(file: string): any[] {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // **망가진 줄 하나 때문에 파일 전체를 못 읽으면 안 된다** — 그 줄만 건너뛴다.
    try { out.push(JSON.parse(line)); } catch { /* 건너뜀 */ }
  }
  return out;
}

function dataDirs(): string[] {
  if (!opts) return [];
  try {
    return fs.readdirSync(opts.botsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(opts!.botsDir, d.name, 'data'))
      .filter((d) => fs.existsSync(d));
  } catch {
    return [];
  }
}

const SOURCES = ['1on1.jsonl', 'coffeechat.jsonl', 'relay.jsonl', 'turns.jsonl'];

/** 기록이 바뀌었으면 지문을 다시 만든다. 바뀐 것은 크기·수정 시각으로 본다. */
function refresh(): void {
  if (!opts) return;
  const files = [...dataDirs().flatMap((d) => SOURCES.map((f) => path.join(d, f))), opts.registryPath];
  const sig = files.map((f) => {
    try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:-`; }
  }).join('|');
  if (sig === stamp) return;

  const owner = opts.ownerUserId;
  const ix: Index = new Map();
  for (const dir of dataDirs()) {
    for (const r of rows(path.join(dir, '1on1.jsonl'))) {
      if (!r?.user || r.user === owner) continue;
      for (const k of ['note', 'when']) {
        if (typeof r[k] === 'string') put(ix, prints(r[k], NGRAM, SHORT_STRICT), [r.user]);
      }
    }
    for (const r of rows(path.join(dir, 'coffeechat.jsonl'))) {
      if (typeof r?.text !== 'string' || r.from === owner) continue;
      put(ix, prints(r.text, NGRAM, SHORT), [r.from, r.to]);
    }
    for (const r of rows(path.join(dir, 'relay.jsonl'))) {
      if (typeof r?.head === 'string') put(ix, prints(r.head, NGRAM, SHORT), [r.to]);
    }
    for (const r of rows(path.join(dir, 'turns.jsonl'))) {
      // 1:1 대화만(열쇠가 사람 ID). 주간 턴은 비밀이 아니다(파이썬 빗장 `dm_texts` 와 같은 이유).
      const who = String(r?.key ?? '');
      if (!/^[UW]/.test(who) || who === owner || r.initiate || typeof r.text !== 'string') continue;
      put(ix, prints(r.text, NGRAM_DM, SHORT), [who]);
    }
  }
  for (const r of rows(opts.registryPath)) {
    if (Array.isArray(r?.w)) put(ix, r.w, Array.isArray(r.allow) ? r.allow : []);
  }
  index = ix;
  stamp = sig;
}

/** 나가는 글에서 사람이 읽을 말을 모은다(글 · 블록 · 첨부 · 파일 설명). */
function readable(o: any): string {
  const out: string[] = [];
  const walk = (v: any): void => {
    if (!v) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(o?.text); walk(o?.blocks); walk(o?.attachments); walk(o?.initial_comment);
  return out.join('\n');
}

/** 이 글에 걸린 조각들 — 조각마다 받을 수 있는 사람. 비면 개인 글이 안 실린 것이다. */
function hits(text: string): Set<string>[] {
  const t = norm(text);
  const out: Set<string>[] = [];
  for (const [n, m] of index) {
    for (let i = 0; i + n <= t.length; i++) {
      const who = m.get(mac(t.slice(i, i + n)));
      if (who) out.push(who);
    }
  }
  return out;
}

/** 이 글을 볼 사람들. 방·여럿이면 `null`(누구인지 못 가림). */
async function viewers(client: any, call: Function, method: string, o: any): Promise<string[] | null> {
  if (method === 'chat.postEphemeral') return o?.user ? [String(o.user)] : null;
  const ch = String(o?.channel ?? o?.channel_id ?? '');
  if (/^[UW]/.test(ch)) return [ch];
  if (!ch.startsWith('D')) return null;
  const known = dmPerson.get(ch);
  if (known) return [known];
  try {
    const res: any = await call.call(client, 'conversations.info', { channel: ch });
    const person = res?.channel?.user;
    if (typeof person !== 'string') return null;
    dmPerson.set(ch, person);
    return [person];
  } catch {
    return null;
  }
}

function blocked(): Error {
  const e: any = new Error('privacy_blocked: 개인 글 조각이 든 글이라 보내지 않았습니다');
  e.code = 'slack_webapi_platform_error';
  e.data = { ok: false, error: 'privacy_blocked' };
  return e;
}

async function alertOwner(client: any, call: Function, bot: string, where: string, method: string): Promise<void> {
  const owner = opts?.ownerUserId;
  if (!owner) return;
  const now = Date.now();
  if (now - (lastAlert.get(bot) ?? 0) < ALERT_GAP_MS) {
    heldAlerts.set(bot, (heldAlerts.get(bot) ?? 0) + 1);
    return;
  }
  const held = heldAlerts.get(bot) ?? 0;
  lastAlert.set(bot, now);
  heldAlerts.set(bot, 0);
  try {
    const im: any = await call.call(client, 'conversations.open', { users: owner });
    if (!im?.channel?.id) return;
    await call.call(client, 'chat.postMessage', {
      channel: im.channel.id,
      text: `:no_entry: *${bot}* 이(가) 개인 글 조각이 든 글을 ${where} 에 보내려다 막혔습니다 (\`${method}\`).\n`
        + (held ? `_(앞 알림 뒤로 ${held}번 더 막혔습니다)_\n` : '')
        + '_내용은 어디에도 적지 않았습니다. 같은 일이 되풀이되면 그 기능을 봐야 합니다._',
    });
  } catch (error) {
    logger.warn('막았다는 알림을 못 보냈습니다', error);
  }
}

/**
 * 문 — 보내도 되면 그냥 돌아오고, 안 되면 던진다(부르는 쪽은 보내기 실패로 받는다).
 * `call` 은 문 안쪽의 원래 길(활동 기록이 감싼 것)이다.
 */
async function gate(client: any, call: Function, method: string, o: any): Promise<void> {
  const owner = opts?.ownerUserId ?? '';
  let found: Set<string>[];
  try {
    refresh();
    found = hits(readable(o));
  } catch (error) {
    // 점검이 넘어졌다 — 모르는 채로 내보내지 않는다. 실장 DM 만 연다.
    logger.warn('문 점검이 넘어졌습니다 — 실장 DM 말고는 막습니다', error);
    found = [new Set<string>()];
  }
  if (!found.length) return;

  const who = await viewers(client, call, method, o);
  const ok = who !== null && who.length > 0
    && who.every((u) => u === owner || found.every((allow) => allow.has(u)));
  if (ok) return;

  const bot = botOfToken(client?.token);
  const ch = String(o?.channel ?? o?.channel_id ?? '');
  const where = who === null ? (ch.startsWith('D') ? '누구인지 모를 DM' : `방(<#${ch}>)`) : '다른 사람 DM';
  logger.warn(`막음 — ${bot} · ${method} · ${where} · 조각 ${found.length}곳`);
  note(bot, '막음', { 어디: ch, 무엇: method, 글자수: readable(o).length, 왜: '개인 글 조각' });
  await alertOwner(client, call, bot, where, method);
  throw blocked();
}

/**
 * 명단 밖 DM 을 실장에게 넘길 때 그 말을 **지문으로** 적어 둔다 — 그 뒤로 그 말은 실장과
 * `allow` 에게만 나간다. 원문은 어디에도 안 남긴다. 문이 안 걸려 있으면 아무것도 안 한다.
 */
export function rememberPrivate(text: string, allow: string[]): void {
  if (!opts || !key) return;
  try {
    const w = prints(text, NGRAM, SHORT_STRICT);
    if (!w.length) return;
    fs.mkdirSync(path.dirname(opts.registryPath), { recursive: true });
    fs.appendFileSync(opts.registryPath, `${JSON.stringify({ at: new Date().toISOString(), allow, w })}\n`, 'utf-8');
    put(index, w, allow);   // 파일을 다시 읽기 전에도 바로 막히게
  } catch (error) {
    logger.warn('넘긴 말의 지문을 못 적었습니다', error);
  }
}

function loadKey(file: string): Buffer {
  try {
    const hex = fs.readFileSync(file, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* 없으면 만든다 */ }
  const fresh = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    // 못 적으면 이번 실행만 이 열쇠로 — 앞서 적은 지문은 안 맞지만 1on1·커피챗은 기록에서 다시 만든다.
    logger.warn('지문 열쇠를 못 적었습니다 — 이번 실행만 임시 열쇠를 씁니다', error);
  }
  return fresh;
}

/** 문을 건다. **활동 기록(`installActivityLog`) 다음에** 부른다 — 그래야 가장 바깥이다. */
export function installPrivacyGuard(o: PrivacyGuardOptions): void {
  if (opts) return;
  if (!o.ownerUserId) {
    logger.warn('실장 ID 가 없어 개인 글 문을 걸지 않습니다');
    return;
  }
  opts = o;
  key = loadKey(o.keyPath);
  const call = WebClient.prototype.apiCall;
  WebClient.prototype.apiCall = async function guarded(this: any, method: string, options?: any) {
    if (SEND.has(method)) await gate(this, call, method, options);
    return call.call(this, method, options);
  } as typeof call;
  refresh();
  // 활동 기록도 같은 자로 가린다 — 개인 글 조각이 든 말은 원문 대신 글자 수만 남는다.
  setRedactor({ owner: o.ownerUserId, isPrivate: containsPrivate });
  const n = [...index.values()].reduce((a, m) => a + m.size, 0);
  logger.info(`개인 글 문을 걸었습니다 — 지문 ${n}개 · 실장 DM·본인 DM 말고는 막음 · 활동 기록도 가림`);
}

/** 이 글에 개인 글 조각이 들어 있나(누구에게 보내는지는 안 따진다) — 활동 기록 가림과 옛 기록 정리에 쓴다. */
export function containsPrivate(text: string): boolean {
  if (!opts || !text) return false;
  refresh();
  return hits(text).length > 0;
}

/** 시험 전용 — 기록을 다시 읽게 한다. */
export function reloadForTest(): void {
  stamp = '';
  refresh();
}
