/**
 * NAS 이동 컨펌 큐 — mycelium confirm_nas CLI 브리지 + Slack 블록 빌더.
 *
 * inbox 자동분류(company 분류분)는 NAS 컨펌 게이트(pending_nas_confirm)에서
 * 운영자 결정을 기다린다. 이 모듈은 그 결정을 슬랙 버튼 1클릭으로 만든다:
 * 브리핑 직후(assistant-scheduler) 또는 `-nas` 명령으로 항목별
 * [✅ 이동][❌ 거부][⏸️ 보류] + 분류 변경 드롭다운 메시지를 게시하고,
 * slack-handler의 action 핸들러가 여기 함수로 CLI를 호출한다.
 *
 * 설계: 매니페스트 파일 없이 매 렌더마다 `--list --json` 라이브 호출
 * (버튼 클릭으로 큐가 변해도 항상 최신). 디렉터리 카드는 1 unit 1버튼셋
 * (폴더 통째 — 내부 파일 개별로 묻지 않음, 2026-06-11 사용자 결정).
 */
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import { config } from './config';

export interface NasShareReview {
  flag: boolean;
  reasons: string[];
}

export interface NasQueueItem {
  id: string;
  name: string;
  unit: 'file' | 'dir';
  file_count?: number;
  scope: string;
  category: string;
  confidence: number;
  target_path: string | null;
  waiting_days: number;
  overdue: boolean;
  share_review: NasShareReview;
}

export interface NasQueue {
  files: NasQueueItem[];
  dirs: NasQueueItem[];
  /** 승인됐으나 이동 미완(락 충돌 등) 잔류 카드 — 재시도 대상 */
  stuck?: NasQueueItem[];
}

export interface NasCategory {
  value: string;
  label: string;
}

export interface NasCliResult {
  ok: boolean;
  detail: string;
}

function workflowRoot(): string {
  // ASSISTANT_CONFIG_DIR = <claude-workflow>/assistant → 한 단계 위가 repo 루트
  return path.resolve(config.assistant.configDir, '..');
}

/**
 * 카드 id에는 한글·공백이 포함됨(`26323a13341a41d1_2026년 상…`) — win32
 * shell:true spawn에서 인자가 깨지므로 hex prefix만 CLI에 전달한다
 * (confirm_nas는 LIKE prefix 매칭).
 */
export function idPrefix(id: string): string {
  return id.split('_')[0];
}

function runConfirmNas(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'python',
      ['-X', 'utf8', '-m', 'mycelium.auto_classify.confirm_nas', ...args],
      {
        cwd: workflowRoot(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
        // 콘솔 창이 화면에 깜빡이지 않게 한다. 이 프로세스에는 콘솔이 없어서
        // 윈도우가 자식마다 새 콘솔을 만들어 주고, `shell: true` 는 cmd.exe 를
        // 거치므로 특히 필요하다. 출력은 이미 파이프로 받고 있어 잃는 것이 없다.
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    const killTimer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          // shell:true 래퍼(cmd.exe)만 죽이면 python 자식이 고아로 계속 실행되며
          // acquire_job 락을 쥔다 — 트리 전체 kill
          execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch {}
    }, timeoutMs);
    proc.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function tail(text: string, lines = 4): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/** 락 충돌(데일리 sync 등과 동시 실행) 여부 — acquire_job 가드 메시지 감지. */
function isLockConflict(out: string): boolean {
  return /acquire_job|JobConflict|job .*(?:held|conflict|locked)/i.test(out);
}

export async function listNasQueue(): Promise<NasQueue> {
  const { code, stdout, stderr } = await runConfirmNas(['--list', '--json'], 30_000);
  if (code !== 0) {
    throw new Error(`confirm_nas --list failed (rc=${code}): ${tail(stderr || stdout)}`);
  }
  return JSON.parse(stdout) as NasQueue;
}

let categoriesCache: NasCategory[] | null = null;
let categoriesCacheAt = 0;
const CATEGORIES_CACHE_TTL_MS = 60 * 60 * 1000; // categories.yaml 변경 반영 상한 1시간

export async function listNasCategories(): Promise<NasCategory[]> {
  if (categoriesCache && Date.now() - categoriesCacheAt < CATEGORIES_CACHE_TTL_MS) {
    return categoriesCache;
  }
  const { code, stdout, stderr } = await runConfirmNas(['--categories', '--json'], 30_000);
  if (code !== 0) {
    throw new Error(`confirm_nas --categories failed (rc=${code}): ${tail(stderr || stdout)}`);
  }
  categoriesCache = (JSON.parse(stdout) as { categories: NasCategory[] }).categories;
  categoriesCacheAt = Date.now();
  return categoriesCache;
}

/** shell:true spawn 방어 — id prefix는 hex만 허용 (위·변조 payload 차단). */
function validPrefixes(ids: string[]): string[] | null {
  const prefixes = ids.map(idPrefix);
  return prefixes.every(p => /^[0-9a-f]{8,64}$/i.test(p)) ? prefixes : null;
}

/** 승인: confirmed_for_nas 마킹 → 즉시 NAS 이동(apply-confirmed)까지. */
export async function confirmAndApply(ids: string[]): Promise<NasCliResult> {
  const prefixes = validPrefixes(ids);
  if (!prefixes) return { ok: false, detail: 'invalid id prefix' };
  const mark = await runConfirmNas(['--confirm', '--ids', ...prefixes, '--apply'], 30_000);
  if (mark.code !== 0) {
    const out = mark.stderr || mark.stdout;
    return { ok: false, detail: isLockConflict(out) ? 'lock' : tail(out) };
  }
  // NAS 이동 (UNC copy + dual-write 미러) — 폴더는 수십 파일일 수 있어 넉넉히
  const move = await runConfirmNas(['--apply-confirmed', '--apply', '--limit', '20'], 300_000);
  if (move.code !== 0) {
    const out = move.stderr || move.stdout;
    return { ok: false, detail: isLockConflict(out) ? 'lock' : tail(out) };
  }
  return { ok: true, detail: tail(move.stdout) };
}

export async function rejectItems(ids: string[]): Promise<NasCliResult> {
  const prefixes = validPrefixes(ids);
  if (!prefixes) return { ok: false, detail: 'invalid id prefix' };
  const r = await runConfirmNas(['--reject', '--ids', ...prefixes, '--apply'], 30_000);
  if (r.code !== 0) {
    const out = r.stderr || r.stdout;
    return { ok: false, detail: isLockConflict(out) ? 'lock' : tail(out) };
  }
  return { ok: true, detail: tail(r.stdout) };
}

/** 분류 변경 (드롭다운): category 교체 + target 재계산. 상태는 pending 유지. */
export async function retargetItem(id: string, category: string): Promise<NasCliResult> {
  // shell:true spawn 방어 — category는 yaml 고정값이지만 payload 위·변조 대비 화이트리스트 검증
  if (!/^[A-Za-z0-9_-]+$/.test(category)) {
    return { ok: false, detail: `invalid category value: ${category.slice(0, 50)}` };
  }
  const prefixes = validPrefixes([id]);
  if (!prefixes) return { ok: false, detail: 'invalid id prefix' };
  const r = await runConfirmNas(
    ['--retarget', '--ids', prefixes[0], '--category', category, '--apply'], 30_000);
  if (r.code !== 0) {
    const out = r.stderr || r.stdout;
    return { ok: false, detail: isLockConflict(out) ? 'lock' : tail(out) };
  }
  return { ok: true, detail: tail(r.stdout) };
}

// ──────────────────────────────────────────────────────────
// Slack 블록 빌더
// ──────────────────────────────────────────────────────────

const MAX_ITEMS = 10;

function shortTarget(targetPath: string | null): string {
  if (!targetPath) return '-';
  const parts = targetPath.replace(/\//g, '\\').split('\\').filter(Boolean);
  // 마지막 파일/폴더명 제외, 그 앞 2단계 (category/subpath)
  return parts.slice(-3, -1).join('/') || targetPath;
}

function itemText(item: NasQueueItem): string {
  const icon = item.unit === 'dir' ? '📁' : '📄';
  const fire = item.overdue ? '🔴 ' : '';
  const unitNote = item.unit === 'dir' ? ` _(폴더 ${item.file_count ?? '?'}개 파일 통째)_` : '';
  let text = `${fire}${icon} *${item.name}*${unitNote}\n` +
    `→ \`${shortTarget(item.target_path)}\` — conf ${item.confidence.toFixed(2)}, ${item.waiting_days}일 대기`;
  if (item.share_review?.flag) {
    text += `\n⚠️ *공유검토*: ${item.share_review.reasons.join(', ')} — 부서원 전체 공유에 적합한지 개별 확인`;
  }
  return text;
}

/**
 * 큐 → Slack blocks. 비어 있으면 null.
 * 항목별: section(+분류변경 드롭다운) + [✅이동][❌거부][⏸️보류] 버튼.
 * 하단: [✅ 전체 승인(⚠️제외)] [❌ 전체 거부] — ⚠️ 항목은 개별 클릭 강제.
 */
export async function buildNasQueueBlocks(queue: NasQueue): Promise<any[] | null> {
  const items = [...queue.files, ...queue.dirs];
  const stuck = queue.stuck ?? [];
  if (items.length === 0 && stuck.length === 0) return null;
  // 🔴(7일 초과) 우선, 오래된 순
  items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.waiting_days - a.waiting_days);
  const shown = items.slice(0, MAX_ITEMS);

  let categories: NasCategory[] = [];
  try {
    categories = await listNasCategories();
  } catch {
    // 드롭다운 없이도 버튼 결정은 가능 — 카테고리 로드 실패는 무시
  }
  const overdueCount = items.filter(i => i.overdue).length;

  const blocks: any[] = [];
  if (items.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📦 *NAS 이동 컨펌 대기 — ${items.length}건*` +
          (overdueCount ? ` (🔴 7일 초과 ${overdueCount}건)` : ''),
      },
    });
  }

  for (const item of shown) {
    const section: any = {
      type: 'section',
      block_id: `nas_${idPrefix(item.id)}`,
      text: { type: 'mrkdwn', text: itemText(item) },
    };
    if (categories.length > 0) {
      section.accessory = {
        type: 'static_select',
        action_id: 'nas_retarget_item',
        placeholder: { type: 'plain_text', text: '📂 분류 변경' },
        options: categories.map(c => ({
          text: { type: 'plain_text', text: c.label.slice(0, 75) },
          value: c.value,
        })),
      };
    }
    blocks.push(section);
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ NAS 이동' },
          style: 'primary',
          action_id: 'nas_confirm_item',
          value: idPrefix(item.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ 거부' },
          style: 'danger',
          action_id: 'nas_reject_item',
          value: idPrefix(item.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏸️ 보류' },
          action_id: 'nas_hold_item',
          value: idPrefix(item.id),
        },
      ],
    });
  }

  if (items.length > shown.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `…외 ${items.length - shown.length}건 — \`-nas\`로 다시 조회` }],
    });
  }

  // 승인됐으나 이동 미완 잔류(락 충돌·NAS 불통 등) — 재시도 버튼.
  // nas_confirm_item 핸들러 재사용: confirm 단계는 SKIP(이미 confirmed)되고
  // apply-confirmed가 잔류분을 일괄 이동한다.
  if (stuck.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `⏳ *이동 대기 잔류 ${stuck.length}건* — 승인됐으나 이동 미완 (락 충돌 등)\n` +
          stuck.slice(0, 5).map(s => `• ${s.name} → \`${shortTarget(s.target_path)}\``).join('\n'),
      },
    });
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: `▶️ 이동 재시도 (${stuck.length}건)` },
        action_id: 'nas_confirm_item',
        value: idPrefix(stuck[0].id),
      }],
    });
  }

  // 묶음 버튼 — ⚠️ 공유검토 항목은 전체 승인에서 제외 (개별 확인 강제)
  const safeIds = shown.filter(i => !i.share_review?.flag).map(i => idPrefix(i.id));
  const allIds = shown.map(i => idPrefix(i.id));
  const bulk: any[] = [];
  if (safeIds.length > 1) {
    bulk.push({
      type: 'button',
      text: { type: 'plain_text', text: `✅ 전체 승인 ${safeIds.length}건 (⚠️ 제외)` },
      action_id: 'nas_confirm_all_safe',
      value: JSON.stringify({ ids: safeIds }),
    });
  }
  if (allIds.length > 1) {
    bulk.push({
      type: 'button',
      text: { type: 'plain_text', text: `❌ 전체 거부 ${allIds.length}건` },
      action_id: 'nas_reject_all',
      value: JSON.stringify({ ids: allIds }),
    });
  }
  if (bulk.length > 0) {
    blocks.push({ type: 'actions', elements: bulk });
  }
  return blocks;
}
