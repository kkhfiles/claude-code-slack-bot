/**
 * 보류 재실행 v2 — 모아 둔 요청을 회복 뒤 **받은 자리에서 · 한 줄로 · 다시 막히면 멈추며** 돌리는가.
 *
 *   npm run check:hold
 *
 * 슬랙도 파이썬도 안 탄다. 순수 함수(`hold-replay.ts` · `turn-outcome.ts`)는 그대로 부르고,
 * 대화 처리기 · 스케줄러의 메서드는 **`dist` 의 진짜 메서드**를 껍데기(`Object.create`)에 얹어
 * 부른다 — 파이썬을 부르는 다리(`work-assistant.js`)의 함수는 가짜로 바꿔 끼운다.
 *
 * **왜 기계로 세나** — 이 길은 실제로 잘 안 돈다(한도가 바닥나는 날에만). 그리고 틀려도 조용하다:
 * 다시 막혔는데 다음 것을 집으면 시도 횟수만 타서 며칠 뒤 사람 손으로 넘어가고, 일하다 끊긴 것을
 * 처음부터 돌리면 같은 쓰기가 두 번 들어가는데 오류도 로그도 없다.
 *
 * 상태 파일은 전부 임시 폴더로 옮긴다(엔진 상태 · 보관 첨부 · 업무 비서 홈) — 운영 파일을 안 건드린다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-v2-'));
process.env.ENGINE_STATE_FILE = path.join(TMP, 'engine-state.json');
process.env.HELD_FILES_DIR = path.join(TMP, 'held');
process.env.WORK_ASSISTANT_HOME = path.join(TMP, 'wa-home');   // 새어 나간 호출이 있어도 운영 큐가 아니다
process.env.WORK_EVENTS_FILE = path.join(TMP, 'events.jsonl');
fs.mkdirSync(process.env.WORK_ASSISTANT_HOME, { recursive: true });

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const hr = require(path.join(ROOT, 'dist', 'hold-replay.js'));
const to = require(path.join(ROOT, 'dist', 'turn-outcome.js'));
const { engineState } = require(path.join(ROOT, 'dist', 'engine-state.js'));
const wa = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const { config } = require(path.join(ROOT, 'dist', 'config.js'));
// `.env` 에 DM 폴백을 켜 두었으면 dotenv 가 다시 채운다 — 이 검사는 폴백이 꺼진 드레인을 잰다(사다리는 `check:agy`).
for (const k of ['DM_FALLBACK', 'DM_FALLBACK_AGY']) delete process.env[k];
const { SlackHandler } = require(path.join(ROOT, 'dist', 'slack-handler.js'));
const { AssistantScheduler } = require(path.join(ROOT, 'dist', 'assistant-scheduler.js'));

config.assistant.dmChannel = 'D_DM';
config.bot.allowUsers = ['U_ME'];
const nowSec = () => Math.floor(Date.now() / 1000);
const block = (sec = 3600) => engineState.recordBlocked('claude', { kind: 'usage', until: nowSec() + sec });
const clearEngine = () => fs.rmSync(process.env.ENGINE_STATE_FILE, { force: true });
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const item = (id, extra = {}) => ({ id, text: `말 ${id}`, thread: null, tries: 0,
  ts: '2026-10-14T09:12:33+09:00', ...extra });
const OKO = { outcome: 'ok', engine: 'claude', steps: [], writeRan: false };
const LIM = { outcome: 'limited', engine: 'claude', steps: [], writeRan: false };

// ---------------------------------------------------------------- 파이썬 다리 가짜
/** 다리 함수를 가짜로 — 부른 것을 적는다. 빠진 것이 있으면 진짜가 임시 홈으로 가므로 해는 없다. */
function bridge({ run = [], tell = [] } = {}) {
  const log = [];
  const told = new Set();
  const state = { run: [...run], tell: [...tell] };
  wa.isWorkAssistantEnabled = () => true;
  wa.pendingHeld = async () => {
    log.push(['pending']);
    return {
      run: state.run.map((x) => ({ ...x })),
      tell: state.tell.map((x) => (told.has(x.id) ? { ...x, told_at: '2026-10-14T10:00:00+09:00' } : { ...x })),
    };
  };
  wa.pendingCaptures = async () => { log.push(['pendingCaptures']); return state.run.map((x) => ({ ...x })); };
  wa.markCaptureTried = async (id) => { log.push(['tried', id]); };
  wa.markCaptureReplayed = async (id) => { log.push(['replayed', id]); state.run = state.run.filter((x) => x.id !== id); };
  wa.markCaptureTold = async (ids) => { log.push(['told', ...ids]); ids.forEach((i) => told.add(i)); };
  wa.markCaptureFailed = async (id, why, extra) => { log.push(['fail', id, why, extra ?? null]); };
  wa.dropCapture = async (id, why) => { log.push(['drop', id, why]); };
  return { log, state };
}

/** 대화 처리기 껍데기 — 쓰는 칸만 채운다. 도는 것은 `dist` 의 진짜 메서드다. */
function handler(outcomes = []) {
  const h = Object.create(SlackHandler.prototype);
  const posts = [];
  const replays = [];
  h.logger = silent;
  h.draining = false;
  h.drainRun = null;
  h.holdGate = new hr.ChannelGate();
  h.app = { client: { chat: { postMessage: async (m) => { posts.push(m); return { ts: `17000000${posts.length}.0001` }; } } } };
  h.replayHeld = async (it) => {
    replays.push({ id: it.id, gateHeld: h.holdGate.isHeld(hr.replayTarget(it, 'D_DM').channel) });
    const o = outcomes.shift() ?? OKO;
    if (o instanceof Error) throw o;
    return o;
  };
  h.canaryCalls = 0;
  h.canaryClaude = async () => { h.canaryCalls += 1; };
  return { h, posts, replays };
}

try {
  // ================================================================ ① 켜는 문
  eq('HOLD_V2 는 on 일 때만', [hr.holdV2On({}), hr.holdV2On({ HOLD_V2: '1' }), hr.holdV2On({ HOLD_V2: 'on' })],
    [false, false, true]);

  // ================================================================ ② 도구 기록과 결과
  {
    const log = new to.StepLog();
    eq('새 도구면 true', log.see({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python -X utf8 bin/tasks.py log --id TSK-1 --text "x"' } },
    ] } }), true);
    eq('같은 id 는 한 번만', log.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } }), false);
    log.see({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] } });
    log.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__x__create', input: { title: '제목', content: '본문은 안 싣는다' } }] } });
    eq('읽기 · 쓰기 가름(모르는 이름은 쓰기)', log.steps.map((s) => [s.name, s.write]),
      [['Read', false], ['Bash', true], ['mcp__x__create', true]]);
    eq('결과가 온 것만 완료', log.steps.map((s) => s.done), [false, true, false]);
    ok('본문 칸은 요약에 안 싣는다', !log.steps[2].input.includes('본문'));
    eq('이어 갈 때 넘길 줄 — 쓰기만 · 결과 모름 표시',
      to.doneStepLines(log.steps).map((l) => l.split(' · ').slice(0, 2).join(' · ')),
      ['완료 · Bash', '결과 모름 · mcp__x__create']);
    const rd = new to.StepLog();
    rd.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Grep', input: { pattern: 'x' } }] } });
    eq('읽기만 돌았으면 쓰기 안 돎', [rd.writeRan, log.writeRan], [false, true]);
    ok('입력 요약은 120자 안', to.summarizeInput('Bash', { command: 'x'.repeat(500) }).length <= to.STEP_INPUT_MAX);
    eq('결과 — 과부하 · 한도 · 오류 · 됨',
      [to.outcomeFrom({ kind: 'overload' }, false), to.outcomeFrom({ kind: 'usage' }, false),
        to.outcomeFrom(null, true), to.outcomeFrom(null, false)],
      ['overload', 'limited', 'error', 'ok']);
  }

  // ================================================================ ③ 드레인 — 순수 순서
  {
    const mk = (opts) => {
      const calls = [];
      let blocked = opts.blocked ?? (() => false);
      const outs = [...(opts.outs ?? [])];
      const gate = new hr.ChannelGate();
      const deps = {
        blocked: () => blocked(),
        needsCanary: () => opts.needsCanary ?? false,
        canary: async () => { calls.push(['canary']); opts.onCanary?.(); },
        pending: async () => ({ run: opts.run ?? [], tell: opts.tell ?? [] }),
        tried: async (id) => { calls.push(['tried', id]); },
        replay: async (it) => {
          calls.push(['replay', it.id, gate.isHeld(it.channel ?? 'D_DM')]);
          const o = outs.shift() ?? OKO;
          if (o === 'block-after') { blocked = () => true; return OKO; }
          return o;
        },
        replayed: async (it) => { calls.push(['replayed', it.id]); },
        summary: async (t) => { calls.push(['summary', t]); },
        askOld: async (its) => { calls.push(['askOld', ...its.map((i) => i.id)]); },
        gate,
        channelOf: (it) => it.channel ?? 'D_DM',
      };
      return { deps, calls, gate };
    };

    // 다시 막히면 그 자리에서 멈춘다 — 뒤의 것은 시도도 안 센다.
    let t = mk({ run: [item('a'), item('b'), item('c')], outs: [OKO, LIM, OKO] });
    let rep = await hr.drainHeld(t.deps, 5);
    eq('다시 막힌 데서 멈춤 — 셋째는 손 안 댐',
      t.calls.filter((c) => c[0] === 'tried' || c[0] === 'replay').map((c) => c.slice(0, 2).join(':')),
      ['tried:a', 'replay:a', 'tried:b', 'replay:b']);
    eq('보고 — 1건 돌고 2건 남음', [rep.ran, rep.done, rep.left, rep.stopped], [1, 1, 2, 'relimit']);
    eq('요약 한 줄', t.calls.find((c) => c[0] === 'summary')?.[1],
      '▶ 밀린 1건 처리 — 완료 1 · 확인 필요 0 · 다시 막혀 2건은 회복 뒤에');
    eq('끝까지 간 것만 걷음', t.calls.filter((c) => c[0] === 'replayed').map((c) => c[1]), ['a']);
    eq('도는 동안 그 방의 문이 잡혀 있음', t.calls.filter((c) => c[0] === 'replay').map((c) => c[2]), [true, true]);
    eq('끝나면 문을 놓음', t.gate.isHeld('D_DM'), false);

    // 과부하도 멈춘다
    t = mk({ run: [item('a'), item('b')], outs: [{ ...LIM, outcome: 'overload' }] });
    rep = await hr.drainHeld(t.deps, 5);
    eq('과부하도 멈춤', [rep.stopped, t.calls.filter((c) => c[0] === 'tried').length], ['relimit', 1]);

    // 막혀 있으면 아무것도 안 한다 — 목록도 안 읽고 시도도 안 센다.
    t = mk({ run: [item('a')], blocked: () => true });
    rep = await hr.drainHeld(t.deps, 5);
    eq('막혀 있으면 손 안 댐', [rep.stopped, t.calls.length], ['blocked', 0]);

    // 도는 중에 막히면(다른 차례가 막힘을 적음) 다음 것은 시도를 안 센다.
    t = mk({ run: [item('a'), item('b')], outs: ['block-after'] });
    rep = await hr.drainHeld(t.deps, 5);
    eq('도중에 막히면 다음 것은 시도 안 셈', t.calls.filter((c) => c[0] === 'tried').map((c) => c[1]), ['a']);
    eq('도중에 막힘 보고', [rep.stopped, rep.left], ['blocked', 1]);

    // 막힌 뒤 된 적이 없으면 먼저 떠 본다 — 아직 막혔으면 아무것도 안 집는다.
    let canaryBlocked = false;
    t = mk({ run: [item('a')], needsCanary: true, blocked: () => canaryBlocked, onCanary: () => { canaryBlocked = true; } });
    rep = await hr.drainHeld(t.deps, 5);
    eq('떠 보니 막혀 있으면 시도 안 셈', [t.calls.map((c) => c[0]), rep.stopped], [['canary'], 'canary']);
    t = mk({ run: [item('a')], needsCanary: true });
    await hr.drainHeld(t.deps, 5);
    eq('떠 보고 풀렸으면 돈다', t.calls.map((c) => c[0]).slice(0, 3), ['canary', 'tried', 'replay']);
    t = mk({ run: [], needsCanary: true });
    await hr.drainHeld(t.deps, 5);
    eq('밀린 것이 없으면 떠 보지도 않음', t.calls.length, 0);

    // 터진 것 · 오류 결과는 「확인 필요」 · 나머지는 간다.
    t = mk({ run: [item('a'), item('b'), item('c')], outs: [new Error('터짐'), { ...OKO, outcome: 'error' }, OKO] });
    t.deps.replay = (orig => async (it) => { const o = await orig(it); if (o instanceof Error) throw o; return o; })(t.deps.replay);
    rep = await hr.drainHeld(t.deps, 5);
    eq('터져도 다음 것은 간다', [rep.ran, rep.done, rep.check], [3, 1, 2]);

    // 7일 지난 것은 한 번만 묻는다(물은 것은 `told_at`).
    t = mk({ run: [], tell: [item('o1', { old: true }), item('o2', { old: true, told_at: 'x' }), item('n1', { why: '끊긴 채 닫힘' })] });
    await hr.drainHeld(t.deps, 5);
    eq('7일 지난 것 중 안 물은 것만', t.calls.filter((c) => c[0] === 'askOld'), [['askOld', 'o1']]);
  }

  // ================================================================ ④ 문구 · 자리
  {
    const it = item('p', { channel: 'D_DM', msg_ts: '1760400753.000100', session_id: 'sess-9',
      done_steps: ['완료 · Bash · tasks.py log --id TSK-3', '결과 모름 · Edit · notes.md'] });
    eq('머리 줄', hr.leadLine(it), '↻ 10/14 09:12 에 받은 요청을 이제 처리합니다');
    eq('DM 맨 위에서 받은 것은 맨 위로', hr.replayTarget(it, 'D_DM'), { channel: 'D_DM' });
    eq('DM 스레드에서 받은 것은 그 스레드로', hr.replayTarget({ ...it, thread: '1760.1' }, 'D_DM'),
      { channel: 'D_DM', thread: '1760.1' });
    eq('채널 맨 위에서 받은 것은 그 메시지의 스레드로', hr.replayTarget({ ...it, channel: 'C_X' }, 'D_DM'),
      { channel: 'C_X', thread: '1760400753.000100' });
    eq('대화방을 모르면(옛 캡처) 비서 DM', hr.replayTarget(item('q'), 'D_DM'), { channel: 'D_DM' });
    const note = hr.replayNote(it, '');
    ok('메모에 받은 시각', note.includes('10/14 09:12 에 받았는데'));
    ok('이어 가는 것은 「이미 한 것」을 싣는다',
      note.includes('이 요청은 앞에서 하다 끊겼습니다. 이미 한 것(다시 하지 말 것):')
      && note.includes('- 완료 · Bash · tasks.py log --id TSK-3') && note.includes('결과를 못 받은 것'));
    ok('처음부터 도는 것은 「이미 한 것」이 없다', !hr.replayNote(item('r'), '').includes('이미 한 것'));
    eq('7일 지난 목록 — 건마다 버튼 둘',
      hr.oldListMessage([item('o1'), item('o2')]).blocks.filter((b) => b.type === 'actions')
        .map((b) => b.elements.map((e) => `${e.action_id}:${JSON.parse(e.value).id}`)),
      [['held_run:o1', 'held_drop:o1'], ['held_run:o2', 'held_drop:o2']]);
    const after = hr.markChoice(hr.oldListMessage([item('o1'), item('o2')]).blocks, 'o1', '🗑 버렸습니다');
    eq('누른 건만 결과 한 줄로', after.filter((b) => b.type === 'actions').length, 1);
  }

  // ================================================================ ⑤ 방의 문 — 새 차례는 기다린다
  {
    const g = new hr.ChannelGate();
    const rel = g.hold(['D_DM', 'C_X']);
    let done = false;
    const waiting = g.wait('D_DM').then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 30));
    eq('잡혀 있는 동안 기다린다', done, false);
    eq('다른 방은 바로 지나간다', await g.wait('D_OTHER'), 'free');
    rel();
    eq('놓으면 지나간다', await waiting, 'waited');
    rel();
    eq('두 번 놓아도 탈 없음', g.isHeld('C_X'), false);
    const r2 = g.hold(['D_DM']);
    eq('상한이 지나면 그냥 들어간다', await g.wait('D_DM', 20), 'timeout');
    r2();

    // 대화 처리기가 그 문을 실제로 기다리는가 — 앞 차례를 끊기(`interrupt`) **전에** · 다시 돌리는
    // 차례 자신은 안 기다린다(자기가 잡은 문이다).
    const src = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
    const hm = src.slice(src.indexOf('async handleMessage('));
    const iWait = hm.indexOf('await this.holdGate.wait(channel)');
    const iCut = hm.indexOf('existingProcess.interrupt()');
    ok('새 차례가 문을 기다린다', iWait >= 0);
    ok('앞 차례를 끊기 전에 기다린다', iWait >= 0 && iCut >= 0 && iWait < iCut);
    ok('다시 돌리는 차례는 안 기다린다', /if \(!event\.replay && this\.holdGate\.isHeld\(channel\)\)/.test(hm));
  }

  // ================================================================ ⑥ 대화 처리기의 드레인 — 진짜 메서드
  {
    // --- v2: 막혀 있으면 손 안 댐 ---
    process.env.HOLD_V2 = 'on';
    clearEngine();
    block();
    let b = bridge({ run: [item('a', { channel: 'D_DM' })] });
    let { h } = handler();
    await h.drainStuck('검사');
    eq('v2 — 막혀 있으면 목록도 안 읽고 시도도 안 셈', b.log, []);

    // --- v2: 막힘이 지났는데 된 적이 없음 → 떠 봄 → 아직 막힘 → 시도 안 셈 ---
    clearEngine();
    engineState.recordBlocked('claude', { kind: 'usage', until: nowSec() - 5 });
    b = bridge({ run: [item('a', { channel: 'D_DM' })] });
    ({ h } = handler());
    h.canaryClaude = async () => { h.canaryCalls = (h.canaryCalls ?? 0) + 1; block(); };
    await h.drainStuck('검사');
    eq('v2 — 떠 보니 막힘이면 시도 안 셈', [h.canaryCalls, b.log.filter((x) => x[0] === 'tried').length], [1, 0]);

    // --- v2: 둘째에서 다시 막힘 → 셋째는 손 안 댐 · 요약 한 줄 · 7일 지난 것은 한 번만 ---
    clearEngine();
    b = bridge({
      run: [item('a', { channel: 'D_DM' }), item('b', { channel: 'C_X', msg_ts: '1.2' }), item('c')],
      tell: [item('o1', { old: true, why: '7일 지남' })],
    });
    let posts; let replays;
    ({ h, posts, replays } = handler([OKO, LIM, OKO]));
    await h.drainStuck('검사');
    eq('v2 — 시도는 실제로 돌린 것만', b.log.filter((x) => x[0] === 'tried').map((x) => x[1]), ['a', 'b']);
    eq('v2 — 돌린 것', replays.map((r) => r.id), ['a', 'b']);
    eq('v2 — 돌리는 동안 그 방의 문이 잡힘', replays.map((r) => r.gateHeld), [true, true]);
    eq('v2 — 끝까지 간 것만 걷음', b.log.filter((x) => x[0] === 'replayed').map((x) => x[1]), ['a']);
    eq('v2 — 7일 지난 것을 물었다고 적음', b.log.filter((x) => x[0] === 'told'), [['told', 'o1']]);
    const texts = posts.map((p) => p.text);
    ok('v2 — 7일 지난 목록을 올림', texts.some((t) => t.startsWith('⏳ 받은 지 7일이 지나')));
    ok('v2 — 요약 한 줄', texts.includes('▶ 밀린 1건 처리 — 완료 1 · 확인 필요 0 · 다시 막혀 2건은 회복 뒤에'));
    eq('v2 — 끝나면 겹침 막기를 푼다', [h.draining, h.drainRun], [false, null]);
    // 다음 판 — 이미 물은 것은 다시 안 묻는다.
    posts.length = 0;
    await h.drainStuck('검사');
    ok('v2 — 7일 지난 것은 두 번 안 묻는다', !posts.some((p) => (p.text ?? '').startsWith('⏳ 받은 지 7일')));

    // --- v1(꺼짐): 옛 길 그대로 — DM 맨 위 · 옛 머리 줄 · 다시 막히면 멈춤(켜는 문과 무관한 고침) ---
    delete process.env.HOLD_V2;
    clearEngine();
    b = bridge({ run: [item('a', { channel: 'C_X', msg_ts: '1.2' }), item('b'), item('s', { session_id: 'x' })] });
    ({ h, posts } = handler());
    const asked = [];
    const v1outs = [LIM, OKO];
    h.askFromBoard = async (text, lead, shown, id) => { asked.push({ text, lead, shown, id }); return v1outs.shift(); };
    await h.drainStuck('검사');
    eq('v1 — 옛 머리 줄 · 받은 자리 대신 비서 DM(askFromBoard) · 원래 캡처',
      asked.map((a) => [a.lead, a.shown, a.id]), [['↻ 밀렸던 것 (1/2 · 1번째 시도)', '', 'a']]);
    eq('v1 — 다시 막히면 멈춤 · 이어 갈 것(세션)은 안 집음',
      b.log.filter((x) => x[0] === 'tried').map((x) => x[1]), ['a']);
    eq('v1 — 요약 줄 · 7일 목록 없음(비서 DM 에 직접 올린 것 없음)', posts.length, 0);
  }

  // ================================================================ ⑦ 받은 자리에서 다시 돌림 — 진짜 replayHeld
  {
    process.env.HOLD_V2 = 'on';
    const real = SlackHandler.prototype.replayHeld;
    const run = async (it, history = []) => {
      const h = Object.create(SlackHandler.prototype);
      const posts = [];
      let seen = null;
      h.logger = silent;
      h.app = { client: {
        chat: { postMessage: async (m) => { posts.push(m); return { ts: '1760500000.000100' }; } },
        conversations: {
          history: async () => ({ messages: history }),
          replies: async () => ({ messages: history }),
        },
      } };
      h.getBotUserId = async () => 'UBOT';
      h.handleMessage = async (ev) => { seen = ev; ev.outcomeSink.outcome = 'limited'; };
      const out = await real.call(h, it);
      return { posts, seen, out };
    };
    // 채널 맨 위에서 받은 것 — 그 메시지의 스레드에 · 받은 시각 머리 줄 · 그 뒤의 글을 같이
    let r = await run(item('c1', { channel: 'C_X', msg_ts: '1760400753.000100', text: '보고서 올려 줘\n둘째 줄' }),
      [{ ts: '1760401000.000100', user: 'U_ME', text: '아까 것은 취소' }]);
    eq('채널 — 그 스레드에 머리 줄', [r.posts[0].channel, r.posts[0].thread_ts, r.posts[0].text.split('\n')[0]],
      ['C_X', '1760400753.000100', '↻ 10/14 09:12 에 받은 요청을 이제 처리합니다']);
    eq('채널 — 같은 자리로 넘김', [r.seen.channel, r.seen.thread_ts, r.seen.captureId, r.seen.replay, r.seen.pushed],
      ['C_X', '1760400753.000100', 'c1', true, true]);
    ok('채널 — 받은 뒤 올라온 글을 세션 앞에', r.seen.replayNote.includes('아까 것은 취소'));
    eq('결과를 돌려줌', r.out.outcome, 'limited');
    ok('처음부터 도는 것은 세션을 안 잇는다', r.seen.resumeSessionId === undefined);
    // DM 에서 일하다 끊긴 것 — 같은 세션 · 이미 한 것
    r = await run(item('p1', { channel: 'D_DM', session_id: 'sess-1', done_steps: ['완료 · Bash · tasks.py log'],
      files: [{ path: 'x', name: 'x.png', mimetype: 'image/png', isImage: true, isText: false, size: 1 }] }));
    eq('DM — 맨 위로', [r.posts[0].channel, r.posts[0].thread_ts], ['D_DM', undefined]);
    eq('일하다 끊긴 것 — 같은 세션 · 이미 한 것 · 보관 첨부',
      [r.seen.resumeSessionId, r.seen.heldSteps, r.seen.heldFiles?.[0]?.name],
      ['sess-1', ['완료 · Bash · tasks.py log'], 'x.png']);
    ok('일하다 끊긴 것 — 메모에 「다시 하지 말 것」', r.seen.replayNote.includes('이미 한 것(다시 하지 말 것)'));
    // 대화방을 모르는 옛 캡처 — 비서 DM
    r = await run(item('o'));
    eq('옛 캡처 — 비서 DM', r.posts[0].channel, 'D_DM');
  }

  // ================================================================ ⑧ 실패 표시 — 쓰기가 돌았나 · 첨부 보관
  {
    const turn = SlackHandler.prototype.markTurnFailed;
    const inter = SlackHandler.prototype.markInterrupted;
    const h = Object.create(SlackHandler.prototype);
    const wrote = new to.StepLog();
    wrote.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w', name: 'Bash', input: { command: 'tasks.py add' } }] } });
    wrote.see({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w' }] } });
    const read = new to.StepLog();
    read.see({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } });
    const att = path.join(TMP, 'att.txt');
    fs.writeFileSync(att, '첨부');
    const pf = [{ path: att, name: 'att.txt', mimetype: 'text/plain', isImage: false, isText: true, size: 6, tempPath: att }];

    delete process.env.HOLD_V2;
    let b = bridge();
    await turn.call(h, 'k1', 'limit', wrote, 'sess', {}, pf);
    eq('꺼짐 — 옛 모양(이유 하나 · 칸 없음)', b.log, [['fail', 'k1', 'limit', null]]);

    process.env.HOLD_V2 = 'on';
    b = bridge();
    await turn.call(h, 'k2', 'limit', wrote, 'sess', {}, pf);
    const [, , why2, ex2] = b.log[0];
    eq('켜짐 — 쓰기 뒤 막힘은 partial · 세션 · 이미 한 것', [why2, ex2.hold, ex2.session_id, ex2.done_steps],
      ['partial', 'v2', 'sess', ['완료 · Bash · tasks.py add']]);
    ok('켜짐 — 첨부를 보관 폴더로 옮김', ex2.files?.[0]?.path.startsWith(process.env.HELD_FILES_DIR)
      && fs.existsSync(ex2.files[0].path));
    b = bridge();
    await turn.call(h, 'k3', 'limit', read, 'sess', {}, []);
    eq('켜짐 — 읽기만 돌았으면 처음부터(limit · 세션 없음)', [b.log[0][2], b.log[0][3].session_id ?? null], ['limit', null]);
    b = bridge();
    await turn.call(h, 'k4', 'limit', read, 'sess', { heldSteps: ['완료 · Bash · 앞 차례'] }, []);
    eq('켜짐 — 이어 가던 차례가 또 막히면 앞의 「이미 한 것」을 합침',
      [b.log[0][2], b.log[0][3].done_steps], ['partial', ['완료 · Bash · 앞 차례']]);
    b = bridge();
    await turn.call(h, 'k5', 'error', read, 'sess', {}, [{ ...pf[0], path: path.join(TMP, '없는-파일') }]);
    eq('켜짐 — 첨부를 못 옮기면 사람에게(hold_note)', [b.log[0][2], b.log[0][3].hold_note], ['error', '첨부를 못 보관함']);

    // 재시작으로 끊긴 것 — 처리 중 기록의 도구로 가른다
    b = bridge();
    await inter.call(h, { captureId: 'i1', steps: wrote.steps, sessionId: 'sess-r' }, true);
    await inter.call(h, { captureId: 'i2', steps: read.steps, sessionId: 'sess-r' }, true);
    await inter.call(h, { captureId: 'i3', steps: wrote.steps, sessionId: 'sess-r' }, false);
    eq('재시작 — 쓰기 돌았으면 partial · 아니면 interrupted · 꺼짐이면 옛 모양',
      b.log.map((x) => [x[1], x[2], x[3]?.session_id ?? null]),
      [['i1', 'partial', 'sess-r'], ['i2', 'interrupted', null], ['i3', 'interrupted', null]]);
  }

  // ================================================================ ⑨ [실행] — 7일 지난 것을 지금 돌림
  {
    process.env.HOLD_V2 = 'on';
    clearEngine();
    let b = bridge({ tell: [item('o1', { old: true, channel: 'D_DM' })] });
    let { h, replays } = handler([OKO]);
    let r = await h.runHeldNow('o1');
    eq('[실행] — 돌리고 걷음', [r.settle, replays.map((x) => x.id), b.log.filter((x) => x[0] !== 'pending').map((x) => x[0])],
      [true, ['o1'], ['tried', 'replayed']]);
    b = bridge({ tell: [item('o1', { old: true })] });
    ({ h, replays } = handler([LIM]));
    r = await h.runHeldNow('o1');
    eq('[실행] — 다시 막히면 버튼을 남김', [r.settle, b.log.some((x) => x[0] === 'replayed')], [false, false]);
    block();
    b = bridge({ tell: [item('o1', { old: true })] });
    ({ h, replays } = handler([OKO]));
    r = await h.runHeldNow('o1');
    eq('[실행] — 막혀 있으면 시도 안 셈', [r.settle, replays.length, b.log.length], [false, 0, 0]);
    clearEngine();
    b = bridge({});
    ({ h } = handler());
    r = await h.runHeldNow('없음');
    eq('[실행] — 이미 처리한 것', [r.settle, r.text], [true, '이미 처리했거나 버린 요청입니다']);
  }

  // ================================================================ ⑩ 메일 폴러 — 막혔으면 표시를 안 옮긴다
  {
    const RealDate = Date;
    const fixed = new RealDate(2026, 9, 14, 10, 0, 0).getTime();   // 지역 10시 — 폴러가 도는 시간대
    globalThis.Date = class extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(fixed); }
      static now() { return fixed; }
    };
    try {
      const cfgDir = path.join(TMP, 'assistant');
      fs.mkdirSync(path.join(cfgDir, 'prompts'), { recursive: true });
      const marks = [];
      const asked = [];
      let outcome = OKO;
      wa.mailCandidates = async () => ({ ok: true, threads: [{}], text: '본문', lead: '📬 메일 후보 1건', newest: '2026-10-14 09:50' });
      wa.mailMark = async (ts) => { marks.push(ts); return true; };
      const drops = [];
      wa.dropCapture = async (id, why) => { drops.push([id, why]); };
      const sched = new AssistantScheduler(async () => {}, async () => ({}), cfgDir,
        async (text) => { asked.push(text); return outcome; });
      sched.isNonWorkingDay = () => ({ skip: false });
      sched.logger = silent;

      clearEngine();
      block();
      await sched.runMailPoll();
      eq('메일 — 막혀 있으면 읽지도 넘기지도 표시도 안 함', [asked.length, marks.length], [0, 0]);

      clearEngine();
      outcome = { ...LIM, captureId: 'm1' };
      await sched.runMailPoll();
      eq('메일 — 막혀 끝나면 표시를 안 옮기고 그 캡처를 버림', [asked.length, marks.length, drops.map((d) => d[0])],
        [1, 0, ['m1']]);

      outcome = { ...LIM, writeRan: true, captureId: 'm2' };
      await sched.runMailPoll();
      eq('메일 — 쓰기가 돈 뒤 막힘은 표시를 옮기고 캡처가 이어 감', [marks.length, drops.length], [1, 1]);

      outcome = OKO;
      await sched.runMailPoll();
      eq('메일 — 끝까지 가면 표시를 옮김', marks.length, 2);
    } finally {
      globalThis.Date = RealDate;
    }
  }

  // ================================================================ ⑪ 배선 — 기동 · 쓸어 보기 · 버튼
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
    ok('30분 쓸어 보기는 켜졌을 때만', /if \(holdV2On\(\)\) \{\s*const sweep = setInterval\(/.test(src));
    ok('쓸어 보기는 막혀 있으면 안 돈다', /if \(stillBlocked\(\)\) return;\s*void this\.drainStuck\('쓸어보기'\)/.test(src));
    ok('[실행] · [버림] 버튼이 걸려 있다', /this\.action\('held_run'/.test(src) && /this\.action\('held_drop'/.test(src));
    ok('[버림] 은 캡처와 보관 첨부를 버린다', /dropCapture\(id, '7일 지남 — 사람이 버림'\);\s*dropHeldFiles\(id\);/.test(src));
    ok('재시작 안내 — 자동으로 이어질 것만 「다시 보내지 않으셔도」',
      src.includes('재시작으로 끊긴 요청 ${g.n}건 — 자동으로 이어서 처리합니다(다시 보내지 않으셔도 됩니다)'));
    ok('처리 중 기록이 도구 · 세션을 싣는다(도구 하나에 한 번)',
      /if \(stepLog\.see\(event\)\) \{\s*patchInflight\(sessionKey, \{ steps: stepLog\.steps, sessionId: session\?\.sessionId \}\);/.test(src));
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8');
    ok('보관 첨부 폴더는 Git 추적 제외', /^\.held-files\/$/m.test(gi));
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`실패 ${fails.length}건\n`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — 보류 재실행 v2 (켜는 문 · 도구 기록과 결과 · 다시 막히면 멈춤 · 막혀 있거나 떠 보니 막히면 '
    + '시도 안 셈 · 받은 자리 · 받은 시각 머리 줄 · 그 뒤의 글 · 일하다 끊긴 것은 같은 세션과 「이미 한 것」 · '
    + '방의 문 · 7일 지난 것은 한 번만 · 꺼짐이면 옛 길 · 실패 표시와 첨부 보관 · 재시작 갈래 · [실행] · '
    + '메일 표시 안 옮김)');
}
