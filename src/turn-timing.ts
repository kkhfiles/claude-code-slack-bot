/**
 * 차례 하나의 구간 시계(2026-11-03 실장님 「세나 답이 너무 느리다 — 프로파일링」).
 *
 * 세션 띄우기, 모델 차례(생각과 글), 도구 실행을 나눠 잰다. 로그의 「Assistant message received」 시각만으로는
 * 도구 시간과 그 뒤 모델 시간이 한 덩어리로 보였다(18:14 서랍 차례의 12초, 17:28 의 36초).
 *
 * - **도구** — `tool_use` 를 낸 메시지부터 그 `tool_result` 가 돌아올 때까지
 * - **모델** — 앞 구간이 끝난 뒤(시작 · 도구 결과)부터 다음 assistant 메시지까지
 * - **이름만 남긴다** — 도구 이름과, Bash 면 부른 스크립트 파일 이름 하나. 명령 인자와 글은 안 남긴다
 *   (관찰 기록은 판정 재료라 사람 글이 섞이면 안 된다)
 */

export interface TimingStep { k: 'model' | 'tool'; name: string; s: number }

const r1 = (ms: number) => Math.round(ms / 100) / 10;

/** Bash 명령에서 부른 스크립트 이름 하나 — `python -X utf8 bin/tasks.py brief` → `tasks.py`. 모르면 첫 낱말. */
export function commandName(command: unknown): string {
  if (typeof command !== 'string') return '';
  const script = /([A-Za-z0-9_.-]+\.(?:py|mjs|js|ps1|sh))\b/.exec(command);
  if (script) return script[1];
  const first = command.trim().split(/\s+/)[0] || '';
  return first.replace(/^.*[\\/]/, '').slice(0, 30);
}

export class TurnTimer {
  readonly t0: number;
  private initAt = 0;
  private mark: number;
  private open = new Map<string, { name: string; at: number }>();
  readonly steps: TimingStep[] = [];

  constructor(private readonly now: () => number = Date.now) {
    this.t0 = now();
    this.mark = this.t0;
  }

  see(event: any): void {
    const at = this.now();
    if (event?.type === 'system' && event?.subtype === 'init') {
      this.initAt = at;
      this.mark = at;
      return;
    }
    if (event?.type === 'assistant') {
      const parts: any[] = event?.message?.content || [];
      // 한 차례가 여러 메시지(생각 · 도구 호출)로 나뉘어 오면 모델 구간은 첫 메시지까지만 센다
      if (at > this.mark) {
        const kinds = [...new Set(parts.map((p) => p?.type).filter(Boolean))].join('+') || 'message';
        this.steps.push({ k: 'model', name: kinds, s: r1(at - this.mark) });
        this.mark = at;
      }
      for (const p of parts) {
        if (p?.type !== 'tool_use' || !p.id) continue;
        const name = p.name === 'Bash' ? `Bash:${commandName(p.input?.command)}` : String(p.name || 'tool');
        this.open.set(p.id, { name, at });
      }
      return;
    }
    if (event?.type === 'user') {
      const parts: any[] = Array.isArray(event?.message?.content) ? event.message.content : [];
      for (const p of parts) {
        if (p?.type !== 'tool_result') continue;
        const o = this.open.get(p.tool_use_id);
        if (!o) continue;
        this.open.delete(p.tool_use_id);
        this.steps.push({ k: 'tool', name: o.name, s: r1(at - o.at) });
        this.mark = Math.max(this.mark, at);
      }
    }
  }

  /** 관찰 기록 한 줄 — 합계와 구간. 단계는 앞 20개까지. */
  summary(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const end = this.now();
    const sum = (k: 'model' | 'tool') => r1(this.steps.filter((x) => x.k === k).reduce((a, x) => a + x.s * 1000, 0));
    return {
      ...extra,
      total_s: r1(end - this.t0),
      spawn_s: this.initAt ? r1(this.initAt - this.t0) : null,
      model_s: sum('model'),
      tool_s: sum('tool'),
      steps: this.steps.slice(0, 20),
    };
  }
}
