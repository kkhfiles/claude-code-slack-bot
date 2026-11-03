import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SESSION_ENV from './session-env.json';

const SESSION_NAMES = new Set(SESSION_ENV.names.map((n) => n.toUpperCase()));

/**
 * 봇을 띄운 Claude Code · Codex · agy 세션이 남긴 변수인가 — 자식에게 넘기면 사람이 보는 세션의 자식으로 잡히고
 * 그 세션의 메시지 통로를 자기 것으로 안다. pm2 데몬과 앱이 세션에서 띄워져 이 변수를 들고 있었다(2026-11-02 확인).
 * **접두사로 통째 빼지 않는다** — `CLAUDE_CODE_USE_BEDROCK`(`config.ts`) · `CODEX_QUOTA_PYTHON`(`codex-quota.ts`)처럼
 * 봇이 읽는 같은 접두사 변수가 있다. 목록 정본은 `session-env.json`(재시작 스크립트도 같은 파일을 읽는다).
 */
export function isSessionEnv(name: string): boolean {
  const k = name.toUpperCase();
  return SESSION_NAMES.has(k) || SESSION_ENV.prefixes.some((p) => k.startsWith(p));
}

/**
 * 봇이 띄우는 Claude Code 세션(SDK · CLI 두 길)에 넘길 환경 변수 — **API 키는 늘 뺀다.** 세션이 남긴 변수(`isSessionEnv`)도 뺀다.
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
    if (v === undefined || k.toUpperCase() === 'ANTHROPIC_API_KEY' || isSessionEnv(k)) continue;
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
export function withApiKey(env: Record<string, string | undefined>, keyFile?: string): Record<string, string> {
  const file = keyFile || apiKeyFile();
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
    if (v === undefined || OTHER_AUTH.has(k.toUpperCase()) || isSessionEnv(k)) continue;
    out[k] = v;
  }
  out.ANTHROPIC_API_KEY = key;
  return out;
}
