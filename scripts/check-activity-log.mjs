/**
 * 활동 기록이 **남의 방 대화를 안 적는지** 잰다.
 *
 *   npm run check:activity
 *
 * 왜 재나 — 슬랙 앱에 message 이벤트 구독을 켜면 **우리가 안 맡은 방의 말까지 들어온다.**
 * 그 원문을 그대로 적고 있었다: 2026-08-27 실측으로 무관한 업무 방 한 곳에서만 110건,
 * 전 봇 합쳐 12,922자였다. 오류도 경고도 안 난다 — 조용히 쌓일 뿐이다.
 *
 * 그날 한 번 고쳤다고 보고했는데 **다른 경로가 계속 적고 있었다.** 물러섬 기록만 막고
 * 길목(`processEvent`)은 안 봤다. 그래서 이 검사를 둔다.
 */
import './lib/fresh-dist.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 기록 폴더는 임시로 — 운영 폴더에 시험 글이 쌓이면 안 된다. 불러오기 **전에** 정한다(모듈이 읽는 때).
const TMP = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'check-activity-'));
process.env.BOT_ACTIVITY_DIR = TMP;
const { redactForeign, tagRooms, scrub, setRedactor, note } = require(path.join(ROOT, 'dist', 'activity-log.js'));

let pass = 0;
const fails = [];
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS ${name}`); return; }
  fails.push(name);
  console.log(`FAIL ${name} — 받음 ${JSON.stringify(got)}`);
};

const MINE = 'C_MINE';
const FOREIGN = 'C_FOREIGN';
const DM = 'D_ME';
tagRooms('lunch', [MINE]);

const heard = (channel) => ({ 누가: 'U1', 어디: channel, 무엇: 'message', 말: '남의 업무 이야기' });

// --- 안 맡은 방 -------------------------------------------------------------------
{
  const out = redactForeign('lunch', '들음', heard(FOREIGN));
  check('안 맡은 방의 말은 원문이 안 남는다', !('말' in out), out);
  check('대신 몇 글자였는지는 남는다', out.글자수 === '남의 업무 이야기'.length, out);
  check('어느 방·누구인지는 남는다 (몇 번인지 셀 수 있어야 한다)',
    out.어디 === FOREIGN && out.누가 === 'U1', out);
}

// --- 맡은 방 · 1:1 ----------------------------------------------------------------
{
  const out = redactForeign('lunch', '들음', heard(MINE));
  check('맡은 방의 말은 그대로 남는다', out.말 === '남의 업무 이야기', out);
}
{
  const out = redactForeign('lunch', '들음', heard(DM));
  check('1:1 은 그대로 남는다 (우리에게 건 말이다)', out.말 === '남의 업무 이야기', out);
}

// --- 우리에게 건 말은 방을 안 따진다 ------------------------------------------------
// 부름·명령·버튼은 안 맡은 방에서 와도 우리를 향한 말이라 남긴다. 안 남기면 「나 모르게
// 불려서 활동하면 안 된다」를 되짚을 근거가 사라진다.
for (const kind of ['부름받음', '명령', '버튼', '창 제출']) {
  const out = redactForeign('lunch', kind, heard(FOREIGN));
  check(`${kind} 은 안 맡은 방에서도 그대로 남는다`, out.말 === '남의 업무 이야기', out);
}

// --- 방을 안 알려 준 봇 -------------------------------------------------------------
// 모르는 쪽으로 기울일 때는 **안 남기는 편**이 맞다.
{
  const out = redactForeign('없는봇', '들음', heard(MINE));
  check('맡은 방을 안 알려 준 봇은 아무 방도 안 맡은 것으로 본다', !('말' in out), out);
}

// --- 길목이 이 함수를 실제로 쓰는가 --------------------------------------------------
// 순수 함수만 맞고 길목이 안 부르면 아무것도 안 막힌다 — 그게 이번에 겪은 그대로다.
const src = require('node:fs').readFileSync(path.join(ROOT, 'src', 'activity-log.ts'), 'utf-8');
const wired = /processEvent[\s\S]{0,600}?redactForeign\(/.test(src);
check('들어오는 말을 적는 길목이 이 함수를 거친다', wired);
const registers = /tagRooms\(this\.opts\.name/.test(
  require('node:fs').readFileSync(path.join(ROOT, 'src', 'chat-host.ts'), 'utf-8'));
check('대화 봇이 맡은 방을 알려 준다', registers);

// --- 실원이 봇에게 한 말 · 개인 글 조각은 원문을 안 남긴다 (2026-09-30) -----------------
// 실장 「DM 이나 콩에게 전달한 말이 타인이나 채널에 공유되면 절대 안 됨」 → 「가리고 옮기기」.
// `redactForeign` 은 방을 가르고, 그 뒤 `scrub` 이 사람 말을 가른다 — 위의 「1:1 은 그대로」는
// 방 가르기까지의 이야기이고, 실원 DM 은 여기서 가려진다.
{
  const dm = (who, text = '요즘 너무 힘들어서요') => ({ 누가: who, 어디: 'D_X', 무엇: 'message', 말: text });
  setRedactor(null);
  let out = scrub('들음', dm('U_BOSS'));
  check('가림 기준이 없으면 DM 은 누구 것이든 가린다(모르면 안 남김)', !('말' in out) && out.글자수 > 0, out);
  check('가림 기준이 없어도 방 말은 남는다', scrub('들음', heard(MINE)).말 === '남의 업무 이야기');

  setRedactor({ owner: 'U_BOSS', isPrivate: (t) => t.includes('비밀 조각') });
  out = scrub('들음', dm('U_A'));
  check('⛔ 실원이 봇에게 보낸 DM 은 원문이 안 남는다', !('말' in out) && out.글자수 === '요즘 너무 힘들어서요'.length && /원문은 안 남긴다/.test(out.가림), out);
  check('실장 자신의 DM 은 남는다', scrub('들음', dm('U_BOSS')).말 === '요즘 너무 힘들어서요');
  out = scrub('명령', { 누가: 'U_A', 어디: 'C_ANY', 무엇: '/coffeechat', 말: '누구에게 고맙다고' });
  check('⛔ 실원이 슬래시 명령 뒤에 적은 말은 안 남는다', !('말' in out), out);
  check('실장이 슬래시 명령 뒤에 적은 말은 남는다',
    scrub('명령', { 누가: 'U_BOSS', 어디: 'C_ANY', 무엇: '/1on1', 말: '시험' }).말 === '시험');
  out = scrub('보냄', { 어디: 'D_BOSS', 무엇: 'chat.postMessage', 말: '넘김: 비밀 조각 입니다' });
  check('⛔ 개인 글 조각이 든 나가는 말은 원문이 안 남는다(실장에게 넘긴 글 포함)', !('말' in out), out);
  out = scrub('보냄', { 어디: 'D_BOSS', 무엇: 'chat.postMessage', 말: ':speech_balloon: *가가* 님이 저에게 보낸 말이에요.\n\n> 네' });
  check('⛔ 실장에게 넘긴 글은 짧은 말(지문 없음)이라도 통째로 가린다', !('말' in out), out);
  const hostSrc = require('node:fs').readFileSync(path.join(ROOT, 'src', 'chat-host.ts'), 'utf-8');
  check('넘김 글의 머리말을 활동 기록과 같은 상수로 만든다', /\$\{FORWARD_HEAD\}/.test(hostSrc));
  scrub('들음', { 누가: 'U_A', 어디: 'D_A', 무엇: 'message', 말: '상의드릴 게 있어요' });
  out = scrub('보냄', { 어디: 'D_A', 무엇: 'chat.postMessage', 말: '그런 사정이면 이렇게 해 보세요' });
  check('⛔ 실원 DM 방으로 나간 봇의 답도 가린다(그 사람 사정이 실림)', !('말' in out), out);
  scrub('들음', { 누가: 'U_BOSS', 어디: 'D_BOSS', 무엇: 'message', 말: '오늘 일정' });
  check('실장 DM 방으로 나간 봇의 말은 남는다',
    scrub('보냄', { 어디: 'D_BOSS', 무엇: 'chat.postMessage', 말: '오늘 일정은 셋입니다' }).말 === '오늘 일정은 셋입니다');
  check('조각 없는 나가는 말은 남는다(봇이 한 일을 되짚는 기록)',
    scrub('보냄', { 어디: 'C_MINE', 무엇: 'chat.postMessage', 말: '점심 12시에 모여요' }).말 === '점심 12시에 모여요');
  check('방에서 부른 말은 조각이 없으면 남는다(방에 공개된 말)',
    scrub('부름받음', { 누가: 'U_A', 어디: 'C_MINE', 무엇: 'app_mention', 말: '@소인 오늘 점심?' }).말 === '@소인 오늘 점심?');
  setRedactor({ owner: 'U_BOSS', isPrivate: () => { throw new Error('고장'); } });
  out = scrub('보냄', { 어디: 'C_MINE', 무엇: 'chat.postMessage', 말: '아무 말' });
  check('⛔ 가림 점검이 넘어지면 가린다(모르면 안 남김)', !('말' in out), out);

  // 파일에 실제로 안 남는지 — 순수 함수만 맞고 적는 길이 안 거치면 소용없다.
  setRedactor({ owner: 'U_BOSS', isPrivate: () => false });
  note('letter', '들음', dm('U_A', '파일에 남으면 안 되는 말'));
  const fs = require('node:fs');
  const written = fs.readdirSync(TMP).filter((f) => f.endsWith('.jsonl'))
    .map((f) => fs.readFileSync(path.join(TMP, f), 'utf-8')).join('');
  check('⛔ 기록 파일에 실원 DM 원문이 안 적힌다', written.length > 0 && !written.includes('파일에 남으면'), written.slice(0, 120));
  const guardSrc = fs.readFileSync(path.join(ROOT, 'src', 'privacy-guard.ts'), 'utf-8');
  check('개인 글 문이 걸릴 때 활동 기록에도 같은 자를 넘긴다', /setRedactor\(\{\s*owner:/.test(guardSrc));
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n통과 ${pass} / 실패 ${fails.length}`);
if (fails.length) process.exitCode = 1;
