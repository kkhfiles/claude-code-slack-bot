/**
 * `sdk-update.mjs` 의 계산 부분 — 부수 효과 없는 것만 모았다(시험이 직접 부른다).
 */

/** "2.1.284" → [2, 1, 284]. 모양이 다르면 null. */
export function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 판 비교 — a<b 음수 · 같으면 0 · a>b 양수. 못 읽는 쪽은 가장 낮게 본다. */
export function cmpVer(a, b) {
  const x = parseVer(a) ?? [-1, -1, -1];
  const y = parseVer(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * 올릴 판 고르기 — **짝 판이 설치된 Claude Code 를 넘지 않는 것 중 가장 새 것.**
 *
 * SDK 가 Claude Code 보다 앞서 나오는 날이 있다(SDK 는 새 판, CLI 는 아직 자동 업데이트 전). 그 판을
 * 고르면 반대쪽으로 어긋나므로 짝 판이 CLI 이하인 것만 본다. 설치된 판보다 새 것이 없으면 null.
 *
 * @param {{version: string, pair: string}[]} entries
 * @param {string} cli 설치된 Claude Code 판
 * @param {string} installed 설치된 SDK 판
 */
export function pickTarget(entries, cli, installed) {
  const ok = (entries ?? [])
    .filter((e) => parseVer(e.version) && parseVer(e.pair) && cmpVer(e.pair, cli) <= 0)
    .sort((a, b) => cmpVer(b.version, a.version));
  const best = ok[0];
  return best && cmpVer(best.version, installed) > 0 ? best : null;
}

/** `npm view pkg@range version claudeCodeVersion --json` 은 하나면 객체, 여럿이면 배열로 온다. */
export function normalizeNpmView(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .filter((e) => e && e.version && e.claudeCodeVersion)
    .map((e) => ({ version: String(e.version), pair: String(e.claudeCodeVersion) }));
}

/**
 * llm-playbook `pyproject.toml` 의 SDK 최소 판과 그 윗줄 주석의 짝 판을 새 값으로.
 * 둘 중 하나라도 못 찾으면 던진다 — 모양이 바뀐 파일을 조용히 그대로 두지 않게.
 */
export function bumpPyproject(text, version, pair) {
  const req = /claude-agent-sdk>=\d+\.\d+\.\d+/;
  const note = /\(\d+\.\d+\.\d+ = \d+\.\d+\.\d+\)/;
  if (!req.test(text)) throw new Error('pyproject 에 claude-agent-sdk>= 가 없음');
  if (!note.test(text)) throw new Error('pyproject 에 짝 판 주석「(SDK = CLI)」이 없음');
  return text.replace(req, `claude-agent-sdk>=${version}`).replace(note, `(${version} = ${pair})`);
}

/**
 * 버튼이 남긴 요청이 지금 처리할 것인가 — **방금 만든 것 · 아직 안 쓴 것만.**
 * pm2 가 멈춘 앱을 저장해 두었다가 부팅 때 되살려도 옛 요청으로 다시 돌지 않게 하는 문이다.
 */
export function requestFresh(req, nowMs, maxAgeMs = 15 * 60 * 1000) {
  if (!req || req.consumed || !req.id) return false;
  const at = Date.parse(req.requestedAt ?? '');
  return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= maxAgeMs;
}

/**
 * 커밋 직전 — **시작할 때 본 그대로인가.** 기본 브랜치 · 시작한 뒤 커밋이 안 늘었나 · 판 맞춤이 안 건드린 파일이 안 바뀌었나.
 * 판 맞춤은 몇 분~한 시간 돌므로, 그사이 다른 세션이 브랜치를 바꾸거나 작성 중인 수정을 올려 두면 그것이 커밋·배포에
 * 섞인다(검토 2026-09-29). 이유 문장을 돌려준다(없으면 '').
 */
export function guardReason({ branch, want, porcelain, allowed = [], head, base }) {
  if (branch !== want) return `기본 브랜치(${want})가 아니라 ${branch || '알 수 없는 브랜치'}에 있음`;
  if (base && head !== base) return `시작한 뒤 커밋이 더해짐(${String(head || '').slice(0, 7)})`;
  const extra = String(porcelain ?? '').split('\n').filter((l) => l.trim())
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((f) => !allowed.includes(f));
  if (!extra.length) return '';
  return `판 맞춤이 안 건드린 파일이 바뀜(${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ' …' : ''})`;
}

/**
 * 자식 명령(npm · 빌드 · 시험 · git)에 줄 환경 — 받은 환경에 `extra` 를 얹고 **`NODE_ENV` 를 뺀다.**
 * 봇은 pm2 설정(`ecosystem.config.js`)으로 `NODE_ENV=production` 이라, 그대로 물려준 `npm install` 이
 * 개발용 패키지(typescript · tsx)를 지워 빌드도 되돌리기도 실패했다(2026-10-12 판 맞춤).
 */
export function childEnv(base, extra = {}) {
  const env = { ...base, ...extra };
  delete env.NODE_ENV;
  return env;
}

/** `git status --porcelain` · 현재 브랜치로 「다른 작업 중」인지. 이유 문장을 돌려준다(없으면 ''). */
export function busyReason(branch, want, porcelain) {
  if (branch !== want) return `기본 브랜치(${want})가 아니라 ${branch || '알 수 없는 브랜치'}에 있음`;
  const n = String(porcelain ?? '').split('\n').filter((l) => l.trim()).length;
  return n ? `커밋 안 된 파일 ${n}개` : '';
}

// --- Claude 가 막혔을 때 (2026-10-19) ---------------------------------------------
// 주간 한도 중에 버튼을 누르자 봇 SDK 는 「미리 띄운 세션 통과」로 올라가고(답이 한도 글이었는데 흐름은 끝났다)
// 파이썬만 「응답 없음 · 되돌림」이 됐다. 실제 호출을 시험할 수 없는 때는 아무것도 바꾸지 않고, 한도에 걸린
// 호출은 한도라고 적는다.

/** 엔진 상태 파일 자리 — `src/engine-state.ts` 의 `defaultFile` 과 같은 규칙(시험은 `ENGINE_STATE_FILE`). */
export function engineStateFile(env, root) {
  if (env.ENGINE_STATE_FILE) return env.ENGINE_STATE_FILE;
  if (env.RATE_LIMIT_UNTIL_FILE) return `${env.RATE_LIMIT_UNTIL_FILE.replace(/[^/\\]+$/, '')}.engine-state.json`;
  return `${root}/.engine-state.json`;
}

/** 엔진 상태(JSON 내용)에서 **지금** Claude 막힘 — `isBlocked` 와 같은 판정(`until` 이 지금보다 뒤). 없으면 null. */
export function claudeBlockNow(state, nowSec) {
  const b = state?.engines?.claude?.blocked;
  return b && typeof b.until === 'number' && b.until > nowSec ? b : null;
}

const BLOCK_LABEL = { usage: '사용량 소진', overload: '과부하', auth: '인증 오류' };
const mmddhhmm = (sec) => {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 막혀서 멈출 때의 「점검」 줄 — 시각은 이 PC 시간. 서버가 준 시각이 아니면 「다시 볼 시각」. */
export function blockedStopDetail(block) {
  const when = `${block.untilKnown ? '풀림' : '다시 볼 시각'} ${mmddhhmm(block.until)}`;
  return `Claude ${BLOCK_LABEL[block.kind] ?? '막힘'}(${when}) · 실제 호출을 시험할 수 없어 아무것도 바꾸지 않았습니다 · 풀린 뒤 다시 누르세요`;
}

/**
 * 실제 호출 출력에 한도 글이 있나 — 끝 코드가 0 이어도(답이 한도 글이어도 흐름은 끝난다) 본다.
 * 봇의 `isRateLimitText` 보다 좁다 — 성공한 호출의 기록 줄(`rate_limit_event` · 숫자 429)에 안 걸리게.
 */
export function limitHit(out) {
  return /You['’]ve hit your|usage limit|weekly limit|rate limit|Too Many Requests/i.test(String(out ?? ''));
}

export const LIMIT_REASON = 'Claude 한도에 걸려 실제 호출을 시험하지 못함';
