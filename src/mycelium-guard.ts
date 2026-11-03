/**
 * Mycelium 사이트 알림의 버튼 — 「이 계정 막기 · 사이트 닫기 · 다시 열기 · 지금 상태」.
 *
 * 알림 메시지는 Mycelium 서버가 work-assistant `notify/sena_mycelium.py` 의 `send` 로 이 봇의
 * 토큰을 써서 실장 DM 에 올린다. 그래서 누른 것은 이 봇의 연결로 들어온다.
 *
 * **명령은 여기서 만들지 않는다.** 버튼 값에는 `id` 와 `who` 만 있고, 그 둘을 같은 파이썬 파일의
 * `run` 에 넘긴다 — 허용 목록과 지문 형식 검사가 그 파일 한 곳에 있어 대화로 시킨 명령과 같은
 * 문을 지난다(규격: mycelium-web `docs/sena-interface.md`). 여기서도 모양을 먼저 거르는 것은
 * 남이 만든 값이 파이썬까지 가지 않게 하려는 것이다.
 *
 * 누른 사람 확인은 `SlackHandler.action` 이 한다 — 허용 목록 밖이면 이 처리기에 오지 않는다.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { pythonCommand } from './python-command';
import { workAssistantRoot } from './work-assistant';

export const GUARD_ACTION = /^mycelium_guard_(block|close|open|status|yes|no)$/;
const WHO = /^u-[0-9a-f]{16}$/;
/** 버튼 이름 — 파이썬 `BUTTONS` 와 같은 표(규격 「버튼(actions)」). */
const LABELS: Record<string, string> = { block: '이 계정 막기', close: '사이트 닫기', open: '다시 열기', status: '지금 상태' };
const CONFIRM = new Set(['block', 'close']);
const TAIL = 'mycelium_guard';

export interface GuardPick { id: string; who: string | null }

/** 버튼 값 → `{id, who}`. 모양이 틀리면 null. */
export function parsePick(value: unknown): GuardPick | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  let v: any;
  try { v = JSON.parse(value); } catch { return null; }
  if (!v || typeof v.id !== 'string' || !(v.id in LABELS)) return null;
  const who = v.who == null ? null : v.who;
  if (who !== null && (typeof who !== 'string' || !WHO.test(who))) return null;
  if (v.id === 'block' && !who) return null;
  return { id: v.id, who };
}

export function needsConfirm(id: string): boolean {
  return CONFIRM.has(id);
}

function button(actionId: string, label: string, pick: GuardPick, danger: boolean): any {
  const b: any = {
    type: 'button', action_id: actionId, text: { type: 'plain_text', text: label },
    value: JSON.stringify({ id: pick.id, who: pick.who }),
  };
  if (danger) b.style = 'danger';
  return b;
}

/** 처음 버튼 줄 — 「아니요」를 누르면 이것으로 되돌린다. */
export function buttonsTail(who: string | null): any[] {
  const els = Object.keys(LABELS)
    .filter(id => id !== 'block' || who)
    .map(id => button(`mycelium_guard_${id}`, LABELS[id], { id, who }, CONFIRM.has(id)));
  return [{ type: 'actions', block_id: TAIL, elements: els }];
}

/** 한 번 더 묻기 — 막기와 닫기. */
export function confirmTail(pick: GuardPick): any[] {
  const ask = pick.id === 'block'
    ? `정말 이 계정(\`${pick.who}\`)을 막을까요? 다음 요청부터 막힙니다.`
    : '정말 사이트를 닫을까요? 새 질문을 받지 않고 화면 위에 안내를 냅니다.';
  return [
    { type: 'section', block_id: `${TAIL}_ask`, text: { type: 'mrkdwn', text: ask } },
    { type: 'actions', block_id: TAIL, elements: [
      button('mycelium_guard_yes', pick.id === 'block' ? '네, 막기' : '네, 닫기', pick, true),
      button('mycelium_guard_no', '아니요', pick, false),
    ] },
  ];
}

/** 결과 — 버튼 자리에 `message` 를 둔다. 실패면 그렇다고 먼저 적는다. */
export function resultTail(label: string, r: { ok: boolean; message: string }): any[] {
  const msg = (r.message || '').slice(0, 2800);
  const head = r.ok ? `✅ ${label}` : `❌ ${label} 실행 실패`;
  return [{ type: 'section', block_id: `${TAIL}_note`,
    text: { type: 'mrkdwn', text: msg ? `${head}\n\`\`\`${msg}\`\`\`` : head } }];
}

/** 원래 메시지에서 버튼 쪽(이 모듈이 붙인 블록)을 걷고 새 꼬리를 단다. */
export function swapTail(blocks: any[] | undefined, tail: any[]): any[] {
  const keep = (blocks || []).filter(b => !(typeof b?.block_id === 'string' && b.block_id.startsWith(TAIL)));
  return [...keep, ...tail];
}

export function labelOf(id: string): string {
  return LABELS[id] || id;
}

/** `sena_mycelium.py run` 한 번 — 결과 JSON 한 줄을 읽는다. 파일을 못 찾거나 못 읽으면 실패 결과. */
export function runGuard(pick: GuardPick, reason: string): Promise<{ ok: boolean; message: string }> {
  const root = workAssistantRoot();
  if (!root) return Promise.resolve({ ok: false, message: 'WORK_ASSISTANT_ROOT 가 설정되지 않음' });
  const script = path.join(root, 'notify', 'sena_mycelium.py');
  const args = ['-X', 'utf8', script, 'run', pick.id];
  if (pick.who && (pick.id === 'block')) args.push(pick.who);
  args.push('--reason', reason);
  return new Promise(resolve => {
    const proc = spawn(pythonCommand('python'), args, {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* 이미 끝남 */ } }, 45_000);
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, message: `실행 실패: ${e.message}` }); });
    proc.on('close', code => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop() || '';
      try {
        const j = JSON.parse(last);
        resolve({ ok: !!j.ok, message: String(j.message ?? '') });
      } catch {
        resolve({ ok: false, message: `결과를 못 읽음(rc=${code}) ${(err || out).trim().slice(-300)}` });
      }
    });
  });
}
