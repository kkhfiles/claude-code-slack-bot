// Phase 0.6 — SDK 단순 호출 1회. 메시지 stream dump.
// Usage:  npx tsx migrations/2026-06-sdk-restore/sandbox/learn.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const startTime = Date.now();
  const messages: any[] = [];

  const q = query({
    prompt: 'Reply with just the number 42. No other text.',
    options: {
      model: 'claude-haiku-4-5-20251001',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      persistSession: false,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: false,
    },
  });

  for await (const msg of q) {
    messages.push(msg);
    const t = Date.now() - startTime;
    const summary = `${msg.type}${(msg as any).subtype ? `/${(msg as any).subtype}` : ''}`;
    console.error(`[${t.toString().padStart(5)}ms] ${summary}`);
  }

  const duration = Date.now() - startTime;
  const outPath = path.join(__dirname, 'learn-output.jsonl');
  fs.writeFileSync(outPath, messages.map(m => JSON.stringify(m)).join('\n') + '\n');

  console.error(`\n--- summary ---`);
  console.error(`duration: ${duration}ms`);
  console.error(`message_count: ${messages.length}`);
  console.error(`dump: ${outPath}`);

  const result = messages.find(m => m.type === 'result') as any;
  if (result) {
    console.error(`\n--- result ---`);
    console.error(`cost_usd: ${result.total_cost_usd ?? result.cost_usd ?? 'n/a'}`);
    console.error(`duration_ms: ${result.duration_ms ?? 'n/a'}`);
    console.error(`usage: ${JSON.stringify(result.usage ?? result.modelUsage ?? {})}`);
  }

  const assistantTexts = messages
    .filter(m => m.type === 'assistant')
    .map(m => (m as any).message?.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''))
    .filter(Boolean);
  if (assistantTexts.length > 0) {
    console.error(`\n--- assistant text ---`);
    console.error(assistantTexts.join('\n'));
  }
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
