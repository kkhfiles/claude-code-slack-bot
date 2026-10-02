/**
 * 규칙 파일이 Codex 가 다 읽는 크기 안에 있는지 · CLAUDE.md 가 불러오기 한 줄인지 본다.
 *
 *   npm run check:agents-md
 *
 * **왜 있나.** Codex 는 프로젝트 지시 파일을 합쳐 기본 32 KiB 까지만 읽고 넘는 부분은 말없이
 * 자른다(`project_doc_max_bytes` · 로그 경고뿐). 이 파일은 이틀 사이 32 KB 에서 36 KB 로 늘어
 * 동료 PC 의 Codex 에서 뒤가 잘려 읽혔다(2026-10-02). 그래서 참고 자료를 `docs/` 로 옮기고
 * 상한을 시험으로 건다 — 28 KB 는 하위 폴더 지시 파일이 붙을 여유를 둔 값이다.
 *
 * **CLAUDE.md 는 `@AGENTS.md` 한 줄** — Claude Code 는 같은 폴더에 CLAUDE.md 가 있으면 그것만
 * 읽고, Codex 는 `@` 를 펼치지 않는다. 규칙이 CLAUDE.md 에 다시 쌓이면 Codex 가 못 본다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 28 * 1024;
const fails = [];

const agents = path.join(ROOT, 'AGENTS.md');
const claude = path.join(ROOT, 'CLAUDE.md');
if (!fs.existsSync(agents)) {
  fails.push('AGENTS.md 가 없습니다 — 규칙 본문은 AGENTS.md 에 둡니다');
} else {
  const size = fs.statSync(agents).size;
  if (size > LIMIT) {
    fails.push(`AGENTS.md 가 ${size} B 로 상한 ${LIMIT} B 를 넘었습니다 — 명령별 상세 같은 참고 자료는 docs/ 로 옮깁니다`);
  }
}
if (fs.existsSync(claude)) {
  const lines = fs.readFileSync(claude, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length !== 1 || lines[0].trim() !== '@AGENTS.md') {
    fails.push('CLAUDE.md 는 「@AGENTS.md」 한 줄이어야 합니다 — 규칙은 AGENTS.md 에 적습니다(Codex 는 CLAUDE.md 를 안 읽습니다)');
  }
}

if (fails.length) {
  console.log(`실패 ${fails.length}건\n`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`통과 — AGENTS.md ${fs.statSync(agents).size} B / 상한 ${LIMIT} B · CLAUDE.md 는 불러오기 한 줄`);
