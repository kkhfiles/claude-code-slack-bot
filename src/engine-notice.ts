/**
 * 엔진 안내 — DM 을 어느 엔진이 맡는지가 바뀌면 **한 줄로 한 번** 알린다. 안내는 여기 한 곳에서만 짓는다.
 *
 * DM 을 맡는 차례는 Claude → GPT(codex) → agy 의 Gemini → agy 의 Claude(Sonnet) → 없음(모아 두고 회복 때
 * 처리)이다. 앞이 막히면 다음으로 내려가고, 풀리면 올라온다. 받는 사람이 알아야 하는 것은 「지금
 * 누가 답하나 · 무엇이 달라지나 · 다시 보내야 하나」 셋이라 그것만 쓴다.
 *
 * **모델 이름은 표에서 읽는다** — llm-playbook 의 `models.json`(별칭 → 실제 모델). 판 번호를 여기
 * 적으면 새 모델이 나올 때 안내만 낡는다. 표를 못 읽으면 판 없이 「GPT」·「Gemini」로만 쓴다.
 *
 * **기본은 꺼짐**(`ENGINE_NOTICE=on` 일 때만 보냄) — 꺼져 있으면 보낼 줄을 로그에만 남긴다. 봇은 실제로
 * 붙은 칸만 사다리로 넘긴다(`DM_FALLBACK=on` 이면 Claude · GPT, `DM_FALLBACK_AGY=on` 이면 agy 두 칸까지,
 * 꺼져 있으면 Claude 하나) —
 * 안 붙은 엔진을 「이어 갑니다」로 알리면 사실이 아니다.
 * 마지막으로 알린 차례는 엔진 상태에 적어 재시작해도 같은 안내를 되풀이하지 않는다.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { engineState, ENGINES, type Engine, type EngineState, type EngineStateData } from './engine-state';

export type Rung = Engine | 'none';
const RUNGS: readonly Rung[] = [...ENGINES, 'none'];

/** 안내 줄에 쓰는 짧은 이름 — 판 번호 없이. */
const SHORT: Record<Engine, string> = {
  claude: 'Claude', codex: 'GPT', 'agy-claude': 'agy Claude', 'agy-gemini': 'Gemini',
};
const KIND_PHRASE: Record<string, string> = {
  usage: '사용량 소진', overload: '서버 과부하', auth: '인증 오류', unknown: '응답 오류',
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export interface ModelLabels {
  /** codex 상위 등급 모델 id. 표를 못 읽으면 빈 글자. */
  codex: string;
  /** agy 안의 Claude 표시 이름. */
  agyClaude: string;
  /** agy 의 Gemini 상위 등급 표시 이름. */
  gemini: string;
}

/** 모델 표 자리 — `LLM_PLAYBOOK_MODELS` 로 바꾼다. 기본은 이 저장소 옆의 llm-playbook. */
export function modelsFile(): string {
  return process.env.LLM_PLAYBOOK_MODELS
    || path.resolve(__dirname, '..', '..', 'llm-playbook', 'llm_playbook', 'models.json');
}

/**
 * 표에서 이름 셋을 읽는다 — codex 는 `tiers.top.codex` 별칭(`<별칭>-<깊이>`)의 `codex.models[별칭].id`,
 * Gemini 와 agy Claude 는 `service_fallback.agy` 의 앞 · 뒤 별칭의 `agy.models` 값(6단계 · 표에 없으면
 * `flash-high` · `sonnet-thinking` · agy 의 Opus 는 안 씀).
 * **부를 때마다 읽는다** — 표를 고치면 다음 안내부터 바로 따라온다.
 */
export function loadModelLabels(file: string = modelsFile(), primary?: string, effort?: string): ModelLabels {
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const top = String(t?.tiers?.top?.codex ?? '');
    const codexModels: Record<string, { id?: string }> = t?.codex?.models ?? {};
    let alias = Object.keys(codexModels)
      .filter((k) => top === k || top.startsWith(`${k}-`))
      .sort((a, b) => b.length - a.length)[0];
    // 서비스 폴백 대응표가 있으면 1차(Claude) 모델에 맞춘 codex 칸 — DM 폴백이 실제로 부르는 모델과 같게
    // (`model-ladder.ts` `serviceCodex` 와 같은 규칙 · 별칭 · id · 집안 이름으로 맞춘다).
    const svc: Record<string, unknown> = t?.service_fallback?.codex ?? {};
    const aliases: Record<string, string> = t?.claude?.aliases ?? {};
    const p = (primary ?? '').toLowerCase().replace(/\[.*\]$/, '');
    const fam = p ? Object.keys(svc).find((k) => {
      const id = String(aliases[k] ?? '').toLowerCase();
      return p === k || (id !== '' && (p === id || p.startsWith(id))) || p.includes(k);
    }) : undefined;
    const cell = fam ? svc[fam] : undefined;
    if (typeof cell === 'string' && codexModels[cell]) alias = cell;
    // 대응표 모양(깊이마다 「별칭-깊이」) — 1차 깊이의 칸 · 모르면 high 줄(`model-ladder.ts` `serviceCodex` 와 같은 규칙)
    if (cell && typeof cell === 'object') {
      const row = cell as Record<string, unknown>;
      const spec = String(row[effort && row[effort] ? effort : 'high'] ?? '');
      const hit = Object.keys(codexModels).filter((k) => spec === k || spec.startsWith(`${k}-`))
        .sort((a, b) => b.length - a.length)[0];
      if (hit) alias = hit;
    }
    const agy: Record<string, string> = t?.agy?.models ?? {};
    const sf: unknown[] = Array.isArray(t?.service_fallback?.agy) ? t.service_fallback.agy : [];
    const at = (i: number, dflt: string) => (typeof sf[i] === 'string' && sf[i] ? String(sf[i]) : dflt);
    return {
      codex: (alias && codexModels[alias]?.id) || '',
      agyClaude: agy[at(1, 'sonnet-thinking')] || '',
      gemini: agy[at(0, 'flash-high')] || '',
    };
  } catch {
    return { codex: '', agyClaude: '', gemini: '' };
  }
}

/** `10/19(월) 10:00` — 한국 시각. */
export function formatKst(epochSec: number): string {
  const d = new Date((epochSec + 9 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}(${WEEKDAYS[d.getUTCDay()]}) `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function activeBlock(st: EngineStateData, e: Engine, nowSec: number) {
  const b = st.engines[e].blocked;
  return b && b.until !== null && b.until > nowSec ? b : null;
}

/**
 * 지금 DM 을 맡을 차례 — 막히지 않은 첫 엔진. 다 막혔으면 `none`.
 * `ladder` 는 실제로 붙은 칸만 넘긴다(5단계는 Claude · GPT) — 안 붙은 agy 를 「이어 갑니다」로 알리지 않게.
 */
export function dmRung(st: EngineStateData, nowSec: number, ladder: readonly Engine[] = ENGINES): Rung {
  for (const e of ladder) if (!activeBlock(st, e, nowSec)) return e;
  return 'none';
}

/** 차례의 위아래 — 사다리가 바뀌어도(폴백을 켜고 끔) 같은 순서로 견준다. */
function rank(r: Rung): number {
  return r === 'none' ? RUNGS.length : RUNGS.indexOf(r);
}

/** 「누구로 이어 가나」 부분. */
function target(to: Engine, labels: ModelLabels): string {
  switch (to) {
    case 'claude': return 'Claude 로 이어 갑니다';
    case 'codex': return `${labels.codex ? `GPT(${labels.codex})` : 'GPT'}로 이어 갑니다`;
    case 'agy-claude': return `agy 의 ${labels.agyClaude || 'Claude'}로 이어 갑니다 · 업무 조회·등록·수정까지`;
    case 'agy-gemini': return `${labels.gemini || 'Gemini'}로 이어 갑니다 · 답이 느리고 업무 조회·등록·수정까지`;
  }
}

/** 막힌 엔진 하나를 말하는 부분 — 「Claude 사용량 소진(풀림 10/19(월) 10:00)」. */
function blockedOne(st: EngineStateData, e: Engine, nowSec: number): string {
  const b = activeBlock(st, e, nowSec);
  if (!b) return `${SHORT[e]} 소진`;
  const when = b.until === null ? ''
    : b.kind === 'usage' && b.untilKnown ? `(풀림 ${formatKst(b.until)})` : `(다시 확인 ${formatKst(b.until)})`;
  return `${SHORT[e]} ${KIND_PHRASE[b.kind] ?? '소진'}${when}`;
}

/**
 * 차례가 `from` 에서 `to` 로 바뀔 때 보낼 한 줄. 바뀌지 않았으면 `null`.
 *
 * - 내려감 — 「🔁 <막힌 것> — <다음 엔진>로 이어 갑니다」 · 다 막히면 「⏸ …」(가장 빠른 회복 시각)
 * - 올라감 — 「✅ <돌아온 엔진> 회복 — …」 · Claude 로 돌아오면 「돌아왔습니다」
 */
export function composeTransition(
  from: Rung, to: Rung, st: EngineStateData, labels: ModelLabels, nowSec: number,
  ladder: readonly Engine[] = ENGINES,
): string | null {
  if (from === to) return null;
  if (to === 'none') {
    const next = ladder.map((e) => activeBlock(st, e, nowSec)?.until ?? null)
      .filter((u): u is number => u !== null)
      .sort((a, b) => a - b)[0];
    const when = next !== undefined ? formatKst(next) : '시각 모름';
    return `⏸ 모든 엔진 소진 — 받은 말은 모아 두고 가장 빠른 회복(${when})에 차례대로 처리합니다`
      + ' · 다시 보내지 않으셔도 됩니다';
  }
  if (rank(to) < rank(from) && to === 'claude') return '✅ Claude 회복 — 돌아왔습니다';
  // Claude 가 아닌 칸으로 올라가면(모두 막힘 → GPT 가 풀림 · 폴백을 켬) 「회복」이라 하지 않고 지금 모양을
  // 그대로 말한다 — 폴백을 켜는 순간에는 GPT 가 막힌 적이 없는데 「✅ GPT 회복」이 나갔다(5단계 검토).
  const above = ladder.slice(0, Math.max(0, ladder.indexOf(to)));
  let what: string;
  if (above.length === 1) {
    what = blockedOne(st, above[0], nowSec);
  } else {
    const allUsage = above.every((e) => activeBlock(st, e, nowSec)?.kind === 'usage');
    what = `${above.map((e) => SHORT[e]).join('·')} ${above.length === 2 && allUsage ? '사용량 소진' : '소진'}`;
  }
  // agy 칸은 지시문이 Claude 세션과 달라 답이 다를 수 있다 — 모델이 같다고 단정하지 않는다(사용자 지적).
  const tail = to === 'agy-claude' || to === 'agy-gemini' ? ' · 지시문이 달라 답이 다를 수 있습니다' : '';
  return `🔁 ${what} — ${target(to, labels)}${tail}`;
}

export interface EngineNoticeOptions {
  store?: EngineState;
  /** 켜져 있을 때 한 줄을 보낸다(봇: 비서 DM). */
  post?: (text: string) => Promise<unknown>;
  /** 기본 — `ENGINE_NOTICE=on` 일 때만 켜짐. */
  enabled?: () => boolean;
  labels?: () => ModelLabels;
  /** DM 을 맡는 칸 — 기본은 네 엔진 전부. 봇은 실제로 붙은 칸만 넘긴다(`dm-fallback.ts` `dmLadder`). */
  ladder?: () => readonly Engine[];
  log?: { info: (msg: string, data?: any) => void; warn: (msg: string, data?: any) => void };
}

export class EngineNotice {
  private store: EngineState;
  private log: NonNullable<EngineNoticeOptions['log']>;
  private unsubscribe: (() => void) | null = null;

  constructor(private opts: EngineNoticeOptions = {}) {
    this.store = opts.store ?? engineState;
    this.log = opts.log ?? new Logger('EngineNotice');
  }

  get enabled(): boolean {
    return this.opts.enabled ? this.opts.enabled() : process.env.ENGINE_NOTICE === 'on';
  }

  /** 기동 때 한 번 — 막힘이 바뀔 때마다 본다. */
  init(): void {
    if (!this.unsubscribe) this.unsubscribe = this.store.subscribe(() => { void this.check(); });
    void this.check();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * 차례가 바뀌었으면 한 줄을 짓고 알린다(꺼져 있으면 로그만). 지은 줄을 돌려준다.
   * **알리기 전에 차례를 적는다** — 보내다 실패해도 같은 줄이 되풀이되지 않게.
   */
  async check(): Promise<string | null> {
    try {
      const st = this.store.load();
      const now = this.store.nowSec();
      const ladder = this.opts.ladder?.() ?? ENGINES;
      const rung = dmRung(st, now, ladder);
      const last = (st.ladder?.rung ?? 'claude') as Rung;
      if (rung === last) return null;
      // **Claude 로 올라가는 것은 실제로 된 뒤에만 알린다**(2026-10-15 검토) — 막힘 시각이 지난 것만으로는 된 것이
      // 아니다(떠 보기 · 밀린 것이 다시 막힐 수 있다). 막힘 기록은 성공(`recordOk`)이 지우므로, 남아 있으면 차례를
      // 안 적고 기다린다 — 지워질 때 다시 불려(`subscribe`) 그때 한 번 낸다. 그사이 다시 막히면 아무 줄도 안 나간다.
      if (rung === 'claude' && rank(rung) < rank(last) && st.engines.claude.blocked) {
        this.log.info('Claude 막힘 시각이 지났지만 아직 된 차례가 없어 회복 안내를 미룹니다');
        return null;
      }
      const line = composeTransition(last, rung, st, (this.opts.labels ?? loadModelLabels)(), now, ladder);
      this.store.setLadder(rung, `${last}>${rung}`);
      if (!line) return null;
      if (!this.enabled) {
        this.log.info('엔진 안내 — 꺼져 있어 보내지 않음(ENGINE_NOTICE)', { line });
      } else if (this.opts.post) {
        await this.opts.post(line);
      }
      return line;
    } catch (err: any) {
      this.log.warn('엔진 안내를 못 냈습니다', { err: String(err?.message ?? err) });
      return null;
    }
  }
}
