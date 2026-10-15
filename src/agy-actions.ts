/**
 * agy 칸의 명령 허용 목록 · 실행 · 프롬프트 재료(2026-10-14 · 엔진 폴백 6단계).
 *
 * agy 는 도구가 없다 — 「무엇을 할지」를 JSON 으로만 내고, 봇이 여기서 **모양을 엄격히 본 뒤** `tasks.py` 를
 * **셸 없이**(인자 배열) 부른다. 받는 명령은 여덟뿐이다.
 *
 *   add · update · log · defer · quick · inbox_resolve · recurring_done · focus
 *
 * 그 밖의 명령 · 모르는 칸 · 업무 번호가 아닌 id(정기 업무는 목록에 있는 id 만) · 날짜 모양이 아닌 값 ·
 * 한 줄 칸의 줄바꿈 · 길이 초과는 **실행하지 않고** 「실행하지 않은 명령」으로 사람에게 돌려준다.
 * 값의 뜻(상태 낱말 · 칸 이름 · 날짜)은 파이썬 문(`_check_sets`)이 한 번 더 본다 — 여기는 인자 모양과 범위를
 * 막는 바깥 문이다. 값은 `--이름=값` 한 덩어리로 넘긴다(값이 `-` 로 시작해도 깃발로 안 읽히게).
 *
 * 실행 환경 — `WORK_ASSISTANT_CAPTURE=<캡처 id>`(쓰기가 되면 그 캡처가 스스로 닫힌다) · `CLAUDE_BOT_SESSION=1` ·
 * API 키 뺌. 앞 명령이 실패하면 뒤는 안 돌린다(뒤 명령이 앞 결과를 전제할 수 있다).
 */
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import { withoutApiKey } from './child-env';
import { runTasks } from './work-assistant';

// ---------------------------------------------------------------- 업무 목록(재료)

export interface TaskRef {
  id: string;
  title: string;
  recurring: boolean;
}

export interface TaskList {
  today: string;
  now: string;
  tasks: TaskRef[];
  /** 프롬프트에 싣는 한 줄씩. */
  lines: string[];
}

const TSK_RE = /^TSK-\d{1,5}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REMIND_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):[0-5]\d$/;
const JIRA_RE = /^[A-Z][A-Z0-9]{0,19}-\d{1,7}$/;
const RECUR_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const WD = ['일', '월', '화', '수', '목', '금', '토'];

function md(d: string | undefined): string {
  const m = DATE_RE.exec(d ?? '');
  if (!m) return '';
  const wd = WD[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `${m[2]}/${m[3]}(${wd})`;
}

/**
 * `tasks.py json --slim` 을 프롬프트 재료로 — **열린 업무 전부**(일부만 주면 두 엔진 다 엉뚱한 업무를 골랐다 ·
 * 0단계 측정). 못 읽으면 `null` — 목록 없이 고르게 두지 않는다.
 */
export function parseTaskList(json: string): TaskList | null {
  let d: any;
  try { d = JSON.parse(json.trim().split('\n').pop() || ''); } catch { return null; }
  if (!d || !Array.isArray(d.tasks)) return null;
  const tasks: TaskRef[] = [];
  const lines: string[] = [];
  for (const t of d.tasks) {
    if (!t || typeof t.id !== 'string' || typeof t.title !== 'string') continue;
    const recurring = !TSK_RE.test(t.id);
    tasks.push({ id: t.id, title: t.title, recurring });
    const parts = [
      `${t.id}${recurring ? '(정기)' : ''} 「${t.title}」`,
      t.status,
      t.importance ? `중요도 ${t.importance}` : '',
      typeof t.est === 'number' ? `추정 ${t.est}h` : '',
      t.deadline ? `${t.deadline_kind === 'hard' ? '하드' : '소프트'} 마감 ${t.deadline}` : '마감 없음',
      t.start_by ? `착수 마지노선 ${t.start_by}` : '',
      t.my_turn ? `내 차례 ${t.my_turn}` : '',
      t.next_action ? `다음: ${String(t.next_action).replace(/\s+/g, ' ').slice(0, 120)}` : '',
    ].filter(Boolean);
    lines.push(`- ${parts.join(' · ')}`);
  }
  return { today: String(d.today ?? ''), now: String(d.now ?? ''), tasks, lines };
}

export async function fetchTaskList(): Promise<TaskList | null> {
  try {
    const { code, stdout } = await runTasks(['json', '--slim'], 30_000);
    return code === 0 ? parseTaskList(stdout) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 규칙(프롬프트)

/**
 * agy DM 칸에 주는 규칙 — Claude 세션의 슬랙 안내와 업무 비서 규칙에서 **이 칸이 지킬 것만** 줄였다.
 * agy 쪽은 지시문이 달라 Claude 세션과 답이 다를 수 있다(사용자 지적) — 그래서 허용 명령 · 되묻기 기준을 못 박는다.
 */
export const AGY_DM_RULES = [
  '너는 슬랙 DM 업무 비서(스탠리)의 대체 엔진이다. Claude 와 GPT 가 막혀 이 차례를 받았다.',
  '도구는 없다 — 파일 · 명령 · 웹을 못 쓴다. 업무를 바꾸는 일은 아래 명령을 JSON 으로 적으면 봇이 실행한다.',
  '',
  '답은 JSON 객체 하나만 낸다(앞뒤 글 · 코드펜스 없이):',
  '{"reply": "사람에게 보낼 답", "actions": [명령…], "needs_full": false, "needs_full_reason": ""}',
  '',
  '지킬 것:',
  '- reply 는 존댓말 · 5줄 이내 · 슬랙 문법(*굵게*, 목록은 •). 표 · # 제목 · **굵게** 는 안 쓴다.',
  '- 업무를 지어내지 않는다. 사람이 말하지 않은 업무는 등록하지 않는다.',
  '- 대상 업무가 하나로 정해지지 않으면 actions 를 비우고 reply 로 묻는다(후보를 이름으로).',
  '- 업무는 이름으로 부른다 — 「제목(TSK-5)」. 번호만 쓰지 않는다.',
  '- id 는 아래 [열린 업무] 목록에 있는 것만 쓴다. 정기 업무 id 는 목록 그대로.',
  '- 날짜는 오늘 기준으로 실제 날짜(YYYY-MM-DD)로 바꿔 적는다. 「내일」 같은 말을 값에 넣지 않는다.',
  '- 사람이 「끝났다」고 분명히 말한 업무만 완료로 바꾼다. 애매하면 묻는다.',
  '- 연기 사유는 사람이 한 말을 그대로 쓴다.',
  '- 판에서 온 말([진행판] …)을 말한 대로 반영만 했고 알릴 것이 없으면 reply 를 「[조용히]」 한 줄로.',
  '- 메일 · Mycelium · 파일 고치기 · 다른 저장소 · 첨부 · 웹이 있어야 하는 요청이면 needs_full 을 true 로,',
  '  needs_full_reason 에 무엇이 필요한지 한 줄. 할 수 있는 부분만 actions 에 넣는다.',
  '- 조회 · 잡담은 actions 없이 reply 만.',
  '',
  '명령(이 여덟 말고는 실행되지 않는다):',
  '{"op":"add","title":"…","est":2,"importance":"H|M|L","size":"XS|S|M|L","soft":"YYYY-MM-DD","hard":"YYYY-MM-DD","next":"…","remind":"YYYY-MM-DD HH:MM","jira":"KEY-1"}',
  '  — title · est 필수. 모르면 est 2 · soft 다음 영업일+5일 · importance M · size M',
  '{"op":"update","id":"TSK-5","sets":{"칸":"값"}}',
  '  — 칸: 제목 · 요약 · 상태(대기/진행중/완료/취소) · 중요도 · 크기 · 추정 시간 · 실제 소요 · 하드 마감 · 소프트 마감 · 내 차례 · 알림 · 다음 행동 · 메모 · 지라',
  '  — 날짜 칸과 알림만 빈 값("")으로 지울 수 있다. 하드 마감이 있으면 소프트 마감은 아무 데도 안 쓰인다.',
  '{"op":"log","id":"TSK-5","text":"진행 내용"}   (정기 업무 id 도 받는다)',
  '{"op":"defer","id":"TSK-5","reason":"사람이 한 말","soft":"YYYY-MM-DD"}',
  '{"op":"quick","text":"TSK-5 완료 · TSK-6 1h"}   (항목마다 TSK-n 으로 시작)',
  '{"op":"inbox_resolve","drop":"업무 아님 — 사유"}  또는  {"op":"inbox_resolve","task":"TSK-5"}',
  '{"op":"recurring_done","id":"정기 업무 id","as_of":"YYYY-MM-DD","note":"…"}',
  '{"op":"focus","note":"지금 집중할 것 한 줄","pick":["TSK-5"]}  또는  {"op":"focus","off":true}',
].join('\n');

/**
 * DM 칸의 사람 쪽 글 — 지금 시각 · 열린 업무 전부 · 번호표 · 넘겨줄 메모 · 못 본 대화방 글 · 사람 말.
 * 규칙(`AGY_DM_RULES`)은 시스템 쪽으로 따로 간다.
 */
export function agyDmPrompt(o: { list: TaskList; slotMap?: string; handover?: string; context?: string; text: string }): string {
  return [
    `[지금] ${o.list.today} ${o.list.now} (한국 시각)`,
    '',
    `[열린 업무 — 전체 ${o.list.tasks.length}건 · 이 목록 밖의 id 는 쓰지 않는다]`,
    ...o.list.lines,
    ...(o.slotMap ? ['', o.slotMap.trim()] : []),
    ...(o.handover ? ['', o.handover.trim()] : []),
    ...(o.context ? ['', o.context.trim()] : []),
    '',
    '[사람 말]',
    o.text,
  ].join('\n');
}

// ---------------------------------------------------------------- 예약 일의 agy 칸

/** 「지금 집중할 것」 프롬프트(`focus.md`) 뒤에 붙인다 — 도구 대신 한 줄(JSON)만 받는다. */
export const AGY_FOCUS_NOTE = [
  '[대체 엔진 안내 — 이 차례는 agy 가 받았다]',
  '도구가 없다. 위 「하는 일」의 첫 명령 출력은 아래 [재료]에 있고, 둘째 명령(focus)은 봇이 대신 돌린다.',
  '명령 대신 JSON 객체 하나만 낸다(앞뒤 글 · 코드펜스 없이): {"note": "<한 줄>", "pick": ["TSK-n"]}',
  '고를 것이 없으면 pick 은 빈 배열.',
].join('\n');

/** 아침 브리핑 프롬프트 앞에 붙인다 — 도구 단계를 건너뛰고 재료만으로. */
export const AGY_BRIEF_NOTE = [
  '[대체 엔진 안내 — 이 아침 브리핑은 agy 가 받았다]',
  '도구가 없다 — 아래 지시의 명령 실행 · 파일 읽기 · 달력 호출 단계는 건너뛴다. 재료는 맨 아래 [재료](tasks.py brief 출력)와',
  '지시에 붙은 달력 데이터뿐이다. 재료에 없는 칸은 지어내지 않고 「대체 엔진이라 확인 못 함」 한 줄로 둔다.',
  '브리핑 본문만 낸다(☀️ 로 시작).',
].join('\n');

/** agy 가 낸 집중 한 줄(JSON)을 건진다 — 모양이 다르면 `null`. 값의 모양은 허용 목록 문이 다시 본다. */
export function parseFocusReply(text: string): { note: unknown; pick?: unknown } | null {
  let t = (text || '').trim();
  const f = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (f) t = f[1].trim();
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  let o: any;
  try { o = JSON.parse(t.slice(i, j + 1)); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.note !== 'string') return null;
  const pick = Array.isArray(o.pick) && o.pick.length ? o.pick : undefined;
  return pick ? { note: o.note, pick } : { note: o.note };
}

// ---------------------------------------------------------------- 허용 목록

export interface ValidAction {
  op: string;
  /** `tasks.py` 뒤에 붙는 인자 — 셸 없이 그대로 넘긴다. */
  argv: string[];
  /** 「실행한 것」 한 줄. */
  summary: string;
  /** 이 명령에만 얹는 환경 변수. */
  env?: Record<string, string>;
}

export interface RejectedAction {
  /** 무엇이었나 — 명령 이름과 id 만(본문 · JSON 은 안 옮긴다). */
  what: string;
  why: string;
}

export interface ActionContext {
  tasks: TaskRef[];
}

/** 한 번에 받는 명령 수 상한 — 폭주한 계획이 업무를 한꺼번에 흔들지 않게. */
export const ACTIONS_MAX = 8;

class Reject extends Error {}

const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** 한 줄 칸 — 줄바꿈 · 제어 문자 없음 · 길이 상한 · 앞뒤 공백 걷음. */
function line(v: unknown, max: number, name: string, allowEmpty = false): string {
  if (typeof v !== 'string') throw new Reject(`${name}: 글자가 아님`);
  if (/[\r\n]/.test(v)) throw new Reject(`${name}: 줄바꿈이 있음`);
  if (CTRL_RE.test(v) || v.includes('\t')) throw new Reject(`${name}: 제어 문자가 있음`);
  const s = v.trim();
  if (!s && !allowEmpty) throw new Reject(`${name}: 비었음`);
  if (s.length > max) throw new Reject(`${name}: ${max}자를 넘음`);
  return s;
}

/** 여러 줄 칸(진행 로그 · 요약 · 메모) — 줄바꿈만 받는다. */
function body(v: unknown, max: number, name: string): string {
  if (typeof v !== 'string') throw new Reject(`${name}: 글자가 아님`);
  const s = v.replace(/\r\n?/g, '\n').trim();
  if (CTRL_RE.test(s)) throw new Reject(`${name}: 제어 문자가 있음`);
  if (!s) throw new Reject(`${name}: 비었음`);
  if (s.length > max) throw new Reject(`${name}: ${max}자를 넘음`);
  return s;
}

function date(v: unknown, name: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = DATE_RE.exec(s);
  if (!m) throw new Reject(`${name}: 날짜 모양(YYYY-MM-DD)이 아님`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Reject(`${name}: 없는 날짜`);
  return s;
}

function remind(v: unknown, name: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = REMIND_RE.exec(s);
  if (!m) throw new Reject(`${name}: 「YYYY-MM-DD HH:MM」 모양이 아님`);
  date(m[1], name);
  return s;
}

function num(v: unknown, name: string, max: number): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Reject(`${name}: 0~${max} 사이 숫자가 아님`);
  return String(n);
}

function oneOf(v: unknown, list: readonly string[], name: string): string {
  if (typeof v !== 'string' || !list.includes(v.trim())) throw new Reject(`${name}: ${list.join('/')} 중 하나만`);
  return v.trim();
}

function onlyKeys(a: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(a).filter((k) => k !== 'op' && !keys.includes(k));
  if (extra.length) throw new Reject(`모르는 칸 ${extra.slice(0, 3).map((k) => clipName(k)).join(', ')}`);
}

function clipName(s: string): string {
  const one = s.replace(/[^\p{L}\p{N} _-]/gu, '').trim();
  return one.length > 20 ? `${one.slice(0, 19)}…` : one || '?';
}

function taskId(v: unknown, ctx: ActionContext, recurringOk: boolean): TaskRef {
  const s = typeof v === 'string' ? v.trim() : '';
  if (TSK_RE.test(s)) {
    return ctx.tasks.find((t) => t.id === s) ?? { id: s, title: '', recurring: false };
  }
  if (recurringOk && RECUR_ID_RE.test(s)) {
    const hit = ctx.tasks.find((t) => t.id === s && t.recurring);
    if (hit) return hit;
    throw new Reject(`정기 업무 목록에 없는 id`);
  }
  throw new Reject(recurringOk ? '업무 번호(TSK-n)나 목록의 정기 업무 id 가 아님' : '업무 번호(TSK-n)가 아님');
}

function who(t: TaskRef): string {
  return t.title ? `「${t.title}」(${t.id})` : t.id;
}

const IMPORTANCE = ['H', 'M', 'L'] as const;
const SIZE = ['XS', 'S', 'M', 'L'] as const;
const STATUS = ['대기', '진행중', '완료', '취소'] as const;
const EXEC_TYPE = ['L0 수동', 'L1 AI보조', 'L2 AI실행+승인', 'L3 자동'] as const;

type SetKind = 'title' | 'line' | 'text' | 'status' | 'imp' | 'size' | 'num' | 'date' | 'remind' | 'jira';
/** `update` 가 바꿀 수 있는 칸 — 연기 횟수 · 사유는 `defer` 로, 작업 디렉터리 · 출처 · 순서는 안 받는다. */
const SET_FIELDS: Record<string, SetKind> = {
  '제목': 'title', '요약': 'text', '상태': 'status', '중요도': 'imp', '크기': 'size',
  '추정 시간': 'num', '실제 소요': 'num', '하드 마감': 'date', '소프트 마감': 'date', '내 차례': 'date',
  '알림': 'remind', '다음 행동': 'line', '메모': 'text', '지라': 'jira',
};

function setValue(k: string, v: unknown): string {
  // **제 칸만 본다** — 평범한 객체라 `constructor` · `toString` · `__proto__` 가 원형에서 딸려 와 목록을 통과했다.
  const kind = Object.prototype.hasOwnProperty.call(SET_FIELDS, k) ? SET_FIELDS[k] : undefined;
  if (!kind) throw new Reject(`바꿀 수 없는 칸 「${clipName(k)}」`);
  const raw = typeof v === 'number' ? String(v) : v;
  if (raw === '' || raw === null) {
    // **지우기는 날짜 칸 · 알림만** — 글 칸이 지워지면 카드에서 그 줄이 통째로 사라진다(좁은 길과 같은 규칙).
    if (kind === 'date' || kind === 'remind') return '';
    throw new Reject(`${k}: 비울 수 없는 칸`);
  }
  switch (kind) {
    case 'title': return line(raw, 120, k);
    case 'line': return line(raw, 200, k);
    case 'text': return body(raw, 600, k);
    case 'status': return oneOf(raw, STATUS, k);
    case 'imp': return oneOf(raw, IMPORTANCE, k);
    case 'size': return oneOf(raw, SIZE, k);
    case 'num': return num(raw, k, 200);
    case 'date': return date(raw, k);
    case 'remind': return remind(raw, k);
    case 'jira': {
      const s = line(raw, 30, k);
      if (!JIRA_RE.test(s)) throw new Reject(`${k}: 이슈 키 모양이 아님`);
      return s;
    }
    default: throw new Reject(`바꿀 수 없는 칸 「${clipName(k)}」`);
  }
}

/** 한 명령을 본다 — 통과하면 인자와 「실행한 것」 한 줄, 아니면 `Reject`. */
function validateOne(a: Record<string, unknown>, ctx: ActionContext): ValidAction {
  const op = typeof a.op === 'string' ? a.op.trim().replace(/\s+/g, '_') : '';
  switch (op) {
    case 'add': {
      onlyKeys(a, ['title', 'est', 'importance', 'size', 'hard', 'soft', 'next', 'remind', 'jira', 'exec_type']);
      const title = line(a.title, 120, '제목');
      const est = num(a.est, '추정 시간', 200);
      const argv = ['add', `--title=${title}`, `--est=${est}`, '--source=slack'];
      const bits = [`추정 ${est}h`];
      if (a.importance !== undefined) argv.push(`--importance=${oneOf(a.importance, IMPORTANCE, '중요도')}`);
      if (a.size !== undefined) argv.push(`--size=${oneOf(a.size, SIZE, '크기')}`);
      if (a.hard !== undefined) { const d = date(a.hard, '하드 마감'); argv.push(`--hard=${d}`); bits.push(`하드 ${md(d)}`); }
      if (a.soft !== undefined) { const d = date(a.soft, '소프트 마감'); argv.push(`--soft=${d}`); bits.push(`소프트 ${md(d)}`); }
      if (a.next !== undefined) argv.push(`--next=${line(a.next, 200, '다음 행동')}`);
      if (a.remind !== undefined) { const r = remind(a.remind, '알림'); argv.push(`--remind=${r}`); bits.push(`알림 ${r}`); }
      if (a.jira !== undefined) {
        const j = line(a.jira, 30, '지라');
        if (!JIRA_RE.test(j)) throw new Reject('지라: 이슈 키 모양이 아님');
        argv.push(`--jira=${j}`);
      }
      if (a.exec_type !== undefined) argv.push(`--exec-type=${oneOf(a.exec_type, EXEC_TYPE, '실행유형')}`);
      return { op, argv, summary: `업무 등록 「${title}」(${bits.join(' · ')})` };
    }
    case 'update': {
      onlyKeys(a, ['id', 'sets']);
      const t = taskId(a.id, ctx, false);
      const sets = a.sets;
      if (!sets || typeof sets !== 'object' || Array.isArray(sets)) throw new Reject('sets 가 객체가 아님');
      const entries = Object.entries(sets as Record<string, unknown>);
      if (!entries.length) throw new Reject('바꿀 칸이 없음');
      if (entries.length > 8) throw new Reject('한 번에 바꾸는 칸이 8개를 넘음');
      const argv = ['update', `--id=${t.id}`];
      const said: string[] = [];
      for (const [k0, v] of entries) {
        const k = k0.trim();
        const val = setValue(k, v);
        argv.push(`--set=${k}=${val}`);
        said.push(val === '' ? `${k} 지움` : `${k} ${SET_FIELDS[k] === 'date' ? md(val) : SET_FIELDS[k] === 'text' ? '고침' : val}`);
      }
      return { op, argv, summary: `${who(t)} — ${said.join(' · ')}` };
    }
    case 'log': {
      onlyKeys(a, ['id', 'text']);
      const t = taskId(a.id, ctx, true);
      return { op, argv: ['log', `--id=${t.id}`, `--text=${body(a.text, 1500, '진행 로그')}`], summary: `${who(t)} 진행 로그 남김` };
    }
    case 'defer': {
      onlyKeys(a, ['id', 'reason', 'soft']);
      const t = taskId(a.id, ctx, false);
      const reason = line(a.reason, 200, '연기 사유');
      const argv = ['defer', `--id=${t.id}`, `--reason=${reason}`];
      let when = '';
      if (a.soft !== undefined) { const d = date(a.soft, '소프트 마감'); argv.push(`--soft=${d}`); when = ` → ${md(d)}`; }
      return { op, argv, summary: `${who(t)} 연기${when} · 사유 「${reason}」` };
    }
    case 'quick': {
      onlyKeys(a, ['text']);
      const text = line(a.text, 300, '짧은 갱신');
      // **번호표 번호를 안 받는다** — 「3번」이 TSK-3 으로 읽혀 엉뚱한 업무가 완료된 적이 있다(2026-08-06).
      const items = text.split('·').map((s) => s.trim()).filter(Boolean);
      if (!items.length || items.some((s) => !/^TSK-\d{1,5}\b/.test(s))) throw new Reject('항목마다 TSK-n 으로 시작해야 함');
      return { op, argv: ['quick', `--text=${text}`], summary: `짧은 갱신 「${text}」` };
    }
    case 'inbox_resolve': {
      onlyKeys(a, ['task', 'drop']);
      // id 는 안 받는다 — 이 차례의 캡처만(`WORK_ASSISTANT_CAPTURE`). 남의 캡처를 닫지 않게.
      if ((a.task === undefined) === (a.drop === undefined)) throw new Reject('task 와 drop 중 하나만');
      if (a.task !== undefined) {
        const t = taskId(a.task, ctx, false);
        return { op, argv: ['inbox', 'resolve', `--task=${t.id}`], summary: `캡처 닫음 — ${who(t)} 에 연결` };
      }
      const why = line(a.drop, 200, '버리는 사유');
      return { op, argv: ['inbox', 'resolve', `--drop=${why}`], summary: `캡처 닫음 — 「${why}」` };
    }
    case 'recurring_done': {
      onlyKeys(a, ['id', 'as_of', 'note']);
      const t = taskId(a.id, ctx, true);
      if (!t.recurring) throw new Reject('정기 업무 id 가 아님');
      const argv = ['recurring', 'done', `--id=${t.id}`];
      if (a.as_of !== undefined) argv.push(`--as-of=${date(a.as_of, '회차 날짜')}`);
      if (a.note !== undefined) argv.push(`--note=${line(a.note, 200, '회차 메모')}`);
      return { op, argv, summary: `정기 ${who(t)} 이번 회차 완료` };
    }
    case 'focus': {
      onlyKeys(a, ['note', 'pick', 'off']);
      if (a.off === true) {
        if (a.note !== undefined || a.pick !== undefined) throw new Reject('off 와 note · pick 을 같이 줌');
        return { op, argv: ['focus', '--off'], summary: '지금 집중할 것 지움' };
      }
      const note = line(a.note, 120, '집중 한 줄');
      const argv = ['focus', `--note=${note}`];
      if (a.pick !== undefined) {
        if (!Array.isArray(a.pick) || a.pick.length > 3) throw new Reject('pick 은 업무 번호 3개까지');
        for (const p of a.pick) {
          const t = taskId(p, ctx, false);
          if (!ctx.tasks.some((x) => x.id === t.id)) throw new Reject('열린 업무 목록에 없는 번호');
          argv.push(`--pick=${t.id}`);
        }
      }
      return { op, argv, summary: `지금 집중할 것 — 「${note}」` };
    }
    default:
      throw new Reject('허용 목록에 없는 명령');
  }
}

/** 명령들을 가른다 — 통과한 것(순서 그대로)과 실행하지 않을 것(까닭과 함께). */
export function validateActions(raw: readonly unknown[], ctx: ActionContext):
  { ok: ValidAction[]; rejected: RejectedAction[] } {
  const ok: ValidAction[] = [];
  const rejected: RejectedAction[] = [];
  raw.forEach((a, i) => {
    const rec = a && typeof a === 'object' && !Array.isArray(a) ? a as Record<string, unknown> : null;
    const op = rec && typeof rec.op === 'string' ? clipName(rec.op) : '(이름 없음)';
    const id = rec && typeof rec.id === 'string' && /^[\w-]{1,30}$/.test(rec.id.trim()) ? ` ${rec.id.trim()}` : '';
    if (i >= ACTIONS_MAX) {
      rejected.push({ what: `${op}${id}`, why: `한 번에 ${ACTIONS_MAX}개까지` });
      return;
    }
    if (!rec) {
      rejected.push({ what: op, why: '명령 모양이 아님' });
      return;
    }
    try {
      ok.push(validateOne(rec, ctx));
    } catch (err) {
      rejected.push({ what: `${op}${id}`, why: err instanceof Reject ? err.message : '모양을 못 읽음' });
    }
  });
  return { ok, rejected };
}

// ---------------------------------------------------------------- 실행

export interface ActionRun {
  action: ValidAction;
  ok: boolean;
  /** 파이썬이 사람에게 낸 주의 줄(⚠ · ⛔) — 「조용히」 반영이 깨지지 않게 말해야 한다. */
  notes: string[];
  /** 실패 까닭 한 줄. */
  error?: string;
}

/** 실행체 — 기본 PATH 의 파이썬. 검사가 바꿔 끼운다(`AGY_ACTIONS_PYTHON`). */
function python(): string {
  return process.env.AGY_ACTIONS_PYTHON || 'python';
}

function runOne(root: string, a: ValidAction, captureId: string, timeoutMs: number):
  Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      // ⚠️ **셸 없이 인자 배열로** — 값에 `&` · `|` · `"` · `$(…)` 가 있어도 글자 그대로 간다.
      proc = spawn(python(), ['-X', 'utf8', path.join('bin', 'tasks.py'), ...a.argv], {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: withoutApiKey({
          ...process.env, ...(a.env ?? {}),
          PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
          WORK_ASSISTANT_CAPTURE: captureId, CLAUDE_BOT_SESSION: '1',
        }),
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (c: string) => { if (stdout.length < 20_000) stdout += c; });
    proc.stderr?.on('data', (c: string) => { if (stderr.length < 20_000) stderr += c; });
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && proc.pid) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        else proc.kill('SIGKILL');
      } catch { /* 이미 끝남 */ }
    }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

/**
 * 통과한 명령을 차례로 돌린다. **앞이 실패하면 뒤는 안 돌린다**(돌리지 않은 것은 `skipped` 로 돌려준다).
 * `onStart` 는 명령마다 띄우기 직전에 부른다(처리 중 기록) · `onDone` 은 명령 하나가 끝나면 **다음 명령을 띄우기
 * 전에** 지금까지 끝난 것 전부를 넘긴다(재시작에 끊겨도 앞서 끝난 명령이 「이미 한 것」에 남게 · 2026-10-15 검토) ·
 * `stop` 이 참이면 다음 명령을 안 띄운다(`-stop`).
 */
export async function runActions(actions: readonly ValidAction[], o: {
  root: string; captureId: string; timeoutMs?: number;
  onStart?: (i: number) => void; onDone?: (runs: readonly ActionRun[]) => void; stop?: () => boolean;
}): Promise<{ runs: ActionRun[]; skipped: ValidAction[] }> {
  const runs: ActionRun[] = [];
  for (const [i, a] of actions.entries()) {
    if (o.stop?.()) return { runs, skipped: actions.slice(i) };
    o.onStart?.(i);
    const r = await runOne(o.root, a, o.captureId, o.timeoutMs ?? 90_000);
    const notes = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[⚠⛔]/.test(l)).slice(0, 2);
    if (r.code === 0) {
      runs.push({ action: a, ok: true, notes });
      o.onDone?.(runs);
      continue;
    }
    const tail = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? `rc ${r.code}`;
    runs.push({ action: a, ok: false, notes, error: tail.length > 160 ? `${tail.slice(0, 159)}…` : tail });
    o.onDone?.(runs);
    return { runs, skipped: actions.slice(i + 1) };
  }
  return { runs, skipped: [] };
}

// ---------------------------------------------------------------- 사람에게 낼 글

/**
 * 답 뒤에 붙이는 「실행한 것」 · 「실행하지 않은 명령」 — 명령마다 한 줄 · JSON 은 안 옮긴다.
 * 할 것이 없으면 빈 글자.
 */
export function actionReport(runs: readonly ActionRun[], skipped: readonly ValidAction[],
                             rejected: readonly RejectedAction[]): string {
  const out: string[] = [];
  if (runs.length) {
    out.push('*실행한 것*');
    for (const r of runs) {
      out.push(r.ok ? `• ${r.action.summary}` : `• ⚠️ 실패 — ${r.action.summary} · ${r.error ?? ''}`.trimEnd());
      for (const n of r.notes) out.push(`  ${n}`);
    }
  }
  const not = [
    ...skipped.map((a) => `• ${a.summary} — 앞 명령이 실패해 멈춤`),
    ...rejected.map((r) => `• ${r.what} — ${r.why}`),
  ];
  if (not.length) out.push(...(out.length ? [''] : []), '*실행하지 않은 명령*', ...not);
  return out.join('\n');
}

/** 실행한 명령을 보류 칸의 도구 줄로 — 다 쓰기로 본다(실패한 것도 했을 수 있다 · 「실패」로 갈라 넘긴다). */
export function actionSteps(runs: readonly ActionRun[], rung: string):
  { id: string; name: string; input: string; done: boolean; write: boolean; failed?: boolean }[] {
  return runs.map((r, i) => ({
    id: `${rung}-${i}`, name: `${rung} 명령`, input: `tasks.py ${r.action.argv[0]} · ${r.action.summary}`.slice(0, 120),
    done: r.ok, write: true, ...(r.ok ? {} : { failed: true }),
  }));
}
