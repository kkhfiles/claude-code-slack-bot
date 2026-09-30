import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { Logger } from './logger';

/**
 * 봇이 한 일을 **로컬 파일에 남긴다.** 디버그 로그가 아니라 활동 기록이다.
 *
 * 왜 만들었나 — 「점심봇이 허락 안 한 방에 불렸다」를 되짚는 데 하루가 걸렸다.
 * pm2 표준출력 19MB 안에 SDK 오류·소켓 핑·bolt 경고가 뒤섞여 있었고, 정작
 * **봇이 무엇을 했는지는 거의 안 남아 있었다.** 그래서 알아낸 것도 두 번 틀렸다.
 *
 * ## 손으로 박지 않고 길목을 감싼다
 *
 * 발화 지점마다 기록 호출을 넣으면 **다음에 생기는 발화 지점이 빠진다.** 그래서
 * 길목 두 곳만 감싼다.
 *
 *   나가는 말  `WebClient.prototype.apiCall` — 슬랙으로 가는 모든 호출이 여기를 지난다.
 *              어느 모듈이 어떤 client 로 부르든 잡힌다(실측 확인).
 *   들어오는 말 `App.prototype.processEvent` — 모든 이벤트가 여기로 들어온다.
 *              App 을 새로 만드는 자리가 늘어도 그대로 잡힌다.
 *
 * 판단(물러섬·거절처럼 아무 호출도 안 하고 끝나는 것)만 그 자리에서 `note()` 로 남긴다.
 * 슬랙에 아무 흔적이 안 남는 일이라 길목으로는 안 잡힌다.
 *
 * ## 지켜야 하는 것
 *
 *   1. **절대 던지지 않는다.** 여기서 넘어지면 봇이 말을 못 한다. 전부 삼킨다.
 *   2. **토큰을 적지 않는다.** 남는 것은 사람이 읽을 말과 어디로 갔는지까지다.
 *   3. **달마다 파일을 가른다.** 지울 때 파일째 지운다. 실원이 봇에게 한 말과 개인 글 조각은
 *      2026-09-30 부터 원문 대신 글자 수만 남는다(`scrub`) · 폴더는 작업 공간 밖에 둔다.
 *   4. **이 폴더를 `context_files` 에 넣지 않는다.** 거기 들어가면 사적인 대화가
 *      모델 프롬프트로 나간다. 폴더에 그 경고를 파일로 두고 온다.
 *   5. 자리(`BOT_ACTIVITY_DIR`)가 없으면 **안 남기고 그렇다고 말한다.** 개인 대화가
 *      쌓이는 파일이라 아무 데나 기본값으로 만들지 않는다.
 */

const DIR = process.env.BOT_ACTIVITY_DIR || '';
const logger = new Logger('활동기록');

/** 되짚을 것이 없는 순수 조회. **막을 것만 적는다** — 새 동작이 생기면 저절로 남게. */
const SKIP = new Set([
  'auth.test', 'users.info', 'users.list', 'conversations.info', 'conversations.list',
  'conversations.history', 'conversations.replies', 'conversations.members',
  'apps.connections.open', 'emoji.list', 'team.info', 'usergroups.list',
  'chat.scheduledMessages.list', 'chat.scheduledMessages',
]);

const byToken = new Map<string, string>();
const byApp = new WeakMap<App, string>();
let installed = false;

/** 이 토큰으로 나가는 말은 이 봇 것이다. 모르는 토큰은 `?` 로 남는다(사라지지 않는다). */
export function tagToken(token: string | undefined, bot: string): void {
  if (token) byToken.set(token, bot);
}

/** 이 토큰이 어느 봇 것인가(개인 글 문이 막은 것을 적을 때). 모르면 `?`. */
export function botOfToken(token: string | undefined): string {
  return byToken.get(token ?? '') ?? '?';
}

/** 이 App 으로 들어오는 말은 이 봇 것이다. */
export function tagApp(app: App, bot: string): void {
  byApp.set(app, bot);
}

/** 이 봇이 **맡은 방**. 여기 없는 방의 말은 원문을 안 남긴다(아래 `inbound` 참조). */
const byBotRooms = new Map<string, Set<string>>();

/**
 * 이 봇이 맡은 방을 알려 준다. **안 알려 주면 그 봇은 아무 방도 안 맡은 것으로 본다** —
 * 모르는 쪽으로 기울일 때 안 남기는 편이 맞다.
 */
export function tagRooms(bot: string, channels: (string | undefined)[]): void {
  const set = byBotRooms.get(bot) ?? new Set<string>();
  for (const c of channels) if (c) set.add(c);
  byBotRooms.set(bot, set);
}

/**
 * 이 방의 말을 원문으로 남겨도 되나.
 *
 * **구독을 켜면 우리가 안 맡은 방의 말까지 들어온다**(2026-08-27 실측: 한 봇이 무관한
 * 업무 방 110건을 그대로 적고 있었다). 남의 방 대화는 우리 디스크에 쌓일 것이 아니다.
 * 1:1 은 우리에게 건 말이라 남긴다.
 */
function mayKeepText(bot: string, channel: unknown): boolean {
  const ch = String(channel ?? '');
  if (!ch) return false;
  if (ch.startsWith('D')) return true;                 // 1:1 — 우리에게 건 말
  return byBotRooms.get(bot)?.has(ch) ?? false;
}

/**
 * 남길 줄에서 **안 맡은 방의 원문을 걷어낸다.** 자리에 두면 못 재는 판단이라 떼어냈다 —
 * 틀려도 오류가 안 나고 조용히 남의 대화가 쌓일 뿐이다.
 *
 * 우리를 부른 것(`부름받음`)·슬래시 명령·버튼은 **우리에게 건 말이라 그대로 남긴다.**
 * 그냥 오간 말(`들음`)만 맡은 방인지 따진다.
 */
export function redactForeign(
  bot: string, kind: string, rest: Record<string, unknown>,
): Record<string, unknown> {
  if (kind !== '들음' || mayKeepText(bot, rest.어디)) return rest;
  const out: Record<string, unknown> = {
    ...rest, 글자수: String(rest.말 ?? '').length, 왜: '안 맡은 방 — 원문은 안 남긴다' };
  delete out.말;
  return out;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 개인 글을 가리는 기준 — 개인 글 문(`privacy-guard.ts`)이 걸릴 때 넘겨준다(서로를 import 하면
 * 고리가 생겨서 이쪽은 받기만 한다). 안 걸려 있으면 `null` — 그때는 DM 을 전부 가린다(아래).
 */
let redactor: { owner: string; isPrivate: (text: string) => boolean } | null = null;
export function setRedactor(r: { owner: string; isPrivate: (text: string) => boolean } | null): void {
  redactor = r;
}

/** 사람에게 온 말(DM·부름·명령)인가 — 나가는 말(`보냄`)·판단은 아니다. */
const HEARD = new Set(['들음', '부름받음', '명령']);

/**
 * 명단 밖 DM 을 실장에게 넘기는 글의 머리말(`chat-host.ts` 가 이것으로 글을 만든다). **이 머리말이
 * 든 글은 통째로 가린다** — 넘긴 말이 짧으면(여섯 자 아래) 지문을 안 남겨 조각으로는 못 잡는다.
 */
export const FORWARD_HEAD = '님이 저에게 보낸 말이에요';

/**
 * DM 방 → 그 방의 사람. 들어온 DM 에서 배운다. **실원 DM 방으로 나간 봇의 답도 가린다** — 1:1 대화의
 * 봇 답에는 그 사람 사정이 실린다(파이썬 빗장 `dm_texts` 가 봇 답까지 넣는 것과 같은 이유).
 */
const dmOwner = new Map<string, string>();
export function rememberDmOwner(channel: string, user: string): void {
  if (channel.startsWith('D') && user) dmOwner.set(channel, user);
}

/**
 * **실원이 봇에게 한 말과 개인 글 조각이 든 글은 원문을 안 남긴다**(실장 2026-09-30 「가리고
 * 옮기기」 — 「DM 이나 콩에게 전달한 말이 타인이나 채널에 공유되면 절대 안 됨」). 글자 수와 까닭만.
 *   - 실장이 아닌 사람이 DM 으로 한 말 · 슬래시 명령 뒤에 적은 말
 *   - 들어오든 나가든 개인 글(1on1·커피챗·칭찬·1:1 대화·넘긴 DM)의 조각이 든 말
 * 실장 자신의 DM 과 봇이 방에 쓴 말은 그대로 둔다 — 봇이 무엇을 했는지 되짚는 것이 이 기록의 일이다.
 * 가림 기준이 아직 없으면(문이 안 걸림) DM 은 누구 것이든 가린다 — 모르면 안 남긴다.
 */
export function scrub(kind: string, detail: Record<string, unknown>): Record<string, unknown> {
  const said = detail.말;
  if (typeof said !== 'string' || !said) return detail;
  const where = String(detail.어디 ?? '');
  const who = String(detail.누가 ?? '');
  if (HEARD.has(kind)) rememberDmOwner(where, who);
  const fromPerson = HEARD.has(kind) && (where.startsWith('D') || kind === '명령')
    && (!redactor || who !== redactor.owner);
  const owner = dmOwner.get(where);
  const toPersonDm = !HEARD.has(kind) && where.startsWith('D') && !!owner && (!redactor || owner !== redactor.owner);
  let why = fromPerson ? '실원이 봇에게 한 말'
    : said.includes(FORWARD_HEAD) ? '실장에게 넘긴 실원 DM'
      : toPersonDm ? '실원 DM 방에 보낸 봇의 말' : '';
  if (!why) {
    try { if (redactor?.isPrivate(said)) why = '개인 글 조각'; } catch { why = '개인 글 점검 실패'; }
  }
  if (!why) return detail;
  const { 말: _drop, ...rest } = detail;
  return { ...rest, 글자수: said.length, 가림: `${why} — 원문은 안 남긴다` };
}

/** 한 줄 적는다. **여기서 넘어져도 부르는 쪽은 모른다.** */
export function note(bot: string, kind: string, detail: Record<string, unknown> = {}): void {
  if (!DIR) return;
  try {
    const now = new Date();
    const file = path.join(DIR, `${bot || '?'}-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`);
    const row = { at: stamp(now), bot: bot || '?', kind, ...scrub(kind, detail) };
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf-8');
  } catch {
    // 기록을 못 남긴다고 봇이 멈추면 안 된다.
  }
}

/**
 * 블록·첨부 안에 흩어진 사람이 읽을 말을 모은다.
 *
 * `text` 만 적으면 커피챗처럼 **본문이 첨부에 들어가는 글이 통째로 안 남는다** —
 * 알림 미리보기 한 줄만 남고 정작 무엇을 보냈는지는 사라진다.
 */
function readable(opts: any): string {
  const out: string[] = [];
  const walk = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v.text === 'string') out.push(v.text);
    else if (v.text) walk(v.text);
    for (const k of ['blocks', 'attachments', 'elements', 'view']) if (v[k]) walk(v[k]);
  };
  if (typeof opts?.text === 'string') out.push(opts.text);
  walk(opts?.blocks); walk(opts?.attachments); walk(opts?.view);
  return [...new Set(out)].join('\n').trim();
}

function inbound(body: any): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  // 슬래시 명령
  if (body.command) {
    return { kind: '명령', 누가: body.user_id, 어디: body.channel_id,
             무엇: body.command, 말: String(body.text ?? '').trim() };
  }
  // 버튼·창 제출
  if (body.type === 'block_actions' || body.type === 'view_submission') {
    const act = body.actions?.[0];
    return { kind: body.type === 'view_submission' ? '창 제출' : '버튼',
             누가: body.user?.id, 어디: body.channel?.id ?? '',
             무엇: act?.action_id ?? body.view?.callback_id ?? '', 말: '' };
  }
  // 이벤트(메시지·멘션)
  const e = body.event;
  if (e) {
    if (e.bot_id || e.subtype === 'bot_message') return null;   // 우리 말이 되돌아온 것
    return { kind: e.type === 'app_mention' ? '부름받음' : '들음',
             누가: e.user, 어디: e.channel, 무엇: e.type,
             말: e.text ?? '', 스레드: e.thread_ts };
  }
  return null;
}

/** 길목 두 곳을 감싼다. **한 번만 부른다.** */
export function installActivityLog(): void {
  if (installed) return;
  installed = true;

  if (!DIR) {
    logger.warn('BOT_ACTIVITY_DIR 이 없어 활동 기록을 남기지 않습니다 — .env 에 자리를 적어 주세요');
    return;
  }
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const guard = path.join(DIR, '읽기전.md');
    if (!fs.existsSync(guard)) {
      fs.writeFileSync(guard,
        '# 봇 활동 기록\n\n'
        + '봇이 주고받은 말이 쌓입니다. **실원이 봇에게 한 말과 개인 글 조각은 원문 대신 글자 수만**\n'
        + '남습니다(2026-09-30부터 · 그 전 기록도 같은 꼴로 가렸습니다).\n\n'
        + '- **이 폴더를 작업 공간(Claude·Codex 가 도는 폴더) 안에 두지 마세요.** 넓게 찾다가 모델로 들어갑니다.\n'
        + '- **이 폴더를 봇 설정의 `context_files` 에 넣지 마세요.** 거기 넣으면 이 내용이\n'
        + '  모델 프롬프트로 나갑니다.\n'
        + '- **원격 저장소에 올리지 마세요.** 여기는 일부러 git 저장소 바깥입니다.\n'
        + '- 지울 때는 달 단위 파일째 지웁니다.\n'
        + '- **봇이 맡지 않은 방의 말은 원문이 안 남습니다**(2026-08-27부터). 몇 시에\n'
        + '  어느 방에서 몇 글자였는지만 남습니다. 그 전 기록에는 원문이 들어 있습니다.\n',
        'utf-8');
    }
  } catch (error) {
    logger.warn('활동 기록 폴더를 못 만들었습니다', error);
    return;
  }

  // ── 나가는 말 ────────────────────────────────────────────────────────
  const origCall = WebClient.prototype.apiCall;
  WebClient.prototype.apiCall = function patched(this: any, method: string, options?: any) {
    const done = origCall.call(this, method, options);
    if (!SKIP.has(method)) {
      const bot = byToken.get(this?.token ?? '') ?? '?';
      const said = readable(options);
      Promise.resolve(done).then(
        (res: any) => note(bot, '보냄', {
          어디: options?.channel ?? options?.user ?? '', 무엇: method,
          말: said, 잘됨: res?.ok !== false,
        }),
        (error: any) => note(bot, '못 보냄', {
          어디: options?.channel ?? options?.user ?? '', 무엇: method,
          말: said, 왜: String(error?.data?.error ?? error?.message ?? error).slice(0, 200),
        }),
      );
    }
    return done;
  } as typeof origCall;

  // ── 들어오는 말 ──────────────────────────────────────────────────────
  const origProcess = App.prototype.processEvent;
  App.prototype.processEvent = function patched(this: App, event: any) {
    try {
      const row = inbound(event?.body);
      if (row) {
        const { kind, ...rest } = row as any;
        const bot = byApp.get(this) ?? '?';
        note(bot, kind, redactForeign(bot, kind, rest));
      }
    } catch {
      // 기록 때문에 들어온 말을 놓치면 안 된다.
    }
    return origProcess.call(this, event);
  } as typeof origProcess;

  logger.info(`활동 기록을 남깁니다 → ${DIR}`);
}
