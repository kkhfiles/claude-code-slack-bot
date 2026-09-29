/**
 * SDK 판 맞춤 — 판 고르기 · 요청 문 · 「다른 작업 중」 판정 · pyproject 고치기 ·
 * 주간 카드(시각 창 · 주 한 번 · 쉬는 날 넘김 · 맞으면 조용히) · 버튼(DM 만 · 작업 중 · 이미 도는 중) · 결과 알림 한 번.
 *
 *   npm run check:sdkupdate
 *
 * 실제 설치·시험·푸시는 여기서 안 돌린다(네트워크·구독 호출). 그것은 저장소 사본에서
 * `node scripts/sdk-update.mjs --run --no-push --no-restart` 로 끝까지 돌려 본다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  bumpPyproject, busyReason, cmpVer, guardReason, normalizeNpmView, parseVer, pickTarget, requestFresh,
} from './lib/sdk-update-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { SdkUpdate, cardBlocks, formatResult, RUN_ACTION, SKIP_ACTION } = require(path.join(ROOT, 'dist', 'sdk-update.js'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

// ── 판 비교 ──────────────────────────────────────────────
eq('판 읽기', parseVer('2.1.284 (Claude Code)'), [2, 1, 284]);
ok('자리 수가 달라도 숫자로 비교(2.1.99 < 2.1.100)', cmpVer('2.1.99', '2.1.100') < 0);
ok('같은 판은 0', cmpVer('0.3.284', '0.3.284') === 0);

// ── 올릴 판 고르기 ─────────────────────────────────────────
const ts = [
  { version: '0.3.284', pair: '2.1.284' },
  { version: '0.3.286', pair: '2.1.286' },
  { version: '0.3.285', pair: '2.1.285' },
];
eq('짝 판이 CLI 이하인 것 중 가장 새 것', pickTarget(ts, '2.1.285', '0.3.284')?.version, '0.3.285');
eq('SDK 가 CLI 보다 앞서 나온 판은 안 고름', pickTarget(ts, '2.1.284', '0.3.284'), null);
eq('설치된 판보다 새 것이 없으면 null', pickTarget(ts, '2.1.290', '0.3.286'), null);
eq('설치된 판보다 낮은 것으로 내리지 않음', pickTarget([{ version: '0.3.280', pair: '2.1.280' }], '2.1.290', '0.3.284'), null);
eq('모양이 이상한 줄은 건너뜀', pickTarget([{ version: 'x', pair: '2.1.1' }, ...ts], '2.1.286', '0.3.284')?.version, '0.3.286');

// ── npm view 모양 ────────────────────────────────────────
eq('하나면 객체로 온다', normalizeNpmView({ version: '0.3.284', claudeCodeVersion: '2.1.284' }),
  [{ version: '0.3.284', pair: '2.1.284' }]);
eq('여럿이면 배열', normalizeNpmView([{ version: '1.0.0', claudeCodeVersion: '2.0.0' }, { version: '1.0.1' }]),
  [{ version: '1.0.0', pair: '2.0.0' }]);
eq('비면 빈 목록', normalizeNpmView(''), []);

// ── pyproject ────────────────────────────────────────────
const pp = '# 판은 Claude Code 와 맞춘다 — 짝 CLI 판이다(0.2.161 = 2.1.284).\r\nsdk = ["claude-agent-sdk>=0.2.161"]\r\n';
eq('최소 판과 주석의 짝 판을 같이 바꿈 · 줄바꿈 보존', bumpPyproject(pp, '0.2.165', '2.1.290'),
  '# 판은 Claude Code 와 맞춘다 — 짝 CLI 판이다(0.2.165 = 2.1.290).\r\nsdk = ["claude-agent-sdk>=0.2.165"]\r\n');
let threw = false;
try { bumpPyproject('sdk = ["claude-agent-sdk"]', '1.0.0', '2.0.0'); } catch { threw = true; }
ok('모양이 바뀐 파일은 조용히 두지 않고 던짐', threw);

// ── 요청 문(되살아난 pm2 앱이 옛 요청으로 돌지 않게) ────────────
const now = Date.parse('2026-10-05T01:00:00Z');
ok('방금 만든 요청은 처리', requestFresh({ id: 'a', requestedAt: '2026-10-05T00:55:00Z' }, now));
ok('15분 넘은 요청은 안 함', !requestFresh({ id: 'a', requestedAt: '2026-10-05T00:40:00Z' }, now));
ok('이미 쓴 요청은 안 함', !requestFresh({ id: 'a', requestedAt: '2026-10-05T00:59:00Z', consumed: true }, now));
ok('요청 파일이 없으면 안 함', !requestFresh(null, now));
ok('미래 시각이면 안 함', !requestFresh({ id: 'a', requestedAt: '2026-10-05T02:00:00Z' }, now));

// ── 다른 작업 중 ──────────────────────────────────────────
eq('기본 브랜치 · 깨끗함이면 비어 있음', busyReason('main', 'main', ''), '');
ok('다른 브랜치면 이유', busyReason('feature/x', 'main', '').includes('feature/x'));
ok('커밋 안 된 파일이 있으면 개수', busyReason('main', 'main', ' M src/a.ts\n?? src/b.ts\n').includes('2개'));

// ── 봇 모듈 ───────────────────────────────────────────────
const CHECK = {
  cli: '2.1.290',
  ts: { version: '0.3.284', pair: '2.1.284', target: '0.3.290', targetPair: '2.1.290' },
  py: { version: '0.2.161', pair: '2.1.284', target: null, targetPair: null },
  needed: true,
};
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const dirs = [];
function harness(over = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkupd-'))) {
  dirs.push(dir);
  const log = { sent: [], replies: [], updates: [], launched: [], checks: 0 };
  const su = new SdkUpdate({
    at: '09:30', repoRoot: ROOT, dmChannel: 'D1', stateDir: dir, logger: quiet,
    send: async (t, b) => { log.sent.push({ t, b }); return '111.1'; },
    reply: async (th, t) => { log.replies.push({ th, t }); },
    update: async (ts, t, b) => { log.updates.push({ ts, t, b }); },
    runCheck: async () => { log.checks++; return 'check' in over ? over.check : CHECK; },
    busyReason: async () => over.busy ?? '',
    launch: async (p) => { log.launched.push(p); },
    isWorkday: over.isWorkday ?? (() => true),
  });
  return { su, log, dir };
}
const MON = (h, m) => new Date(2026, 9, 5, h, m);   // 2026-10-05 월요일(이 PC 시간)
const TUE = (h, m) => new Date(2026, 9, 6, h, m);
const click = (channel = 'D1') => ({
  ack: async () => {},
  body: { channel: { id: channel }, message: { ts: '111.1', text: 'card', blocks: cardBlocks(CHECK) } },
});

{
  const { su, log, dir } = harness();
  eq('창 전에는 안 돈다', await su.tick(MON(9, 0)), 'not-time');
  eq('창 안이면 묻는다', await su.tick(MON(9, 31)), 'asked');
  const ids = log.sent[0]?.b?.flatMap((b) => b.elements ?? []).map((e) => e.action_id);
  eq('카드에 버튼 둘', ids, [RUN_ACTION, SKIP_ACTION]);
  ok('카드에 올릴 판이 보임', log.sent[0]?.t.includes('0.3.290') && log.sent[0]?.t.includes('2.1.290'));
  eq('같은 주에 다시 안 묻는다', await su.tick(MON(9, 45)), 'done-this-week');
  const again = harness({}, dir);
  eq('재시작해도 같은 주는 안 묻는다(상태 파일)', await again.su.tick(TUE(9, 31)), 'done-this-week');
  eq('카드는 한 장', log.sent.length + again.log.sent.length, 1);
  eq('창이 지나면 안 돈다', await harness().su.tick(MON(11, 30)), 'not-time');
}
{
  const { su, log } = harness({ isWorkday: (d) => d.getDay() !== 1 });
  eq('쉬는 날은 넘긴다', await su.tick(MON(9, 31)), 'rest');
  eq('쉬는 날은 대조도 안 한다', log.checks, 0);
  eq('다음 업무일에 묻는다', await su.tick(TUE(9, 31)), 'asked');
}
{
  const { su, log } = harness({ check: { ...CHECK, needed: false } });
  eq('판이 맞으면 조용히', await su.tick(MON(9, 31)), 'aligned');
  eq('맞으면 DM 없음', log.sent.length, 0);
  eq('맞았던 주는 다시 안 본다', await su.tick(MON(9, 50)), 'done-this-week');
}
{
  const { su, log } = harness({ check: null });
  eq('대조 실패', await su.tick(MON(9, 31)), 'failed');
  eq('실패 뒤 곧바로는 다시 안 함', await su.tick(MON(9, 32)), 'retry-later');
  eq('15분 뒤 다시 대조', (await su.tick(MON(9, 47)), log.checks), 2);
}
{
  const { su, log } = harness();
  await su.onRun(click('C-other'));
  eq('DM 이 아닌 곳의 누름은 무시', [log.replies.length, log.launched.length, log.updates.length], [0, 0, 0]);
}
{
  const { su, log } = harness({ busy: '다른 작업 중(봇 저장소) — 기본 브랜치(main)가 아니라 feature/x에 있음' });
  await su.onRun(click());
  ok('다른 작업 중이면 이유를 스레드에', log.replies[0]?.t.includes('feature/x') && log.replies[0]?.th === '111.1');
  eq('다른 작업 중이면 안 띄우고 버튼도 남김', [log.launched.length, log.updates.length], [0, 0]);
}
{
  const { su, log } = harness();
  await su.onRun(click());
  eq('누르면 한 번 띄운다', log.launched, [su.requestPath]);
  const req = JSON.parse(fs.readFileSync(su.requestPath, 'utf-8'));
  ok('요청은 방금 만든 것 · 스레드가 카드', requestFresh(req, Date.now()) && req.thread === '111.1');
  ok('카드 글은 「시작했습니다」로', log.updates[0]?.t.includes('시작했습니다'));
  eq('카드에서 버튼을 걷는다', (log.updates[0]?.b ?? []).filter((b) => b.type === 'actions').length, 0);
  fs.writeFileSync(su.resultPath, JSON.stringify({
    id: req.id, thread: '111.1', status: 'running', startedAt: new Date().toISOString(), steps: [],
  }));
  await su.onRun(click());
  ok('도는 중에 또 누르면 안 띄운다', log.launched.length === 1 && log.replies.at(-1)?.t.includes('이미'));
  eq('도는 중에는 알리지 않는다', await su.watchResult(), false);
  fs.writeFileSync(su.resultPath, JSON.stringify({
    id: req.id, thread: '111.1', status: 'done', startedAt: '2026-10-05T00:31:00Z', finishedAt: '2026-10-05T00:34:12Z',
    steps: [{ name: '봇 SDK 설치', ok: true, detail: '0.3.284 → 0.3.290 (짝 2.1.290)' }],
  }));
  eq('끝나면 알린다', await su.watchResult(), true);
  ok('버튼을 누른 스레드에 · 걸린 시간 · 단계', log.replies.at(-1)?.th === '111.1'
    && log.replies.at(-1)?.t.includes('3분 12초') && log.replies.at(-1)?.t.includes('0.3.290'));
  eq('한 번만 알린다', await su.watchResult(), false);
}
{
  const { su, log } = harness();
  await su.onSkip(click());
  ok('건너뛰기는 카드 글만 바꾼다', log.updates[0]?.t.includes('건너뜁니다') && log.launched.length === 0);
}
ok('다른 작업 중으로 멈춘 결과는 다시 누르라고', formatResult({
  status: 'failed', busy: true, startedAt: 'x', steps: [{ name: '점검', ok: false, detail: '다른 작업 중(봇 저장소) — x' }],
}).includes('다시 누르세요'));
ok('실패는 멈춘 단계 이름이 앞에', formatResult({
  status: 'failed', startedAt: '2026-10-05T00:31:00Z', finishedAt: '2026-10-05T00:33:00Z',
  steps: [{ name: '점검', ok: true }, { name: '봇 시험', ok: false, detail: '두 번 다 실패 · 되돌림' }],
}).startsWith('❌ 「봇 시험」에서 멈췄습니다'));

// ── 재검토 반영(2026-09-29) ────────────────────────────────
// 커밋 직전 — 시작 때 그대로인가
const G = { branch: 'main', want: 'main', porcelain: ' M package.json\n M package-lock.json\n', allowed: ['package.json', 'package-lock.json'], head: 'aaa', base: 'aaa' };
eq('판 맞춤이 바꾼 파일만이면 통과', guardReason(G), '');
ok('도중에 다른 브랜치로 바뀌면 멈춤', guardReason({ ...G, branch: 'feature/x' }).includes('feature/x'));
ok('시작한 뒤 커밋이 늘면 멈춤(남의 커밋을 같이 올리지 않게)', guardReason({ ...G, head: 'bbb' }).includes('커밋이 더해짐'));
ok('판 맞춤이 안 건드린 파일이 바뀌면 멈춤', guardReason({ ...G, porcelain: `${G.porcelain} M src/a.ts\n` }).includes('src/a.ts'));
{
  // 두 번 눌러도 한 번만 — 작업 중 판정(1~2초) 사이에 또 누르면 두 번째가 첫째를 죽였다
  let release;
  const gate = new Promise((r) => { release = r; });
  const { su, log } = harness();
  su.opts.busyReason = async () => { await gate; return ''; };
  const first = su.onRun(click());
  await su.onRun(click());
  release();
  await first;
  eq('누르는 사이에 또 누르면 한 번만 띄운다', log.launched.length, 1);
  ok('두 번째 누름에는 띄우는 중이라고 답한다', log.replies.some((r) => r.t.includes('띄우는 중')));
}
{
  const { su, log } = harness();
  su.opts.launch = async () => { throw new Error('pm2 없음'); };
  await su.onRun(click());
  ok('pm2 로 못 띄우면 곧바로 스레드에 알린다', log.replies.some((r) => r.t.includes('pm2 로 못 띄움')));
  ok('못 띄웠으면 카드에 버튼을 되살린다', log.updates.some((u) => (u.b ?? []).some((b) => b.type === 'actions')));
}
{
  const { su, log } = harness();
  await su.onRun(click());
  const req = JSON.parse(fs.readFileSync(su.requestPath, 'utf-8'));
  fs.writeFileSync(su.resultPath, JSON.stringify({
    id: req.id, thread: '111.1', status: 'failed', startedAt: '2026-10-05T00:31:00Z', finishedAt: '2026-10-05T00:32:00Z',
    steps: [{ name: '봇 시험', ok: false, detail: '두 번 다 실패 · 되돌림' }],
  }));
  log.updates.length = 0;
  await su.watchResult();
  const last = log.updates.at(-1);
  ok('실패하면 카드에 버튼을 되살려 다음 주를 안 기다리고 다시 누를 수 있다',
    last?.ts === '111.1' && last.b.some((b) => b.type === 'actions') && last.t.includes('다시 누를 수'));
}
{
  const { su, log } = harness();
  await su.onRun(click());
  const req = JSON.parse(fs.readFileSync(su.requestPath, 'utf-8'));
  fs.writeFileSync(su.resultPath, JSON.stringify({
    id: req.id, thread: '111.1', status: 'running', startedAt: '2026-01-01T00:00:00Z', steps: [],
  }));
  eq('최종 결과 없이 오래 도는 중이면 멈춘 것으로 알린다', await su.watchResult(), true);
  ok('멈춤 알림 문구', log.replies.at(-1)?.t.includes('멈춘 것으로'));
  eq('멈춤도 한 번만 알린다', await su.watchResult(), false);
}
{
  const { su, log } = harness();
  su.opts.send = async () => { throw new Error('slack down'); };
  eq('카드를 못 보내면 실패', await su.tick(MON(9, 31)), 'failed');
  eq('못 보낸 주는 한 것으로 두지 않는다(15분 뒤 다시)', await su.tick(MON(9, 47)), 'failed');
  eq('다시 해 본다(대조 두 번)', log.checks, 2);
}
// 안전장치가 소스에서 빠지면 조용히 옛 동작으로 돌아간다 — 줄을 못 박는다
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
ok('SDK 경로는 프롬프트 속 `@경로`·슬래시 명령을 끈다', src('src/sdk-handler.ts').includes('verbatimPrompts: true'));
ok('비상용 CLI 경로도 끈다(client_composed)', src('src/cli-handler.ts').includes('client_composed: true'));
ok('판 맞춤은 pm2 저장 환경을 안 건드리게 재시작한다',
  src('scripts/sdk-update.mjs').includes("'--keep-env'") && src('scripts/restart.mjs').includes("args.has('--keep-env')"));
ok('재시작은 도는 판 맞춤을 기다린다(판 맞춤 자신만 통과)',
  src('scripts/restart.mjs').includes('SDK_UPDATE_SELF') && src('scripts/sdk-update.mjs').includes("SDK_UPDATE_SELF: '1'"));
ok('판 맞춤은 당겨 오지 않는다(원격과 같아야만 진행)', !src('scripts/sdk-update.mjs').includes("'pull'"));

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — SDK 판 맞춤(짝 판이 CLI 이하인 가장 새 판 · 내리지 않음 · pyproject 두 곳 · 낡은 요청 안 함 · '
    + '다른 작업 중 · 주 한 번 카드 · 쉬는 날 넘김 · 맞으면 조용히 · DM 누름만 · 도는 중 안 겹침 · 결과 한 번)');
}
