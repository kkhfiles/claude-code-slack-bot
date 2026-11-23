/**
 * 생존 자국 검사 — 훑기가 방을 읽으면 마지막 훑은 시각을 남기고, 다 넘어지면 안 남기나.
 *
 *   npm run check:alive
 *
 * 왜 재나 — 봇 밖 점검(`work-assistant/chatbot/check_turn_health.py`)이 대화 기록만 보던 때는
 * 아무도 말을 안 건 평일마다 「판단 불가」가 갔다(2026-11-23). 그 점검이 이 자국으로 「조용한 날」과
 * 「죽은 봇」을 가른다. 자국이 안 남으면 조용한 날마다 다시 오보가 가고, 넘어진 훑기에도 남으면
 * 죽은 봇을 산 것으로 본다. 둘 다 잰다. 자국은 `CHATBOT_ALIVE_DIR`(임시 폴더)로 돌려 진짜 자국을 안 건드린다.
 */
import './lib/fresh-dist.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-'));
process.env.BOT_ACTIVITY_DIR = path.join(tmp, 'activity');
process.env.CHATBOT_ALIVE_DIR = path.join(tmp, 'alive');

const { ChatHost, aliveMarkPath } = await import('../dist/chat-host.js');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name}`);
  if (detail !== undefined) console.log(`     ${JSON.stringify(detail)}`);
};

const file = path.join(tmp, 'alive', 'zz.json');
check('CHATBOT_ALIVE_DIR 이면 그 아래 <이름>.json', aliveMarkPath('/x/turn.py', 'zz') === file, aliveMarkPath('/x/turn.py', 'zz'));
delete process.env.CHATBOT_ALIVE_DIR;
check('기본은 turn.py 옆 bots/<이름>/data/alive.json (점검의 alive_path 와 같은 규칙)',
  aliveMarkPath(path.join('C:', 'c', 'turn.py'), 'letter') === path.join('C:', 'c', 'bots', 'letter', 'data', 'alive.json'),
  aliveMarkPath(path.join('C:', 'c', 'turn.py'), 'letter'));
process.env.CHATBOT_ALIVE_DIR = path.join(tmp, 'alive');

const host = new ChatHost({ name: 'zz', script: path.join(tmp, 'turn.py'), surfaces: ['channel'], channels: ['C1', 'C2'] });
host['app'] = { client: {} };
host['drain'] = () => {};
let fail = new Set();
host['sweepChannel'] = async (_c, ch) => { if (fail.has(ch)) throw new Error('slack down'); };

await host['sweep']();
let mark = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : null;
check('훑기가 방을 읽으면 자국을 남긴다 (지금 시각 · 읽은 방 수)',
  mark && Math.abs(mark.at - Date.now() / 1000) < 5 && mark.channels === 2, mark);
check('반쯤 쓴 임시 파일이 남지 않는다', !fs.existsSync(`${file}.tmp`));

fail = new Set(['C1']);
fs.writeFileSync(file, JSON.stringify({ at: 1 }));
await host['sweep']();
mark = JSON.parse(fs.readFileSync(file, 'utf-8'));
check('한 방이라도 읽으면 자국을 남긴다', mark.at > 1 && mark.channels === 1, mark);

fail = new Set(['C1', 'C2']);
fs.writeFileSync(file, JSON.stringify({ at: 1 }));
await host['sweep']();
mark = JSON.parse(fs.readFileSync(file, 'utf-8'));
check('방을 하나도 못 읽으면 자국을 안 고친다 (슬랙에 못 닿는 봇은 산 것이 아님)', mark.at === 1, mark);

// 자국 폴더를 쓸 수 없어도 훑기는 안 넘어진다
process.env.CHATBOT_ALIVE_DIR = path.join(tmp, 'file-not-dir');
fs.writeFileSync(process.env.CHATBOT_ALIVE_DIR, 'x');
fail = new Set();
let threw = null;
try { await host['sweep'](); } catch (e) { threw = String(e); }
check('자국을 못 써도 훑기는 넘어지지 않는다', threw === null, threw);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n통과 ${pass} / 실패 ${fails.length}`);
process.exit(fails.length ? 1 : 0);
