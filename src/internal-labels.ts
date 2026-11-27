/**
 * 세나 DM 답에 섞인 내부 번호(물음, 사고, 판단, 예약, 지시와 커밋 번호)를 슬랙에 올리기 전에 붙잡고, 같은 차례 안에서
 * 세나가 풀어서 다시 쓰게 한다(2026-11-23 · 사고 ic-20261123-4).
 *
 * **왜** — 17:09 답 「답 대기에 `q-1123-mistake-rule`로 걸어 뒀어요」를 실장님이 못 알아들으셔서 되물으셨다. 정체성의
 * 「알아듣게 전한다」(11/11)가 이미 막던 일이라 글로는 안 지켜진다 — 기계로 옮긴다.
 *
 * **어떻게 — 둘이 짝이다**
 *   - 봇(`slack-handler.ts`)은 사람이 친 DM 차례에서 번호가 든 글을 올리지 않고 `noteText` 로 여기 맡긴다
 *   - 세나 세션이 멈추려 할 때 `labelStopHook`(SDK Stop 훅)이 맡긴 글을 보고 `decision: 'block'` 으로 돌려보낸다 —
 *     세나는 **같은 차례 안에서** 다시 쓰고, 그 글이 평소처럼 올라간다. 새 차례도, 새 캡처도, 따로 부르는 모델도 없다
 *   - 다시 쓴 글에도 번호가 남았거나 훅이 못 돌았으면 차례 끝 `finishTurn` 이 맡긴 글을 돌려줘 그대로 올린다 —
 *     **답을 잃는 것보다 번호가 나가는 것이 낫다**(지금까지와 같은 모양)
 *
 * **겨루기(race)** — 훅은 SDK 가 따로 부르므로 봇이 마지막 글을 아직 안 읽었을 수 있다. 훅은 `last_assistant_message` 를
 * 봇이 읽을 때까지 잠깐(`SEEN_WAIT_MS`) 기다린 뒤 판정한다. 그래도 못 읽었으면 그 글만 보고 판정한다.
 *
 * **모양의 정본은 업무 비서 레포 `bin/sena_labels.json`** — 서랍 답(`sena_drawer.py reply`)도 같은 파일로 거른다. 못 읽으면
 * 아무것도 안 붙잡는다(대화는 그대로 돈다).
 *
 * **안 붙잡는 차례** — 실장님 말에 「번호」, 「근거」, 「id」가 있거나(정체성 「근거를 물으시면 그때 번호를 댄다」) 그 번호를
 * 직접 쓰셨을 때, 봇이 넘긴 차례(판, 메일), 서랍 차례, 채널. 장부 낱말(답 대기, 장부)은 보통 말과 겹쳐 안 센다 — 돌려보내는
 * 안내와 정체성이 맡는다. 끄는 문은 `.env` 의 `LABEL_GUARD=off`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from './logger';
import { workAssistantRoot } from './work-assistant';

const logger = new Logger('InternalLabels');

interface Rules {
  patterns: Array<{ name: string; re: RegExp }>;
  strip: RegExp[];
  ask: RegExp;
}

let rulesOverride: string | null = null;
let cache: { file: string; stamp: number; rules: Rules } | null = null;
let warned = false;

/** 시험 전용 — 정본 파일 위치를 바꿔 끼운다(null 이면 업무 비서 레포). */
export function setRulesFileForTest(file: string | null): void {
  rulesOverride = file;
  cache = null;
}

function rulesFile(): string | null {
  if (rulesOverride) return rulesOverride;
  const root = workAssistantRoot();
  return root ? path.join(root, 'bin', 'sena_labels.json') : null;
}

function loadRules(): Rules | null {
  const file = rulesFile();
  if (!file) return null;
  try {
    const stamp = fs.statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.stamp === stamp) return cache.rules;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const rules: Rules = {
      patterns: raw.patterns.map((p: any) => ({ name: String(p.name), re: new RegExp(p.re, 'g') })),
      strip: raw.strip.map((s: string) => new RegExp(s, 'g')),
      ask: new RegExp(raw.ask),
    };
    cache = { file, stamp, rules };
    return rules;
  } catch (error) {
    if (!warned) { warned = true; logger.warn('내부 번호 정본을 못 읽어 답을 거르지 않습니다', { file, error: String(error) }); }
    return null;
  }
}

/** 글에 든 내부 번호 — 나온 순서, 같은 번호는 한 번. 실장님 말(`question`)이 번호를 묻거나 그 번호를 쓰셨으면 뺀다. */
export function findLabels(text: string, question = ''): string[] {
  const r = loadRules();
  if (!r || !text) return [];
  if (question && r.ask.test(question)) return [];
  let body = text;
  for (const s of r.strip) body = body.replace(s, ' ');
  const hits: Array<[number, string]> = [];
  const seen = new Set<string>();
  for (const p of r.patterns) {
    p.re.lastIndex = 0;
    for (const m of body.matchAll(p.re)) {
      const label = m[0].replace(/^`|`$/g, '');
      if (seen.has(label) || (question && question.includes(label))) continue;
      if ([...seen].some((s) => s.includes(label))) continue;
      seen.add(label);
      hits.push([m.index ?? 0, label]);
    }
  }
  return hits.sort((a, b) => a[0] - b[0]).map(([, l]) => l);
}

/** 이 차례에 거를까 — 사람이 친 DM 이고 번호를 묻는 말이 아닐 때. */
export function wantGuard(o: { isDM: boolean; pushed: boolean; drawer: boolean; userText: string }): boolean {
  if (process.env.LABEL_GUARD === 'off') return false;
  if (!o.isDM || o.pushed || o.drawer) return false;
  const r = loadRules();
  return !!r && !r.ask.test(o.userText || '');
}

interface Guard {
  question: string;
  held: string[];
  seen: Set<string>;
  /** 훅이 돌려보낸 글 — 차례 끝에 이것은 안 올린다 */
  covered: Set<string> | null;
}

const guards = new Map<string, Guard>();
const norm = (t: string) => (t || '').trim();

/** 훅이 봇이 마지막 글을 읽기를 기다리는 시간 */
export const SEEN_WAIT_MS = 1500;

/**
 * 봇이 읽은 세나 글 하나 — `'post'` 면 평소대로 올리고 `'hold'` 면 올리지 않는다.
 * `want` 가 거짓이면 늘 `'post'`(거르지 않는 차례).
 */
export function noteText(sessionId: string, text: string, want: boolean, question = ''): 'post' | 'hold' {
  if (!want || !sessionId) return 'post';
  let g = guards.get(sessionId);
  if (!g) { g = { question, held: [], seen: new Set(), covered: null }; guards.set(sessionId, g); }
  const t = norm(text);
  g.seen.add(t);
  // 훅이 봇보다 먼저 읽고 돌려보낸 글이 뒤늦게 오면 올리지 않는다(머리말 「겨루기」)
  if (g.covered?.has(t)) return 'hold';
  // 돌려보낸 뒤의 글(다시 쓴 답)은 그대로 올린다 — 또 붙잡으면 다시 돌려보낼 길이 없어 답을 잃는다
  if (g.covered) return 'post';
  if (!findLabels(t, g.question).length) return 'post';
  g.held.push(t);
  logger.info('세나 답에 내부 번호 — 올리지 않고 다시 쓰게 함', { labels: findLabels(t, g.question) });
  return 'hold';
}

/** 붙잡은 글이 중간 글이었다(뒤에 도구 호출이 옴, `interim-text.ts`) — 다시 쓰게 하지도, 차례 끝에 올리지도 않는다. */
export function forgetHeld(sessionId: string, text: string): void {
  const g = guards.get(sessionId);
  if (!g) return;
  const t = norm(text);
  g.held = g.held.filter((h) => h !== t);
}

/** 차례 끝 — 훅이 돌려보내지 못한 붙잡은 글(그대로 올릴 것)을 돌려주고 이 세션의 기록을 지운다. */
export function finishTurn(sessionId: string): string[] {
  const g = guards.get(sessionId);
  guards.delete(sessionId);
  if (!g) return [];
  return g.held.filter((t) => !g.covered?.has(t));
}

function rewriteReason(held: string[], labels: string[]): string {
  return [
    '[봇 점검] 방금 실장님께 쓴 답이 슬랙에 아직 안 나갔어요 — 내부 번호(' + labels.join(', ') + ')가 그대로 들어 있어서 봇이 붙잡았어요.',
    '실장님은 이 번호를 모르세요(정체성 「알아듣게 전한다」, 사고 ic-20261123-4). 같은 답을 번호와 장부 말(답 대기, 장부, 갈래 같은 것) 없이',
    '「무엇이 어떻게 됐고 실장님 쪽에서 무엇이 달라지나」로 풀어 처음부터 다시 써 주세요. 다시 쓴 답만 나갑니다.',
    '이미 한 일(명령, 기록)은 다시 하지 않아요. 이 점검 얘기는 답에 쓰지 않아요.',
    '',
    '붙잡은 답:',
    ...held.map((t) => `---\n${t}`),
    '---',
  ].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SDK Stop 훅 — 붙잡은 글이 있으면 한 번 돌려보낸다. 거르지 않는 세션이거나 이미 돌려보냈으면 그냥 멈추게 둔다. */
export async function labelStopHook(input: any): Promise<Record<string, unknown>> {
  try {
    if (input?.hook_event_name !== 'Stop' || input?.stop_hook_active) return {};
    const g = guards.get(input.session_id);
    if (!g || g.covered) return {};
    const last = norm(input.last_assistant_message ?? '');
    // 봇이 마지막 글을 아직 안 읽었으면 잠깐 기다린다(머리말 「겨루기」)
    for (let waited = 0; last && !g.seen.has(last) && waited < SEEN_WAIT_MS; waited += 50) await sleep(50);
    const held = [...g.held];
    if (last && !g.seen.has(last) && findLabels(last, g.question).length) held.push(last);
    if (!held.length) return {};
    g.covered = new Set(held);
    const labels = [...new Set(held.flatMap((t) => findLabels(t, g.question)))];
    return { decision: 'block', reason: rewriteReason(held, labels) };
  } catch (error) {
    logger.warn('내부 번호 훅 실패 — 그냥 멈추게 둡니다', { error: String(error) });
    return {};
  }
}

/** 대화 세션 옵션에 얹을 훅 — 늘 같은 객체라 미리 띄우기 지문이 안 흔들린다. */
export const LABEL_HOOKS = { Stop: [{ hooks: [labelStopHook] }] };
