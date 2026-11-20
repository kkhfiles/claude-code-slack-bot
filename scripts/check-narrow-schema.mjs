/**
 * 좁은 길 codex 폴백의 응답 스키마 — **OpenAI 엄격 모드가 받는 모양인가**, 받은 답을 **지금과 같은 뜻으로** 넘기나.
 *
 *   npm run build
 *   npm run check:narrowschema
 *
 * 2026-11-20 에 찾은 잠복 결함 — `sets` 를 「칸 이름 → 값」 사전(`additionalProperties` 만 있고
 * `properties` 없는 object)으로 넘겼더니 OpenAI 가 400 으로 거절했다:
 *   `object schema must define properties` (invalid_json_schema)
 * 모델과 상관없이 20건 전부 실패했고, 봇에서는 Claude 가 빈손인 날에만 이 길을 지나서 아무도 못 봤다.
 *
 * 그래서 `sets` 를 `[{key, value}]` 배열로 받고, 봇이 파이썬(`tasks.py narrow --apply`)에 넘기기 전에
 * 원래 사전 모양으로 되돌린다. 파이썬은 값이 `null` 이든 빈 문자열이든 「지움」으로 읽으므로 둘 다 그대로 둔다.
 *
 * **외부 서비스를 안 부른다** — 가짜 codex 가 받은 스키마를 적어 두고 정해 둔 답을 낸다.
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

/**
 * OpenAI 구조화 출력 엄격 모드의 object 규칙 — 어긋난 곳을 경로와 함께 돌려준다.
 *   - object 는 `properties` 를 갖고, `additionalProperties: false`, `required` 가 모든 칸
 *   - array 는 `items` 를 갖는다
 */
export function strictProblems(s, at = '') {
  const out = [];
  if (!s || typeof s !== 'object') return [`${at || '/'} 스키마가 객체가 아님`];
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes('object')) {
    if (!s.properties || typeof s.properties !== 'object') out.push(`${at}/type 의 object 에 properties 없음`);
    if (s.additionalProperties !== false) out.push(`${at} additionalProperties 가 false 가 아님`);
    const keys = Object.keys(s.properties ?? {}).sort();
    const req = [...(s.required ?? [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(req)) out.push(`${at} required 가 모든 칸이 아님 (${req} ≠ ${keys})`);
    for (const [k, v] of Object.entries(s.properties ?? {})) out.push(...strictProblems(v, `${at}/properties/${k}`));
  }
  if (types.includes('array')) {
    if (!s.items) out.push(`${at} array 에 items 없음`);
    else out.push(...strictProblems(s.items, `${at}/items`));
  }
  for (const [i, v] of (s.anyOf ?? []).entries()) out.push(...strictProblems(v, `${at}/anyOf/${i}`));
  return out;
}

// ── 검사기가 헛돌지 않나 — 11/20 에 거절당한 옛 모양은 잡아야 한다 ──────────
const OLD = {
  type: 'object', additionalProperties: false, required: ['log', 'sets', 'ask', 'say'],
  properties: {
    log: { type: ['string', 'null'] },
    sets: { type: ['object', 'null'], additionalProperties: { type: ['string', 'null'] } },
    ask: { type: ['string', 'null'] },
    say: { type: ['string', 'null'] },
  },
};
ok(`엄격 검사가 옛 모양(sets 사전)을 잡는다 (받음 ${JSON.stringify(strictProblems(OLD))})`,
   strictProblems(OLD).some((p) => p.includes('/properties/sets') && p.includes('properties 없음')));

// ── 가짜 codex 로 실제 길을 지난다 ─────────────────────────────────────
process.env.ENGINE_STATE_FILE = path.join(os.tmpdir(), `narrow-schema-engine-${Date.now()}.json`);
const fake = makeFakeCodex();
process.env.BOARD_NARROW_CODEX_BIN = fake.bin;
process.env.FAKE_CODEX_MODE = 'ok-noop';
delete process.env.BOARD_NARROW_FALLBACK;
const { narrowCodex } = await import('../dist/work-assistant.js');

const call = async (reply) => {
  process.env.FAKE_CODEX_REPLY = typeof reply === 'string' ? reply : JSON.stringify(reply);
  const n0 = fake.calls().length;
  const said = await narrowCodex('규칙', '말', 30_000);
  return { said, call: fake.calls()[n0] };
};
const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };

try {
  // ① 넘긴 스키마가 엄격 모드를 통과한다
  {
    const { call: c } = await call({ log: null, sets: [], ask: null, say: null });
    ok('가짜 codex 를 불렀다', !!c);
    ok('응답 스키마를 넘겼다', c && c.schema && typeof c.schema === 'object');
    const probs = c ? strictProblems(c.schema) : ['안 부름'];
    eq('넘긴 스키마가 엄격 모드 규칙에 맞는다', probs, []);
    ok('codex 에게 sets 를 배열로 쓰라고 알린다(규칙 글은 사전 모양이라 어긋남을 풀어 둠)',
       c && /"key"/.test(c.prompt) && /"value"/.test(c.prompt));
  }

  // ② 배열로 받은 sets 를 사전으로 되돌린다 — 빈 문자열과 null 은 그대로(파이썬이 둘 다 「지움」으로 읽음)
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

  // ③ 빈 배열 → 빈 사전 · null → null(파이썬 `or {}`)
  eq('빈 배열 → 빈 사전', parse((await call({ log: 'l', sets: [], ask: null, say: null })).said).sets, {});
  eq('sets null 은 그대로', parse((await call({ log: 'l', sets: null, ask: 'q', say: null })).said),
     { log: 'l', sets: null, ask: 'q', say: null });

  // ④ 같은 칸이 둘이면 뒤 것 — 파이썬 `json.loads` 가 사전의 겹친 열쇠를 읽는 방식과 같다
  eq('같은 칸이 둘이면 뒤 것', parse((await call({
    log: null, sets: [{ key: '상태', value: '진행중' }, { key: '상태', value: '완료' }], ask: null, say: null,
  })).said).sets, { 상태: '완료' });

  // ⑤ 모양이 다르면 손대지 않는다 — 파이썬이 거절하고 세션으로 떨어지는 길을 그대로 둔다
  eq('JSON 이 아닌 답은 그대로', (await call('그냥 글')).said, '그냥 글');
  eq('이미 사전인 sets 는 그대로', parse((await call({ log: null, sets: { 상태: '완료' }, ask: null, say: null })).said).sets,
     { 상태: '완료' });
} finally {
  fake.cleanup();
  fs.rmSync(process.env.ENGINE_STATE_FILE, { force: true });
}

if (fails.length) {
  console.error(`❌ 좁은 길 응답 스키마 — ${fails.length}건 실패\n  - ${fails.join('\n  - ')}`);
  process.exit(1);
}
console.log('✅ 좁은 길 응답 스키마 — 엄격 모드 모양 · 배열→사전 되돌림 · 모양 다른 답은 그대로');
