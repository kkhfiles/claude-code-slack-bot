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
  let card: string;
  try { card = fs.readFileSync(file, 'utf-8').trim(); } catch { return ''; }
  const verdict = ledgerVerdict(file);
  return verdict ? `${card}\n${verdict}` : card;
}

/** 원천 파일(폴더는 그 안 파일)의 가장 늦은 수정 시각(ms) — 못 읽는 것은 건너뛴다. 하나도 못 읽으면 null. */
export function latestMtime(paths: string[]): number | null {
  let best: number | null = null;
  const see = (ms: number) => { best = best === null ? ms : Math.max(best, ms); };
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      see(st.mtimeMs);
      if (!st.isDirectory()) continue;
      for (const name of fs.readdirSync(p)) {
        try { see(fs.statSync(path.join(p, name)).mtimeMs); } catch { /* 지운 직후 */ }
      }
    } catch { /* 없는 원천 — 다른 원천으로 판정 */ }
  }
  return best;
}

const hms = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 19);

/**
 * 「답 대기 판정」 한 줄(E1 V3 운영 반영, 2026-11-10) — 카드 옆 `card.json`(계산 시각과 원천 파일 목록, `sena_memory.py card
 * --write` 가 씀)을 읽어, 차례 시작 때 원천의 가장 늦은 수정 시각과 맞댄다. 장부가 카드 뒤에 바뀌었으면 「낡음」. 세나 정체성이
 * 이 줄을 따라 「카드 그대로」면 도구 없이 답한다(먼저 조회하면 그 질문마다 2.4초 늦었다). 옆 파일을 못 읽으면 줄을 안 붙이고,
 * 그때 세나는 예전처럼 `pending` 을 돈다.
 */
export function ledgerVerdict(file: string = cardFile()): string {
  try {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.txt$/, '.json'), 'utf-8')) as { at?: number; ledger?: string[] };
    if (typeof meta.at !== 'number' || !Array.isArray(meta.ledger)) return '';
    const at = meta.at * 1000;
    const last = latestMtime(meta.ledger);
    if (last === null) return '';
    return last > at
      ? `답 대기 판정 — 카드가 낡음(장부 ${hms(last)} 수정 > 카드 ${hms(at)} 계산): pending 을 돌려 그 목록으로 답함`
      : `답 대기 판정 — 카드 그대로(장부 ${hms(last)} 수정 ≤ 카드 ${hms(at)} 계산): 도구 없이 카드의 답 대기 줄로 답함`;
  } catch {
    return '';
  }
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
