/**
 * 봇이 띄우는 파이썬 실행 파일 이름을 정리한다 — 감싼 따옴표만 벗기고 **`pythonw` 로 바꾸지 않는다.**
 * (2026-10-22 에 `toWindowlessPython` 으로 들어와 `pythonw` 로 바꿨다가, 그 때문에 창이 떠서 이름과 동작을 바꿈)
 * 창을 숨기는 것은 이 함수가 아니라 부르는 쪽의 `windowsHide: true` 다 — `check:windowshide` 가 빠진 곳을 잡는다.
 *
 * ⚠️ `pythonw` 로 바꾸면 오히려 창이 뜬다 (2026-10-23 실측).
 * `pythonw.exe` 는 콘솔이 아예 없는 실행 파일이라, 그 아래에서 콘솔 프로그램(git, codex 등)을
 * `CREATE_NO_WINDOW` 없이 띄우면 윈도우가 그 프로그램에 **새 콘솔 창**을 만들어 준다(Windows Terminal 창이 떴다 사라짐).
 * - `pythonw` 로 띄운 `tasks.py commits --dry-run` — git 5번에 Windows Terminal 창 15개
 * - 같은 명령을 `python` + `windowsHide: true` 로 — 창 0개(0.05초 간격 감시)
 * - 운영 봇 — 메일 확인 차례의 GPT 사용량 조회(`pythonw` → `codex.exe`)에서 창이 뜸
 * `python.exe` + `windowsHide: true` 는 숨은 콘솔을 만들고, 그 아래 콘솔 프로그램은 그 콘솔을 물려받아 창이 안 뜬다.
 * 파이썬이 부르는 모든 곳(tasks.py 의 git, codex SDK 의 app-server, mail.py …)에 숨김 표시를 다는 것은
 * 끝이 없으므로 콘솔을 가진 `python` 을 쓴다.
 *
 * 따옴표 벗기기는 남긴다 — `shell: false` 로 부를 때 CreateProcess 에 따옴표가 들어가면 ENOENT 가 난다.
 */
export function pythonCommand(pythonBin = 'python'): string {
  if (process.platform !== 'win32') {
    return pythonBin;
  }
  let clean = pythonBin.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  return clean;
}
