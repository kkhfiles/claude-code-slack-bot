/** Verify SDK execution and context forwarding without starting a model process. */
import './lib/fresh-dist.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SlackHandler } = require(path.join(ROOT, 'dist', 'slack-handler.js'));
const { CliHandler } = require(path.join(ROOT, 'dist', 'cli-handler.js'));
const { SdkHandler } = require(path.join(ROOT, 'dist', 'sdk-handler.js'));
const calls = [];
const warm = [];
const handler = Object.create(SlackHandler.prototype);
handler.accountManager = {
  syncFromCredentialsFile() {},
  async getAccessToken() { return 'test-oauth'; },
};
handler.logger = { info() {}, warn() {}, debug() {}, error() {} };
handler.cliHandler = { runQuery() { throw new Error('Direct CLI execution must not run'); } };
handler.sdkHandler = {
  runQuery(prompt, options) {
    calls.push({ prompt, options });
    return {
      interrupt() {},
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'test-session' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'SDK result' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0 };
      },
    };
  },
  prewarm(options) { warm.push(options); },
};

const names = ['SLACKBOT_FORCE_CLI', 'SLACKBOT_SDK_ENABLED'];
const before = names.map(name => process.env[name]);
try {
  for (const force of [undefined, '1']) {
    if (force === undefined) delete process.env.SLACKBOT_FORCE_CLI;
    else process.env.SLACKBOT_FORCE_CLI = force;
    delete process.env.SLACKBOT_SDK_ENABLED;
    const result = await handler.runAssistantSession('test prompt', {
      // An old JavaScript caller cannot switch the runtime back to the CLI.
      useSdk: false,
      tools: [], settingSources: [], settings: { includeGitInstructions: false },
      systemPrompt: 'Only process the supplied text.',
      noSessionPersistence: true, skipMcp: true, prewarmAfter: true, effort: 'low',
      maxDurationMs: 1000,
    });
    assert.equal(result.text, 'SDK result');
    assert.equal(result.isError, false);
  }
} finally {
  names.forEach((name, index) => {
    if (before[index] === undefined) delete process.env[name];
    else process.env[name] = before[index];
  });
}
assert.equal(calls.length, 2);
assert.equal(warm.length, 2);
for (let index = 0; index < calls.length; index++) {
  const { options } = calls[index];
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settings, { includeGitInstructions: false });
  assert.equal(options.systemPrompt, 'Only process the supplied text.');
  assert.equal(options.noSessionPersistence, true);
  assert.equal(options.effort, 'low');
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, 'test-oauth');
  assert.equal(warm[index], options);
}
assert.equal(CliHandler.prototype.runQuery, undefined);
const source = fs.readFileSync(path.join(ROOT, 'src', 'slack-handler.ts'), 'utf8');
assert.equal(source.includes('this.cliHandler.runQuery('), false);

// skipMcp must exclude configurations discovered outside the explicit server list.
const servers = { fixture: { type: 'http', url: 'http://127.0.0.1:9/mcp' } };
const runtime = new SdkHandler({
  getServerConfiguration() { return servers; },
  getDefaultAllowedTools() { return []; },
});
const excluded = runtime.buildOptions('test', { skipMcp: true, tools: [], settingSources: [] }).sdkOptions;
assert.equal(excluded.strictMcpConfig, true);
assert.equal(excluded.mcpServers, undefined);
const included = runtime.buildOptions('test', { skipMcp: false }).sdkOptions;
assert.deepEqual(included.mcpServers, servers);
assert.notEqual(included.strictMcpConfig, true);
console.log('SDK routing and context forwarding passed; no model requests made.');
