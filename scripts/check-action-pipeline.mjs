/**
 * 처리 제안 실행기 — `next` → 세션 → `complete` 고리가 맞게 도나.
 *
 *   npm run build
 *   npm run check:actions
 *
 * **세션도 report-log 도 안 부른다** — 가짜 `run`(flow.py 의 답)과 가짜 세션을 넣어
 * 고리의 규칙만 잰다. 상태 전환 규칙 자체는 report-log 의 `tests/test_flow.py` 가 본다.
 *
 * 여기서 지키려는 것:
 *   ① 결과는 파일로만 — 이번 세션 뒤에 쓰인 결과 파일이 없으면 실패 · 한도는 한도로 알린다
 *   ② 폴백도 `next` 가 준 범위만 — 기본 폴더 목록으로 새지 않는다
 *   ③ 사용량 한도가 나오면 그 차례를 멈춘다(다음 제안으로 안 넘어간다)
 *   ④ 도는 고리가 영영 안 끝나지 않는다
 *   ⑤ 버튼 값은 믿지 않는다 — 형식이 틀리면 report-log 를 부르지도 않는다 · 거절 답은 원래 메시지를 덮지 않는다
 *   ⑥ 아침 요약이 슬랙 한 메시지 한도 안에 든다 · 세 브리핑 모두에 붙는다 · 브리핑이 한도 · 실패여도
 *      붙는다 · 요약을 못 만들면 「시스템 이슈」
 *   ⑦ 밤 검토는 업무일 시간대 안에서만 · 이어 가기는 늘
 *   ⑧ 사람이 시킨 검토가 한도에 끊기면 회복 뒤 이어 간다 · 재시작에도 남는다 · 밤 검토는 안 남긴다
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// **모듈을 불러오기 전에 정한다** — 이벤트 기록 경로는 `board-queue` 를 불러올 때 한 번 읽힌다.
// 뒤에서 정하면 앞선 require 가 그 모듈을 먼저 끌어와 진짜 기록 파일에 쓴다.
const EVENTS_FILE = path.join(os.tmpdir(), `actions-check-ev-${Date.now()}.jsonl`);
process.env.WORK_EVENTS_FILE = EVENTS_FILE;
// 한도로 미룬 검토 기록 — 운영 파일(`.actions-resume.json`)을 안 건드린다
const RESUME_FILE = path.join(os.tmpdir(), `actions-check-resume-${Date.now()}.json`);
process.env.ACTIONS_RESUME_FILE = RESUME_FILE;
process.env.BOARD_NARROW_CODEX_BIN = 'codex-없는-이름-2026';
// report-log 자동 기록 클론 · 비용 원장 — 스케줄러를 만드는 절이 진짜 것을 부르지 않게(없는 자리)
process.env.REPORT_LOG_STATE = path.join(os.tmpdir(), `actions-check-rl-${Date.now()}`);
process.env.REPORT_LOG_REPO = path.join(process.env.REPORT_LOG_STATE, '없는-클론');
process.env.ASSISTANT_COSTS_FILE = path.join(os.tmpdir(), `actions-check-costs-${Date.now()}.json`);
const {
  ActionPipeline, buildDigestBlocks, buildReportReplyBlocks, decisionReply, markDecided, noticeReply, parseWindow,
} = require(path.join(ROOT, 'dist', 'action-pipeline.js'));
const { errorCollector } = require(path.join(ROOT, 'dist', 'error-collector.js'));
const { codexSessionArgs } = require(path.join(ROOT, 'dist', 'work-assistant.js'));
const { SdkHandler } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-check-'));

function spec(id, job, seq, extra = {}) {
  return {
    job, title: job, id, seq, prompt: `${job} 절차`, model: 'opus', effort: 'high',
    cwd: path.join(tmp, 'cwd'), add_dirs: [path.join(tmp, 'job')], tools: ['Read', 'Write'],
    timeout_min: 30, out: path.join(tmp, `${id}-${seq}.md`),
    fallback: { allowed: true, cwd: path.join(tmp, 'job'), writable: [path.join(tmp, 'job')] },
    ...extra,
  };
}

const NOTICE = (id, kind, state, buttons = []) => ({
  kind, id, title: `제안 ${id}`, emoji: '', state, state_label: state, tier: 'light',
  text: '요약', url: `https://desk.example/actions/${id}/`, buttons,
});

/**
 * 가짜 report-log. `nexts` 는 제안별 `next` 답 차례 · `completes` 는 `complete` 답 차례.
 * 부른 명령은 `calls` 에 남는다.
 */
function world({ nexts = {}, completes = [], pending = {}, digest = null, decide = null,
                 session = null, afterResume = undefined } = {}) {
  const calls = [];
  const posts = [];
  const sessions = [];
  const deps = {
    run: async (script, args) => {
      calls.push([script, ...args]);
      const cmd = args[0];
      if (cmd === 'sync') return { pulled: false };
      if (cmd === 'pending') return { ids: pending[args[2]] || [] };
      if (cmd === 'next') return (nexts[args[1]] || []).shift() || { job: 'done' };
      if (cmd === 'complete') return completes.shift() || { result: 'ok', state: 'x', notify: [] };
      if (cmd === 'digest') return digest || { need_you: [], stuck: [], site: 'https://desk.example' };
      if (cmd === 'decide') return decide || { error: 'no fake' };
      return { error: `모르는 명령 ${cmd}` };
    },
    session: async (label, prompt, opts) => {
      sessions.push(opts);
      return session ? session(opts) : { text: '끝', costUsd: 0, sessionId: 's', subtype: 'success', toolCalls: 3 };
    },
    post: async (text, blocks) => { posts.push({ text, blocks }); },
    afterResume,
  };
  return { calls, posts, sessions, pipe: new ActionPipeline(deps) };
}

/** 세션이 결과 파일을 쓰는 가짜 — 실제 세션이 하는 일. */
const writes = (file, result = {}) => () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '```json\n{}\n```\n본문');
  return { text: '끝', costUsd: 0, sessionId: 's', subtype: 'success', toolCalls: 4, ...result };
};

const completes = (calls) => calls.filter((c) => c[1] === 'complete').map((c) => c.slice(2));

// ── ① 결과 파일을 쓰면 형식 판정은 report-log 에 맡기고 다음 단계로 ─────────
{
  const s1 = spec('a-20260929-01', 'review', 1);
  const w = world({
    nexts: { 'a-20260929-01': [s1, { job: 'wait', who: 'human', state: 'proposed' }] },
    completes: [{ result: 'ok', state: 'proposed', notify: [NOTICE('a-20260929-01', 'urgent', 'proposed', ['approve', 'hold', 'reject'])] }],
    session: writes(s1.out),
  });
  const end = await w.pipe.drain('a-20260929-01');
  eq('결과 파일을 쓴 세션 → 깃발 없이 complete', completes(w.calls), [['a-20260929-01', '--seq', '1']]);
  eq('사람 차례가 나오면 멈춘다', end, 'stop');
  eq('complete 가 준 알림을 DM 으로 보낸다', w.posts.length, 1);
  const o = w.sessions[0];
  eq('세션 작업 폴더 · 추가 폴더는 next 가 준 대로', [o.workingDirectory, o.additionalDirectories], [s1.cwd, s1.add_dirs]);
  eq('세션 깊이 · 모델 · 도구는 next 가 준 대로', [o.effort, o.model, o.allowedTools], ['high', 'opus', ['Read', 'Write']]);
  eq('폴백 범위는 next 가 준 것만', o.fallbackScope, { cwd: s1.fallback.cwd, writable: s1.fallback.writable });
  eq('사람 없는 세션 표시', o.env.CLAUDE_SCHEDULED, '1');
  eq('제한 시간은 분 → 밀리초', o.maxDurationMs, 30 * 60_000);
}

// ── ① 결과 파일이 없으면 실패로 · 한도면 한도로 ─────────────────────────
{
  const s1 = spec('a-20260929-02', 'prepare', 1);
  const s2 = spec('a-20260929-02', 'prepare', 2);
  const w = world({
    nexts: { 'a-20260929-02': [s1, s2, { job: 'wait', who: 'human', state: 'needs-decision' }] },
    completes: [{ result: 'failed', state: 'approved' }, { result: 'failed', state: 'needs-decision' }],
    session: () => ({ text: '', costUsd: 0, sessionId: 's', subtype: 'error_timeout', isError: true, toolCalls: 9 }),
  });
  await w.pipe.drain('a-20260929-02');
  const c = completes(w.calls);
  eq('결과 파일 없음 → --failed 와 사유', c[0] && c[0].slice(0, 3), ['a-20260929-02', '--seq', '1']);
  ok(`실패 사유에 세션 결말이 들어간다 (${c[0] && c[0][4]})`, c[0] && c[0][3] === '--failed' && /error_timeout/.test(c[0][4]));
  eq('실패 뒤에도 next 를 다시 불러 재시도 · 판단 필요로 넘김은 report-log 몫', c.length, 2);
}
{
  // 앞 시도가 남긴 결과 파일 — 이번 세션 성과로 읽으면 안 된다
  const s1 = spec('a-20260929-03', 'review', 1);
  fs.writeFileSync(s1.out, '옛 결과');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(s1.out, old, old);
  const w = world({
    nexts: { 'a-20260929-03': [s1] },
    completes: [{ result: 'failed', state: 'queued' }],
    session: () => ({ text: '', costUsd: 0, sessionId: 's', subtype: 'success', toolCalls: 1 }),
  });
  await w.pipe.drain('a-20260929-03');
  eq('앞 시도의 결과 파일은 이번 성과가 아니다', completes(w.calls)[0][3], '--failed');
}

// ── ③ 사용량 한도 → --rate-limited · 그 차례를 멈춘다 ─────────────────────
{
  const sa = spec('a-20260929-04', 'execute', 1);
  const w = world({
    pending: { run: ['a-20260929-04', 'a-20260929-05'] },
    nexts: { 'a-20260929-04': [sa], 'a-20260929-05': [spec('a-20260929-05', 'verify', 1)] },
    completes: [{ result: 'rate-limited', state: 'executing' }],
    session: () => ({ text: '', costUsd: 0, sessionId: 's', subtype: 'success', rateLimited: true, toolCalls: 2 }),
  });
  await w.pipe.request('run');
  eq('한도 → --rate-limited', completes(w.calls)[0], ['a-20260929-04', '--seq', '1', '--rate-limited']);
  ok('한도 뒤에는 다음 제안을 안 건드린다', !w.calls.some((c) => c[2] === 'a-20260929-05'));
  ok('차례를 시작할 때 원격에 맞춘다', w.calls[0][1] === 'sync');
}

// ── ② 폴백 허용이 아니면 폴백 없음(null) ─────────────────────────────────
{
  const s1 = spec('a-20260929-06', 'review', 1, { fallback: { allowed: false, cwd: '', writable: [] } });
  const w = world({ nexts: { 'a-20260929-06': [s1] }, session: writes(s1.out) });
  await w.pipe.drain('a-20260929-06');
  eq('폴백을 허용하지 않은 작업은 폴백 없음', w.sessions[0].fallbackScope, null);
}

// ── ④ 도는 고리 · 바쁨 ────────────────────────────────────────────────
{
  const again = Array.from({ length: 50 }, () => ({ job: 'again', state: 'final-review' }));
  const w = world({ nexts: { 'a-20260929-07': again } });
  const end = await w.pipe.drain('a-20260929-07');
  const n = w.calls.filter((c) => c[1] === 'next').length;
  ok(`again 이 끝없이 와도 한 차례는 끝난다 (next ${n}번)`, end === 'stop' && n <= 16);
}
{
  const w = world({
    pending: { run: ['a-20260929-08', 'a-20260929-09'] },
    nexts: { 'a-20260929-08': [{ job: 'busy', active: { id: 'x' } }] },
  });
  await w.pipe.request('run');
  ok('다른 작업이 잡혀 있으면 그 차례를 멈춘다', !w.calls.some((c) => c[2] === 'a-20260929-09'));
}

// ── ⑤ 버튼 결정 ────────────────────────────────────────────────────────
{
  const w = world();
  const r1 = await w.pipe.decide('a-2026-09-29', 'approve');
  const r2 = await w.pipe.decide('a-20260929-01', 'delete');
  const r3 = await w.pipe.decide('a-20260929-01;rm', 'approve');
  ok('형식이 틀린 번호 · 모르는 결정은 거절', !r1.ok && !r2.ok && !r3.ok);
  eq('거절할 때는 report-log 를 부르지도 않는다', w.calls.length, 0);
}
{
  const w = world({
    decide: { id: 'a-20260929-10', from: 'proposed', state: 'approved' },
    pending: { run: ['a-20260929-10'] },
  });
  const r = await w.pipe.decide('a-20260929-10', 'approve');
  ok(`진행 → 기록 성공 (${r.note})`, r.ok && /진행/.test(r.note));
  eq('결정은 report_log decide 로', w.calls[0], ['report_log', 'decide', 'a-20260929-10', 'approve', '--by', 'slack']);
  await new Promise((res) => setTimeout(res, 50));
  ok('진행하면 곧바로 실행 차례를 연다(승인 즉시 실행)', w.calls.some((c) => c[1] === 'pending' && c[3] === 'run'));
}
{
  // 계획이 없던 제안의 진행 → report-log 가 검토 대기로 돌림 → 그 한 건을 지금 다시 검토
  const s1 = spec('a-20260929-11', 'review', 1);
  const w = world({
    decide: { id: 'a-20260929-11', from: 'needs-decision', state: 'queued' },
    nexts: { 'a-20260929-11': [s1, { job: 'wait', who: 'human', state: 'proposed' }] },
    session: writes(s1.out),
    digest: { need_you: [NOTICE('a-20260929-11', 'digest', 'proposed', ['approve'])], stuck: [], site: 'https://desk.example' },
  });
  const r = await w.pipe.decide('a-20260929-11', 'approve');
  ok(`계획 없는 진행은 다시 검토로 안내 (${r.note})`, r.ok && /다시 검토/.test(r.note));
  await w.pipe.request('run');
  ok('그 한 건을 지금 검토한다', w.sessions.length === 1);
  ok('검토가 끝나 사람 차례가 되면 바로 알린다', w.posts.some((p) => /다시 검토 끝/.test(p.text)));
}
// ── ⑤b 버튼 답 — 거절은 누른 사람에게만 · 원래 메시지는 그대로(🗂 요약이 거절 답에 덮인 2026-10-06) ──
{
  const msg = {
    text: '🗂 처리 제안',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '요약' } },
      { type: 'actions', block_id: 'actb_a-20260929-01', elements: [] }],
  };
  const refused = decisionReply({ ok: false, note: '⚠️ 보류 상태에서는 「보류」을 할 수 없음' }, msg, 'a-20260929-01', '🗂 처리 제안');
  eq('거절 답은 원래 메시지를 바꿔 쓰지 않는다', refused.replace_original, false);
  eq('거절 답은 누른 사람에게만', refused.response_type, 'ephemeral');
  ok('거절 답은 원래 메시지의 블록을 싣지 않는다', !('blocks' in refused));
  eq('실패 알림도 원래 메시지를 그대로 둔다', noticeReply('❌ 처리 실패').replace_original, false);
  const accepted = decisionReply({ ok: true, note: '*보류* · 08:00' }, msg, 'a-20260929-01', '🗂 처리 제안');
  eq('받아들이면 원래 메시지를 바꿔 쓴다', accepted.replace_original, true);
  eq('누른 제안의 줄만 결과로', accepted.blocks.map((x) => x.block_id ?? x.type), ['section', 'actd_a-20260929-01']);
  // 두 버튼 처리기가 이 둘로만 답하는가 — 옛 모양(`respond({ response_type: 'ephemeral', … })`)이 다시 들어오면 실패
  const src = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  for (const [name, re] of [
    ['처리 제안', /actions_\(approve\|hold\|reject\|reopen\)/],
    ['개선 제안', /improve_\(register\|hold\|drop\)/],
  ]) {
    const at = src.search(re);
    const handler = at < 0 ? '' : src.slice(at, src.indexOf('\n    });', at));
    ok(`${name} 버튼 처리기는 decisionReply · noticeReply 로만 답한다`,
       handler.includes('decisionReply(') && handler.includes('noticeReply(') && !/respond\(\{/.test(handler));
  }
}

// ── ⑥ 아침 요약 ────────────────────────────────────────────────────────
{
  eq('결정할 것도 멈춘 것도 없으면 메시지 없음',
     buildDigestBlocks({ need_you: [], stuck: [], site: 'https://desk.example' }), null);
  eq('끝난 상태만 있으면 여전히 메시지 없음',
     buildDigestBlocks({ need_you: [], stuck: [], site: 'https://desk.example', counts: { achieved: 21, rejected: 9 } }), null);
  // 새벽 검토가 못 돌면(한도 · 실패) 권고가 검토 대기에 쌓인다 — 세지 않으면 아침 요약이 아예 안 뜬다
  const onlyQueued = buildDigestBlocks({ need_you: [], stuck: [], site: 'https://desk.example', counts: { queued: 3, achieved: 2 } });
  ok('검토 대기만 있어도 요약이 뜬다', onlyQueued !== null && JSON.stringify(onlyQueued).includes('검토 대기 3건'));
  const many = Array.from({ length: 30 }, (_, i) => NOTICE(`a-20260929-${String(i + 1).padStart(2, '0')}`,
    'digest', i === 0 ? 'awaiting-second-approval' : i > 25 ? 'reject-proposed' : 'proposed',
    i > 25 ? ['reject', 'reopen'] : ['approve', 'hold', 'reject']));
  const stuck = Array.from({ length: 7 }, (_, i) => NOTICE(`a-20260928-${String(i + 1).padStart(2, '0')}`, 'stuck', 'executing'));
  const b = buildDigestBlocks({ need_you: many, stuck, site: 'https://desk.example' });
  ok(`30건 + 멈춤 7건이어도 슬랙 한 메시지 50블록 안 (${b.length})`, b.length <= 50);
  const acts = b.filter((x) => x.type === 'actions');
  ok('버튼 줄은 제안마다 block_id 로 구분', acts.every((a) => /^actb_a-\d{8}-\d{2}$/.test(a.block_id)));
  const first = acts[0].elements;
  eq('버튼 값은 제안 번호뿐 · 결정은 action_id', first.map((e) => [e.action_id, e.value]),
     [['actions_approve', 'a-20260929-01'], ['actions_hold', 'a-20260929-01'], ['actions_reject', 'a-20260929-01']]);
  eq('두 번째 승인의 진행 버튼은 「실행」', first[0].text.text, '실행');
  ok('넘친 것은 desk 로 안내', JSON.stringify(b).includes('그 외'));
  const few = buildDigestBlocks({
    need_you: [NOTICE('a-20260929-01', 'digest', 'reject-proposed', ['reject', 'reopen']),
               NOTICE('a-20260929-02', 'digest', 'proposed', ['approve', 'hold', 'reject'])],
    stuck: [], site: 'https://desk.example',
  });
  const order = few.filter((x) => x.type === 'actions').map((x) => x.block_id);
  eq('폐기 제안은 결정할 것 뒤로', order, ['actb_a-20260929-02', 'actb_a-20260929-01']);
  const after = markDecided(few, 'a-20260929-02', '*진행*');
  eq('누른 제안의 버튼 줄만 결과 한 줄로',
     after.filter((x) => x.type === 'actions').map((x) => x.block_id), ['actb_a-20260929-01']);
}
{
  // 세 브리핑(예약 · 놓친 것 · 수동) 모두에 붙는가 — NAS 확인 요청이 놓친 브리핑에서 빠진 선례.
  // 예약 · 놓친 것은 **돌려서** 본다 — 브리핑 결과와 무관하게 한 번 붙어야 한다. 예전에는 함수 본문에
  // 글자가 있는지만 봐서, 브리핑 세션이 한도 · 실패로 끝난 날 요약까지 빠지는 것을 못 잡았다(2026-10-07 검토 K7).
  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  const manual = handler.slice(handler.indexOf('this.isBriefingCommand(text)'), handler.indexOf('this.isReportCommand(text)'));
  ok('수동 -briefing 에 처리 제안 요약', manual.includes('actionDigestBlocks('));

  const { AssistantScheduler } = require(path.join(ROOT, 'dist', 'assistant-scheduler.js'));
  const nas = require(path.join(ROOT, 'dist', 'nas-confirm.js'));
  const CFG = path.join(tmp, 'brief-cfg');
  fs.mkdirSync(path.join(CFG, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({
    briefing: { time: '00:00', enabled: true, excludeCalendars: [] },
    reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5, workingHoursStart: '08:00', workingHoursEnd: '20:00' },
    analysis: { schedule: 'saturday-00:00', defaults: {}, types: {} },
  }));
  const savedNas = nas.listNasQueue;
  nas.listNasQueue = async () => { throw new Error('시험 — NAS 큐는 안 본다'); };
  const OK = { text: '☀️ 브리핑', costUsd: 0, sessionId: 's', subtype: 'success', isError: false, toolCalls: 3 };
  /** 브리핑 세션만 갈아 끼운 스케줄러 — 세션 · report-log · 비용 원장 · 개선 제안은 안 부른다. */
  const brief = (how) => {
    const sent = [];
    const s = new AssistantScheduler(async (text) => { sent.push(text); },
      async () => { throw new Error('시험이 세션을 불렀다'); }, CFG);
    s.loadConfig();
    s.recordSessionCost = () => {};
    s.isNonWorkingDay = () => ({ skip: false });
    s.executeBriefing = async () => { if (how instanceof Error) throw how; return { ...how }; };
    s.actionDigestBlocks = async () => [{ type: 'section', text: { type: 'mrkdwn', text: '요약' } }];
    s.improveForBriefing = async () => null;
    return { s, sent };
  };
  const digests = (sent) => sent.filter((t) => t === '🗂 처리 제안').length;
  try {
    for (const [label, how] of [
      ['정상', OK],
      ['한도(결과)', { ...OK, text: '', rateLimited: true }],
      ['한도(던짐)', new Error('Claude usage limit reached')],
      ['실패(던짐)', new Error('브리핑 터짐 시험')],
    ]) {
      const { s, sent } = brief(how);
      let armed = 0;
      s.getNextWorkingDay = () => new Date(Date.now() + (armed++ === 0 ? 5 : 86_400_000));
      s.scheduleBriefing();
      for (let i = 0; i < 200 && armed < 2; i++) await new Promise((r) => setTimeout(r, 10));
      s.stop();
      eq(`예약 브리핑 ${label} — 🗂 요약 한 번`, digests(sent), 1);
      const c = brief(how);
      await c.s.catchUpBriefingIfNeeded();
      eq(`놓친 브리핑 ${label} — 🗂 요약 한 번`, digests(c.sent), 1);
    }

    // 요약을 못 만들면 「시스템 이슈」로 — 「결정할 것 없음」(메시지 없음)과 갈려야 한다
    errorCollector.getAndClear();
    const bad = world({ digest: { error: 'rc 1 · 요약 시험' } });
    eq('report-log 를 못 읽으면 요약 없음', await bad.pipe.digestBlocks(), null);
    ok('요약을 못 읽은 것은 시스템 이슈로', errorCollector.getAndClear().some((e) => e.message.includes('rc 1 · 요약 시험')));
    const quiet = world({ digest: { need_you: [], stuck: [], site: 'https://desk.example' } });
    eq('결정할 것이 없으면 요약 없음', await quiet.pipe.digestBlocks(), null);
    eq('결정할 것 없음은 시스템 이슈가 아니다', errorCollector.getAndClear().length, 0);
    const { s: thrower } = brief(OK);
    thrower.actionDigestBlocks = async () => { throw new Error('요약 터짐 시험'); };
    await thrower.postActionDigest();
    ok('요약이 던지면 시스템 이슈로', errorCollector.getAndClear().some((e) => e.message.includes('요약 터짐 시험')));
    const unsent = new AssistantScheduler(async () => { throw new Error('슬랙 보내기 실패 시험'); },
      async () => { throw new Error('시험이 세션을 불렀다'); }, CFG);
    unsent.actionDigestBlocks = async () => [{ type: 'section', text: { type: 'mrkdwn', text: '요약' } }];
    await unsent.postActionDigest();
    ok('요약을 못 보내면 시스템 이슈로', errorCollector.getAndClear().some((e) => e.message.includes('슬랙 보내기 실패 시험')));
  } finally {
    nas.listNasQueue = savedNas;
  }
}

// ── ⑥b 읽는 쪽 전환(report-log 4단계) — `-report` 는 요약 + desk 링크 · 옛 보고서 훑기는 없음 ──
{
  const site = 'https://desk.example';
  const none = buildReportReplyBlocks({ need_you: [], stuck: [], site });
  const text = JSON.stringify(none);
  ok('결정할 것이 없어도 답이 있다(빈 답 금지)', none.length === 2 && text.includes('결정할 것 없음'));
  ok('종류가 없으면 desk 첫 화면', text.includes(`<${site}/|desk 에서 보고서 보기>`));
  const typed = JSON.stringify(buildReportReplyBlocks({ need_you: [], stuck: [], site }, 'kg-health'));
  ok('종류를 주면 그 종류의 회차 목록', typed.includes(`${site}/reports/kg-health/`));
  const need = buildReportReplyBlocks({
    need_you: [NOTICE('a-20260929-02', 'digest', 'proposed', ['approve', 'hold', 'reject'])], stuck: [], site,
  });
  ok('결정할 것이 있으면 요약 버튼이 먼저 · 링크는 끝', need.some((x) => x.type === 'actions')
     && need[need.length - 1].type === 'context' && JSON.stringify(need[need.length - 1]).includes('📚'));

  // 이름 일부 — 예전 `-report kg` 는 kg-health · kg-regression 을 함께 찾았다. 없는 주소로 링크하면 desk 404
  const types = ['data-sync', 'data-sync-noon', 'kg-health', 'kg-regression', 'kg-skill-update', 'skill-review'];
  const last = (b) => JSON.stringify(b[b.length - 1]);
  const exact = last(buildReportReplyBlocks({ need_you: [], stuck: [], site }, 'data-sync', types));
  ok('정확히 맞으면 그 종류 하나(data-sync-noon 을 끌어오지 않음)',
     exact.includes(`${site}/reports/data-sync/`) && !exact.includes('data-sync-noon'));
  const partial = last(buildReportReplyBlocks({ need_you: [], stuck: [], site }, 'kg', types));
  ok('일부면 맞는 종류 전부', ['kg-health', 'kg-regression', 'kg-skill-update'].every((t) => partial.includes(`${site}/reports/${t}/`))
     && !partial.includes(`${site}/reports/kg/`));
  const miss = last(buildReportReplyBlocks({ need_you: [], stuck: [], site }, 'zzz', types));
  ok('맞는 것이 없으면 없는 주소 대신 첫 화면과 그 사실', miss.includes('맞는 보고서 종류 없음') && miss.includes(`<${site}/|`)
     && !miss.includes('/reports/zzz/'));
  const many = Array.from({ length: 12 }, (_, i) => `kg-t${i}`);
  ok('너무 많이 맞으면 줄이고 나머지 수', last(buildReportReplyBlocks({ need_you: [], stuck: [], site }, 'kg', many)).includes('외 4종'));

  // 블록 수 — 요약이 최대일 때(18건 · 폐기 제안 · 멈춤)도 링크 한 줄을 더해 슬랙 한 메시지 50블록 안
  const maxNeed = Array.from({ length: 30 }, (_, i) => NOTICE(`a-20260930-${String(i + 1).padStart(2, '0')}`,
    'digest', i > 20 ? 'reject-proposed' : 'proposed', ['approve', 'hold', 'reject']));
  const maxStuck = Array.from({ length: 7 }, (_, i) => NOTICE(`a-20260927-${String(i + 1).padStart(2, '0')}`, 'stuck', 'executing'));
  const biggest = buildReportReplyBlocks({ need_you: maxNeed, stuck: maxStuck, site, counts: { queued: 5 } }, 'kg', types);
  ok(`최대 요약 + 링크도 50블록 안 (${biggest.length})`, biggest.length <= 50);

  // 옛 보고서 훑기가 남아 있지 않은가 — 다시 들어오면 브리핑 뒤 「보고서 확인」 버튼이 되살아난다
  const src = ['assistant-scheduler.ts', 'slack-handler.ts', 'report-server.ts']
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf-8')).join('\n');
  ok('「보고서 확인」 버튼을 새로 만들지 않는다', !/action_id: 'briefing_view_reports'/.test(src));
  ok('보관 버튼을 새로 만들지 않는다', !/action_id: 'archive_(report|all_reports|clean_reports)'/.test(src));
  ok('매니페스트(_status.json)를 읽지 않는다', !src.includes('_status.json'));
  const handler = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf-8');
  ok('옛 버튼은 처리기가 남아 있다(이미 올라간 메시지)', handler.includes("this.action('briefing_view_reports'")
     && handler.includes('archive_(report|all_reports|clean_reports)'));
}

// ── 명령이 다른 명령에 먹히지 않는가 — `-actions` 가 계정 명령(`-ac…`)으로 읽혔다(2026-09-29) ──
// 판정 함수를 전부 불러 **정확히 하나**만 받아야 한다. 순서에 기대면 앞 판정이 넓어질 때 조용히 샌다.
{
  const { SlackHandler } = require(path.join(ROOT, 'dist', 'slack-handler.js'));
  const proto = SlackHandler.prototype;
  const judges = Object.getOwnPropertyNames(proto).filter((n) => /^is[A-Z]\w*Command$/.test(n));
  ok(`명령 판정 함수를 찾는다 (${judges.length}개)`, judges.length >= 10 && judges.includes('isActionsCommand'));
  const who = (text) => judges.filter((n) => {
    try { return proto[n].call({}, text) === true; } catch { return false; }
  });
  for (const text of ['-actions', '-actions review', '-actions run', '`-actions` review']) {
    eq(`「${text}」은 처리 제안 명령 하나만 받는다`, who(text), ['isActionsCommand']);
  }
  for (const text of ['-ac', '-ac 1', '-account', '-account setup', '`-ac`']) {
    eq(`「${text}」은 여전히 계정 명령`, who(text), ['isAccountCommand']);
  }
}

// ── ⑦ 밤 검토 시간대 ──────────────────────────────────────────────────
{
  eq('시간대 읽기', parseWindow('02:00-07:00'), [120, 420]);
  eq('거꾸로 된 시간대는 안 켠다', parseWindow('07:00-02:00'), null);
  eq('못 읽으면 안 켠다', parseWindow('밤'), null);
  const at = (h, m) => { const d = new Date(2026, 8, 29, h, m); return d; };
  const kinds = async (opts, now) => {
    const w = world();
    await w.pipe.tick(opts, now);
    return w.calls.filter((c) => c[1] === 'pending').map((c) => c[3]);
  };
  const on = { review: true, window: [120, 420], workingDay: true };
  eq('업무일 02:30 → 이어 가기 + 검토', await kinds(on, at(2, 30)), ['run', 'review']);
  eq('업무일 07:30 → 이어 가기만', await kinds(on, at(7, 30)), ['run']);
  eq('쉬는 날 → 이어 가기만', await kinds({ ...on, workingDay: false }, at(2, 30)), ['run']);
  eq('밤 검토를 안 켰으면 → 이어 가기만', await kinds({ ...on, review: false }, at(2, 30)), ['run']);
}

// ── ⑧ 한도로 끊긴 사람이 시킨 검토 — 회복 뒤 이어 감 · 재시작에도 남음 · 밤 검토는 안 남김 ──
// 남기지 않던 동안 10/2 17:13 의 `-actions review` 가 한도에 걸리는 순간 사라져, 검토 대기 7건이
// 다음 업무일 새벽까지 그대로 있었다.
{
  const parked = () => (fs.existsSync(RESUME_FILE) ? JSON.parse(fs.readFileSync(RESUME_FILE, 'utf-8')) : null);
  const put = (p) => fs.writeFileSync(RESUME_FILE, JSON.stringify(p));
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const limited = (at) => () => ({
    text: '', costUsd: 0, sessionId: 's', subtype: 'success', rateLimited: true, rateLimitResetsAt: at, toolCalls: 8,
  });
  const cut = (id) => ({
    pending: { review: [id, 'a-20261002-27'], run: [id] },
    nexts: { [id]: [spec(id, 'review', 1)] },
    completes: [{ result: 'rate-limited', state: 'queued' }],
  });

  {
    const w = world({ ...cut('a-20261002-21'), session: limited(resetsAt) });
    await w.pipe.request('review');
    eq('-actions review 가 한도에 끊기면 검토 몫과 회복 시각을 남긴다',
       parked() && [parked().review, parked().ids, parked().resetsAt], [true, [], resetsAt]);
    ok('한도 뒤 다음 제안은 안 건드린다', !w.calls.some((c) => c[2] === 'a-20261002-27'));
    ok('회복 타이머를 건다', w.pipe.resumeTimer !== null);
    w.pipe.stopResume();
    ok('stopResume 이 타이머를 푼다', w.pipe.resumeTimer === null);
    const restarted = world();
    restarted.pipe.restoreResume();
    ok('재시작한 실행기도 파일에서 회복 타이머를 다시 건다', restarted.pipe.resumeTimer !== null);
    restarted.pipe.stopResume();
  }
  {
    let after = 0;
    const s = spec('a-20261002-21', 'review', 2);
    const w = world({
      pending: { review: ['a-20261002-21'] },
      nexts: { 'a-20261002-21': [s, { job: 'wait', who: 'human', state: 'proposed' }] },
      session: writes(s.out),
      afterResume: async () => { after += 1; },
    });
    await w.pipe.resume();
    ok('회복 뒤 검토 대기를 다시 검토한다',
       w.calls.some((c) => c[1] === 'pending' && c[3] === 'review') && w.sessions.length === 1);
    eq('다 끝나면 요약 DM 한 번', after, 1);
    eq('이어 간 몫은 지운다', parked(), null);
  }
  {
    let after = 0;
    put({ review: true, ids: [], resetsAt });
    const w = world({ ...cut('a-20261002-22'), session: limited(resetsAt + 600), afterResume: async () => { after += 1; } });
    await w.pipe.resume();
    eq('회복 뒤에도 또 한도면 다시 남기고 새 회복 시각을 쓴다',
       parked() && [parked().review, parked().resetsAt], [true, resetsAt + 600]);
    eq('다시 남겼으면 요약은 아직 안 보낸다', after, 0);
    w.pipe.stopResume();
    fs.rmSync(RESUME_FILE, { force: true });
  }
  {
    const w = world({ ...cut('a-20261002-23'), session: limited(resetsAt) });
    await w.pipe.request('review', Date.now() + 3600_000);
    eq('밤 검토(시간대 있음)는 한도에 끊겨도 남기지 않는다', parked(), null);
    ok('밤 검토는 회복 타이머도 안 건다', w.pipe.resumeTimer === null);
  }
  {
    const w = world({ ...cut('a-20261002-04'), session: limited(resetsAt) });
    const p = w.pipe.request('run');
    void w.pipe.request('review');
    await p;
    eq('이어 가기가 한도에 끊기면 뒤에 기다리던 -actions review 도 남긴다', parked() && parked().review, true);
    w.pipe.stopResume();
    fs.rmSync(RESUME_FILE, { force: true });
  }
  {
    const w = world({ ...cut('a-20261002-08'), session: limited(undefined) });
    await w.pipe.request('one', 'a-20261002-08');
    eq('계획 없는 [진행]으로 집은 한 건은 번호를 남긴다 · 회복 시각을 모르면 null',
       parked() && [parked().review, parked().ids, parked().resetsAt], [false, ['a-20261002-08'], null]);
    w.pipe.stopResume();
  }
  {
    put({ review: true, ids: ['a-20261002-08'], resetsAt });
    const w = world();
    w.pipe.restoreResume();
    await w.pipe.request('review');
    eq('사람이 다시 시킨 검토는 남긴 검토 몫을 지운다', parked() && [parked().review, parked().ids], [false, ['a-20261002-08']]);
    ok('남은 번호가 있으면 회복 타이머는 그대로', w.pipe.resumeTimer !== null);
    await w.pipe.request('one', 'a-20261002-08');
    eq('다 지우면 파일도 없앤다', parked(), null);
    ok('다 지우면 회복 타이머도 푼다', w.pipe.resumeTimer === null);
  }
  {
    // 밤 검토가 도는 중에 사람이 -actions review 를 보냄 → 그 밤 검토가 한도에 끊김 → 사람 몫은 남는다
    // (돌던 밤 검토 r 만 보고 남기던 동안 사람 요청이 clear() 로 사라졌다 · 10/6 검토)
    let w;
    w = world({ ...cut('a-20261002-30'), session: () => { void w.pipe.request('review'); return limited(resetsAt)(); } });
    await w.pipe.request('review', Date.now() + 3600_000);
    eq('밤 검토 도중 들어온 사람 요청은 한도에 끊겨도 남긴다', parked() && parked().review, true);
    w.pipe.stopResume();
    fs.rmSync(RESUME_FILE, { force: true });
  }
  {
    // 사람 요청이 이어 가기 뒤에 기다리는데 밤 타이머가 시간대를 붙여 덮어씀 → 사람 표시가 남아야 한다
    const id = 'a-20261002-31';
    const w = world({
      pending: { review: [id], run: [] }, nexts: { [id]: [spec(id, 'review', 1)] },
      completes: [{ result: 'rate-limited', state: 'queued' }], session: limited(resetsAt),
    });
    const p = w.pipe.request('run');
    void w.pipe.request('review');
    void w.pipe.request('review', Date.now() + 3600_000);
    await p;
    eq('뒤에 온 밤 검토가 기다리던 사람 요청을 덮지 않는다', parked() && parked().review, true);
    w.pipe.stopResume();
    fs.rmSync(RESUME_FILE, { force: true });
  }
  {
    // 이어 가는 동안에는 미룬 몫 파일을 남겨 둔다 — 도중 재시작 · 오류가 나도 기동이 다시 건다
    put({ review: true, ids: [], resetsAt });
    let during = null;
    let after = 0;
    const id = 'a-20261002-32';
    const s = spec(id, 'review', 2);
    const w = world({
      pending: { review: [id] }, nexts: { [id]: [s, { job: 'wait', who: 'human', state: 'proposed' }] },
      session: () => { during = parked(); return writes(s.out)(); },
      afterResume: async () => { after += 1; },
    });
    await w.pipe.resume();
    ok('이어 가는 동안 미룬 몫 파일이 남아 있다', during !== null && during.review === true);
    eq('다 끝나면 지우고 요약 한 번', [parked(), after], [null, 1]);
  }
  {
    // 이어 가는 중에 사람이 다시 -actions review → 요약은 그 요청이 맡는다(두 번 안 보냄)
    put({ review: true, ids: [], resetsAt });
    let after = 0;
    let w;
    const id = 'a-20261002-33';
    const s = spec(id, 'review', 2);
    w = world({
      pending: { review: [id] }, nexts: { [id]: [s, { job: 'wait', who: 'human', state: 'proposed' }] },
      session: () => { void w.pipe.request('review'); return writes(s.out)(); },
      afterResume: async () => { after += 1; },
    });
    await w.pipe.resume();
    eq('이어 가는 중 사람이 다시 시키면 이어 가기는 요약을 안 보낸다', after, 0);
    eq('그 요청이 미룬 몫을 지운다', parked(), null);
  }
  {
    // 짝 — 설정 저장마다 clearAllTimers 가 지우고 scheduleAll → startActionsTicker 가 다시 건다
    const sched = fs.readFileSync(path.join(ROOT, 'src', 'assistant-scheduler.ts'), 'utf-8');
    const from = (name) => sched.indexOf(`private ${name}(`);
    const clearBody = sched.slice(from('clearAllTimers'), sched.indexOf('\n  }\n', from('clearAllTimers')));
    const startBody = sched.slice(from('startActionsTicker'), sched.indexOf('\n  }\n', from('startActionsTicker')));
    ok('clearAllTimers 가 회복 타이머를 푼다', clearBody.includes('this.actionPipeline.stopResume()'));
    ok('startActionsTicker 가 회복 타이머를 되살린다', startBody.includes('this.actionPipeline.restoreResume()'));
    ok('회복 뒤 끝맺음은 -actions review 와 같은 요약 DM', sched.includes('afterResume: () => this.postActionDigest()'));
  }
}

// ── ② Codex 폴백의 쓰기 범위 · SDK 추가 폴더 ─────────────────────────────
{
  const args = codexSessionArgs({ workingDirectory: 'W', writableDirs: ['J'] }, 'OUT');
  const addDirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
  eq('범위를 받으면 그 폴더만 쓰기를 연다', addDirs, ['J']);
  eq('작업 폴더는 범위의 cwd', args[args.indexOf('-C') + 1], 'W');
  const none = codexSessionArgs({ workingDirectory: 'W', writableDirs: [] }, 'OUT');
  eq('빈 범위면 추가로 여는 곳 없음', none.filter((a) => a === '--add-dir').length, 0);
}
{
  const seen = [];
  const saved = SdkHandler.queryFn;
  SdkHandler.queryFn = ({ options }) => {
    seen.push(options);
    return { async *[Symbol.asyncIterator]() {}, interrupt() {} };
  };
  const h = new SdkHandler({ getServerConfiguration: () => ({}), getDefaultAllowedTools: () => [] });
  h.runQuery('x', { workingDirectory: 'W', additionalDirectories: ['J1', 'J2'], skipMcp: true });
  h.runQuery('y', { workingDirectory: 'W', skipMcp: true });
  SdkHandler.queryFn = saved;
  eq('SDK 에 추가 폴더가 넘어간다', seen[0].additionalDirectories, ['J1', 'J2']);
  eq('안 주면 안 넘긴다', seen[1].additionalDirectories, undefined);
}

// ── ② 스케줄러: 폴백 없음(null)이면 Codex 를 안 부른다 ───────────────────
{
  const evFile = EVENTS_FILE;
  const { AssistantScheduler } = await import('../dist/assistant-scheduler.js');
  const { config } = await import('../dist/config.js');
  const sched = new AssistantScheduler(async () => {},
    async () => ({ text: '', costUsd: 0, sessionId: 's', subtype: 'error', isError: true, toolCalls: 0 }),
    config.assistant.configDir);
  await sched.spawnOrFallback('시험', '아무 말', { workingDirectory: tmp, fallbackScope: null });
  const ev = fs.existsSync(evFile)
    ? fs.readFileSync(evFile, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  eq('폴백 없음이면 건너뛴다고 남기고 부르지 않는다', ev.map((e) => e.skipped), ['off']);
}

fs.rmSync(tmp, { recursive: true, force: true });
try { fs.unlinkSync(EVENTS_FILE); } catch { /* 안 썼으면 없다 */ }
fs.rmSync(RESUME_FILE, { force: true });

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 처리 제안 실행기 (결과는 파일로만 · 폴백은 받은 범위만 · 한도에서 멈춤 · '
    + '도는 고리 끊김 · 버튼 값 검사 · 요약 50블록 안 · 세 브리핑 · 밤 검토 시간대 · 한도 회복 뒤 이어 감)');
}
