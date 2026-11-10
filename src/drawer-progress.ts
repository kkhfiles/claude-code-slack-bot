/**
 * 서랍 차례의 진행 단계 — 세나 세션이 부르는 도구를 사람 말 한 줄로 바꿔 서랍에 적는다(2026-11-04 실장님
 * N6 시안 04 「단계 문구에서 답으로」, PC 와 모바일 모두). 서랍은 1.5초마다 차례를 묻고 이 줄들을 한 줄씩 쌓는다.
 *
 * **글은 도구 이름과 명령의 앞부분만 본다** — 명령의 인자(업무 이름, 검색어, 메일 제목)는 화면에 올리지 않는다.
 * 실장님만 보는 서랍이지만, 단계 줄은 무엇을 하는지만 말하면 되고 내용은 답이 말한다.
 */
import { runTasks } from './work-assistant';

/** 명령 앞부분 → 사람 말. 위에서부터 처음 맞는 것. */
const COMMANDS: Array<[RegExp, string]> = [
  [/sena_drawer\.py\s+reply/, '답을 서랍에 정리하는 중'],
  [/tasks\.py\s+(?:brief|board|json|find|session)/, '업무 판 보는 중'],
  [/tasks\.py\s+(?:add|update|log|defer|quick|recurring|inbox)/, '업무 판에 적는 중'],
  [/stanley_sessions\.py/, 'PC 세션 목록 보는 중'],
  [/stanley_send\.py/, '세션에 지시 보내는 중'],
  [/mail\.py/, '메일 보는 중'],
  [/cal\.py/, '달력 보는 중'],
  [/sena_mycelium\.py|mycelium/i, 'Mycelium 보는 중'],
  [/sena_humor\.py/, 'Tension 설정 바꾸는 중'],
  [/llm_playbook\.credits/, '크레딧 장부 보는 중'],
  [/\bgit\b/, '저장소 기록 보는 중'],
  [/\bgh\b/, 'GitHub 보는 중'],
];

const TOOLS: Record<string, string> = {
  Read: '파일 읽는 중',
  Grep: '파일 안을 찾는 중',
  Glob: '파일 찾는 중',
  WebSearch: '웹 검색하는 중',
  WebFetch: '웹 페이지 읽는 중',
  Task: '하위 에이전트에 맡기는 중',
  Agent: '하위 에이전트에 맡기는 중',
  Edit: '파일 고치는 중',
  Write: '파일 쓰는 중',
  TodoWrite: '할 일 정리하는 중',
  Skill: '스킬 불러오는 중',
};

/** 도구 호출 하나를 단계 줄로. 모르는 도구는 「작업하는 중」. */
export function stepLabel(name: string, input: unknown): string {
  if (name === 'Bash' || name === 'PowerShell') {
    const cmd = String((input as { command?: unknown } | null)?.command ?? '');
    for (const [re, label] of COMMANDS) if (re.test(cmd)) return label;
    return '명령 실행하는 중';
  }
  if (name.startsWith('mcp__')) return '연결된 도구 쓰는 중';
  return TOOLS[name] ?? '작업하는 중';
}

/** 서랍 차례 표시(`[서랍 차례 <id>]`)에서 차례 id. 아니면 ''. */
export function drawerTidOf(text: string | undefined): string {
  const m = /^\[서랍 차례 ([0-9a-f]{32})\]/.exec(text ?? '');
  return m ? m[1] : '';
}

/**
 * 차례마다 한 줄씩 순서대로 적는다 — 부르는 쪽은 기다리지 않는다. 같은 줄이 이어지면 파이썬이 하나로 친다.
 * 못 적어도 답에는 영향이 없다(단계 줄이 빠질 뿐).
 */
export function progressWriter(tid: string): (label: string) => void {
  let chain: Promise<unknown> = Promise.resolve();
  let last = '';
  return (label: string) => {
    if (!tid || !label || label === last) return;
    last = label;
    chain = chain.then(() => runTasks(['progress', '--turn', tid, '--label', label], 15_000, 'bin/sena_drawer.py'))
      .catch(() => undefined);
  };
}
