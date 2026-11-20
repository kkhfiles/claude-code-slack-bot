/**
 * 좁은 길의 GPT 단계 — **모델만 부르는 가벼운 길로 가나**, 받은 답을 **지금과 같은 뜻으로** 넘기나.
 *
 *   npm run build
 *   npm run check:narrowlight
 *
 * 좁은 길은 「글 → 정해진 JSON 하나」라 하네스(`codex exec`)가 할 일이 없다 — 파일 · 도구 · 업무 비서 규칙을
 * 안 쓴다. 그런데 `codex exec` 는 호출마다 전역 지시문 · 스킬 목록 · 훅을 싣는다(2026-11-21 실측: 하네스 길
 * 입력 약 7만 토큰, 같은 일을 모델만 부르는 길로 약 3,950 토큰). 그래서 봇의 다른 글 전용 호출(`ladderText`)과
 * 같은 사다리(`python -m llm_playbook.ladder` → `codex_http`)로 부른다(실장 11/20 「딱 필요한 적절한 호출」).
 *
 * 응답 스키마는 안 넘긴다 — 모양은 규칙 글(프롬프트)이 시키고, 받은 답은 봇이 읽는다. `sets` 가 배열로 와도
 * (11/20 스키마 판의 모양) 사전으로 되돌려 파이썬(`tasks.py narrow --apply`)에 넘긴다. 파이썬은 값이 `null` 이든
 * 빈 문자열이든 「지움」으로 읽으므로 둘 다 그대로 둔다.
 *
 * **외부 서비스를 안 부른다** — `PYTHONPATH` 맨 앞에 가짜 `llm_playbook.ladder` 를 두어 받은 인자를 적고 정해 둔
 * 답을 낸다. `codex exec` 는 가짜 codex 로 바꿔 두고 **한 번도 안 띄우는지** 센다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFakeCodex } from './lib/fake-codex.mjs';

const fails = [];
const eq = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}\n    받음 ${JSON.stringify(got)}\n    기대 ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => { if (!cond) fails.push(label); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'narrow-light-'));
process.env.ENGINE_STATE_FILE = path.join(TMP, 'engine-state.json');

// ── 가짜 사다리 — 진짜 llm_playbook 보다 먼저 잡히게 PYTHONPATH 맨 앞 ─────────
const PKG = path.join(TMP, 'pyfake', 'llm_playbook');
fs.mkdirSync(PKG, { recursive: true });
fs.writeFileSync(path.join(PKG, '__init__.py'), '', 'utf-8');
fs.writeFileSync(path.join(PKG, 'ladder.py'), String.raw`
import json, os, sys
a = sys.argv[1:]
def val(k):
    return a[a.index(k) + 1] if k in a else None
rec = {"argv": a,
       "prompt": open(val("--prompt-file"), encoding="utf-8").read() if val("--prompt-file") else None,
       "system": open(val("--system-file"), encoding="utf-8").read() if val("--system-file") else None}
with open(os.environ["FAKE_LADDER_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
reply = os.environ.get("FAKE_LADDER_REPLY", "")
if os.environ.get("FAKE_LADDER_MODE") == "fail":
    print(json.dumps({"ok": False, "attempts": [{"backend": "codex", "why": "시험 실패"}]}))
    sys.exit(1)
with open(val("--out"), "w", encoding="utf-8", newline="") as f:
    f.write(reply)
print(json.dumps({"ok": True, "backend": "codex", "model": "gpt-T-sol"}))
`, 'utf-8');
const LOG = path.join(TMP, 'ladder-calls.jsonl');
process.env.FAKE_LADDER_LOG = LOG;
process.env.PYTHONPATH = [path.join(TMP, 'pyfake'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
delete process.env.LADDER_PYTHON;
const ladderCalls = () => (fs.existsSync(LOG)
  ? fs.readFileSync(LOG, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── codex exec 는 가짜로 — 띄우면 센다 ─────────────────────────────────────
const fake = makeFakeCodex();
process.env.BOARD_NARROW_CODEX_BIN = fake.bin;
process.env.FAKE_CODEX_MODE = 'ok-noop';
process.env.FAKE_CODEX_REPLY = '{"log":"exec 가 답함","sets":{},"ask":null,"say":null}';
delete process.env.BOARD_NARROW_FALLBACK;
const wa = await import('../dist/work-assistant.js');

const RULES = '규칙 글 — 출력은 JSON 하나';
const call = async (reply, mode = 'ok') => {
  process.env.FAKE_LADDER_REPLY = typeof reply === 'string' ? reply : JSON.stringify(reply);
  process.env.FAKE_LADDER_MODE = mode;
  const n0 = ladderCalls().length;
  const c0 = fake.calls().length;
  const said = await wa.narrowCodex(RULES, '판에 온 말', 60_000, 'opus');
  return { said, ladder: ladderCalls().slice(n0), exec: fake.calls().slice(c0) };
};
const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };

try {
  // ① 가벼운 길 — codex exec 를 안 띄우고 사다리를 한 번, codex 칸만 · 표의 모델과 깊이로
  {
    const r = await call({ log: 'l', sets: {}, ask: null, say: null });
    eq('codex exec(하네스 길)를 안 띄운다', r.exec.length, 0);
    eq('사다리를 한 번 부른다', r.ladder.length, 1);
    const a = r.ladder[0]?.argv ?? [];
    const v = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
    eq('codex 칸만(agy 로 안 넘김)', v('--vendors'), 'codex');
    eq('모델은 표에서(narrowCodexModel)', v('--tier'), wa.narrowCodexModel('opus') ?? null);
    eq('깊이는 표에서(narrowCodexEffort)', v('--effort'), wa.narrowCodexEffort('opus'));
    eq('규칙 글은 시스템 칸으로', r.ladder[0]?.system, RULES);
    eq('판의 말은 사용자 칸으로', r.ladder[0]?.prompt, '판에 온 말');
    ok('응답 스키마를 안 넘긴다', !a.some((x) => /schema/i.test(x)));
    eq('사전 모양 답은 그대로 넘김', parse(r.said), { log: 'l', sets: {}, ask: null, say: null });
  }

  // ② 배열로 온 sets 를 사전으로 — 빈 문자열과 null 은 그대로(파이썬이 둘 다 「지움」으로 읽음)
  {
    const { said } = await call({
      log: '오늘 리뷰함.',
      sets: [
        { key: '소프트 마감', value: '2026-11-27' },
        { key: '하드 마감', value: '' },
        { key: '알림', value: null },
      ],
      ask: null, say: '「다음 주」를 금요일로 잡았습니다.',
    });
    eq('배열 sets → 사전 sets', parse(said), {
      log: '오늘 리뷰함.',
      sets: { '소프트 마감': '2026-11-27', '하드 마감': '', '알림': null },
      ask: null, say: '「다음 주」를 금요일로 잡았습니다.',
    });
  }

  // ③ 코드 울타리 안의 배열도 — 스키마가 없으면 모델이 울타리를 칠 수 있다
  eq('울타리 안 배열 → 사전', parse((await call('```json\n{"log":null,"sets":[{"key":"상태","value":"완료"}],"ask":null,"say":null}\n```')).said).sets,
     { 상태: '완료' });

  // ④ 빈 배열 → 빈 사전 · null → null(파이썬 `or {}`) · 겹친 칸은 뒤 것(파이썬 `json.loads` 와 같음)
  eq('빈 배열 → 빈 사전', parse((await call({ log: 'l', sets: [], ask: null, say: null })).said).sets, {});
  eq('sets null 은 그대로', parse((await call({ log: 'l', sets: null, ask: 'q', say: null })).said).sets, null);
  eq('같은 칸이 둘이면 뒤 것', parse((await call({
    log: null, sets: [{ key: '상태', value: '진행중' }, { key: '상태', value: '완료' }], ask: null, say: null,
  })).said).sets, { 상태: '완료' });

  // ⑤ 모양이 다르면 손대지 않는다 — 파이썬이 거절하고 세션으로 떨어지는 길을 그대로 둔다
  eq('JSON 이 아닌 답은 그대로', (await call('그냥 글')).said, '그냥 글');
  const fenced = '```json\n{"log":"l","sets":{"상태":"완료"},"ask":null,"say":null}\n```';
  eq('울타리 안 사전은 글 그대로(파이썬이 읽음)', (await call(fenced)).said, fenced);

  // ⑥ 사다리가 못 하면 빈손 — 부르는 쪽이 세션으로 떨어뜨린다 · exec 로 다시 가지 않는다
  {
    const r = await call('무시됨', 'fail');
    eq('사다리가 못 하면 빈손', r.said, '');
    eq('못 해도 codex exec 로 다시 가지 않는다', r.exec.length, 0);
  }
} finally {
  fake.cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails.length) {
  console.error(`❌ 좁은 길 GPT 단계 — ${fails.length}건 실패\n  - ${fails.join('\n  - ')}`);
  process.exit(1);
}
console.log('✅ 좁은 길 GPT 단계 — exec 안 띄움 · 사다리 codex 칸 한 번 · 표의 모델과 깊이 · 스키마 없음 · 배열→사전 · 모양 다른 답은 그대로');
