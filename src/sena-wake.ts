/**
 * 세나 한 시간 각성(세나 자율성 2단계 · 판단 층 첫 판, 2026-11-11) — 10분마다 업무 비서의 `bin/sena_wake.py tick` 을 부른다.
 *
 * 깨울 때인지(업무일, 08~18시, 이 시각에 아직 안 깨움, 「조용히」 아님)와 깨워서 할 일은 전부 파이썬이 정한다(11/05 A1~A7 ·
 * work-assistant `docs/sena-autonomy-design.md` 「정한 것」). 여기는 부르기만 — 기다리지 않는 판단이 봇 타이머에 섞이지 않게.
 *
 * - **끄는 문** — `.env` 의 `SENA_WAKE=off`(기본 켜짐 · A4 관찰 기간 없음). 파이썬 쪽도 같은 변수를 본다
 * - **DM 은 아직 안 보냄** — 파이썬이 「보냈을 글」만 적는다(`SENA_WAKE_DM`, 시안 확인 뒤 켬)
 * - 실패는 로그 한 줄 — 다음 10분에 다시 보고, 회차를 놓쳐도 다음 시각에 깨운다
 */
import { every } from './recurring';
import { Logger } from './logger';
import { isWorkAssistantEnabled, runTasks } from './work-assistant';

const logger = new Logger('세나각성');
export const WAKE_POLL_MS = 10 * 60_000;
/** 한 번 깨움이 오래 걸려도(모델 한 차례 · 입력 모으기) 이 안에 끝난다 — 실측 9초 */
export const WAKE_TIMEOUT_MS = 6 * 60_000;

export function wakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SENA_WAKE || 'on').toLowerCase() !== 'off';
}

export function startSenaWake(): void {
  if (!wakeEnabled()) {
    logger.info('세나 각성 꺼짐(SENA_WAKE=off)');
    return;
  }
  if (!isWorkAssistantEnabled()) return;
  every({
    name: 'sena:wake',
    everyMs: WAKE_POLL_MS,
    run: async () => {
      const r = await runTasks(['tick'], WAKE_TIMEOUT_MS, 'bin/sena_wake.py');
      if (r.code !== 0) {
        logger.warn(`세나 각성 실패 rc ${r.code}`, r.stderr.slice(-300));
        return;
      }
      const out = r.stdout.trim();
      if (out && !out.includes('"skip"')) logger.info('세나 각성', out.slice(0, 300));
    },
  });
  logger.info(`세나 각성 켬 — ${WAKE_POLL_MS / 60_000}분마다 깨울 때인지 봄`);
}
