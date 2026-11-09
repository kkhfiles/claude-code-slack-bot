/**
 * 브리핑 「⚠️ 시스템 이슈」를 줄인다(2026-11-09 실장 결정 V4) — 11/09 아침 이 칸에 Claude 한도 오류 원문 두 개와
 * 폴백 기록 다섯 줄이 그대로 실렸다. 사람이 알아야 하는 것은 「Claude 가 몇 번 막혔고 다른 엔진이 몇 건 대신 했나」다.
 *
 * - 한도 오류 원문(「You've hit your 5-hour limit · resets …」) — 어느 출처에서 왔든 걷어 「Claude 한도 N번」 한 줄로
 * - 폴백 줄(`폴백` 출처) — 「다른 엔진이 대신 처리 N건(GPT a · agy b) · 못 넘김 c」 한 줄로. 사다리 기록은 「라벨 N건(…)」,
 *   세션 폴백은 한 줄이 한 건이다
 * - 그 밖의 출처는 그대로 — 무엇이 고장인지 사람이 봐야 하는 줄이다
 */

/** 줄 묶음 — 출처와 그 출처의 글들(겹친 글은 부르는 쪽이 걷었다). */
export interface IssueGroup { source: string; messages: string[]; }

const LIMIT_RE = /hit your [\w -]*limit/i;

/** 폴백 한 줄이 몇 건인지와 누가 받았는지. */
function fallbackCount(line: string): { n: number; gpt: number; agy: number; other: number; failed: number } {
  const z = { n: 0, gpt: 0, agy: 0, other: 0, failed: 0 };
  // 사다리 기록 — 「KG 추출 50건(codex gpt-6.1-terra 50 · 전부 실패 2)」
  const ladder = /^(.*?) (\d+)건\((.*)\)$/.exec(line);
  if (ladder) {
    z.n = Number(ladder[2]);
    for (const part of ladder[3].split(' · ')) {
      const m = /(\d+)$/.exec(part.trim());
      const k = m ? Number(m[1]) : 0;
      if (/^전부 실패/.test(part.trim())) z.failed += k;
      else if (/^codex\b/.test(part.trim())) z.gpt += k;
      else if (/^agy\b/.test(part.trim())) z.agy += k;
      else z.other += k;
    }
    return z;
  }
  // 세션 폴백 — 「분석 — Claude claude-blocked → codex gpt-6.1-terra … 가 받음」 · 「… 폴백 안 함」
  z.n = 1;
  if (/가 받음/.test(line)) {
    if (/→ codex\b/.test(line)) z.gpt = 1;
    else if (/→ agy\b/.test(line)) z.agy = 1;
    else z.other = 1;
  } else {
    z.failed = 1;
  }
  return z;
}

/** 줄인 묶음 — 같은 차례의 출처 순서는 그대로, 폴백과 한도는 한 줄씩. */
export function summarizeIssues(groups: IssueGroup[]): IssueGroup[] {
  let limits = 0;
  const out: IssueGroup[] = [];
  let fb: { n: number; gpt: number; agy: number; other: number; failed: number } | null = null;
  for (const g of groups) {
    const kept = g.messages.filter((m) => {
      if (!LIMIT_RE.test(m)) return true;
      limits += (m.match(new RegExp(LIMIT_RE.source, 'gi')) || []).length;
      return false;
    });
    if (g.source === '폴백') {
      fb = fb ?? { n: 0, gpt: 0, agy: 0, other: 0, failed: 0 };
      for (const line of kept) {
        const c = fallbackCount(line);
        fb.n += c.n; fb.gpt += c.gpt; fb.agy += c.agy; fb.other += c.other; fb.failed += c.failed;
      }
      continue;
    }
    if (kept.length) out.push({ source: g.source, messages: kept });
  }
  if (limits) out.unshift({ source: 'Claude 한도', messages: [`${limits}번 걸림`] });
  if (fb && fb.n) {
    const who = [fb.gpt ? `GPT ${fb.gpt}` : '', fb.agy ? `agy ${fb.agy}` : '', fb.other ? `그 밖 ${fb.other}` : '']
      .filter(Boolean).join(' · ');
    const served = fb.gpt + fb.agy + fb.other;
    const parts = [served ? `다른 엔진이 대신 처리 ${served}건${who ? `(${who})` : ''}` : '', fb.failed ? `못 넘김 ${fb.failed}건` : '']
      .filter(Boolean);
    out.splice(limits ? 1 : 0, 0, { source: '폴백', messages: [parts.join(' · ')] });
  }
  return out;
}
