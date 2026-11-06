/**
 * 이어 가는 세션에 바뀐 정체성을 알린다(2026-11-06 · 실장님 「세나는 항상 이전 내용을 기억하고 … 대안 중에 이 원칙에 맞지 않는 게 있으면 안 됨」).
 *
 * **왜 있나** — Claude Code 는 대화의 첫 요청 때 시스템 프롬프트(append 포함)를 기록하고, 이어 가는(resume) 요청에서는
 * 다른 글을 넘겨도 **압축 전까지** 그 기록을 그대로 쓴다(`--system-prompt-snapshot` 기본 on). 11/06 실측: 같은 세션에
 * 「marker=APPLE」을 넣고 이어 가며 「BANANA」로 바꿔 물으니 APPLE, 압축한 뒤에 물으니 BANANA. 그래서 세나 DM 세션처럼
 * 오래 이어 가는 세션에는 정체성 파일을 고쳐도 그 뒤 규칙이 안 닿는다. 기록을 끄면 바뀔 때마다 대화 전체 캐시를 새로 써
 * 차례가 수 초씩 늦어지고(「답이 늦어지면 안 됨」), 새 세션을 열면 앞 대화를 잃는다(「이전 내용을 기억」) — 둘 다 안 된다.
 *
 * **하는 일** — 세션마다 「처음 기록된 판」(snapshot)과 「이미 알린 판」(announced)을 적어 두고, 지금 판이 둘 다와 다르면
 * 그 차례 말 끝에 바뀐 줄(더한 줄, 지운 줄)을 한 번 붙인다. 압축 표시(`compact_boundary`)가 오면 기록이 지금 판으로
 * 다시 쓰였으므로 snapshot 을 지금 판으로 맞춘다. 처음 보는 세션(이 장치 전에 열린 세션)은 무엇이 기록됐는지 모르므로
 * 지금 판 전문을 한 번 붙인다. 판의 글은 지문별로 파일에 남겨 다음 비교에 쓴다.
 *
 * 저장 위치는 `SENA_IDENTITY_DIR`(검사가 바꿔 끼움), 기본 `~/.claude/state/sena/identity`. 못 읽거나 못 쓰면 조용히 빈 글 —
 * 알림이 빠질 뿐 대화는 그대로 돈다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function dir(): string {
  return process.env.SENA_IDENTITY_DIR || path.join(os.homedir(), '.claude', 'state', 'sena', 'identity');
}

/** 바뀐 줄이 이보다 길면 줄 비교 대신 지금 판 전문을 붙인다 — 줄 조각만으로는 어디가 바뀌었는지 안 읽힌다. */
const DIFF_MAX = 6000;

export function versionOf(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 12);
}

interface Rec { snapshot: string; announced: string; at: string }

function stateFile(): string { return path.join(dir(), 'sessions.json'); }

function readState(): Record<string, Rec> {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) || {}; } catch { return {}; }
}

function writeState(st: Record<string, Rec>): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const tmp = `${stateFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf-8');
    fs.renameSync(tmp, stateFile());
  } catch { /* 알림이 빠질 뿐 — 대화는 그대로 */ }
}

function keepText(ver: string, text: string): void {
  try {
    fs.mkdirSync(path.join(dir(), 'texts'), { recursive: true });
    const f = path.join(dir(), 'texts', `${ver}.txt`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, text, 'utf-8');
  } catch { /* 다음 비교가 전문으로 떨어질 뿐 */ }
}

function textOf(ver: string): string | null {
  try { return fs.readFileSync(path.join(dir(), 'texts', `${ver}.txt`), 'utf-8'); } catch { return null; }
}

function set(sessionId: string, patch: Partial<Rec>): void {
  const st = readState();
  const now = new Date().toISOString();
  st[sessionId] = { ...(st[sessionId] ?? { snapshot: '', announced: '', at: now }), ...patch, at: now };
  writeState(st);
}

/**
 * 이 세션의 기록이 지금 판으로 쓰였다 — 새 세션이 처음 돈 때(init)와 압축 뒤(`compact_boundary`)에 부른다.
 * 이어 가는 차례의 init 에는 부르지 않는다(기록은 그대로다).
 */
export function recordSnapshot(sessionId: string | undefined, stable: string): void {
  if (!sessionId) return;
  const ver = versionOf(stable);
  keepText(ver, stable);
  set(sessionId, { snapshot: ver, announced: ver });
}

/** 줄 단위로 더한 줄과 지운 줄 — 빈 줄은 빼고, 순서는 각 판의 순서대로. */
export function lineDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldText.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()));
  const newSet = new Set(newText.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()));
  return {
    added: [...newSet].filter((l) => !oldSet.has(l)),
    removed: [...oldSet].filter((l) => !newSet.has(l)),
  };
}

/**
 * 이어 가는 차례에 붙일 「정체성이 바뀜」 알림 — 바뀐 것이 없거나 이미 알렸으면 빈 글.
 * `resuming` 이 거짓이면(새 세션) 이번 차례의 시스템 프롬프트가 곧 지금 판이라 알릴 것이 없다.
 */
export function identityNotice(sessionId: string | undefined, resuming: boolean, stable: string): string {
  if (!sessionId || !resuming) return '';
  const ver = versionOf(stable);
  keepText(ver, stable);
  const rec = readState()[sessionId];
  if (rec && (rec.snapshot === ver || rec.announced === ver)) return '';
  const head = '[세나 정체성이 바뀜 — 이 대화의 시스템 프롬프트(정체성, 슬랙 규칙)는 처음 기록된 판이다. 아래가 그보다 앞선다]';
  const old = rec ? textOf(rec.announced || rec.snapshot) : null;
  let body: string;
  if (old === null) {
    body = `지금 판 전문:\n${stable}`;
  } else {
    const { added, removed } = lineDiff(old, stable);
    const parts = [
      added.length ? `더하거나 바뀐 줄:\n${added.join('\n')}` : '',
      removed.length ? `지운 줄(이제 따르지 않음):\n${removed.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    body = parts.length > DIFF_MAX || !parts ? `지금 판 전문:\n${stable}` : parts;
  }
  set(sessionId, { ...(rec ? {} : { snapshot: '' }), announced: ver });
  return `${head}\n${body}`;
}
