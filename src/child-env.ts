import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 봇이 띄우는 Claude Code 세션(SDK · CLI 두 길)에 넘길 환경 변수 — **API 키는 늘 뺀다.**
 *
 * 2026-10-14 사용자 결정으로 「API 키로 계속」을 걷었다 — 한도에 걸리면 엔진 폴백과
 * 보류 재실행이 대신한다. 그런데 PC 환경 변수에 키가 남아 있으면 세션이 구독 토큰 대신
 * 그 키로 **말없이 과금된다.** 키를 넣는 길을 지우는 것만으로는 안 막혀서 나가는 문에서 뺀다.
 *
 * 윈도우의 환경 변수 이름은 대소문자를 안 가리므로 대문자로 맞춰 견준다.
 * 두 길이 이 함수를 부르는지는 `npm run check:noaccounts` 가 본다.
 */
export function withoutApiKey(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.toUpperCase() === 'ANTHROPIC_API_KEY') continue;
    out[k] = v;
  }
  return out;
}

/** 월 API 크레딧 키 파일 — llm-playbook 과 같은 파일(`claude_api.DEFAULT_KEY_FILE`). 시험은 `CLAUDE_API_KEY_FILE` 로 옮긴다. */
export function apiKeyFile(): string {
  return process.env.CLAUDE_API_KEY_FILE || path.join(os.homedir(), '.config', 'llm-playbook', '.anthropic-api-key');
}

/** 키 파일을 못 읽었거나 모양이 틀림 — 오류 글에 키 값을 싣지 않는다. */
export class ApiKeyFileError extends Error {}

/** 키를 넣을 때 같이 빼는 인증 변수 — 남아 있으면 Claude Code 가 키보다 그것을 먼저 쓴다. */
const OTHER_AUTH = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

/**
 * **월 API 크레딧 세션 전용**(2026-10-21 사용자 결정 · `claude-api` 칸) — 키 파일을 읽어 `ANTHROPIC_API_KEY` 로 넣고
 * 구독 토큰(`CLAUDE_CODE_OAUTH_TOKEN`)과 다른 인증 변수는 뺀다. 크레딧은 Agent SDK 세션에 적용된다(2026-10-21
 * 실측 · `apiKeySource: ANTHROPIC_API_KEY`). **이 함수를 부르는 곳은 `sdk-handler.ts` 의 `billing: 'api'` 하나**
 * — 다른 곳에서 부르면 그 길이 구독 대신 과금된다(`npm run check:noaccounts`).
 */
export function withApiKey(env: Record<string, string | undefined>): Record<string, string> {
  const file = apiKeyFile();
  let key: string;
  try {
    key = fs.readFileSync(file, 'utf-8').trim();
  } catch (err: any) {
    throw new ApiKeyFileError(`API 키 파일을 못 읽음: ${file} (${err?.code ?? 'error'})`);
  }
  if (!key.startsWith('sk-ant-') || key.length < 40 || /\s/.test(key)) {
    throw new ApiKeyFileError(`API 키 파일 모양이 틀림: ${file}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || OTHER_AUTH.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  out.ANTHROPIC_API_KEY = key;
  return out;
}
