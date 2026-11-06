/** Temporary evidence only; exercise helper and the scheduler's real commit consumer. */
import './lib/fresh-dist.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-gate-'));
process.env.REPORT_LOG_STATE = path.join(tmp, 'state');
process.env.REPORT_LOG_REPO = path.join(tmp, 'absent-report-log');
process.env.WORK_ASSISTANT_STATE = path.join(tmp, 'work-state');
process.env.WORK_EVENTS_FILE = path.join(tmp, 'events.jsonl');
const helper = require('../dist/discovery-report-gate.js');
const { AssistantScheduler } = require('../dist/assistant-scheduler.js');
const out = path.join(tmp, 'report.md');
const slot = '2026-11-07';
const settings = { minimumUnits: 6, runRoot: path.join(tmp, 'runs') };

try {
  assert.deepEqual(helper.discoveryRunnerArgs(undefined), []);
  assert.throws(() => helper.discoveryRunnerArgs({ execute: true }), /confirmed/);
  assert.equal(helper.discoveryRunnerArgs({ execute: true, runRoot: settings.runRoot, questions: 'q.json', repetitions: 2, minimumUnits: 6 }).at(-1), '--execute');
  assert.equal((await helper.gateDiscoveryReport(tmp, { slot, out }, undefined)).ok, false);
  fs.writeFileSync(out, '# Synthetic report\n');
  let calls = [];
  let result = await helper.gateDiscoveryReport(tmp, { slot, out }, settings, async (...args) => {
    calls.push(args);
    return { code: 1, stdout: JSON.stringify({ ok: false, errors: ['preview week'] }) };
  });
  assert.equal(result.ok, false);
  assert.match(fs.readFileSync(out, 'utf8'), /judgment: pending/);
  assert.equal(calls[0][2], path.join(tmp, 'mycelium'));
  assert.ok(calls[0][1].includes('--check-final'));
  assert.equal(calls[0][1][calls[0][1].indexOf('--minimum-units') + 1], '6');
  assert.ok(!calls[0][1].includes('--execute'));

  result = await helper.gateDiscoveryReport(tmp, { slot, out }, settings, async () => { throw Error('spawn failed'); });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  result = await helper.gateDiscoveryReport(tmp, { slot, out }, settings,
    async () => ({ code: 0, stdout: '{"ok":true}' }));
  assert.equal(result.ok, true);

  // Actual execFile bridge, using a tiny deterministic CLI in a temporary repo.
  const batch = path.join(tmp, 'mycelium', 'batch');
  fs.mkdirSync(batch, { recursive: true });
  fs.writeFileSync(path.join(batch, 'discovery_weekly.py'),
    "import json,sys\nfrom pathlib import Path\n" +
    "assert '--check-final' in sys.argv and '--execute' not in sys.argv\n" +
    "p=Path(sys.argv[sys.argv.index('--out')+1])\n" +
    "p.with_suffix('.args.json').write_text(json.dumps(sys.argv))\n" +
    "print(json.dumps({'ok':False,'errors':['synthetic CLI terminal failure']}))\nsys.exit(1)\n");
  const spacedOut = path.join(tmp, 'report with spaces.md');
  fs.writeFileSync(spacedOut, '# Synthetic report\n');
  result = await helper.gateDiscoveryReport(tmp, { slot, out: spacedOut },
    { ...settings, runRoot: path.join(tmp, 'runs with spaces') });
  assert.equal(result.ok, false);
  assert.match(fs.readFileSync(spacedOut, 'utf8'), /judgment: pending/);
  assert.ok(JSON.parse(fs.readFileSync(spacedOut.replace(/\.md$/, '.args.json'), 'utf8')).includes(spacedOut));

  // Exercise the actual scheduler method, with only the external report-log/child process replaced.
  const commits = [];
  const scheduler = new AssistantScheduler(async () => {}, async () => { throw Error('no model calls'); },
    path.join(tmp, 'assistant'), undefined,
    { reportLog: async (_script, args) => { commits.push(args); return { status: args.includes('--partial') ? 'partial' : 'complete' }; } });
  scheduler.config = { analysis: { types: { 'discovery-improvement': { discovery: settings } } } };
  let gateCalls = 0;
  const original = helper.gateDiscoveryReport;
  try {
    helper.gateDiscoveryReport = async (_root, run, received) => {
      gateCalls++;
      assert.equal(run.slot, slot);
      assert.deepEqual(received, settings);
      return { ok: false, errors: ['synthetic independent record missing'] };
    };
    const run = { runId: 'synthetic-run', out, slot, type: 'discovery-improvement' };
    assert.equal((await scheduler.commitReportRun(run, false, 'claude')).status, 'partial');
    assert.ok(commits.at(-1).includes('--partial'));
    assert.equal(gateCalls, 1);
    helper.gateDiscoveryReport = async () => ({ ok: true, errors: [] });
    assert.equal((await scheduler.commitReportRun(run, false, 'claude')).status, 'complete');
    // An already partial session must stay partial even when evidence is valid.
    assert.equal((await scheduler.commitReportRun(run, true, 'claude')).status, 'partial');
    helper.gateDiscoveryReport = async () => { throw Error('other types must not call discovery gate'); };
    assert.equal((await scheduler.commitReportRun({ ...run, type: 'kg-regression' }, false, 'claude')).status, 'complete');
  } finally {
    helper.gateDiscoveryReport = original;
  }
  console.log('discovery helper + scheduler commit consumer passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
