/**
 * 정할 것 없는 알림을 DM 에서 desk 와 아침 한 줄로 돌린다(2026-11-26 실장님 결정, 열쇠 「처리제안알림」, 「세나정리」).
 *
 * 실측(11/23~26 결정 요청 DM 132통) — 처리 제안 27통은 11/11 뒤 결정 0건, 메일 후보 30통 중 실장님께 묻는 것이 든 것은 8통.
 * 켜면 셋이 바뀐다.
 * - **처리 제안 아침 요약** — 요약 한 통과 제안마다 카드 · 결정 요청 답글 대신 한 줄(`buildDeskLine`). 결정은 desk 에서
 * - **처리 제안이 생길 때의 즉시 알림**(`urgent`) — 보내지 않는다. 실장님이 진행을 누른 뒤의 알림(두 번째 승인, 병합 대기,
 *   결과, 다시 승인, 실행 준비 실패)은 그대로 — 실장님이 시작한 일이다(`HELD_NOTICE_KINDS`)
 * - **메일 차례의 답** — 실장님께 묻는 것(물음, 컨펌 전 등록, 회신, 임원 메일, 판정이 덜 남음)이 있을 때만 바로 보낸다.
 *   가르는 것은 파이썬(`mail.py route`)이고, 판정 불가면 보낸다
 *
 * 켜는 문은 `.env` 의 `ALERT_ROUTE_DESK=on`(기본 꺼짐) — 코드 배포와 떼어 두고 실장님 확인 뒤에 켠다.
 */

/** report-log 가 site 를 못 알려 줄 때 쓰는 desk 주소 — 정본은 report-log `tools/flow.py` 의 `SITE`. */
export const DESK_SITE = 'https://desk.dispatchflow.cc';

export function alertRouteOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALERT_ROUTE_DESK === 'on';
}

/** 켜져 있으면 보내지 않는 처리 제안 즉시 알림 — 새로 생긴 제안(밤 검토가 급하다고 본 것)뿐. */
export const HELD_NOTICE_KINDS: readonly string[] = ['urgent'];

export function holdNotice(kind: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return alertRouteOn(env) && HELD_NOTICE_KINDS.includes(kind);
}

/**
 * 아침 한 줄 — 「🗂 처리 제안 N건 · 메일 처리 M건 — desk 에서 보기」. 둘 다 0 이면 null(안 보낸다).
 * `null` 값은 못 읽은 것 — 0 과 섞으면 못 읽은 날이 「없음」으로 읽혀서 따로 적는다.
 */
export function buildDeskLine(proposals: number | null, mail: number | null, site: string): string | null {
  const parts: string[] = [];
  if (proposals === null) parts.push('처리 제안 못 읽음');
  else if (proposals > 0) parts.push(`처리 제안 ${proposals}건`);
  if (mail === null) parts.push('메일 처리 못 셈');
  else if (mail > 0) parts.push(`메일 처리 ${mail}건`);
  if (!parts.length) return null;
  return `🗂 ${parts.join(' · ')} — <${site.replace(/\/+$/, '')}/actions/|desk 에서 보기>`;
}
