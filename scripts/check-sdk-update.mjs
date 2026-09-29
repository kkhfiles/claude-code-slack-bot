/**
 * SDK 판 맞춤 — 판 고르기 · 요청 문 · 「다른 작업 중」 판정 · pyproject 고치기.
 *
 *   npm run check:sdkupdate
 *
 * 실제 설치·시험·푸시는 여기서 안 돌린다(네트워크·구독 호출). 그것은 저장소 사본에서
 * `node scripts/sdk-update.mjs --run --no-push --no-restart` 로 끝까지 돌려 본다.
 */
import {
  bumpPyproject, busyReason, cmpVer, normalizeNpmView, parseVer, pickTarget, requestFresh,
} from './lib/sdk-update-lib.mjs';

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

if (fails.length) {
  console.error(`\n실패 ${fails.length}건\n\n  ✗ ${fails.join('\n\n  ✗ ')}\n`);
  process.exitCode = 1;
} else {
  console.log('통과 — SDK 판 맞춤 계산(짝 판이 CLI 이하인 가장 새 판 · 내리지 않음 · pyproject 두 곳 · '
    + '낡은 요청 안 함 · 다른 작업 중 판정)');
}
