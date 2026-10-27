/**
 * 메모리 경고에 붙는 분석과 대안 버튼 (2026-10-27).
 *
 * **왜** — 감시기는 상위 프로세스 몇 개만 보고 판정해, 커밋 44GB 중 30GB 의 행방을 모른 채 「기다림」만
 * 냈다. 경고할 때 스냅샷 도구(`memory-snapshot.py --json`)로 프로세스 전부 · AI 세션 묶음 · 커널 풀을 재고,
 * 평소 기준과 직전 장에 맞대 무엇이 늘었는지를 AI 가 읽어 **그때그때 대안**을 고른다. 정해 둔 버튼
 * (유령 Explorer 정리 등)은 대안의 한 갈래일 뿐이다.
 *
 * **대안은 자동으로 실행되지 않는다** — 사람이 버튼을 눌러야 돈다. 그래서 자동 종료가 안 건드리는
 * 대화형 세션도 대안으로 낼 수 있다(쉬는 세션이 첫 후보). 상시 작업(스탠리 · 동기화 · 스탠리를 띄운 쪽)은
 * 버튼으로도 못 끈다 — 여기 `vetOptions` 가 거른다. AI 가 무엇을 쓰든 실행할 수 있는 것은 아래 다섯 갈래뿐이다.
 */
import type { Role } from './process-memory-watchdog';

const GB = 1024 ** 3;

export type OptionAction = 'kill' | 'kill_tree' | 'explorer' | 'watchers' | 'reboot' | 'manual';
const ACTIONS = new Set<OptionAction>(['kill', 'kill_tree', 'explorer', 'watchers', 'reboot', 'manual']);

export interface MemOption {
  action: OptionAction;
  label: string;
  reason: string;
  pid?: number;
  /** 실행 직전에 같은 프로세스인지 대조할 이름과 생성 시각(100ns 단위 문자열) */
  name?: string;
  ticks?: string;
  expectGB?: number;
  loss?: string;
}

export interface Analysis { text: string; options: MemOption[] }

/** `memory-snapshot.py --json` 의 모양 중 여기서 쓰는 것만 */
export interface MemSnapshot {
  summary: {
    measured_at: string; boot: string; committed: number; limit: number; available: number; pct: number;
    process_private: number; kernel_pools: number; remainder: number; ai_total: number;
    ai_sessions: Array<{ pid: number; name: string; host: string; tag: string; created: string; ticks?: string;
      procs: number; priv: number; cpu: number; children: Record<string, number> }>;
    non_ai_by_exe: Array<{ name: string; count: number; priv: number }>;
    pool_tags: Array<{ tag: string; paged: number; nonpaged: number }>;
  };
  top_procs: Array<{ pid: number; ppid: number; name: string; parent: string; priv: number; created: string;
    ticks: string; cmd: string }>;
  baseline: SnapDiff | null;
  previous: SnapDiff | null;
  file: string | null;
}

export interface SnapDiff {
  file: string; from: string; to: string; minutes: number;
  deltas: Record<'committed' | 'process_private' | 'kernel_pools' | 'remainder' | 'ai_total', number>;
  sessions: Array<{ pid: number; name: string; host: string; tag: string; priv: number;
    priv_delta: number | null; cpu_delta: number | null }>;
  exe_growth: Array<{ name: string; delta: number; priv: number; count: number; new: boolean }>;
  pool_tag_growth: Array<{ tag: string; hint: string; delta: number; now: number }>;
}

const gb = (b: number) => (b / GB).toFixed(1);
const sgb = (b: number) => `${b >= 0 ? '+' : ''}${(b / GB).toFixed(1)}`;
const hhmm = (iso: string) => iso.slice(5, 16).replace('T', ' ');

/** 끌 수 없는 역할 — 대안 버튼으로도 안 된다 */
const LOCKED: Role[] = ['host', 'stanley', 'pipeline'];
/** 이름으로 막는 것 — 끄면 화면이나 시스템이 같이 넘어간다. 유령 Explorer 는 `explorer` 갈래가 따로 다룬다 */
const LOCKED_NAMES = new Set(['explorer', 'dwm', 'csrss', 'wininit', 'winlogon', 'lsass', 'services', 'svchost',
  'system', 'registry', 'smss', 'memory compression', 'fontdrvhost', 'sihost']);

const bare = (n: string) => n.toLowerCase().replace(/\.exe$/, '');

/** AI 프롬프트에 붙일 내역 — 숫자는 GB 로 줄여 읽기 쉽게 */
export function snapshotDigest(snap: MemSnapshot, roles: Map<number, Role>): string {
  const s = snap.summary;
  const up = (Date.parse(s.measured_at) - Date.parse(s.boot)) / 86_400_000;
  const roleOf = (pid: number) => {
    const r = roles.get(pid);
    return r ? (LOCKED.includes(r) ? `보호(${r})` : '대화형') : '-';
  };
  const L: string[] = [
    '## 메모리 내역 (방금 측정)',
    `커밋 ${gb(s.committed)}/${gb(s.limit)}GB (${s.pct}%), RAM 여유 ${gb(s.available)}GB, 재부팅 뒤 ${up.toFixed(1)}일`,
    `프로세스 전용 합 ${gb(s.process_private)}GB, 커널 풀 ${gb(s.kernel_pools)}GB, 그 밖(공유 메모리 · 드라이버 등) ${gb(s.remainder)}GB`,
  ];
  const b = snap.baseline;
  if (b) {
    L.push('', `## 평소 기준 대비 (기준 ${hhmm(b.from)} 측정)`,
      `커밋 ${sgb(b.deltas.committed)}GB = 프로세스 ${sgb(b.deltas.process_private)} + 커널 풀 ${sgb(b.deltas.kernel_pools)}`
      + ` + 그 밖 ${sgb(b.deltas.remainder)} (그중 AI 세션 ${sgb(b.deltas.ai_total)})`);
    if (b.exe_growth.length) {
      L.push('늘어난 실행 파일: ' + b.exe_growth.slice(0, 8)
        .map((x) => `${x.name} ${sgb(x.delta)}GB(${x.count}개${x.new ? ', 기준에 없던 것' : ''})`).join(', '));
    }
    if (b.pool_tag_growth.length) {
      L.push('늘어난 커널 풀 태그: ' + b.pool_tag_growth.slice(0, 6)
        .map((t) => `${t.tag} ${sgb(t.delta)}GB${t.hint ? `(${t.hint})` : ''}`).join(', '));
    }
  } else {
    L.push('', '평소 기준 장 없음 — 기준 대비는 판정 불가');
  }
  const prev = snap.previous;
  const cpu = new Map((prev?.sessions || []).map((x) => [x.pid, x.cpu_delta]));
  L.push('', `## AI 세션 ${s.ai_sessions.length}개 ${gb(s.ai_total)}GB`
    + (prev ? ` (CPU 증가는 ${prev.minutes}분 전 장 대비 · 0 근처면 그 사이 쉰 세션)` : ' (직전 장 없음 · CPU 증가 판정 불가)'),
  '| PID | 종류 | 이름표 | 띄운 곳 | 메모리 GB | 프로세스 수 | CPU 증가 초 | 역할 |', '|---|---|---|---|---|---|---|---|');
  for (const x of s.ai_sessions) {
    const d = cpu.get(x.pid);
    L.push(`| ${x.pid} | ${x.name} | ${x.tag || '-'} | ${x.host} | ${gb(x.priv)} | ${x.procs} | `
      + `${d === undefined || d === null ? '새로' : Math.round(d)} | ${roleOf(x.pid)} |`);
  }
  L.push('', '## AI 세션 밖 큰 프로세스', '| PID | 이름 | 부모 | 메모리 MB | 역할 | 명령줄 |', '|---|---|---|---|---|---|');
  for (const p of snap.top_procs.slice(0, 15)) {
    L.push(`| ${p.pid} | ${bare(p.name)} | ${bare(p.parent || '?')} | ${Math.round(p.priv / 1024 ** 2)} | `
      + `${roleOf(p.pid)} | ${p.cmd.replace(/\|/g, '/').slice(0, 120)} |`);
  }
  return L.join('\n');
}

/** 대안을 고르는 규칙과 답 모양 — 판정 프롬프트 뒤에 붙이거나(`withVerdict`) 단독으로 쓴다 */
export function optionsInstructions(withVerdict: boolean): string {
  return [
    '## 대안 고르기',
    '위 내역으로 평소 기준보다 무엇이 늘었는지 읽고, 사람이 버튼으로 고를 대안을 1~4개 낸다. **대안은 사람이 눌러야만 실행된다.**',
    '- action 은 다섯 가지뿐: kill(프로세스 하나), kill_tree(프로세스와 자식 전부 — AI 세션은 이것), explorer(창 없는 유령 Explorer 정리), watchers(끝난 작업의 감시 프로세스 정리), reboot(재시작 — 커널 풀이나 그 밖이 주범일 때만 효과가 있다), manual(버튼 없이 사람이 할 일 안내).',
    '- 역할이 「보호」인 것은 고르지 않는다(골라도 버려진다). pid 는 위 표에 있는 것만.',
    '- 「대화형」 세션도 낼 수 있다 — 쉬는 세션(CPU 증가가 0 근처)을 먼저 낸다. 잃는 것은 그 터미널의 지난 출력이고, 이름표가 있으면 다시 여는 명령(claude -r <이름표> · codex resume <id> · agy --conversation <id>)을 loss 에 적는다.',
    '- 기준 대비 커널 풀이나 그 밖이 크게 늘었으면 프로세스를 꺼도 안 줄어든다고 analysis 에 밝힌다. 그 원인이 될 작업(파일을 대량으로 여는 동기화 · 검색 등)이 보이면 manual 이나 reboot 로 낸다.',
    '- 회수 예상이 큰 순서로. 효과가 0.3GB 안 되는 것은 내지 않는다.',
    '',
    withVerdict
      ? '위 답 JSON 에 두 칸을 더한다: "analysis" 와 "options".'
      : '답(다른 글 없이 JSON 하나): {"analysis": …, "options": […]}',
    '"analysis": "기준 대비 무엇이 얼마나 늘었고 그중 끌 수 있는 몫이 얼마인지 두세 문장"',
    '"options": [{"action": "kill_tree", "pid": 숫자 또는 null, "label": "버튼에 쓸 짧은 이름(20자 안)", "reason": "왜 이것인지 한 줄", "expect_gb": 회수 예상 숫자, "loss": "잃는 것 한 줄"}]',
  ].join('\n');
}

function jsonOf(text: string | null | undefined): any {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

/**
 * AI 답에서 분석과 대안을 꺼내 **실행할 수 있는 것만** 남긴다. 버린 것은 `dropped` 에 사유와 함께.
 * pid 는 스냅샷에 있어야 하고(이름 · 생성 시각을 거기서 얻는다) · 보호 역할이 아니어야 하고 ·
 * kill_tree 는 자손에 보호 역할이 없어야 한다.
 */
export function vetOptions(text: string | null | undefined, ctx: {
  snap: MemSnapshot; roles: Map<number, Role>; botPid: number;
  /** pid → 자손 pid 목록(kill_tree 검사용) */
  descendants: (pid: number) => number[];
}): Analysis & { dropped: string[] } {
  const d = jsonOf(text);
  const dropped: string[] = [];
  const analysis = typeof d?.analysis === 'string' ? d.analysis.trim().slice(0, 500) : '';
  const raw: any[] = Array.isArray(d?.options) ? d.options : [];
  const known = new Map<number, { name: string; ticks: string }>();
  for (const p of ctx.snap.top_procs) known.set(p.pid, { name: bare(p.name), ticks: p.ticks });
  for (const x of ctx.snap.summary.ai_sessions) known.set(x.pid, { name: x.name, ticks: x.ticks || '' });
  const options: MemOption[] = [];
  const seen = new Set<string>();
  for (const o of raw) {
    if (options.length >= 4) { dropped.push('다섯 번째부터 버림'); break; }
    const action = String(o?.action || '') as OptionAction;
    const label = String(o?.label || '').trim().slice(0, 30);
    if (!ACTIONS.has(action) || !label) { dropped.push(`모양이 틀림: ${JSON.stringify(o).slice(0, 80)}`); continue; }
    const opt: MemOption = {
      action, label, reason: String(o?.reason || '').trim().slice(0, 200),
      loss: o?.loss ? String(o.loss).trim().slice(0, 120) : undefined,
      expectGB: Number.isFinite(Number(o?.expect_gb)) ? Math.max(0, Number(o.expect_gb)) : undefined,
    };
    if (action === 'kill' || action === 'kill_tree') {
      const pid = Number(o?.pid);
      const k = Number.isInteger(pid) ? known.get(pid) : undefined;
      const role = ctx.roles.get(pid);
      const why = !k ? '스냅샷에 없는 pid'
        : pid === ctx.botPid || (role && LOCKED.includes(role)) ? '보호 대상'
          : LOCKED_NAMES.has(k.name) ? '시스템 프로세스'
            : !k.ticks ? '생성 시각을 몰라 같은 프로세스인지 확인 불가'
              : action === 'kill_tree' && ctx.descendants(pid).some((c) => {
                const r = ctx.roles.get(c);
                return c === ctx.botPid || (r && LOCKED.includes(r));
              }) ? '자손에 보호 대상'
                : '';
      if (why) { dropped.push(`${label} — ${why}`); continue; }
      Object.assign(opt, { pid, name: k!.name, ticks: k!.ticks });
    }
    const key = `${action}:${opt.pid ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(opt);
  }
  return { text: analysis, options, dropped };
}

/** 사람에게 보이는 첫 줄 — AI 없이 스냅샷만으로 */
export function snapshotHeadline(snap: MemSnapshot): string {
  const b = snap.baseline;
  if (!b) return `📊 프로세스 ${gb(snap.summary.process_private)}GB, 커널 풀 ${gb(snap.summary.kernel_pools)}GB, `
    + `그 밖 ${gb(snap.summary.remainder)}GB (평소 기준 장이 없어 비교 못 함)`;
  return `📊 *평소 기준(${hhmm(b.from)}) 대비 커밋 ${sgb(b.deltas.committed)}GB* — 프로세스 ${sgb(b.deltas.process_private)}, `
    + `커널 풀 ${sgb(b.deltas.kernel_pools)}, 그 밖 ${sgb(b.deltas.remainder)} (AI 세션 ${snap.summary.ai_sessions.length}개 `
    + `${gb(snap.summary.ai_total)}GB)`;
}

/** 분석 · 대안 글. 결과가 붙으면 그 대안 줄 끝에 이어 쓴다. */
export function analysisText(head: string, a: Analysis, results: Record<number, string> = {}): string {
  const L = [head];
  if (a.text) L.push(`🧠 ${a.text}`);
  if (a.options.length) {
    L.push('', '*대안* — 눌러야 실행됩니다');
    a.options.forEach((o, i) => {
      const gain = o.expectGB !== undefined ? `, 회수 약 ${o.expectGB.toFixed(1)}GB` : '';
      const loss = o.loss ? `, 잃는 것: ${o.loss}` : '';
      const done = results[i] ? `\n    → ${results[i]}` : '';
      L.push(`${i + 1}. *${o.label}*${o.action === 'manual' ? ' (직접)' : ''} — ${o.reason}${gain}${loss}${done}`);
    });
  }
  return L.join('\n');
}

const CONFIRM_TEXT: Partial<Record<OptionAction, string>> = {
  kill: '이 프로세스를 끕니다. 저장 안 한 작업은 사라집니다.',
  kill_tree: '이 프로세스와 그 자식을 모두 끕니다. 세션이면 터미널의 지난 출력이 사라집니다.',
  explorer: '창 없는 유령 Explorer 를 정리합니다.',
  watchers: '끝난 작업의 감시 프로세스를 정리합니다.',
};

/** 버튼 블록 — 이미 실행한 것과 직접 할 일(manual)은 버튼이 없다 · 끝에 「그대로 둠」 */
export function optionButtons(groupId: string, a: Analysis, done: Set<number> = new Set()): any | null {
  const elements: any[] = [];
  a.options.forEach((o, i) => {
    if (o.action === 'manual' || done.has(i)) return;
    const b: any = {
      type: 'button', text: { type: 'plain_text', text: `${i + 1}. ${o.label}`.slice(0, 75) },
      action_id: `watchdog_opt_${i}`, value: `${groupId}:${i}`,
    };
    if (o.action === 'kill' || o.action === 'kill_tree') b.style = 'danger';
    const c = CONFIRM_TEXT[o.action];
    if (c) {
      b.confirm = {
        title: { type: 'plain_text', text: `${i + 1}. ${o.label}`.slice(0, 100) },
        text: { type: 'plain_text', text: c },
        confirm: { type: 'plain_text', text: '실행' }, deny: { type: 'plain_text', text: '취소' },
      };
    }
    elements.push(b);
  });
  if (!elements.length) return null;
  elements.push({ type: 'button', text: { type: 'plain_text', text: '그대로 둠' },
    action_id: 'watchdog_opt_x', value: `${groupId}:x` });
  return { type: 'actions', elements };
}
