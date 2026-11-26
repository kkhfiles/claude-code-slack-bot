/**
 * 정할 것 없는 알림을 DM 에서 desk 와 아침 한 줄로(2026-11-26 실장님 「처리제안알림」 「세나정리」 · `alert-route.ts`).
 *
 *   npm run build
 *   npm run check:alertroute
 *
 * 여기서 지키려는 것:
 *   ① 켜는 문은 `ALERT_ROUTE_DESK=on` 하나 — 기본은 꺼짐이고 꺼져 있으면 예전과 똑같이 돈다
 *   ② 처리 제안 즉시 알림은 새로 생긴 것(`urgent`)만 안 보냄 — 실장님이 진행을 누른 뒤의 알림은 그대로
 *   ③ 아침 한 줄 — 둘 다 0 이면 안 보냄 · 못 읽은 것은 0 과 갈라 적음 · 메일 몫은 올린 뒤에 표시를 옮김
 *   ④ 메일 차례 답 — 판정은 파이썬(`mail.py route`), 못 가르면 보냄 · 판정 결과대로 보내거나 안 보냄
 *
 * **진짜 work-assistant · report-log 를 안 부른다** — 가짜 `bin/mail.py` 와 가짜 report-log 폴더를 임시로 짓는다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-route-check-'));

// **모듈을 불러오기 전에 정한다** — `config` 가 불러올 때 한 번 읽는다
const WA = path.join(TMP, 'wa');
fs.mkdirSync(path.join(WA, 'bin'), { recursive: true });
fs.writeFileSync(path.join(WA, 'bin', 'tasks.py'), '');
const LOG = path.join(TMP, 'mail-calls.jsonl');
fs.writeFileSync(path.join(WA, 'bin', 'mail.py'), [
  'import json, os, sys',
  'a = sys.argv[1:]',
  "open(os.environ['FAKE_MAIL_LOG'], 'a', encoding='utf-8').write(json.dumps(a) + chr(10))",
  "if a[0] == 'route':",
  "    cap = a[a.index('--capture') + 1]",
  "    if cap == 'boom':",
  '        sys.exit(2)',
  "    if cap == 'junk':",
  "        print('not json')",
  '        sys.exit(0)',
  "    print(json.dumps({'send': cap == 'ask', 'why': 'fake ' + cap}))",
  "elif a[0] == 'quiet':",
  "    if '--mark' in a:",
  "        print('mark')",
  '    else:',
  "        print(os.environ.get('FAKE_QUIET', json.dumps({'count': 3, 'threads': 4, 'newest': '2026-11-26T10:00:00'})))",
].join('\n'));
process.env.WORK_ASSISTANT_ROOT = WA;
process.env.FAKE_MAIL_LOG = LOG;
const RL = path.join(TMP, 'report-log');
fs.mkdirSync(path.join(RL, 'tools'), { recursive: true });
fs.writeFileSync(path.join(RL, 'tools', 'flow.py'), '');
process.env.REPORT_LOG_REPO = RL;
process.env.BRIEFING_DELIVERED_FILE = path.join(TMP, 'briefing-delivered.json');
delete process.env.ALERT_ROUTE_DESK;

const { alertRouteOn, holdNotice, buildDeskLine } = require(path.join(ROOT, 'dist', 'alert-route.js'));
const { ActionPipeline } = require(path.join(ROOT, 'dist', 'action-pipeline.js'));
const { mailRoute } = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const { errorCollector } = require(path.join(ROOT, 'dist', 'error-collector.js'));

const fails = [];
const ok = (name, cond) => { if (!cond) fails.push(name); };
const eq = (name, a, b) => ok(`${name} — ${JSON.stringify(a)}`, JSON.stringify(a) === JSON.stringify(b));
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ① 켜는 문
eq('기본은 꺼짐', alertRouteOn({}), false);
eq('on 이면 켜짐', alertRouteOn({ ALERT_ROUTE_DESK: 'on' }), true);
eq('on 말고는 꺼짐', alertRouteOn({ ALERT_ROUTE_DESK: '1' }), false);

// ② 즉시 알림 — 새로 생긴 것만
const ON = { ALERT_ROUTE_DESK: 'on' };
eq('꺼져 있으면 urgent 도 보냄', holdNotice('urgent', {}), false);
eq('켜면 urgent 는 안 보냄', holdNotice('urgent', ON), true);
for (const k of ['second-approval', 'merge-waiting', 'result', 'reapproval', 'stuck', 'reviewed']) {
  eq(`켜도 ${k} 는 보냄(실장님이 시작한 일)`, holdNotice(k, ON), false);
}
const NOTICE = (kind) => ({ kind, id: 'a-20261126-01', title: '시험 제안', emoji: '', state: 'proposed', state_label: '결정 대기',
  tier: 'normal', text: '요약', url: 'https://desk.example/actions/a-20261126-01/', buttons: ['approve', 'hold', 'reject'] });
const pipe = (hold) => {
  const posts = [];
  const p = new ActionPipeline({
    run: async () => ({ need_you: [NOTICE('digest'), NOTICE('digest')], stuck: [], site: 'https://desk.example' }),
    session: async () => { throw new Error('시험이 세션을 불렀다'); },
    post: async (text) => { posts.push(text); },
    hold,
  });
  return { p, posts };
};
{
  const a = pipe((k) => holdNotice(k, ON));
  await a.p.tell([NOTICE('urgent'), NOTICE('result')]);
  eq('켜면 urgent 는 건너뛰고 result 만 DM', a.posts.length, 1);
  ok('남은 한 통이 결과 알림', String(a.posts[0]).includes('실행 결과'));
  const b = pipe(undefined);
  await b.p.tell([NOTICE('urgent'), NOTICE('result')]);
  eq('hold 가 없으면 예전처럼 둘 다', b.posts.length, 2);
  eq('결정 대기 수 · desk 주소', await a.p.digestCount(), { need: 2, stuck: 0, queued: 0, site: 'https://desk.example' });
  errorCollector.getAndClear();
  const bad = new ActionPipeline({ run: async () => ({ error: 'rc 1 · 시험' }), session: async () => ({}), post: async () => {} });
  eq('못 읽으면 null', await bad.digestCount(), null);
  ok('못 읽은 것은 시스템 이슈로', errorCollector.getAndClear().some((e) => e.message.includes('rc 1 · 시험')));
}

// ③ 아침 한 줄
const SITE = 'https://desk.example';
eq('둘 다 있으면 한 줄', buildDeskLine(25, 3, SITE), '🗂 처리 제안 25건 · 메일 처리 3건 — <https://desk.example/actions/|desk 에서 보기>');
eq('메일만', buildDeskLine(0, 2, `${SITE}/`), '🗂 메일 처리 2건 — <https://desk.example/actions/|desk 에서 보기>');
eq('둘 다 0 이면 안 보냄', buildDeskLine(0, 0, SITE), null);
eq('못 읽은 것은 0 과 갈라 적음', buildDeskLine(null, null, SITE),
  '🗂 처리 제안 못 읽음 · 메일 처리 못 셈 — <https://desk.example/actions/|desk 에서 보기>');
ok('한 줄 — 줄바꿈 없음', !buildDeskLine(25, 3, SITE).includes('\n'));
eq('멈춤 · 검토 대기는 있을 때만(예전 요약 머리 줄의 두 신호)', buildDeskLine(0, 0, SITE, { stuck: 1, queued: 7 }),
  '🗂 멈춤 1건 · 검토 대기 7건 — <https://desk.example/actions/|desk 에서 보기>');
eq('멈춤 · 검토 대기가 0 이면 안 붙음', buildDeskLine(2, 0, SITE, { stuck: 0, queued: 0 }),
  '🗂 처리 제안 2건 — <https://desk.example/actions/|desk 에서 보기>');

const { AssistantScheduler } = require(path.join(ROOT, 'dist', 'assistant-scheduler.js'));
const CFG = path.join(TMP, 'cfg');
fs.mkdirSync(path.join(CFG, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({
  briefing: { time: '00:00', enabled: true, excludeCalendars: [] },
  reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5, workingHoursStart: '08:00', workingHoursEnd: '20:00' },
  analysis: { schedule: 'saturday-00:00', defaults: {}, types: {} },
}));
const sched = () => {
  const sent = [];
  const s = new AssistantScheduler(async (text, blocks) => { sent.push({ text, blocks }); },
    async () => { throw new Error('시험이 세션을 불렀다'); }, CFG);
  s.actionPipeline.digestCount = async () => ({ need: 25, site: SITE });
  s.actionPipeline.postDigest = async () => { sent.push({ text: 'OLD_DIGEST' }); return 'sent'; };
  return { s, sent };
};
try {
  fs.rmSync(LOG, { force: true });
  process.env.ALERT_ROUTE_DESK = 'on';
  const on = sched();
  await on.s.postActionDigest();
  eq('켜면 아침에 한 줄 한 통', on.sent.map((m) => m.text), ['🗂 처리 제안 25건 · 메일 처리 4건 — <https://desk.example/actions/|desk 에서 보기>']);
  eq('켜면 예전 요약 · 카드는 안 감', on.sent.some((m) => m.text === 'OLD_DIGEST'), false);
  eq('올린 뒤 메일 몫 표시를 옮김', calls().filter((c) => c[0] === 'quiet').map((c) => c.join(' ')),
    ['quiet', 'quiet --mark 2026-11-26T10:00:00']);

  fs.rmSync(LOG, { force: true });
  const unsent = new AssistantScheduler(async () => { throw new Error('슬랙 보내기 실패 시험'); },
    async () => { throw new Error('시험이 세션을 불렀다'); }, CFG);
  unsent.actionPipeline.digestCount = async () => ({ need: 1, site: SITE });
  errorCollector.getAndClear();
  await unsent.postActionDigest();
  eq('못 올렸으면 표시를 안 옮김', calls().some((c) => c.includes('--mark')), false);
  ok('못 올린 것은 시스템 이슈로', errorCollector.getAndClear().some((e) => e.message.includes('아침 한 줄')));

  fs.rmSync(LOG, { force: true });
  process.env.FAKE_QUIET = JSON.stringify({ count: 0, threads: 0, newest: '' });
  const none = sched();
  none.s.actionPipeline.digestCount = async () => ({ need: 0, site: SITE });
  await none.s.postActionDigest();
  eq('둘 다 0 이면 아무것도 안 보냄', none.sent.length, 0);
  delete process.env.FAKE_QUIET;

  delete process.env.ALERT_ROUTE_DESK;
  const off = sched();
  await off.s.postActionDigest();
  eq('꺼져 있으면 예전 요약 길', off.sent.map((m) => m.text), ['OLD_DIGEST']);
} finally {
  delete process.env.ALERT_ROUTE_DESK;
}

// ④ 메일 차례 답
eq('판정이 보내라면 보냄', (await mailRoute('ask', '답')).send, true);
eq('판정이 조용히면 안 보냄', (await mailRoute('quiet', '답')).send, false);
eq('캡처 id 가 없으면 보냄', (await mailRoute(undefined, '답')).send, true);
eq('명령이 실패하면 보냄', (await mailRoute('boom', '답')).send, true);
eq('깨진 JSON 이면 보냄', (await mailRoute('junk', '답')).send, true);
ok('답 글은 파일로 넘김(명령줄에 안 실음)', calls().filter((c) => c[0] === 'route').every((c) => c.includes('--reply-file') && !c.includes('답')));

// 배선 — 소스에서 본다(슬랙 통로를 띄우지 않고)
const sched_src = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
ok('메일 폴러가 mailRoute 를 켜서 넘김', /\{ single: true, noWeb: true, mailRoute: true \}/.test(sched_src));
ok('처리 제안 실행기에 hold 를 넘김', sched_src.includes('hold: (kind) => holdNotice(kind)'));
const single = handler.slice(handler.indexOf('if (opts.single) {'), handler.indexOf('private drawerSay'));
const gate = single.indexOf('opts.mailRoute && alertRouteOn()');
ok('한 통 길은 켜져 있을 때만 판정', gate > 0);
ok('판정은 한 통을 올리기 전에', gate > 0 && gate < single.indexOf('chat.postMessage(singleMessage('));
ok('막히거나 터진 차례는 판정 없이 보냄', single.includes("(outcomeSink.outcome ?? 'ok') === 'ok'"));

fs.rmSync(TMP, { recursive: true, force: true });
if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('통과 — 켜는 문(기본 꺼짐) · 즉시 알림은 urgent 만 걸름 · 아침 한 줄(0 이면 안 보냄 · 못 읽음 갈라 적음 · 올린 뒤 표시) · 메일 답은 파이썬 판정대로(못 가르면 보냄) · 배선');
