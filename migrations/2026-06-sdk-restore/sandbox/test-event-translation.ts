// Phase 1.11 — interpretSdkMessage unit test (mock SDK messages, no API call)
//   plus Phase 1.13 rate-limit text + budget-exceeded subtype propagation.
// Usage:  npx tsx migrations/2026-06-sdk-restore/sandbox/test-event-translation.ts
import { interpretSdkMessage } from '../../../src/sdk-handler';
import { isRateLimitText } from '../../../src/rate-limit-utils';

let pass = 0;
let fail = 0;
const log: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    log.push(`  ✓ ${label}`);
  } else {
    fail++;
    log.push(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1.11 — Event-shape preservation across interpretSdkMessage
// ---------------------------------------------------------------------------

log.push('--- 1.11 — message translation ---');

const sysInit = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'claude-haiku-4-5',
  tools: ['Read', 'Glob'],
  permissionMode: 'default',
  uuid: 'u-init',
} as any;
const r1 = interpretSdkMessage(sysInit);
check('system/init → CliInitEvent', r1?.type === 'system' && (r1 as any).session_id === 'sess-1');

const assistant = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  session_id: 'sess-1',
  uuid: 'u-1',
} as any;
const r2 = interpretSdkMessage(assistant);
check('assistant → CliAssistantEvent', r2?.type === 'assistant' && (r2 as any).message?.content?.[0]?.text === 'hello');

const user = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  session_id: 'sess-1',
  uuid: 'u-2',
} as any;
const r3 = interpretSdkMessage(user);
check('user → CliUserEvent', r3?.type === 'user');

const rateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rate_limited',
    resetsAt: 1700000000,
    rateLimitType: '5h',
    overageStatus: 'none',
  },
  session_id: 'sess-1',
} as any;
const r4 = interpretSdkMessage(rateLimit);
check(
  'rate_limit_event → CliRateLimitEvent (preserved fields)',
  r4?.type === 'rate_limit_event'
    && (r4 as any).rate_limit_info?.status === 'rate_limited'
    && (r4 as any).rate_limit_info?.rateLimitType === '5h',
);

const resultOk = {
  type: 'result',
  subtype: 'success',
  session_id: 'sess-1',
  total_cost_usd: 0.0206,
  duration_ms: 2637,
  permission_denials: [],
  is_error: false,
  usage: {
    input_tokens: 10,
    output_tokens: 47,
    cache_creation_input_tokens: 13720,
    cache_read_input_tokens: 27088,
  },
} as any;
const r5 = interpretSdkMessage(resultOk);
check('result/success preserves cost + usage', r5?.type === 'result' && (r5 as any).total_cost_usd === 0.0206 && (r5 as any).usage?.cache_read_input_tokens === 27088);

// 1.13 — subtype propagation
const resultBudget = {
  type: 'result',
  subtype: 'error_max_budget_usd',
  session_id: 'sess-2',
  total_cost_usd: 0.5,
  duration_ms: 100,
  permission_denials: [],
  is_error: true,
  result: 'Budget exceeded',
} as any;
const r6 = interpretSdkMessage(resultBudget);
check(
  'result/error_max_budget_usd subtype preserved (drives retry path in runSingleAnalysis)',
  r6?.type === 'result' && (r6 as any).subtype === 'error_max_budget_usd' && (r6 as any).is_error === true,
);

// Partial / stream events MUST be dropped (interpretSdkEvents §1.5)
const partial = { type: 'stream_event', event: { type: 'content_block_delta' }, session_id: 's', uuid: 'u' } as any;
check('stream_event dropped', interpretSdkMessage(partial) === null);

const partialAssistant = { type: 'partial_assistant_message', text: 'partial' } as any;
check('partial_assistant_message dropped', interpretSdkMessage(partialAssistant) === null);

const unknown = { type: 'something_new_in_0.4', data: {} } as any;
check('unknown future type dropped (no crash)', interpretSdkMessage(unknown) === null);

const noType = {} as any;
check('missing type → null', interpretSdkMessage(noType) === null);

// ---------------------------------------------------------------------------
// 1.13 — Rate-limit text detection (drives runSingleAnalysis retry branch)
// ---------------------------------------------------------------------------

log.push('');
log.push('--- 1.13 — rate-limit text detection ---');

const rateTexts: Array<[string, boolean]> = [
  ['You are rate limited. Try again in 5 minutes.', true],
  ['Claude usage limit reached. Resets at 1pm.', true],
  ['Spending cap reached, resets 2am', true],
  ['Spending cap reached resets 2am', true],
  ['Hello world, normal response', false],
  ['', false],
];
for (const [txt, expected] of rateTexts) {
  check(
    `isRateLimitText(${JSON.stringify(txt).slice(0, 50)}) = ${expected}`,
    isRateLimitText(txt) === expected,
  );
}

// ---------------------------------------------------------------------------

log.push('');
log.push(`Result: ${pass} pass / ${fail} fail (${pass + fail} total)`);
console.error(log.join('\n'));
process.exit(fail === 0 ? 0 : 1);
