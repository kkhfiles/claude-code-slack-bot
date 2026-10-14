/**
 * 차례 하나가 **어떻게 끝났나 · 무엇을 돌렸나** (2026-10-14 · 보류 v2).
 *
 * 밀린 것을 다시 돌리는 드레인이 두 가지를 몰랐다.
 *   - **끝이 어땠나** — 대화 처리기(`handleMessage`)가 결과를 안에서 삼켜, 다시 돌린 것이 또 한도에
 *     막혀도 드레인은 다음 것을 집었다(건마다 시도 횟수만 탔다)
 *   - **무엇을 이미 했나** — 쓰기 도구가 돈 뒤 한도에 끊긴 차례를 처음부터 다시 돌리면 같은 쓰기가
 *     두 번 들어간다(업무 둘 · 진행 로그 둘)
 *
 * 그래서 차례가 도는 동안 도구 호출을 한 줄씩 적고(`StepLog`), 끝에서 결과를 부른 쪽에 돌려준다.
 * **판정은 이벤트만 본다** — 모델이 쓴 글은 안 읽는다(한도를 이야기한 글이 한도로 둔갑한다).
 */
import type { Block } from './engine-state';

export type TurnResult = 'ok' | 'limited' | 'overload' | 'error';

export interface TurnStep {
  /** `tool_use` 의 id — 결과(`tool_result`)와 짝을 맞춘다. */
  id: string;
  name: string;
  /** 무엇에 썼나 한 줄(≤ `STEP_INPUT_MAX`) — 파일 내용은 안 싣는다. */
  input: string;
  /** 결과가 돌아왔나. 안 돌아온 것은 「했는지 모름」이다. */
  done: boolean;
  /** 쓰기를 할 수 있는 도구인가(`isWriteTool`). */
  write: boolean;
}

export interface TurnOutcome {
  outcome: TurnResult;
  engine: 'claude';
  steps: TurnStep[];
  /** 쓰기를 할 수 있는 도구가 하나라도 **시작했나** — 결과가 안 왔어도 셈(했을 수 있다). */
  writeRan: boolean;
  sessionId?: string;
  captureId?: string;
}

/**
 * 읽기만 하는 도구 — 이 밖은 전부 쓰기로 본다(`Bash` · `Edit` · `Write` · `Task` · `Skill` ·
 * `mcp__*` · 모르는 이름). **모르면 쓰기 쪽이다** — 쓰기를 읽기로 잘못 보면 두 번 쓰고,
 * 읽기를 쓰기로 잘못 보면 이어 가기가 한 번 더 확인할 뿐이다.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'NotebookRead',
]);

export function isWriteTool(name: string): boolean {
  return !READ_ONLY_TOOLS.has(name);
}

export const STEP_INPUT_MAX = 120;
/** 한 차례에 적는 도구 수 상한 — 폭주한 차례가 기록을 끝없이 늘리지 않게. */
export const STEP_MAX = 60;

/** 내용을 싣는 칸 — 한 줄 요약에 넣지 않는다(파일 본문 · 바꿀 글 · 프롬프트). */
const BODY_KEYS = new Set(['content', 'text', 'body', 'new_string', 'old_string', 'edits', 'prompt',
  'new_source', 'markdown', 'data']);

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 도구 입력을 한 줄로 — 무엇에 썼는지만. */
export function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (k: string) => (typeof input[k] === 'string' ? input[k] : '');
  let s = '';
  switch (name) {
    case 'Bash': s = pick('command'); break;
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': s = pick('file_path'); break;
    case 'NotebookEdit': case 'NotebookRead': s = pick('notebook_path'); break;
    case 'Grep': case 'Glob': s = pick('pattern'); break;
    case 'Task': case 'Agent': s = pick('description'); break;
    case 'Skill': s = [pick('skill'), pick('args')].filter(Boolean).join(' '); break;
    case 'WebFetch': s = pick('url'); break;
    case 'WebSearch': s = pick('query'); break;
    default: {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(input)) {
        if (BODY_KEYS.has(k)) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          parts.push(`${k}=${clip(String(v), 40)}`);
        }
      }
      s = parts.join(' ');
    }
  }
  return clip(s, STEP_INPUT_MAX);
}

/**
 * 차례가 도는 동안 도구 호출을 적는다. 이벤트를 하나씩 넘긴다(`see`).
 *
 * - `assistant` 의 `tool_use` — 새 도구(같은 id 는 한 번만)
 * - `user` 의 `tool_result` — 그 도구가 끝남
 */
export class StepLog {
  readonly steps: TurnStep[] = [];
  private byId = new Map<string, TurnStep>();

  /** 이벤트 하나를 본다. **새 도구가 시작했으면 `true`** — 부르는 쪽이 기록을 고쳐 쓰는 신호다. */
  see(ev: any): boolean {
    let started = false;
    try {
      const parts = ev?.message?.content;
      if (!Array.isArray(parts)) return false;
      if (ev.type === 'assistant') {
        for (const p of parts) {
          if (p?.type !== 'tool_use' || typeof p.id !== 'string' || this.byId.has(p.id)) continue;
          if (this.steps.length >= STEP_MAX) continue;
          const name = String(p.name ?? '');
          const step: TurnStep = {
            id: p.id, name, input: summarizeInput(name, p.input), done: false, write: isWriteTool(name),
          };
          this.steps.push(step);
          this.byId.set(p.id, step);
          started = true;
        }
      } else if (ev.type === 'user') {
        for (const p of parts) {
          if (p?.type !== 'tool_result') continue;
          const step = this.byId.get(String(p.tool_use_id ?? ''));
          if (step) step.done = true;
        }
      }
    } catch {
      /* 기록은 차례의 일부가 아니다 — 터져도 차례는 간다 */
    }
    return started;
  }

  get writeRan(): boolean {
    return this.steps.some((s) => s.write);
  }
}

/** 쓰기 도구 한 줄 — 「완료 · Bash · …」 또는 「결과 모름 · Bash · …」. */
export function stepLine(s: TurnStep): string {
  return [s.done ? '완료' : '결과 모름', s.name, s.input].filter(Boolean).join(' · ');
}

/** 이어 갈 때 넘길 「이미 한 것」 — 쓰기 도구만(읽기는 다시 해도 된다). */
export function doneStepLines(steps: readonly TurnStep[]): string[] {
  return steps.filter((s) => s.write).map(stepLine);
}

/** 막힘(있으면)과 오류 여부로 결과를 정한다 — 과부하는 한도와 따로 센다. */
export function outcomeFrom(block: Block | null, error: boolean): TurnResult {
  if (block) return block.kind === 'overload' ? 'overload' : 'limited';
  return error ? 'error' : 'ok';
}

/** 다시 막혔나 — 드레인이 멈추는 조건. */
export function isHeldOutcome(o: { outcome?: TurnResult } | undefined | void): boolean {
  return !!o && (o.outcome === 'limited' || o.outcome === 'overload');
}
