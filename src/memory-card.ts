/**
 * 세나 0층 기억 카드와 미리 꺼내 붙이기(2026-11-06 · 설계 work-assistant `docs/sena-agency.md`, Argon, Astra 교차 검토).
 *
 * - **카드** — 업무 비서 저장소의 `bin/sena_memory.py card --write` 가 써 둔 파일을 차례 말 끝에 그대로 싣는다. 차례 중에는
 *   도구를 안 돌린다(답 대기 셈에 데스크 조회가 들어 1~3초). 차례가 끝나면 다시 쓰게 띄워 두고 기다리지 않는다.
 * - **미리 꺼내 붙이기** — 사람이 쓴 말에 업무 번호(TSK-n)나 「어제」가 있으면 `sena_memory.py recall` 을 같이 돌려
 *   그 결과를 말 끝에 붙인다. 세나가 「꺼내 볼까」를 스스로 고르다 안 꺼내고 짐작하는 실패를 줄인다(E1 에서 도구가 있어도
 *   기억으로 답한 질문이 나옴). 다른 준비와 나란히 돌고, 늦으면(`PREFETCH_MS`) 버린다 — 답을 늦추지 않는다.
 *
 * 못 읽거나 늦으면 빈 글 — 카드와 미리 꺼낸 것이 빠질 뿐 대화는 그대로 돈다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTasks } from './work-assistant';

export const PREFETCH_MS = 2500;
/** 서랍에서 온 차례 — 봇이 넘긴 말(pushed)이지만 사람이 쓴 말이다. */
export const DRAWER_TURN = /^\[서랍 차례 [0-9a-f]{32}\]/;
export const PREFETCH_LINES = 12;

export function cardFile(): string {
  return process.env.SENA_CARD_FILE || path.join(os.homedir(), '.claude', 'state', 'sena', 'card.txt');
}

export function readCard(file: string = cardFile()): string {
  try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return ''; }
}

/** 차례가 끝난 뒤 카드를 다시 쓰게 띄운다 — 기다리지 않는다. */
export function refreshCard(): void {
  runTasks(['card', '--write'], 30_000, 'bin/sena_memory.py').catch(() => { });
}

/** 말에서 꺼낼 열쇠 — 업무 번호 둘까지, 「어제」면 어제 날짜(한국 시각). */
export function prefetchKeys(text: string, now: Date = new Date()): string[] {
  const keys = [...new Set((text.match(/\bTSK-\d+\b/g) || []))].slice(0, 2);
  if (/어제/.test(text)) {
    keys.push(new Date(now.getTime() + 9 * 3600_000 - 86_400_000).toISOString().slice(0, 10));
  }
  return keys;
}

/** 열쇠마다 일지를 꺼내 한 덩어리로 — 늦거나 실패하면 그 열쇠는 뺀다. */
export async function prefetchNote(text: string, run = runTasks): Promise<string> {
  const keys = prefetchKeys(text);
  if (!keys.length) return '';
  const parts = await Promise.all(keys.map((k) => Promise.race([
    run(['recall', k, '--days', '7'], PREFETCH_MS, 'bin/sena_memory.py').then((r) => (r.code === 0 ? r.stdout.trim() : ''), () => ''),
    new Promise<string>((res) => { setTimeout(() => res(''), PREFETCH_MS).unref?.(); }),
  ])));
  const body = parts.filter(Boolean).map((p) => p.split('\n').slice(0, PREFETCH_LINES).join('\n')).join('\n');
  return body ? `[일지에서 미리 꺼냄 — 이 말의 ${keys.join(', ')} · 앞서 한 일은 이것과 대조해 말함]\n${body}` : '';
}
