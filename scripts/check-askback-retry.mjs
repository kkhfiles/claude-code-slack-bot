/**
 * 예약 분석 세션의 **되물음 재시도** — 도구 0회로 끝난 회차를 성공으로 적지 않나.
 *
 *   npm run build
 *   npm run check:askback
 *
 * 2026-09-12 토요일 archive-sync·product-docs 세션이 7초 만에 「what would you like
 * me to do?」로 끝났고(도구 0회) `completed` 로 기록됐다. 09-09 자정과 같은 유형이다.
 * 처방은 셋이고 **셋 다 여기서 실행으로 잰다** — 소스 모양만 보면 「멀쩡해 보이는데
 * 안 도는」 판을 못 잡는다.
 *
 *   ① 도구 0회 + 보고서 없음 → 머리말(`[지시]`)을 붙여 **새 세션으로 한 번** 재시도
 *   ② 재시도도 도구 0회 → `noOutput` (완료가 아니다 · 저널에 `no-output`)
 *   ③ 안 하는 셋 — 몇 번 돌렸는지 **모름**(`undefined`) · 이어받는 회차 · 보고서를 남긴 회차
 *
 * 시스템 프롬프트에 「사람이 없는 예약 실행」 지시가 붙는지도 본다 — 되묻는 것을
 * 막는 첫 층이라, 빠지면 재시도 층만 남는다.
 *
 * **외부 서비스를 안 부른다** — 가짜 spawnSession 이 회차 결과를 흉내 낸다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const evFile = path.join(os.tmpdir(), `wa-askback-${Date.now()}.jsonl`);
process.env.WORK_EVENTS_FILE = evFile;
function readEvents() {
  if (!fs.existsSync(evFile)) return [];
  return fs.readFileSync(evFile, 'utf-8').trim().split('\n')
    .filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'analysis-askback');
}

const { AssistantScheduler } = await import('../dist/assistant-scheduler.js');

// 임시 레포 모양 — assistant/config.json + prompts/analysis-probe.md. 보고서 디렉터리는
// 비워 둔다(「보고서 없음」이 기본 상태).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'askback-'));
const cfgDir = path.join(root, 'assistant');
fs.mkdirSync(path.join(cfgDir, 'prompts'), { recursive: true });
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
  briefing: { time: '08:00', enabled: false, excludeCalendars: [] },
  reminders: { enabled: false, beforeMinutes: 15, pollingIntervalMinutes: 5,
    workingHoursStart: '08:00', workingHoursEnd: '20:00' },
  analysis: {
    schedule: 'saturday-00:00',
    defaults: { allowedTools: ['Read', 'Write'], writablePaths: ['reports/'], maxRetries: 0 },
    types: { probe: { enabled: true, cadence: 'weekly', model: 'sonnet', effort: 'low' } },
  },
}), 'utf-8');
fs.writeFileSync(path.join(cfgDir, 'prompts', 'analysis-probe.md'),
  '# Probe (Weekly)\n\n매주 토요일에 무언가를 동기화합니다.\n', 'utf-8');

const ASKED = { text: 'Ready — what would you like me to do?', costUsd: 0, sessionId: 's0',
  subtype: 'success', isError: false, toolCalls: 0 };
const WORKED = { text: '보고서를 썼다', costUsd: 0.01, sessionId: 's1',
  subtype: 'success', isError: false, toolCalls: 5 };

/** 회차마다 다른 결과를 주는 가짜 spawnSession. 받은 프롬프트·옵션을 모아 둔다. */
function harness(results) {
  const calls = [];
  const sched = new AssistantScheduler(
    async () => {},
    async (prompt, opts) => {
      calls.push({ prompt, opts });
      const r = results.shift();
      if (!r) throw new Error('예상보다 많이 불렀다');
      return typeof r === 'function' ? r() : r;
    },
    cfgDir,
  );
  sched.loadConfig();
  // 비용 원장(실파일)에 시험 회차를 남기지 않는다.
  sched.recordSessionCost = () => {};
  return { sched, calls };
}

// ── ① 되묻고 끝남 → 머리말 붙여 한 번 재시도 → 두 번째가 일하면 완료 ──
{
  const before = readEvents().length;
  const { sched, calls } = harness([ASKED, WORKED]);
  const r = await sched.runSingleAnalysis('probe');
  eq('세션을 두 번 띄운다', calls.length, 2);
  ok('첫 회차는 원 프롬프트 그대로', calls[0].prompt.startsWith('# Probe (Weekly)'));
  ok('두 번째 회차는 [지시] 머리말로 시작', calls[1].prompt.startsWith('[지시]'));
  ok('머리말 뒤에 원 프롬프트가 그대로 온다', calls[1].prompt.includes('# Probe (Weekly)'));
  eq('두 번째가 일하면 완료로 돌아온다', [r.noOutput ?? false, r.rateLimited, r.timedOut], [false, false, false]);
  ok('시스템 프롬프트에 예약 실행 지시가 붙는다',
     /사람이 없는 예약 실행/.test(calls[0].opts.appendSystemPrompt || ''));
  ok('쓰기 경로 제한도 그대로 남는다',
     /CRITICAL: reports\//.test(calls[0].opts.appendSystemPrompt || ''));
  const ev = readEvents().slice(before);
  eq('재시도를 관찰 기록에 남긴다', ev.map((e) => [e.type, e.retried]), [['probe', true]]);
}

// ── ② 재시도도 되묻고 끝남 → noOutput (완료 아님) ──────────────
{
  const { sched, calls } = harness([ASKED, { ...ASKED, sessionId: 's0b' }]);
  const r = await sched.runSingleAnalysis('probe');
  eq('두 번만 띄운다 — 세 번째는 없다', calls.length, 2);
  eq('두 번 다 빈손이면 noOutput', r.noOutput, true);
  eq('리미트·타임아웃으로 오인하지 않는다', [r.rateLimited, r.timedOut], [false, false]);
}

// ── ③-a 몇 번 돌렸는지 모르면(undefined) → 재시도 안 함 ────────
{
  const { toolCalls, ...unknown } = ASKED;
  const { sched, calls } = harness([unknown]);
  const r = await sched.runSingleAnalysis('probe');
  eq('모르는 것을 0 으로 안 읽는다 — 한 번만', calls.length, 1);
  ok('noOutput 으로 적지도 않는다', !r.noOutput);
}

// ── ③-b 이어받는 회차 → 재시도 안 함 ──────────────────────────
{
  const { sched, calls } = harness([ASKED]);
  await sched.runSingleAnalysis('probe', 'resume-abc');
  eq('이어받는 회차는 한 번만', calls.length, 1);
  eq('이어받는 프롬프트는 continue 한 낱말', calls[0].prompt, 'continue');
}

// ── ③-c 도구 0회여도 보고서를 남겼으면(codex 폴백 모양) → 재시도 안 함 ─
{
  const dir = path.join(root, 'reports', 'scheduled-reports', 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const { sched, calls } = harness([() => {
    // 세션이 도는 동안 보고서가 쓰였다고 치자.
    fs.writeFileSync(path.join(dir, '2026-09-12.md'), '# probe\n', 'utf-8');
    return ASKED;
  }]);
  const r = await sched.runSingleAnalysis('probe');
  eq('보고서가 있으면 도구 0회여도 한 번만', calls.length, 1);
  ok('완료로 돌아온다', !r.noOutput);
  fs.rmSync(dir, { recursive: true, force: true });
}

delete process.env.WORK_EVENTS_FILE;
try { fs.unlinkSync(evFile); } catch { /* 없으면 그만 */ }
fs.rmSync(root, { recursive: true, force: true });

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — 되물음 재시도 (도구 0회는 머리말로 1회 재시도 · 두 번 빈손은 noOutput · '
    + '모름·이어받기·보고서 있음은 안 함 · 예약 실행 지시가 시스템 프롬프트에 붙음)');
}
