/**
 * 세나(옛 이름 스탠리)의 정체성을 슬랙 DM 세션에 싣는다 (2026-10-31).
 *
 * **비서는 하나다.** 판 서랍은 업무 비서 레포의 `bin/stanley_persona.md` 를 시스템 프롬프트 맨 앞에 두는데,
 * 슬랙 DM 세션은 슬랙 문법 규칙만 받아 대원칙(「장난은 쳐도 팩트는 틀리지 않는다」), 위트, 「실장님」 호칭이
 * 없었다. 같은 파일을 차례마다 새로 읽어 붙인다 — 파일을 고치면 봇을 다시 띄우지 않아도 다음 차례부터 걸린다.
 *
 * 유머 값은 서랍의 유머 창이 저장하는 설정 파일 하나(`<대화 DB>.settings.json`)를 같이 읽는다. 못 읽으면 50.
 * 정체성 파일이 없거나 못 읽으면 아무것도 붙이지 않는다 — 슬랙 대화는 그대로 돈다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HUMOR_DEFAULT = 50;

/** 서랍과 같은 유머 설정 파일. 옮기면 `.env` 의 `SENA_SETTINGS_FILE` 로 알린다. */
export function settingsFile(): string {
  return process.env.SENA_SETTINGS_FILE
    || path.join(os.homedir(), '.claude', 'state', 'stanley', 'connection-20261021', 'production-chat.settings.json');
}

export function readHumor(file: string = settingsFile()): number {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8')).humor;
    return Number.isInteger(v) && v >= 0 && v <= 100 ? v : HUMOR_DEFAULT;
  } catch {
    return HUMOR_DEFAULT;
  }
}

/** DM 세션에 덧붙일 정체성 — 업무 비서 레포가 없거나 파일을 못 읽으면 빈 글. */
export function personaNote(root: string | null, humorFile: string = settingsFile()): string {
  if (!root) return '';
  let persona: string;
  try {
    persona = fs.readFileSync(path.join(root, 'bin', 'stanley_persona.md'), 'utf-8').trim();
  } catch {
    return '';
  }
  if (!persona) return '';
  return [
    '## 이 대화의 비서 — 세나',
    '',
    persona,
    '',
    '## 슬랙에서 이 정체성을 쓸 때',
    '',
    `- **지금 유머 값: ${readHumor(humorFile)}** (0~100). 정체성에 적힌 「대화 자료의 \`humor\` 칸」이 슬랙에서는 이 줄이다.`,
    '- 분량과 형식은 아래 슬랙 규칙을 따른다 — 정체성의 「출력 규칙」은 판 서랍 화면 것이다.',
  ].join('\n');
}
