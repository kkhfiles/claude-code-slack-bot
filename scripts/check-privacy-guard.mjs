/**
 * 개인 글 문(`privacy-guard.ts`)을 슬랙 없이 확인한다.
 *
 *     npm run build && npm run check:privacy
 *
 * 실장 2026-09-30 「DM 이나 콩에게 전달한 말이 타인이나 채널에 공유되면 절대 안 됨」.
 * 여기서 세는 것은 셋이다.
 *
 *   1. **막아야 할 것을 막나** — 개인 글 조각이 방·남의 DM 으로 가는 것
 *   2. **막지 말아야 할 것을 통과시키나** — 본인·받을 사람·실장 DM · 실장이 쓴 말 · 조각 없는 글
 *   3. **문을 돌아가는 길이 생기지 않았나** — 소스를 읽어 센다(새 코드가 문을 우회하면 여기서 실패)
 *
 * 기록 파일은 임시 폴더에만 쓴다 — 운영 기록을 절대 건드리지 않는다. 슬랙으로는 아무것도 안 나간다
 * (`apiCall` 을 가짜로 바꿔 끼운 뒤에 문을 건다 — 운영과 같은 순서로 바깥에 걸린다).
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

process.env.BOT_ACTIVITY_DIR = '';          // 활동 기록은 안 남긴다(운영 폴더에 시험 글이 쌓이면 안 된다)
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { WebClient } = require('@slack/web-api');

let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) fail++;
};

// ── 시험 자료 ──────────────────────────────────────────────────────────────
const BOSS = 'UBOSS';
const NOTE_A = '팀장님과 따로 얘기하고 싶은 게 있어요 사정이 좀 있어서';
const SHORT_B = '면담요청드려요';
const NOTE_BOSS = '다음 주 오후 아무 때나 괜찮습니다 시험입니다';
const CC = '회의 때 늘 먼저 정리해 주셔서 정말 도움이 많이 됐어요';
const RELAY = '발표 자료를 꼼꼼히 봐 주셔서 큰 힘이 됐습니다';
const DM_D = '요즘 점심 같이 먹을 사람이 없어서 좀 외로워요';
const DM_BOSS = '실원들에게 내일 회의는 오후 세 시라고 전해 줘';
const WEEKLY = '이번 주는 커피챗 방에서 회의 이야기를 꺼내 볼게요';
const BYPASS = '요즘 일이 너무 많아서 힘들어요 상의드리고 싶어요';
const SECRETS = [NOTE_A, SHORT_B, CC, RELAY, DM_D, BYPASS];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-privacy-'));
const bots = path.join(tmp, 'bots');
const jl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', 'utf-8');
};
jl(path.join(bots, 'letter', 'data', '1on1.jsonl'), [
  { ts: 't1', action: 'ask', id: 't1', user: 'UA', user_name: '가', note: NOTE_A },
  '{망가진 줄',
  { ts: 't2', action: 'ask', id: 't2', user: 'UB', user_name: '나', note: SHORT_B },
  { ts: 't3', action: 'ask', id: 't3', user: BOSS, user_name: '실장', when: NOTE_BOSS },
]);
jl(path.join(bots, 'letter', 'data', 'coffeechat.jsonl'), [
  { id: 'c1', action: 'new', from: 'UA', to: 'UB', text: CC },
]);
jl(path.join(bots, 'letter', 'data', 'relay.jsonl'), [{ ts: 'r1', to: 'UC', head: RELAY }]);
jl(path.join(bots, 'letter', 'data', 'turns.jsonl'), [
  { key: BOSS, text: DM_BOSS, reply: '네' },
  { key: 'UA', initiate: true, text: WEEKLY, reply: '' },
]);
jl(path.join(bots, 'lunch', 'data', 'turns.jsonl'), [{ key: 'UD', text: DM_D, reply: '같이 먹어요' }]);
const registry = path.join(bots, '_shared', 'data', 'private-registry.jsonl');
const keyPath = path.join(bots, '_shared', 'data', 'private-registry.key');

// ── 가짜 슬랙 — 문 안쪽의 「원래 길」 ────────────────────────────────────────
const sent = [];
let infoCalls = 0;
WebClient.prototype.apiCall = async function fake(method, options) {
  if (method === 'conversations.info') {
    infoCalls++;
    const ch = String(options?.channel);
    if (ch === 'D-UNKNOWN') throw Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } });
    return { ok: true, channel: { id: ch, user: ch.replace(/^D-/, '') } };
  }
  if (method === 'conversations.open') return { ok: true, channel: { id: `D-${options.users}` } };
  sent.push({ method, ...options });
  return { ok: true, ts: '1.1' };
};

// 로그를 잡는다 — 막은 글의 내용이 로그에 찍히면 안 된다.
const logged = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); if (k === 'log' && String(a[0]).match(/^(PASS|FAIL|\n)/)) orig(...a); };
}

const guard = require('../dist/privacy-guard.js');
guard.installPrivacyGuard({ ownerUserId: BOSS, botsDir: bots, registryPath: registry, keyPath });
const client = new WebClient('xoxb-test');

const tryPost = async (channel, text, method = 'postMessage', extra = {}) => {
  const before = sent.length;
  try {
    if (method === 'postEphemeral') await client.chat.postEphemeral({ channel, text, ...extra });
    else if (method === 'update') await client.chat.update({ channel, ts: '1.1', text });
    else if (method === 'views') await client.views.open({ trigger_id: 't', view: { type: 'modal', blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] } });
    else if (method === 'file') await client.files.completeUploadExternal({ files: [{ id: 'F1' }], channel_id: channel, initial_comment: text });
    else await client.chat.postMessage({ channel, text });
    return { ok: true, delivered: sent.slice(before).some((s) => s.channel === channel || s.channel_id === channel || s.method === 'views.open') };
  } catch (e) {
    return { ok: false, error: e?.data?.error, delivered: sent.slice(before).some((s) => s.channel === channel) };
  }
};

// ── 1. 조각 없는 글 ─────────────────────────────────────────────────────────
{
  const before = infoCalls;
  const r = await tryPost('C1', '오늘 점심은 김치찌개 어떠세요? 12시에 모여요');
  ok('조각 없는 글은 방에 나간다', r.ok && r.delivered);
  ok('조각 없는 글은 받는 곳을 묻지도 않는다', infoCalls === before);
}

// ── 2. 막아야 할 것 ─────────────────────────────────────────────────────────
{
  const r = await tryPost('C1', `오늘 안건입니다. ${NOTE_A}`);
  ok('⛔ 1on1 메모가 방으로 못 나간다', !r.ok && !r.delivered);
  ok('막히면 부르는 쪽은 슬랙 오류처럼 받는다(privacy_blocked)', r.error === 'privacy_blocked');
  const piece = NOTE_A.slice(5, 20);   // 띄어쓰기를 빼면 11자 — 기준(10자)을 넘는 토막
  ok('⛔ 메모의 한 토막(띄어쓰기 빼고 10자 이상)만 실려도 막힌다',
    piece.replace(/\s+/g, '').length >= 10 && !(await tryPost('C1', `혹시 ${piece} 같은 말`)).ok);
  const nine = NOTE_A.slice(5, 17);    // 9자 — 기준 아래는 우연일 수 있어 안 막는다(파이썬 빗장과 같은 자)
  ok('기준 아래(9자) 토막은 안 막는다',
    nine.replace(/\s+/g, '').length === 9 && (await tryPost('C1', `혹시 ${nine} 같은 말`)).ok);
  ok('⛔ 띄어쓰기를 바꿔도 막힌다', !(await tryPost('C1', NOTE_A.replace(/ /g, '  '))).ok);
  ok('⛔ 남의 DM 으로 못 나간다', !(await tryPost('D-UB', NOTE_A)).ok);
  ok('⛔ 짧은 1on1 메모(7자)도 방으로 못 나간다', !(await tryPost('C1', `공지: ${SHORT_B}`)).ok);
  ok('⛔ 커피챗 원문이 방으로 못 나간다', !(await tryPost('C2', CC)).ok);
  ok('⛔ 커피챗 원문이 관계없는 사람 DM 으로 못 나간다', !(await tryPost('D-UC', CC)).ok);
  ok('⛔ 칭찬 전달 머리가 방으로 못 나간다', !(await tryPost('C1', RELAY)).ok);
  ok('⛔ 1:1 대화의 사람 말이 방으로 못 나간다(다른 봇 기록도)', !(await tryPost('C1', DM_D)).ok);
  ok('⛔ 수정(update)으로도 못 나간다', !(await tryPost('C1', NOTE_A, 'update')).ok);
  ok('⛔ 파일 설명으로도 못 나간다', !(await tryPost('C1', NOTE_A, 'file')).ok);
  ok('⛔ 방의 남에게 보이는 임시 글도 못 나간다', !(await tryPost('C1', NOTE_A, 'postEphemeral', { user: 'UB' })).ok);
  ok('⛔ 누구 DM 인지 모르면 막는다', !(await tryPost('D-UNKNOWN', NOTE_A)).ok);
  ok('⛔ 블록 안에 숨어도 막힌다', await (async () => {
    try {
      await client.chat.postMessage({ channel: 'C1', text: '안내', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: NOTE_A } }] });
      return false;
    } catch { return true; }
  })());
}

// ── 3. 막지 말아야 할 것 ────────────────────────────────────────────────────
{
  ok('쓴 사람 본인 DM 에는 나간다', (await tryPost('D-UA', NOTE_A)).ok);
  ok('쓴 사람에게 사람 ID 로 보내도 나간다', (await tryPost('UA', NOTE_A)).ok);
  ok('실장 DM 에는 나간다', (await tryPost(`D-${BOSS}`, NOTE_A)).ok);
  ok('커피챗은 받을 사람 DM 에 나간다(칭찬 전달)', (await tryPost('D-UB', CC)).ok);
  ok('커피챗은 쓴 사람 DM 에도 나간다', (await tryPost('D-UA', CC)).ok);
  ok('칭찬 전달 머리는 받을 사람 DM 에 나간다', (await tryPost('D-UC', RELAY)).ok);
  ok('실장이 쓴 말은 방에 나간다(전할 말이 여기서 나온다)', (await tryPost('C1', NOTE_BOSS)).ok);
  ok('실장의 1:1 대화도 방에 나간다', (await tryPost('C1', DM_BOSS)).ok);
  ok('주간 턴의 글은 비밀이 아니다', (await tryPost('C1', WEEKLY)).ok);
  ok('본인만 보는 임시 글은 나간다', (await tryPost('C1', NOTE_A, 'postEphemeral', { user: 'UA' })).ok);
  ok('창(모달)은 이 문이 안 본다 — 여는 쪽이 사람을 가린다', (await tryPost('', NOTE_A, 'views')).ok);
  ok('짧은 메모의 다섯 자 토막은 우연일 수 있어 안 막는다', (await tryPost('C1', `${SHORT_B.slice(0, 5)} 관련`)).ok);
  ok('누구 DM 인지 몰라도 조각이 없으면 나간다', (await tryPost('D-UNKNOWN', '안녕하세요 반갑습니다')).ok);
}

// ── 4. 넘긴 DM — 지문만 적는다 ──────────────────────────────────────────────
{
  ok('넘기기 전에는 그 말이 막히지 않는다', (await tryPost('C3', BYPASS)).ok);
  guard.rememberPrivate(BYPASS, ['UE']);
  ok('⛔ 넘긴 말은 곧바로 방으로 못 나간다', !(await tryPost('C3', BYPASS)).ok);
  ok('넘긴 말은 보낸 사람 DM 에는 나간다', (await tryPost('D-UE', BYPASS)).ok);
  const raw = fs.readFileSync(registry, 'utf-8');
  const leaks = [];
  const t = BYPASS.replace(/\s+/g, '');
  for (let i = 0; i + 3 <= t.length; i++) if (raw.includes(t.slice(i, i + 3))) leaks.push(i);
  ok('⛔ 지문 파일에 원문이 한 토막(3자)도 없다', leaks.length === 0, `${leaks.length}곳`);
  guard.reloadForTest();
  ok('⛔ 다시 읽은 뒤(재시작과 같음)에도 막힌다', !(await tryPost('C3', BYPASS)).ok);
  ok('지문 열쇠가 만들어졌다', /^[0-9a-f]{64}$/.test(fs.readFileSync(keyPath, 'utf-8').trim()));
}

// ── 5. 알림 — 실장에게 「막았다」만 ─────────────────────────────────────────
{
  const alerts = sent.filter((s) => s.channel === `D-${BOSS}` && /막혔습니다/.test(s.text ?? ''));
  ok('막히면 실장 DM 에 알린다', alerts.length >= 1);
  ok('⛔ 알림에 내용이 안 실린다', alerts.every((a) => !SECRETS.some((x) => a.text.replace(/\s+/g, '').includes(x.replace(/\s+/g, '').slice(0, 8)))));
  ok('같은 봇이 잇달아 막혀도 알림은 10분에 한 번', alerts.length === 1, `${alerts.length}번`);
}

// ── 6. 로그 ──────────────────────────────────────────────────────────────
{
  const all = logged.join('\n').replace(/\s+/g, '');
  const found = SECRETS.filter((x) => all.includes(x.replace(/\s+/g, '').slice(0, 8)));
  ok('⛔ 로그에 개인 글이 한 줄도 안 찍힌다', found.length === 0, `${found.length}건`);
}

// ── 7. 빠르기 ─────────────────────────────────────────────────────────────
{
  const long = '가나다라마바사아자차카타파하 '.repeat(250);
  const t0 = performance.now();
  await tryPost('C1', long);
  const ms = performance.now() - t0;
  ok(`긴 글(3,500자)도 금방 본다 (${ms.toFixed(0)}ms)`, ms < 300);
}

// ── 8. 문을 돌아가는 길이 없나 — 소스를 센다 ────────────────────────────────
{
  const src = path.join(ROOT, 'src');
  const files = fs.readdirSync(src).filter((f) => f.endsWith('.ts'));
  const read = (f) => fs.readFileSync(path.join(src, f), 'utf-8');
  const patchers = files.filter((f) => /prototype\.apiCall\s*=/.test(read(f)));
  ok('⛔ 슬랙 길목을 바꿔 끼우는 곳은 활동 기록과 이 문 둘뿐',
    patchers.sort().join(',') === 'activity-log.ts,privacy-guard.ts', patchers.join(', '));
  const direct = files.filter((f) => /slack\.com\/api|hooks\.slack\.com/.test(read(f)));
  ok('⛔ 슬랙에 HTTP 로 바로 보내는 코드가 없다(문을 안 지나는 길)', direct.length === 0, direct.join(', '));
  const idx = read('index.ts');
  const a = idx.indexOf('installActivityLog();');
  const g = idx.indexOf('installPrivacyGuard(');
  ok('⛔ 문은 활동 기록 다음에 건다(가장 바깥 · 막힌 글은 기록에도 안 남음)', a > 0 && g > a);
  ok('⛔ 슬랙 앱을 디버그 로그로 켜지 않는다(본문이 로그에 찍힌다)',
    !files.some((f) => /LogLevel\.DEBUG|logLevel:\s*['"]debug/.test(read(f))));
  const host = read('chat-host.ts');
  const bp = host.slice(host.indexOf('private async bypassToManager('));
  ok('⛔ 명단 밖 DM 은 넘기기 전에 지문부터 적는다',
    bp.indexOf('rememberPrivate(') > 0 && bp.indexOf('rememberPrivate(') < bp.indexOf('chat.postMessage'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n실패 ${fail}건` : '\n전부 통과 — 개인 글 문');
process.exit(fail ? 1 : 0);
