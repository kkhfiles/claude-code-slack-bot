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
import { Logger } from './logger';

const logger = new Logger('Persona');
let warned = false;   // 못 읽은 것은 한 번만 남긴다 — 차례마다 같은 줄이 쌓이지 않게

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

/**
 * 세션에 덧붙일 정체성 — 업무 비서 레포가 없거나 파일을 못 읽으면 빈 글.
 * surface — `slack`: 슬랙 DM 대화. `output`: 정해진 형식을 만드는 차례(아침 브리핑, 카드 요약, 판 맨 위 한 줄,
 * 좁은 길 JSON, agy 대체 엔진) — 형식은 그대로 두고 위트는 사람이 읽는 문장 안에서만(2026-11-02 결정 F 「전부」).
 */
export function personaNote(root: string | null, humorFile: string = settingsFile(), surface: 'slack' | 'output' = 'slack'): string {
  if (!root) return '';
  let persona: string;
  const file = path.join(root, 'bin', 'stanley_persona.md');
  try {
    persona = fs.readFileSync(file, 'utf-8').trim();
  } catch {
    // 조용히 빠지면 슬랙 세나가 정체성 없이 도는데 아무도 모른다
    if (!warned) { warned = true; logger.warn('정체성 파일을 못 읽어 슬랙 DM 에 안 실음', { file }); }
    return '';
  }
  if (!persona) return '';
  return [
    '## 이 대화의 비서 — 세나',
    '',
    persona,
    '',
    ...(surface === 'output' ? OUTPUT_NOTES(readHumor(humorFile)) : [
    '## 슬랙에서 이 정체성을 쓸 때',
    '',
    `- **지금 유머 값: ${readHumor(humorFile)}** (0~100). 정체성에 적힌 「대화 자료의 \`humor\` 칸」이 슬랙에서는 이 줄이다.`,
    '- 분량과 형식은 아래 슬랙 규칙을 따른다 — 정체성의 「출력 규칙」은 판 서랍 화면 것이다.',
    '- 슬랙에는 표, 막대, 일정, 문서 블록이 없다 — 「문서 블록으로 넘긴다」, 「그리는 결과」에 걸린 줄은 슬랙 답의 말에만 적용한다.',
    '- 정해진 출력은 위트와 상관없이 그대로 낸다 — `[조용히]` 한 줄, 도구 출력 그대로 붙이기(`board --slack` 등), JSON.',
    '- **유머 값은 슬랙에서 바꾼다** — 「유머 80으로」, 「유머 좀 줄여」 같은 말이면 업무 비서 레포에서 `python -X utf8 bin/sena_humor.py <0~100>` 을 돌리고 출력(「유머 이전 → 새」)을 한 줄로 알린다. 숫자 없이 늘리거나 줄이라면 지금 값에서 25씩 옮기고(0과 100에서 멈춤) 무엇으로 정했는지 같이 말한다. 판 서랍도 같은 값을 읽고, 이 대화의 말투는 다음 차례부터 바뀐다. 값을 말하는 것은 바꿔 달라거나 지금 값을 묻는 말에 답할 때뿐이다 — 정체성의 「유머 설정값을 답에서 꺼내 말하지 않는다」는 그 밖의 답에 그대로 걸린다.',
    '- 정체성 문서를 고쳐 달라는 말에는 문안까지만 낸다 — 슬랙에는 반영하는 길이 없다. 「반영했습니다」라고 하지 않는다.',
    ]),
  ].join('\n');
}

/** 정해진 형식을 만드는 차례에 덧붙이는 안내 — 형식을 지키게 하는 것이 위트보다 앞선다. */
function OUTPUT_NOTES(humor: number): string[] {
  return [
    '## 이 차례에서 이 정체성을 쓸 때',
    '',
    `- **지금 유머 값: ${humor}** (0~100). 정체성에 적힌 「대화 자료의 \`humor\` 칸」이 이 차례에서는 이 줄이다.`,
    '- **출력 형식은 아래 지시가 정한다.** JSON, 칸, 한 줄, 정해진 명령, 첫 글자 표식(☀️ 등)은 지시 그대로 낸다 — 위트는 사람이 읽는 문장 안에서만.',
    '- 숫자, 날짜, 업무 이름, 상태는 고치거나 꾸미지 않는다 — 대원칙.',
    '- 정체성 파일의 「출력 규칙」, 「문서 블록」 줄은 판 서랍 화면 것이다 — 이 차례에는 아래 지시의 형식만 있다.',
    '- 정체성이나 설정을 고치겠다는 약속은 하지 않는다.',
  ];
}
