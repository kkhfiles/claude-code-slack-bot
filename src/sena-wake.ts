/**
 * 세나 한 시간 각성(세나 자율성 2단계 · 판단 층 첫 판, 2026-11-11) — 10분마다 업무 비서의 `bin/sena_wake.py tick` 을 부른다.
 *
 * 깨울 때인지(업무일, 08~18시, 이 시각에 아직 안 깨움, 「조용히」 아님)와 깨워서 할 일은 전부 파이썬이 정한다(11/05 A1~A7 ·
 * work-assistant `docs/sena-autonomy-design.md` 「정한 것」). 여기는 부르기만 — 기다리지 않는 판단이 봇 타이머에 섞이지 않게.
 *
 * - **끄는 문** — `.env` 의 `SENA_WAKE=off`(기본 켜짐 · A4 관찰 기간 없음). 파이썬 쪽도 같은 변수를 본다
 * - **DM** — 파이썬이 보낼 글을 정하면(tick 출력 JSON 의 `dm`) 여기서 실장 DM 으로 보낸다. 11/11 시안을 보고 실장님 「고쳐서 켬」 —
 *   보내기 시작하는 날과 끄는 문(`SENA_WAKE_DM=off`)은 파이썬이 본다. 봇이 보내야 활동 기록, 개인 글 문, 부른곳을 그대로 지난다
 * - 실패는 로그 한 줄 — 다음 10분에 다시 보고, 회차를 놓쳐도 다음 시각에 깨운다
 */
import type { WebClient } from '@slack/web-api';
import { config } from './config';
import { every, type RunFailure } from './recurring';
import { Logger } from './logger';
import { isWorkAssistantEnabled, runTasks } from './work-assistant';
import { WAKE_REF_EVENT } from './dm-context';

const logger = new Logger('세나각성');
export const WAKE_POLL_MS = 10 * 60_000;
/** 한 번 깨움이 오래 걸려도(모델 한 차례 · 입력 모으기) 이 안에 끝난다 — 실측 9초 */
export const WAKE_TIMEOUT_MS = 6 * 60_000;

export function wakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SENA_WAKE || 'on').toLowerCase() !== 'off';
}

/** tick 출력의 마지막 JSON 줄에서 보낼 글 — 없거나 못 읽으면 빈 글. */
export function dmOf(stdout: string): string {
  const last = stdout.trim().split('\n').pop() || '';
  try {
    const o = JSON.parse(last) as { dm?: unknown };
    return typeof o.dm === 'string' ? o.dm.trim() : '';
  } catch {
    return '';
  }
}

/**
 * tick 출력의 번호표(`dm_refs`) — 항목마다 글 머리 「head」와 번호 「ref」(물음 q-…와 세션 앞 8자). 슬랙 글에 안 보이는 표시 정보로
 * 실어 DM 세션의 「세션이 못 본 대화방 글」이 세나 글 옆에 적는다(`dm-context.ts` `WAKE_REF_EVENT`). 11/23 오조준 — 글에 번호가
 * 없어 DM 세션이 이름이 비슷한 다른 세션을 골랐다. 없거나 못 읽으면 없음.
 */
export function refsMetadata(stdout: string): { event_type: string; event_payload: { refs: string } } | undefined {
  const last = stdout.trim().split('\n').pop() || '';
  let refs: unknown;
  try {
    refs = (JSON.parse(last) as { dm_refs?: unknown }).dm_refs;
  } catch {
    return undefined;
  }
  if (!Array.isArray(refs)) return undefined;
  const lines = refs
    .filter((r): r is { head?: unknown; ref: string } => Boolean(r) && typeof (r as { ref?: unknown }).ref === 'string' && Boolean((r as { ref: string }).ref.trim()))
    .slice(0, 10)
    .map((r) => {
      const head = String(r.head ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      return `${head ? `「${head}」 → ` : ''}${r.ref.trim().slice(0, 200)}`;
    });
  return lines.length ? { event_type: WAKE_REF_EVENT, event_payload: { refs: lines.join('\n') } } : undefined;
}

/**
 * DM 보내기 — 한 번 실패하면 잠시 뒤 한 번 더. 파이썬은 보낼 글을 넘기며 장부에 「보냄」을 적고, 같은 일은 그날 다시 안 넘기므로
 * 여기서 놓치면 그 알림은 그날 안 간다(11/11 재검토). 두 번째도 실패하면 로그만 — 다음 각성이 새로 생긴 일을 따로 알린다.
 */
export async function postWithRetry(
  client: Pick<WebClient, 'chat'>, channel: string, text: string, waitMs = 60_000,
  metadata?: { event_type: string; event_payload: Record<string, string> },
): Promise<boolean> {
  let meta = metadata;
  for (let i = 0; i < 2; i++) {
    try {
      // 링크 미리보기 끔 — 각성 글에는 메일 제목처럼 남이 쓴 글이 섞일 수 있고, 미리보기는 슬랙이 그 주소를 부르는 바깥
      // 요청이다(2026-11-23 실장님 결정 「메일실험 → 막기먼저」, 관리 문서 G2 에 적혀 있었으나 코드에 없던 것)
      await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false, ...(meta ? { metadata: meta } : {}) });
      return true;
    } catch (err) {
      // 번호표를 슬랙이 거절하면 번호표 없이 바로 다시 — 알림을 번호표 때문에 잃지 않는다
      const why = String((err as { data?: { error?: string } })?.data?.error ?? (err as Error)?.message ?? err);
      if (meta && /metadata/i.test(why)) {
        logger.warn(`세나 각성 DM 번호표 거절(${why}) — 번호표 없이 다시 보냄`);
        meta = undefined;
        i--;
        continue;
      }
      logger.warn(`세나 각성 DM 실패(${i + 1}/2)`, err);
      // 두 번째는 번호표 없이 — 이름에 metadata 가 안 든 거절(missing_scope 같은 것)이 번호표 탓이어도 알림은 가게(11/23 재검토)
      meta = undefined;
      if (i === 0) await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return false;
}

export function startSenaWake(client?: Pick<WebClient, 'chat'>): void {
  if (!wakeEnabled()) {
    logger.info('세나 각성 꺼짐(SENA_WAKE=off)');
    return;
  }
  if (!isWorkAssistantEnabled()) return;
  every({
    name: 'sena:wake',
    everyMs: WAKE_POLL_MS,
    run: async (): Promise<void | RunFailure> => {
      let r: Awaited<ReturnType<typeof runTasks>>;
      try {
        r = await runTasks(['tick'], WAKE_TIMEOUT_MS, 'bin/sena_wake.py');
      } catch (err) {
        // 띄우기부터 실패(폴더 없음, spawn 오류) — 던지면 타이머 묶음이 처리 안 된 거부로 내보낸다. 로그를 남기고 실패로 적는다
        logger.warn('세나 각성을 못 띄움', err);
        return { ok: false, code: 'spawn' };
      }
      if (r.code !== 0) {
        // 실패로 적는다 — 전에는 그냥 돌아가 타이머 기록에 성공으로 남았다(11/26 구조 검토 2-1)
        logger.warn(`세나 각성 실패 rc ${r.code}`, r.stderr.slice(-300));
        return { ok: false, code: 'rc' };
      }
      const out = r.stdout.trim();
      if (out && !out.includes('"skip"')) logger.info('세나 각성', out.slice(0, 300));
      const dm = dmOf(out);
      if (dm && client && config.assistant.dmChannel) {
        await postWithRetry(client, config.assistant.dmChannel, dm, undefined, refsMetadata(out));
      }
    },
  });
  logger.info(`세나 각성 켬 — ${WAKE_POLL_MS / 60_000}분마다 깨울 때인지 봄`);
}
