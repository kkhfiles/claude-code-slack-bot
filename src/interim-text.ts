/**
 * DM 차례의 Claude 글은 마지막 답만 올린다 — 도구 호출 사이에 쓴 중간 글(속생각)은 버린다(사고 ic-20261127-2).
 *
 * 2026-11-27 12:46 「왜 안된거야?」에 대한 답에 「Need the result body. Find the results ledger file.」가 섞여 실장님께
 * 나갔다. SDK 는 글과 도구 호출을 따로따로 내보내는데(같은 메시지라도 내용 칸마다 한 이벤트), 봇은 도구 호출이 없는
 * 이벤트의 글을 받는 즉시 올렸다 — 그 글 뒤에 도구 호출이 또 오는지 받는 순간에는 모른다. 글과 도구 호출이 한
 * 이벤트에 같이 오면 이미 글을 버렸으니, 따로 왔을 때만 새던 셈이다.
 *
 * 그래서 글을 받으면 쥐고 있다가, 뒤에 도구 호출이 오면 중간 글로 버리고 차례가 끝나면 남은 글(마지막 도구 뒤의 글)을
 * 올린다. 쟀을 때(세나 차례 234건) 중간 글이 든 차례 9건은 전부 마지막 도구 뒤에 답이 따로 있었다 — 버려도 답을 안
 * 잃는다. 채널은 도구 실행을 보여 주는 작업 기록이라 그대로 둔다(`slack-handler.ts`).
 */

export interface HeldText {
  text: string;
  /** 내부 번호 문(`internal-labels.ts` `noteText`)이 붙잡은 글 — 올리지 않고, 중간 글이면 그 문에서도 뺀다 */
  held: boolean;
}

export class ReplyBuffer {
  private pending: HeldText[] = [];
  private posted = false;

  /** 도구 호출이 없는 글 — 마지막 답일지 중간 글일지 아직 모른다 */
  text(text: string, held: boolean): void {
    this.pending.push({ text, held });
  }

  /** 도구 호출이 왔다 — 쥐고 있던 글은 중간 글이다. 버린 글을 돌려준다 */
  tool(): HeldText[] {
    const dropped = this.pending;
    this.pending = [];
    return dropped;
  }

  /** 차례 끝 — 올릴 글(붙잡히지 않은 것). 두 번 불러도 한 번만 돌려준다 */
  flush(): string[] {
    if (this.posted) return [];
    this.posted = true;
    const out = this.pending.filter((p) => !p.held).map((p) => p.text);
    this.pending = [];
    return out;
  }
}
