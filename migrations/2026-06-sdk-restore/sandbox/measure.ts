// Phase 0.11 — Same client/no-process-restart, 100x query calls.
// Measures: RSS / heapUsed / handle count / latency / cache hit pattern.
// Env-isolation check is separate (env_isolation.ts).
// Usage:  npx tsx migrations/2026-06-sdk-restore/sandbox/measure.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import * as path from 'path';

interface Sample {
  i: number;
  ts: number;
  durationMs: number;
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  handleCount?: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  error?: string;
}

const TOTAL = 100;
const PROMPT = 'Reply with only the word "ok".';

async function callOnce(i: number): Promise<Sample> {
  const t0 = Date.now();
  let result: any = null;
  let error: string | undefined;

  try {
    const q = query({
      prompt: PROMPT,
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
      if (msg.type === 'result') result = msg;
    }
  } catch (e: any) {
    error = String(e?.message || e);
  }

  const post = process.memoryUsage();
  const usage = result?.usage || result?.modelUsage || {};
  let handleCount: number | undefined;
  try {
    handleCount = (process as any)._getActiveHandles?.().length;
  } catch {}

  return {
    i,
    ts: t0,
    durationMs: Date.now() - t0,
    rssMb: post.rss / 1048576,
    heapUsedMb: post.heapUsed / 1048576,
    externalMb: post.external / 1048576,
    arrayBuffersMb: post.arrayBuffers / 1048576,
    handleCount,
    cost: result?.total_cost_usd ?? result?.cost_usd ?? 0,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    error,
  };
}

function slope(arr: number[]): number {
  if (arr.length < 2) return 0;
  const n = arr.length;
  const xMean = (n - 1) / 2;
  const yMean = arr.reduce((a, b) => a + b, 0) / n;
  let num = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (arr[i] - yMean);
    denom += (i - xMean) ** 2;
  }
  return num / denom;
}

function pct(arr: number[], p: number): number {
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

async function main() {
  const samples: Sample[] = [];
  const startWall = Date.now();
  console.error(`Phase 0.11 — ${TOTAL}x SDK query.`);
  console.error(`start: ${new Date().toISOString()}`);

  for (let i = 1; i <= TOTAL; i++) {
    const s = await callOnce(i);
    samples.push(s);
    process.stderr.write(s.error ? '!' : '.');
    if (i % 10 === 0) {
      process.stderr.write(` ${i} rss=${s.rssMb.toFixed(1)}MB heap=${s.heapUsedMb.toFixed(1)}MB handles=${s.handleCount ?? '?'} dur=${s.durationMs}ms\n`);
    }
  }

  const totalWall = Date.now() - startWall;
  const outDir = __dirname;
  const jsonlPath = path.join(outDir, 'measure-samples.jsonl');
  fs.writeFileSync(jsonlPath, samples.map(s => JSON.stringify(s)).join('\n') + '\n');

  const successes = samples.filter(s => !s.error);
  const failures = samples.filter(s => s.error);
  const rssArr = successes.map(s => s.rssMb);
  const heapArr = successes.map(s => s.heapUsedMb);
  const handleArr = successes.map(s => s.handleCount).filter((v): v is number => typeof v === 'number');
  const durArr = successes.map(s => s.durationMs);
  const cacheReadArr = successes.map(s => s.cacheReadTokens);
  const cacheCreateArr = successes.map(s => s.cacheCreateTokens);
  const costSum = successes.reduce((acc, s) => acc + s.cost, 0);

  const summary = [
    '# Phase 0.11 — SDK Sandbox 100x measurement',
    '',
    `**Run**: ${new Date().toISOString()}`,
    `**Wall time**: ${(totalWall / 1000).toFixed(1)} s (avg ${(totalWall / TOTAL).toFixed(0)} ms/call)`,
    `**Successes**: ${successes.length} / ${TOTAL}`,
    `**Failures**: ${failures.length}`,
    `**Total cost**: $${costSum.toFixed(4)} (avg $${(costSum / Math.max(1, successes.length)).toFixed(5)}/call)`,
    '',
    '## Memory / handles (post-call snapshot)',
    '',
    '| metric | min | p50 | p95 | max | first | last | slope/call |',
    '|---|---|---|---|---|---|---|---|',
    `| rss MB | ${Math.min(...rssArr).toFixed(1)} | ${pct(rssArr, 0.5).toFixed(1)} | ${pct(rssArr, 0.95).toFixed(1)} | ${Math.max(...rssArr).toFixed(1)} | ${rssArr[0].toFixed(1)} | ${rssArr[rssArr.length-1].toFixed(1)} | ${slope(rssArr).toFixed(3)} |`,
    `| heapUsed MB | ${Math.min(...heapArr).toFixed(1)} | ${pct(heapArr, 0.5).toFixed(1)} | ${pct(heapArr, 0.95).toFixed(1)} | ${Math.max(...heapArr).toFixed(1)} | ${heapArr[0].toFixed(1)} | ${heapArr[heapArr.length-1].toFixed(1)} | ${slope(heapArr).toFixed(3)} |`,
    handleArr.length ? `| handles | ${Math.min(...handleArr)} | ${pct(handleArr, 0.5)} | ${pct(handleArr, 0.95)} | ${Math.max(...handleArr)} | ${handleArr[0]} | ${handleArr[handleArr.length-1]} | ${slope(handleArr).toFixed(3)} |` : '| handles | n/a |',
    `| duration ms | ${Math.min(...durArr)} | ${pct(durArr, 0.5)} | ${pct(durArr, 0.95)} | ${Math.max(...durArr)} | ${durArr[0]} | ${durArr[durArr.length-1]} | ${slope(durArr).toFixed(3)} |`,
    '',
    '## Cache pattern (1H + 5m prompt cache)',
    '',
    '| metric | min | p50 | max | first | last |',
    '|---|---|---|---|---|---|',
    `| cache_read tokens | ${Math.min(...cacheReadArr)} | ${pct(cacheReadArr, 0.5)} | ${Math.max(...cacheReadArr)} | ${cacheReadArr[0]} | ${cacheReadArr[cacheReadArr.length-1]} |`,
    `| cache_create tokens | ${Math.min(...cacheCreateArr)} | ${pct(cacheCreateArr, 0.5)} | ${Math.max(...cacheCreateArr)} | ${cacheCreateArr[0]} | ${cacheCreateArr[cacheCreateArr.length-1]} |`,
    '',
    '## Go criteria (Phase 0.11)',
    '',
    `- Monotonic rss growth: ${slope(rssArr) < 0.5 ? '✅' : '⚠️'} (slope ${slope(rssArr).toFixed(3)} MB/call, threshold <0.5)`,
    `- Monotonic heap growth: ${slope(heapArr) < 0.3 ? '✅' : '⚠️'} (slope ${slope(heapArr).toFixed(3)} MB/call, threshold <0.3)`,
    `- Handle growth: ${handleArr.length && slope(handleArr) < 0.1 ? '✅' : (handleArr.length ? '⚠️' : 'n/a')} (slope ${handleArr.length ? slope(handleArr).toFixed(3) : 'n/a'} handles/call)`,
    `- Failure rate: ${failures.length === 0 ? '✅' : '⚠️'} (${failures.length} / ${TOTAL})`,
    '',
    failures.length ? '## Failures\n\n' + failures.map(s => `- call ${s.i}: ${s.error}`).join('\n') + '\n' : '',
    `Raw samples: \`${path.basename(jsonlPath)}\``,
  ].filter(Boolean).join('\n');

  const mdPath = path.join(outDir, 'measure-summary.md');
  fs.writeFileSync(mdPath, summary);
  console.error(`\n${summary}`);
  console.error(`\nSummary: ${mdPath}`);
  console.error(`Samples: ${jsonlPath}`);
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
