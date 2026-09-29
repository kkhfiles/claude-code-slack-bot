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

/** `git status --porcelain` · 현재 브랜치로 「다른 작업 중」인지. 이유 문장을 돌려준다(없으면 ''). */
export function busyReason(branch, want, porcelain) {
  if (branch !== want) return `기본 브랜치(${want})가 아니라 ${branch || '알 수 없는 브랜치'}에 있음`;
  const n = String(porcelain ?? '').split('\n').filter((l) => l.trim()).length;
  return n ? `커밋 안 된 파일 ${n}개` : '';
}
