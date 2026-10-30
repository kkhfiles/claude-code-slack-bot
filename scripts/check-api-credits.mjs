/**
 * API 크레딧 장부(봇 쪽) — 고르는 규칙이 파이썬 정본(llm-playbook `credits.py`)과 같은가 · Claude 막힘 판단.
 *
 *   npm run check:apicredits     (먼저 `npm run build`)
 *
 * 같은 장부 파일을 두 쪽이 쓴다. 규칙이 어긋나면 한쪽은 크레딧으로, 다른 쪽은 구독으로 띄운다 — 그래서 같은 장부 ·
 * 같은 시각에서 **파이썬이 고른 키와 봇이 고른 키를 맞대 본다**(파이썬이 없으면 그 대조만 건너뛰고 알린다).
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-api-credits-'));
const LEDGER = path.join(TMP, 'api-credits.json');
process.env.LLM_PLAYBOOK_CREDITS = LEDGER;
process.env.ENGINE_STATE_FILE = path.join(TMP, 'engine-state.json');

const ac = require(path.join(DIST, 'api-credits.js'));
const { EngineState } = require(path.join(DIST, 'engine-state.js'));

const fails = [];
const notes = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
};

const KST = (day, hh = 12) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:00:00+09:00`);
const write = (o) => fs.writeFileSync(LEDGER, JSON.stringify({ v: 1, margin: 0.03, ...o }));
const base = {
  max: { key_file: 'K-max', grant_usd: 96.35, expires: '2026-11-01', spent_usd: 0 },
  team: { key_file: 'K-team', grant_usd: 500, expires: '2026-11-05', spent_usd: 0 },
};
const name = (now) => ac.pickCreditKey(now)?.name ?? null;

try {
  write({ enabled: false, keys: base });
  eq('꺼짐 — 안 고름', name(KST('2026-10-22')), null);
  write({ enabled: true, keys: base });
  eq('만료가 이른 키부터', name(KST('2026-10-22')), 'max');
  eq('만료일 전날 밤까지', name(KST('2026-10-31', 23)), 'max');
  eq('만료일 0시에 다음 키', name(KST('2026-11-01', 0)), 'team');
  eq('둘 다 만료 — 없음', name(KST('2026-11-05', 0)), null);
  // 쓴 금액(추정)으로는 멈추지 않는다 — 멈추는 것은 서버의 잔액 부족(막힘)뿐(2026-10-23 사용자 결정)
  write({ enabled: true, keys: { ...base, max: { ...base.max, spent_usd: 500 } } });
  eq('추정 사용액이 받은 금액을 넘어도 그 키', name(KST('2026-10-22')), 'max');
  write({ enabled: true, keys: { ...base, max: { ...base.max, blocked: { why: 'x', at: 1 } } } });
  eq('막힌 키 건너뜀', name(KST('2026-10-22')), 'team');
  fs.writeFileSync(LEDGER, '{깨짐');
  eq('깨진 장부 — 없음', name(KST('2026-10-22')), null);
  ac.recordCreditSpend('max', 1);
  eq('깨진 장부는 덮어쓰지 않음', fs.readFileSync(LEDGER, 'utf-8'), '{깨짐');
  fs.rmSync(LEDGER);
  eq('장부 없음 — 없음', name(KST('2026-10-22')), null);

  // 쓴 금액 · 날짜별 합 · 막기
  write({ enabled: true, keys: base });
  ac.recordCreditSpend('team', 0.25, KST('2026-10-22'));
  ac.recordCreditSpend('team', 0.25, KST('2026-10-22'));
  ac.blockCreditKey('max', 'server: credit balance is too low');
  const st = JSON.parse(fs.readFileSync(LEDGER, 'utf-8'));
  eq('쓴 금액과 날짜별 합', [st.keys.team.spent_usd, st.keys.team.daily['2026-10-22']], [0.5, 0.5]);
  eq('막힘 표시', !!st.keys.max.blocked, true);
  eq('남이 쓴 칸은 그대로', [st.v, st.margin], [1, 0.03]);

  // 사용 내역 — 더할 때마다 장부 옆 한 줄(파이썬 credits.record 와 같은 칸). 2026-10-23: 합계만 있어 누가 더했는지 못 갈랐다.
  const HISTORY = path.join(TMP, 'api-credits.history.jsonl');
  ac.recordCreditSpend('team', 0.5, KST('2026-10-23'), LEDGER, { session: 's-1', auth: 'ANTHROPIC_API_KEY', model: 'm', caller: 'sdk-handler' });
  ac.recordCreditSpend('nobody', 1, KST('2026-10-23'));
  const hist = fs.readFileSync(HISTORY, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const h = hist[hist.length - 1];
  eq('내역 한 줄의 칸', Object.keys(h), ['at', 'by', 'pid', 'key', 'usd', 'session', 'auth', 'model', 'caller']);
  eq('내역 — 값', [h.at, h.by, h.key, h.usd, h.session, h.auth], ['2026-10-23T12:00:00+09:00', 'bot', 'team', 0.5, 's-1', 'ANTHROPIC_API_KEY']);
  eq('더한 것만 남긴다(없는 키 · 깨진 장부는 안 남김)', hist.map((x) => x.usd), [0.25, 0.25, 0.5]);

  // 세션 누적 비용 → 이번 차례 몫 — 2026-10-23 같은 세션이 $44.00 → $44.20 → $46.36 으로 적혀 셋 다 더해졌다
  eq('새로 띄운 세션의 첫 차례는 전부', ac.turnCost('s-new', 0.3, false, KST('2026-10-23'), LEDGER), 0.3);
  eq('다음 차례는 늘어난 만큼', ac.turnCost('s-new', 0.5, false, KST('2026-10-23'), LEDGER), 0.2);
  eq('이어 받은 세션을 처음 보면 0(크레딧 몫을 모름)', ac.turnCost('s-old', 44.0, true, KST('2026-10-23'), LEDGER), 0);
  eq('그 뒤로는 늘어난 만큼', [ac.turnCost('s-old', 44.2, true, KST('2026-10-23'), LEDGER),
    ac.turnCost('s-old', 46.36, true, KST('2026-10-23'), LEDGER)], [0.2, 2.16]);
  eq('다른 프로세스가 적은 기준보다 누적이 줄면 0', ac.turnCost('s-new', 0.1, true, KST('2026-10-23'), LEDGER), 0);
  // 2026-10-30 실측 모양 — 한 세션을 두 프로세스(A·B)가 번갈아 이어 받았다. 그전 규칙은 줄 때마다 누적 전체를 더해
  // 실제 $37.08 을 $102.62 로 셌다. 프로세스마다 자기가 앞서 낸 값(prev)과의 차이만 센다.
  {
    const T = KST('2026-10-23');
    const a1 = ac.turnCost('s-alt', 24.0, true, T, LEDGER);          // A 첫 차례 — 이어 받았고 처음 봄 → 0
    const b1 = ac.turnCost('s-alt', 1.0, true, T, LEDGER);           // B 첫 차례 — 기준(24.0)보다 작음 → 0
    const a2 = ac.turnCost('s-alt', 24.3, true, T, LEDGER, 24.0);    // A 둘째 — 자기 값과의 차이
    const b2 = ac.turnCost('s-alt', 1.4, true, T, LEDGER, 1.0);      // B 둘째 — 자기 값과의 차이
    const a3 = ac.turnCost('s-alt', 24.5, true, T, LEDGER, 24.3);
    eq('번갈아 이어 받아도 늘어난 만큼만', [a1, b1, a2, b2, a3], [0, 0, 0.3, 0.4, 0.2]);
    eq('같은 프로세스에서 값이 줄면 0', ac.turnCost('s-alt', 24.4, true, T, LEDGER, 24.5), 0);
  }
  eq('세션 id 가 없으면 안 셈', ac.turnCost(null, 1, false, KST('2026-10-23'), LEDGER), 0);
  eq('보름 넘은 기준은 걷음', (ac.turnCost('s-x', 1, false, KST('2026-11-10'), LEDGER),
    Object.keys(JSON.parse(fs.readFileSync(LEDGER.replace(/\.json$/, '') + '.sessions.json', 'utf-8')))), ['s-x']);

  // Claude 막힘 — 구독이 막혔어도 크레딧이 있으면 띄울 수 있다
  const es = new EngineState(process.env.ENGINE_STATE_FILE);
  const now = Date.now();
  const future = new Date(now + 10 * 86400_000).toISOString().slice(0, 10);
  es.recordBlocked('claude', { kind: 'usage', until: Math.floor(now / 1000) + 3600 });
  write({ enabled: true, keys: { max: { key_file: 'K', grant_usd: 10, expires: future, spent_usd: 0 } } });
  eq('구독 막힘 + 크레딧 있음 → 막힘 아님', ac.claudeBlocked(es, now), false);
  write({ enabled: false, keys: { max: { key_file: 'K', grant_usd: 10, expires: future, spent_usd: 0 } } });
  eq('구독 막힘 + 크레딧 꺼짐 → 막힘', ac.claudeBlocked(es, now), true);
  // DM 사다리의 막힘 표도 같은 판단 — 크레딧이 있으면 Claude 칸을 건너뛰지 않는다
  const dmf = require(path.join(DIST, 'dm-fallback.js'));
  eq('사다리 막힘 표 — 크레딧 꺼짐이면 Claude 막힘', dmf.ladderBlockedMap(es).claude, true);
  write({ enabled: true, keys: { max: { key_file: 'K', grant_usd: 10, expires: future, spent_usd: 0 } } });
  eq('사다리 막힘 표 — 크레딧 있으면 Claude 안 막힘', dmf.ladderBlockedMap(es).claude, false);
  es.recordOk('claude');
  eq('구독 안 막힘 → 막힘 아님', ac.claudeBlocked(es, now), false);

  // 파이썬 정본과 같은 키를 고르나 — 같은 장부 · 같은 시각
  const py = process.env.LADDER_PYTHON || 'python';
  const cases = [
    ['2026-10-22', 12, { enabled: true, keys: base }],
    ['2026-11-01', 0, { enabled: true, keys: base }],
    ['2026-10-22', 12, { enabled: true, keys: { ...base, max: { ...base.max, spent_usd: 94 } } }],
    ['2026-10-22', 12, { enabled: false, keys: base }],
  ];
  for (const [day, hh, ledger] of cases) {
    write(ledger);
    const at = KST(day, hh);
    const r = spawnSync(py, ['-X', 'utf8', '-c',
      `import json;from llm_playbook import credits;p=credits.pick(${at / 1000});print(json.dumps(p and p['name']))`],
    { encoding: 'utf-8', env: { ...process.env, LLM_PLAYBOOK_CREDITS: LEDGER }, timeout: 60_000 });
    if (r.status !== 0) {
      notes.push(`파이썬 대조 안 봄 — llm_playbook 을 못 부름(${(r.stderr || '').trim().split('\n').pop()})`);
      break;
    }
    eq(`파이썬과 같은 키 — ${day} ${hh}시 ${JSON.stringify(Object.fromEntries(Object.entries(ledger.keys).map(([k, v]) => [k, v.spent_usd])))} 켬=${ledger.enabled}`,
      name(at), JSON.parse(r.stdout.trim()));
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

for (const n of notes) console.log('· ' + n);
if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('통과 — API 크레딧 장부 (꺼짐 · 만료가 이른 키부터 · 만료일 0시 · 추정 사용액으로 안 멈춤 · 막힘 · 깨진 장부 · 날짜별 합 · 세션 누적에서 늘어난 만큼 · Claude 막힘 판단 · 파이썬과 같은 키)');
}
