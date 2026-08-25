/**
 * 밀린 요청을 **다시 알릴지** 정하는 규칙 한 조각.
 *
 * 왜 떼어냈나 — 이 판단은 타이머·슬랙·시각이 얽혀 있어서 통째로는 돌려볼 수가 없는데,
 * 틀리면 **조용히 틀린다.** 밤사이에 상한이 다 닳아 정작 아침에 한 번도 안 알리거나,
 * 사람이 이미 처리했는데 계속 두드리거나 하는 식이다. 둘 다 오류도 로그도 안 난다.
 * 순수 함수로 두면 그 셋을 그냥 세어 볼 수 있다.
 */

export interface NudgeInput {
  /** 아직 밀려 있는 건수 */
  pending: number;
  /** 지금 시각(0~23) */
  hour: number;
  /** 지금까지 다시 알린 횟수 */
  nudges: number;
  /** 깨어 있는 시간 (from 이상 to 미만) */
  fromHour: number;
  toHour: number;
  /** 다시 알릴 수 있는 최대 횟수 */
  max: number;
}

/**
 * - `stop` — 더 볼 것이 없다. 타이머까지 끈다.
 * - `wait` — 지금은 안 알리지만 **다음 판에 다시 본다.** 횟수는 안 쓴다.
 * - `post` — 지금 알린다. 횟수를 하나 쓴다.
 */
export type NudgeAction = 'stop' | 'wait' | 'post';

export function nudgeDecision(o: NudgeInput): NudgeAction {
  // 사람이 이미 눌렀거나 큐가 비었다 — 더 두드릴 이유가 없다.
  if (o.pending <= 0) return 'stop';
  // **자는 시간에는 안 깨우되 세지도 않는다.** 여기서 횟수를 쓰면 밤사이에 상한이
  // 다 닳아, 정작 아침에 한 번도 안 알린다.
  if (o.hour < o.fromHour || o.hour >= o.toHour) return 'wait';
  // 여기까지 왔는데도 안 눌렀으면 그건 안 급한 것이다. 끝없이 두드리면 사람이 그
  // 알림 자체를 안 보게 되고, 그러면 다시 알리는 뜻이 사라진다.
  if (o.nudges >= o.max) return 'stop';
  return 'post';
}
