/**
 * 세나 일지 — 2층 원본(2026-11-06 실장님 「세나는 계속 자기가 한 일과 생각한 것까지 기억하게」, 설계 `docs/sena-agency.md`).
 *
 * 세나의 기억이 대화 세션 하나에만 살면 압축이나 새 세션에서 줄거나 사라진다. 그래서 봇이 세나 DM 세션의 차례마다
 * 두 줄을 남긴다 — **시작**(받은 말 원문, 어디서 왔나)은 세션을 띄우기 전에, **끝**(돈 도구와 그 입력 한 줄, 쓰기가
 * 있었나, 답 첫 줄, 걸린 업무 번호)은 차례가 끝난 뒤에. 읽는 쪽은 업무 비서 저장소의 `bin/sena_memory.py`(recall).
 *
 * **출처 표지는 코드가 붙인다**(Argon, Astra 교차 검토 11/06) — 시작 줄은 「실장 말씀」(사람이 쓴 DM 과 서랍) 또는
 * 「봇이 넘김」(판 버튼, 메일 후보), 끝 줄은 「봇 기록」. 세나의 판단은 세나가 `sena_memory.py note` 로 남기고 늘 「세나의 판단」이다.
 * 모델이 「확인한 사실」을 붙이게 하지 않는다 — 지어낸 것에도 붙는다.
 *
 * 날짜별 파일(`YYYY-MM-DD.jsonl`, 한국 시각) — 앞 요약을 다시 요약하지 않게 원본은 날짜마다 새 파일에 쌓인다.
 * 못 쓰면 조용히 넘어간다 — 일지가 빠질 뿐 대화는 그대로 돈다. 위치는 `SENA_EPISODES_DIR`(검사가 바꿔 끼움).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEXT_MAX = 2000;
export const INPUT_MAX = 160;
export const HEAD_MAX = 240;

function dir(): string {
  return process.env.SENA_EPISODES_DIR || path.join(os.homedir(), '.claude', 'state', 'sena', 'episodes');
}

/** 한국 시각의 날짜 — 파일 이름. */
export function dayOf(d: Date = new Date()): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function append(rec: Record<string, unknown>): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(path.join(dir(), `${dayOf()}.jsonl`), JSON.stringify(rec) + '\n', 'utf-8');
  } catch { /* 일지가 빠질 뿐 */ }
}

/** 말이 어디서 왔나 — 앞머리 표시로 가른다(봇이 붙이는 것이라 정해진 모양). */
export function whereOf(text: string, pushed: boolean): 'drawer' | 'board' | 'mail' | 'bot' | 'slack' {
  if (/^\[서랍 차례 [0-9a-f]{32}\]/.test(text)) return 'drawer';
  if (/^\[진행판\]/.test(text)) return 'board';
  if (/^\[메일\]/.test(text)) return 'mail';
  return pushed ? 'bot' : 'slack';
}

/** 글 속 업무 번호 — 판에서 쓰는 꼴(TSK-n). 겹치면 한 번. */
export function tasksIn(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t || '').matchAll(/\bTSK-\d+\b/g)) out.add(m[0]);
  return [...out];
}

export function episodeId(ts: string): string {
  return `ep-${ts.replace(/[^0-9]/g, '').slice(0, 16)}`;
}

/** 차례 시작 — 세션을 띄우기 전에 남긴다(받은 말을 잃지 않게). */
export function startEpisode(o: { ts: string; text: string; pushed: boolean; session?: string }): string {
  const id = episodeId(o.ts);
  const where = whereOf(o.text, o.pushed);
  append({
    id, kind: 'turn-start', at: new Date().toISOString(), where,
    source: where === 'slack' || where === 'drawer' ? '실장 말씀' : '봇이 넘김',
    session: o.session || undefined, text: o.text.slice(0, TEXT_MAX), tasks: tasksIn(o.text),
  });
  return id;
}

export interface EpisodeStep { name: string; input: string; done: boolean; error?: boolean }

/** 차례 끝 — 무엇을 했나(돈 도구), 무엇을 답했나(첫 줄). 내용은 봇이 본 그대로이고 세나가 쓰지 않는다. */
export function endEpisode(id: string, o: {
  steps: EpisodeStep[]; writeRan: boolean; engine?: string; outcome?: string; answer?: string; session?: string;
}): void {
  const steps = o.steps.map((s) => ({ name: s.name, input: (s.input || '').slice(0, INPUT_MAX), done: s.done, ...(s.error ? { error: true } : {}) }));
  const head = (o.answer || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  append({
    id, kind: 'turn-end', at: new Date().toISOString(), source: '봇 기록',
    session: o.session || undefined, engine: o.engine, outcome: o.outcome, wrote: o.writeRan,
    steps, answer_head: head.slice(0, HEAD_MAX), tasks: tasksIn(...steps.map((s) => s.input), o.answer || ''),
  });
}
