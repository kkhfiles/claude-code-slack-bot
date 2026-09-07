import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger';
import { tagApp, tagToken, tagRooms, note } from './activity-log';

/**
 * agy 위에 얹은 슬랙 대화 계층. **봇 여러 개가 이 한 클래스를 같이 쓴다.**
 *
 * 각 봇은 자기 슬랙 앱(=자기 정체성과 토큰)을 쓰므로 소켓 연결도 따로 연다.
 * **한 앱에는 연결 하나뿐이다** — 자리가 늘어도 호스트를 더 만들지 않는다.
 * 말을 만드는 일은 외부 파이썬(`turn.py`)이 하고 여기는 슬랙 쪽만 맡는다 —
 * 그 이음매 덕에 대화는 워크스페이스 없이도 시험할 수 있다.
 *
 * 자리는 두 가지고, **한 봇이 둘 다 열 수 있다**(`surfaces`).
 *   - `dm`      개인이 봇과 1:1 로 말한다. 대화 열쇠 = 사람
 *   - `channel` 여러 사람이 있는 방에 봇이 상주한다. 대화 열쇠 = 방
 *
 * 시간이 걸려서 생기는 문제는 전부 이쪽 몫이다.
 *   - 🤔 를 부른 메시지에 붙였다가 답하면서 뗀다. 성공이든 실패든 반드시 뗀다.
 *   - 한 번 답하는 데 10초쯤 걸린다(모델이 아니라 agy 기동 시간이라 모델을 바꿔도 안 빨라진다).
 *     그 사이 들어온 말은 "처리 중"이라 하지 않고 **모아서 다음 답에 합친다.**
 *   - 전체 동시 실행은 **봇을 통틀어** 3개까지.
 */

/** 동시 실행은 봇마다가 아니라 **PC 전체로** 센다. agy 는 한 번에 여러 개가 무겁다. */
let globalRunning = 0;
const CONCURRENCY_CAP = 3;

const MAX_MERGED_LINES = 20;
/** 한 방에서 「이미 집어 갔다」를 기억해 둘 글 수. 넘으면 오래된 것부터 버린다. */
const TAKEN_MEMORY = 500;
/**
 * 한 턴을 기다려 주는 한계. turn.py 가 agy 를 90초에 끊으니 보통은 그 위 여유면 된다.
 *
 * **다만 대화가 길어지면 한 턴에 agy 를 두 번 부른다** — 앞 대화를 요약해서 끊고(최대
 * 120초, turn.py 의 `_maybe_compact`) 새 대화로 본 턴을 돈다. 150초로 두면 그 턴만
 * 골라서 죽는다. 드물게 오는 턴이라 눈에 안 띄고, 하필 **가장 긴 대화에서만** 난다.
 */
const TURN_TIMEOUT_MS = 240 * 1000;
/**
 * 답을 만드는 동안 그 말에 붙였다 떼는 표시. **봇마다 다른 것을 쓴다.**
 *
 * 한 방에 봇이 둘 있으면 같은 표시로는 **누가 생각 중인지 못 가린다** — 답이 오기까지
 * 10~20초가 걸리는데 그동안 아무 단서가 없으면 안 듣는 것과 구분되지 않는다.
 * 실제 이름은 봇 프로필(`bots/<이름>/config.json`)의 `reaction` 이 정하고, 여기는 기본값이다.
 */
const THINKING = 'thinking_face';
/**
 * 훑을 때 채널을 얼마나 거슬러 읽나. 하루 종일 조용하다 한 마디 올라온 자리에서
 * 어제 얘기까지 끌어오지 않게 잘라 둔다. 봇이 그 사이 말을 했으면 어차피 거기서 끊긴다.
 */
const SWEEP_LOOKBACK_MS = 30 * 60 * 1000;

const BUSY_TEXT = '지금 다른 얘기를 듣고 있어서 조금만 기다려 주세요. 끝나는 대로 바로 답할게요.';
const FAIL_TEXT = '죄송해요, 지금은 답을 못 만들겠어요. 잠시 뒤에 다시 말 걸어 주시겠어요?';
/** 명단 밖 사람의 DM 을 주인에게 넘긴 뒤 그 사람에게 남기는 한 줄. */
const BYPASS_TEXT = '말씀 잘 받았어요. 실장님께 그대로 전해 드릴게요 :coffee:';
/** 같은 사람에게 위 한 줄을 다시 보내기까지. 이어 치는 줄에는 안 겹치고, 새로 걸면 답한다. */
const NOT_YET_AGAIN_MS = 10 * 60 * 1000;

/**
 * **방에 있는 봇들을 통째로 부르는 말.** 봇마다 다를 이유가 없어서 여기 둔다 —
 * 이건 그 봇의 주제(`interest`)가 아니라 「나를 불렀나」이고, 봇 설정에 하나씩
 * 적어 두면 새로 만든 봇에서 조용히 빠진다.
 *
 * 왜 필요한가(2026-09-07 실측): 「얘들아」에 두 봇이 다 조용했다. 이름을 부른 것도
 * 아니고 아무 낱말에도 안 걸려서 **1분짜리 훑기를 기다렸고**, 그 훑기는 「사람들끼리
 * 주고받는 인사」로 보고 넘겼다. 33분 뒤 「얘들아?????」에야 답했다.
 *
 * 여기 걸리면 **그 자리에서** 판단으로 넘어간다 — 답하기로 정해 주는 것이 아니라
 * 기다리지 않게 해 주는 것뿐이고, 낄지 말지는 그대로 모델이 정한다.
 */
const CALL_WORDS = /얘들아|애들아|얘들|봇들|너희|니들|느그|다들|여러분|모두들/;

/**
 * 채널에서 **먼저** 말을 걸 조건.
 *
 * 양이 아니라 **내용**으로 거른다. "새 말이 N개 쌓이면"으로 재면 "뭐 맛있는 거 없나?"
 * 같은 한 마디짜리 순간을 놓친다 — 그 사이 대화는 이미 지나가 있다. 사람이라면 그 한
 * 마디에 바로 대답하지, 넉 줄이 쌓일 때까지 기다리지 않는다.
 *
 * 판단하는 길은 둘이다.
 *
 *   낱말(`interest`)  걸리면 **그 자리에서** 바로 — 싸고 빠르다
 *   훑기(`sweepSeconds`)  몇 초마다 **쌓인 말을 통째로** 모델에게 보여 주고 물어본다
 *
 * 훑기가 필요한 이유: 「애가 됐네」·「신분이 내시인가요」처럼 **앞 글을 가리키는 말**은
 * 어떤 낱말 목록으로도 못 잡는데, 정작 그런 자리가 봇이 껴야 할 자리다(실측: 안 부른
 * 글 11건 중 6건이 그 종류였고 낱말을 늘려도 여전히 안 걸렸다). 한 줄만 보면 못 풀고
 * 대화를 봐야 풀린다.
 *
 * 나머지 둘은 수다스러움을 막는 굴레다.
 */
export interface ButtInRule {
  quietMinutes: number;   // 마지막으로 입을 연 지 이만큼은 조용히
  dailyCap: number;       // 하루 이만큼까지만
  sweepSeconds?: number;  // 이만큼마다 쌓인 말을 통째로 보고 낄지 다시 본다 (0=끔)
}

export interface BotTalkRule {
  softTurns: number;      // 이만큼 오가면 「마무리하라」고 한마디 붙인다
  hardTurns: number;      // 이만큼을 넘기면 사람이 말할 때까지 끊는다
}

/**
 * 형제 봇들의 슬랙 사용자 ID. 호스트가 뜨면서 자기 것을 적어 두고, 서로를 여기서 알아본다.
 *
 * **설정에 적게 하지 않는다** — 봇이 늘 때마다 사람이 ID 를 옮겨 적어야 하고, 한 번
 * 빠뜨리면 그 봇의 말만 조용히 안 들린다(에러도 로그도 없이 기능만 사라지는 종류).
 */
const siblingIds = new Set<string>();

/** 봇끼리 길어졌을 때 붙이는 한마디. **스스로 맺게 먼저 해 본다** — 끊는 것은 그다음이다. */
/**
 * 봇끼리 길어졌을 때 붙이는 한마디. **스스로 맺게 먼저 해 본다** — 끊는 것은 그다음이다.
 *
 * **줄을 그어 앞말과 떼어 놓고, 옮겨 적지 말라고 못을 박는다.** 이 글은 형제가 한 말
 * 바로 뒤에 붙으므로, 안 떼어 놓으면 ①형제가 그렇게 말한 줄 알거나 ②그대로 베껴서
 * 방에 찍는다. 이 프로젝트에 실측 선례가 있다 — 자료 파일에 적어 둔 사용 지침이
 * 채널 게시글 끝에 괄호째 붙어 나갔다. **프롬프트에 붙는 지시는 사람 눈에 안 보인다는
 * 보장이 없다.**
 */
const WRAP_UP = '\n---\n[안내] 봇끼리 이야기가 길어졌습니다. 이번 답으로 자연스럽게'
  + ' 마무리하세요. 이 안내는 사람에게 안 보이는 줄이니 답에 옮겨 적지 마세요.';

/**
 * 사람이 치는 멈춤·풀기 낱말. **모델에게 묻지 않고 낱말로 잡는다** — 멈추라는 말은
 * 모델 왕복(10초)을 기다릴 수 없고, 한창 주고받는 중이면 그 물음마저 줄을 선다.
 * 푸는 말도 같이 둔다. 없으면 봇을 재시작해야 풀린다.
 */
const HUSH = /(그만|멈춰|멈춰라|조용히?\s*해|입\s*다)/;
const UNHUSH = /(다시\s*(해|시작|얘기|이야기)|계속\s*해)/;

export interface ChatBotOptions {
  name: string;           // turn.py 의 봇 이름이자 로그 이름
  botToken: string;
  appToken: string;
  python: string;
  script: string;         // turn.py 경로
  /**
   * 이 봇이 여는 자리. **둘 다여도 연결은 하나다.**
   *
   * 자리마다 호스트를 하나씩 두면 같은 앱에 소켓이 두 번 열리고, 슬랙은 들어온 것을
   * 연결 하나에만 주므로 **부름의 절반이 흔적 없이 사라진다**(2026-08-06에 반나절을
   * 태운 사고). 그래서 자리는 여기서 늘리고 연결은 안 늘린다.
   */
  surfaces: Array<'dm' | 'channel'>;
  allowUsers?: string[];  // dm: 여기 적힌 사람만. **비면 아무도 못 쓴다**
  managerUserId?: string;
  channels?: string[];    // channel: 여기 적힌 방에서만
  /**
   * **부른 것만 받는 방.** `channels` 에도 함께 넣어야 열린다.
   *
   * `knownRooms` 와 다르다 — 그쪽은 불러도 「여기서는 활동하지 않아요」만 돌려주는
   * 아예 닫힌 방이고, 이쪽은 **부르면 제대로 답하되 먼저 끼어들지는 않는** 방이다.
   * 식단 알림처럼 사람이 보러 오는 방에 쓴다: 답이 없으면 고장으로 보이고, 끼어들면
   * 알림 방이 잡담 방이 된다. 낱말·굴레·봇끼리 말 섞기가 여기서는 전부 안 걸린다.
   */
  quietRooms?: string[];
  /**
   * **봇끼리 말 섞기.** null 이면 봇이 한 말은 전부 안 들린다(기본).
   *
   * 켤 때 굴레가 반드시 같이 온다 — 부름(멘션)은 조용한 시간·하루 한도를 건너뛰도록
   * 해 놨기 때문에, 봇 둘이 서로를 부르기 시작하면 **아무 굴레도 안 걸린 채 최고 속도로**
   * 주고받는다. 사람이 「그만」을 치는 사이에도 몇 번이 더 오간다. 그래서 세는 자리를
   * 따로 두고 거기서만 끊는다.
   */
  botTalk?: BotTalkRule | null;
  buttIn?: ButtInRule | null;   // channel: null 이면 불렀을 때만 답한다
  /** 방에 들어간 직후 한 번 인사할지. 인사말은 그 자리에서 지어낸다(고정 문구 아님). */
  greetOnJoin?: boolean;
  /**
   * 같은 슬랙 앱에 **대화가 아닌 기능**을 얹을 자리(레터의 칭찬 전달).
   *
   * 앱 하나에 소켓을 두 번 열면 안 된다 — 슬랙은 들어온 것을 연결 하나에만 주므로,
   * 명령이 핸들러 없는 쪽으로 가면 조용히 실패한다. 그래서 이 앱을 그대로 넘긴다.
   */
  attach?: (app: App) => void;
}

interface Waiting {
  channel: string;
  threadTs?: string;
  texts: string[];
  reactTs: string[];
  toldBusy: boolean;
  /**
   * 이 묶음에서 **가장 새 글의 ts.** 아무 데도 표시를 안 붙이기로 한 자리(먼저 말 걸기)
   * 에서도 「지금 이 말에 답을 만들고 있다」를 하나는 보여 주려고 들고 있는다.
   */
  lastTs?: string;
  /**
   * 이 묶음에 **형제 봇의 말이 들어 있나.** 훑기는 봇 말을 못 집으므로, 자리가 났을 때
   * 여기서 안 집으면 그 말은 사람이 입을 열 때까지 대기열에 묻힌다.
   */
  hasSibling?: boolean;
  /**
   * 이 묶음에서 **말한 사람들.** 설정을 말로 바꾸는 길이 실장만 열리는데, 방에서는
   * 한 턴이 여러 사람의 말을 합친 것일 수 있다. 「실장도 끼어 있으니 실장」으로 보면
   * **다른 분의 청이 실장 이름으로 먹는다** — 그래서 전원이 실장일 때만 실장으로 넘긴다.
   */
  users?: Set<string>;
}

interface TurnResult {
  reply: string;
  speak?: boolean;
  error: string | null;
  elapsed_s?: number;
}

export class ChatHost {
  private app: App | null = null;
  private logger: Logger;
  private selfUserId = '';
  /** 이 봇이 관심 있는 화제. 여기 안 걸리면 **그 자리에서는** 말을 걸지 않는다. */
  private interest: RegExp | null = null;
  /** 생각 중임을 알리는 표시. 봇 프로필이 정하고, 없으면 기본값. */
  private mark = THINKING;
  /** 그 표시가 이 워크스페이스에 없더라 — 한 번만 알린다(장식이라 답은 그대로 나간다). */
  private toldBadMark = false;
  /**
   * 말투마다 다른 「생각 중」 표시(`chatbot/tone_marks.json`). **말투를 갈아입으면 표시도
   * 갈아입는다** — 얼굴만 바뀌고 표시가 그대로면 갈아입은 티가 안 난다.
   *
   * 여기 없는 말투(사람이 지어낸 지시문 — 「비 오는 날처럼 나른하게」)는 위 `mark` 로
   * 돌아간다. 목록에 말투를 더하고 이 파일을 안 채우면 조용히 그렇게 되므로
   * `chatbot/check_tone_marks.py` 가 두 목록의 차이를 센다.
   */
  private toneMarks: Record<string, string> = {};
  /** 이 봇의 기본 말투(`bots/<이름>/config.json` 의 `tone`). 대화에 저장된 것이 없을 때 쓴다. */
  private botTone = '';
  /** 쌓인 말을 주기적으로 훑어보는 타이머. */
  private sweeper: NodeJS.Timeout | null = null;

  /** 지금 턴이 도는 열쇠 — 그쪽으로 새로 온 말은 뒤에 줄서지 않고 합쳐진다. */
  private active = new Set<string>();
  /** 말했지만 아직 답하지 않은 것, 열쇠별로. */
  private pending = new Map<string, Waiting>();
  /**
   * 열쇠마다 **이미 집어 간 글의 ts.**
   *
   * **대기열(`pending`)이 아니라 여기 둔다.** 대기열은 턴이 시작할 때 통째로 지워지므로
   * (`pump` 의 `pending.delete`), 거기에 두면 **지금 답을 만들고 있는 바로 그 말**이
   * 아무 데도 안 남는다. 그 10~15초 사이에 훑기가 방을 다시 읽으면 봇이 아직 답을 안
   * 올린 탓에 그 말이 여전히 「답 안 한 글」로 보여 다시 담기고, 턴이 끝나자마자
   * `pump` 의 반복문이 그걸 집어 **한 번 더 답한다**.
   *
   * 실측 2026-09-02 — 소인이 방에서 한 마디에 두 번씩 답했고, 사람이 먼저 알아채고
   * 물었다. 훑기 쪽에는 이걸 막으려고 둔 검사가 이미 있었는데(「줄이 하나도 안 남았다
   * = 이미 도는 턴에 들어가 있다」), **그 검사가 여기 기억을 믿고 있었다.**
   *
   * 대신 잃는 것 — 턴이 넘어져 방에 아무 말도 안 남은 자리를 훑기가 되집어 주던 길이
   * 닫힌다. 사람이 부른 턴은 넘어져도 「못 했다」 한 줄이 나가므로 다시 물어볼 수 있고,
   * 먼저 말 걸려던 턴은 아무도 기다리지 않는다. **두 번 답하는 쪽이 훨씬 나쁘다.**
   */
  private taken = new Map<string, Set<string>>();
  /**
   * 방마다 **훑어서 이미 물어본 마지막 글의 시각.**
   *
   * 훑기의 경계는 「봇이 마지막으로 입을 연 자리」인데, 안 끼기로 하면 봇은 아무 말도
   * 안 하므로 **경계가 그대로 있다.** 그래서 같은 글을 1분 뒤에 또 묻고, 되돌아보는
   * 30분 창에서 빠질 때까지 **한 글당 서른 번쯤** 묻게 된다(실측 2026-08-10: 8자짜리
   * 한 줄을 26번 물었고 26번 다 「말 안 함」이었다. 그날 34턴 중 봇이 말한 것은
   * 사람이 직접 부른 2턴뿐).
   *
   * 「봤고 안 끼기로 했다」를 남길 자리가 없던 것이 원인이라, 여기에 남긴다.
   */
  private sweptUpTo = new Map<string, number>();
  /** 방마다 봇끼리 이어 온 횟수. **사람이 한 마디 하면 처음으로 돌아간다.** */
  private botTurns = new Map<string, number>();
  /**
   * 사람이 그만하라고 한 방 — **봇끼리 오가는 것**을 막는다. 지나가는 말도 듣는다:
   * 봇 둘이 주고받기 시작하면 누구든 한마디로 끊을 수 있어야 하는 안전 밸브다.
   */
  private hushed = new Set<string>();
  /**
   * **부른 턴에** 그만하라고 한 방 — 먼저 끼어드는 것까지 멈춘다. 부르면 그대로 답한다.
   *
   * **왜 부른 턴만인가.** 낱말은 「그만큼 맛있었어요」·「오늘 그만 먹을래」에도 걸린다.
   * 봇끼리 대화를 끊는 데 쓸 때는 오탐이 나도 손해가 없었지만, 이것으로 봇을 재우면
   * 아무도 청한 적 없는데 봇이 조용해지고 **사람 눈에는 고장으로 보인다.** 말투를
   * 말로 바꾸는 길이 부른 턴만 듣는 것과 같은 이유다. 푸는 것은 느슨하게 듣는다 —
   * 잘못 재워졌을 때 부르지 않고도 깨울 수 있어야 한다.
   */
  private buttInHushed = new Set<string>();
  /** 채널에서 우리가 마지막으로 입을 연 시각·횟수. */
  private lastSpoke = new Map<string, number>();
  private spokenToday = new Map<string, { day: string; count: number }>();
  /** 한 사람에게 한 번만 알린다 — 지나가던 사람이 같은 말을 반복해 듣지 않게. */
  private toldNotYet = new Map<string, number>();
  /** 아직 초대 안 된 방 — 같은 말을 1분마다 찍지 않으려고 한 번만 알린다. */
  private toldNotInChannel = new Set<string>();
  /** 누구인지 못 가린 봇 말이 온 방. 방마다 한 번만 적는다. */
  private toldMuteBot = new Set<string>();
  /** **허락 안 한 방**인데 불려 간 곳. 주인에게 방마다 한 번만 알린다. */
  private toldStranger = new Set<string>();
  /** 이미 인사한 방. 들어왔다 나갔다 해도 한 살림에 한 번만 인사한다. */
  private greeted = new Set<string>();
  private names = new Map<string, string>();

  /**
   * **살아 있는 말이 한 번이라도 들어왔나.** 앱에 `message` 이벤트 구독이 빠져 있으면
   * 여기가 영영 거짓으로 남는다 — 권한(`channels:history`)과 이벤트 구독은 따로라
   * **훑기는 멀쩡히 도는데 부름만 안 들리는** 모양이 된다(2026-08-19 커피콩 실측).
   * 그 상태는 에러가 안 나서, 세지 않으면 알아낼 길이 없다.
   */
  private sawLive = false;
  private toldNoEvents = false;
  private readonly startedAt = Date.now();

  constructor(private readonly opts: ChatBotOptions) {
    this.logger = new Logger(`Chat:${opts.name}`);
  }

  private get servesDm(): boolean { return this.opts.surfaces.includes('dm'); }
  private get servesChannel(): boolean { return this.opts.surfaces.includes('channel'); }
  /**
   * 이 대화 열쇠가 DM 인가. **열쇠 자체가 안다** — DM 은 사람(`U…`), 채널은 방(`C…`)이라
   * 호스트 설정을 볼 필요가 없다. 한 봇이 두 자리를 다 받으므로 「이 봇은 DM 봇」 같은
   * 판단은 이제 틀린 답을 준다.
   */
  private isDmKey(key: string): boolean { return key.startsWith('U'); }

  /**
   * 이 열쇠의 답을 이 자리에 내도 되나. **개인 것은 개인 방에만.**
   *
   * 사람과의 대화(`U…`)는 개인 대화방(`D…`)으로만 나가고, 방과의 대화(`C…`)는
   * **바로 그 방으로만** 나간다. 둘이 엇갈리면 답을 버린다 — 늦게 답하는 것과
   * 엉뚱한 데 떠드는 것은 무게가 다르다.
   */
  private canSay(key: string, channel: string): boolean {
    return this.isDmKey(key) ? channel.startsWith('D') : channel === key;
  }

  async start(): Promise<void> {
    if (this.app) return;
    const app = new App({
      token: this.opts.botToken, appToken: this.opts.appToken, socketMode: true,
    });
    tagApp(app, this.opts.name);
    tagToken(this.opts.botToken, this.opts.name);
    // **맡은 방을 활동 기록에 알려 준다.** 구독을 켜면 안 맡은 방의 말까지 들어오는데,
    // 안 알려 주면 그 원문이 전부 디스크에 쌓인다(2026-08-27 실측 110건).
    tagRooms(this.opts.name, this.opts.channels ?? []);

    this.loadProfile();

    // 대화 말고 다른 것을 얹을 것이 있으면 **소켓을 열기 전에** 붙인다.
    if (this.opts.attach) {
      try {
        this.opts.attach(app);
      } catch (error) {
        this.logger.warn('attach 실패 — 대화는 그대로 뜹니다', error);
      }
    }

    app.event('message', async ({ event, client }) => {
      try {
        await this.onEvent(client, event as unknown as Record<string, unknown>);
      } catch (error) {
        this.logger.warn('Failed to handle a message', error);
      }
    });

    try {
      await app.start();
      this.app = app;
      // 채널에서는 자기를 부른 것인지 알아야 한다. 멘션은 본문에 <@봇ID> 로 들어온다.
      try {
        const me = await app.client.auth.test();
        this.selfUserId = (me.user_id as string) ?? '';
        // 형제 봇들이 서로를 알아볼 자리. 여기 없는 봇의 말은 안 들린다.
        if (this.selfUserId) siblingIds.add(this.selfUserId);
      } catch (error) {
        this.logger.warn('auth.test failed — mentions will not be recognised', error);
      }
      const every = this.opts.buttIn?.sweepSeconds ?? 0;
      if (this.servesChannel && this.opts.buttIn && every > 0) {
        // **비동기라 try/catch 로는 못 잡는다** — 채널을 읽어 오는 사이에 나는 실패는
        // 되돌아온 약속(promise)에 담겨 오므로 거기서 받아야 타이머가 안 죽는다.
        this.sweeper = setInterval(() => {
          void this.sweep().catch((error) =>
            this.logger.warn('훑어보다 넘어졌습니다', error));
        }, every * 1000);
        this.sweeper.unref?.();
      }
      const where: string[] = [];
      if (this.servesDm) where.push(`DM ${this.opts.allowUsers?.length ?? 0}명 허용`);
      if (this.servesChannel) {
        where.push(`채널 ${this.opts.channels?.length ?? 0}곳, 먼저 말 걸기 ${
          this.opts.buttIn ? `on · ${every > 0 ? `${every}초마다 훑어봄` : '낱말만'}` : 'off'}`);
      }
      // **연결 수를 같이 찍는다** — 자리가 둘인데 연결도 둘이면 그게 사고다.
      this.logger.info(`listening (연결 1개 · ${where.join(' + ') || '자리 없음'})`);
    } catch (error) {
      this.logger.warn('failed to start', error);
    }
  }

  /**
   * 봇 프로필(`bots/<이름>/config.json`)에서 **관심 낱말과 생각 중 표시**를 읽는다.
   * 파이썬 쪽과 **같은 파일**을 본다 — 봇의 성격을 정하는 것이 두 군데로 갈리면
   * 한쪽만 고쳐 놓고 왜 안 되는지 찾게 된다.
   */
  private loadProfile(): void {
    const configPath = path.join(
      path.dirname(this.opts.script), 'bots', this.opts.name, 'config.json');
    let profile: { interest?: unknown; reaction?: unknown; tone?: unknown };
    try {
      profile = JSON.parse(fs.readFileSync(configPath, 'utf-8')) ?? {};
    } catch (error) {
      this.logger.warn(`봇 프로필을 못 읽었습니다 (${configPath}) — 관심 낱말과 표시는 기본값으로 갑니다`, error);
      return;
    }

    const wanted = typeof profile.reaction === 'string' ? profile.reaction.replace(/:/g, '').trim() : '';
    if (wanted) this.mark = wanted;
    if (typeof profile.tone === 'string') this.botTone = profile.tone.trim();

    // 말투마다 다른 표시. **뜰 때 읽는 것은 아래 로그에 개수를 찍으려는 것뿐**이고,
    // 실제로 붙일 때는 `markFor` 가 그때그때 다시 읽는다.
    this.toneMarks = this.marksNow();

    if (!this.servesChannel) return;
    const words = profile.interest;
    if (!Array.isArray(words) || words.length === 0) return;
    const escaped = words.map((w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const marks = Object.keys(this.toneMarks).length;
    this.logger.info(`관심 낱말 ${escaped.length}개를 읽었습니다 (생각 중 표시 :${this.mark}:`
      + `${marks ? ` · 말투별 ${marks}개` : ''}${this.botTone ? ` · 기본 말투 ${this.botTone}` : ''})`);
    this.interest = new RegExp(escaped.join('|'));
  }

  async stop(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    if (!this.app) return;
    try {
      await this.app.stop();
    } catch (error) {
      this.logger.warn('failed to stop', error);
    }
    this.app = null;
  }

  private async onEvent(client: App['client'], m: Record<string, unknown>): Promise<void> {
    const channel = m.channel as string | undefined;
    const user = m.user as string | undefined;
    const ts = m.ts as string | undefined;
    const text = ((m.text as string) ?? '').trim();
    // 편집·입퇴장 알림과 봇이 한 말은 사람의 발화가 아니다. **형제 봇만 예외로 듣는다.**
    const fromSibling = !!user && user !== this.selfUserId && siblingIds.has(user);
    if (m.bot_id && !fromSibling) {
      // 봇이 한 말인데 형제로 안 잡힌 자리. 이 모양으로 오면 봇끼리 대화가
      // **에러도 없이 안 열린다.** 방마다 한 번 적어 두어 그때 눈에 띄게 한다.
      //
      // **못 가린 이유를 갈라 적는다.** 예전에는 `user` 가 없을 때만 적었는데, 그건
      // 둘 중 흔하지 않은 쪽이다 — `user` 가 멀쩡히 실려 있는데 형제 명단에 없는
      // 경우(뜰 때 자기 ID 를 못 적었거나 봇이 늦게 붙은 경우)가 그대로 묻혔다.
      // **안 적히는 절반이 하필 더 잦은 쪽이면 기록은 있으나 마나다.**
      if (this.opts.botTalk && channel && user !== this.selfUserId
          && !this.toldMuteBot.has(channel)) {
        this.toldMuteBot.add(channel);
        note(this.opts.name, '물러섬', { 어디: channel, 말: text,
          왜: user
            ? `봇이 한 말인데 형제 명단에 없다 — 말한 이 ${user} · 아는 형제 [${[...siblingIds].join(' ')}]`
            : '봇이 한 말인데 누구인지 못 가렸다(user 없음) — 형제 봇이면 봇끼리 대화가 안 열린다' });
      }
      return;
    }
    if (m.subtype || !channel || !user || !ts || !text) return;
    if (user === this.selfUserId) return;
    // **어느 자리인지는 들어온 것이 정한다.** 호스트의 설정으로 가르면 자리가 늘 때마다
    // 호스트를(그러니까 연결을) 하나 더 열게 된다 — 그게 소켓 이중 연결 사고의 뿌리다.
    if (m.channel_type === 'im') {
      if (!this.servesDm) return;
      // **봇끼리는 방에서만 말을 섞는다.** 1:1 에는 세는 자리가 없어서, 여기로 새면
      // 굴레 없는 주고받기가 된다 — 막으려고 만든 바로 그 모양이다.
      if (fromSibling) return;
      await this.onDirectMessage(client, user, channel, ts, text);
      return;
    }
    // **방의 말만 증거로 센다 — 1:1 은 안 센다.** 구독은 자리마다 따로 켜므로
    // `message.im` 만 있고 `message.channels` 가 빠진 조합이 그대로 성립한다(DM 만
    // 하던 봇을 방에 넣을 때 흔하다). 1:1 한 마디에 이 값이 켜지면, 정작 **잡으려던
    // 그 상태에서 경고가 영영 안 뜬다** — 감시가 자기가 못 보는 것을 봤다고 하는 꼴이다.
    this.sawLive = true;
    if (!this.servesChannel) return;
    // **허락한 방에서만 움직인다.** 누가 다른 방에 초대해도 여기서 끊긴다 — 부르든 말든.
    if (!(this.opts.channels ?? []).includes(channel)) {
      await this.notInvitedHere(client, user, channel, ts, text);
      return;
    }
    // 사람이 한 마디 하면 봇끼리 세던 것이 처음으로 돌아간다. 멈춤·풀기도 여기서 본다.
    let say: string | null = text;
    if (fromSibling) say = this.botTalkTurn(channel, text);
    else this.humanSpoke(channel, text);
    if (say === null) return;

    await this.onChannelMessage(client, user, channel, ts,
      m.thread_ts as string | undefined, say, fromSibling);
  }

  /**
   * 봇이 한 말을 받을 차례인가. 받는다면 **넘길 글**을, 아니면 null 을 돌려준다.
   *
   * **사람이 없어도 저절로 멈춰야 한다.** 봇 둘이 서로를 부르면 조용한 시간·하루 한도가
   * 통째로 건너뛰어지므로, 세는 일을 여기 한 곳에 몰아 두고 여기서만 끊는다.
   */
  private botTalkTurn(channel: string, text: string): string | null {
    const rule = this.opts.botTalk;
    if (!rule) return null;                       // 안 켰으면 봇이 한 말은 안 듣는다
    if (this.hushed.has(channel)) return null;    // 사람이 그만하라고 했다
    // **오간 말을 통째로 센다 — 받은 것만 세면 실제 길이의 절반만 보인다.**
    // 봇 둘이 번갈아 말하므로 각자는 상대 말만 받는다. 그것만 세면 스무 번을 셌을 때
    // 방에는 마흔 마디가 지나간 뒤다. 상대 말 하나에 내 답 하나가 붙으니 둘로 센다.
    const n = (this.botTurns.get(channel) ?? 0) + 2;
    this.botTurns.set(channel, n);
    if (n > rule.hardTurns) {
      // **넘긴 첫 번에만 적는다.** 매번 적으면 끊긴 뒤에도 기록만 계속 쌓인다.
      if (n === rule.hardTurns + 1) {
        this.logger.info(`봇끼리 ${rule.hardTurns}번을 넘겨 끊었습니다 (${channel})`);
        note(this.opts.name, '물러섬', { 어디: channel, 말: text,
          왜: `봇끼리 ${rule.hardTurns}번을 넘겼다 — 사람이 말할 때까지 멈춘다` });
      }
      return null;
    }
    return n >= rule.softTurns ? `${text}\n\n${WRAP_UP}` : text;
  }

  /** 사람이 말했다 — 봇끼리 세던 것을 처음으로 돌리고, 멈춤·풀기 낱말을 본다. */
  private humanSpoke(channel: string, text: string): void {
    this.botTurns.delete(channel);
    if (HUSH.test(text)) {
      if (!this.hushed.has(channel)) {
        this.hushed.add(channel);
        this.logger.info(`봇끼리 대화를 멈춥니다 (${channel})`);
      }
      // **먼저 끼어들기까지 멈추는 것은 부른 턴에서만.** 지나가는 말에 걸리면
      // 청한 적 없는 사람들에게 봇이 제멋대로 조용해진 것으로 보인다.
      if (this.isCalled(text) && !this.buttInHushed.has(channel)) {
        this.buttInHushed.add(channel);
        this.logger.info(`먼저 말 걸기를 멈춥니다 (${channel}) — 부르면 답합니다`);
      }
    } else if (UNHUSH.test(text)) {
      // 푸는 것은 부르지 않아도 듣는다 — 잘못 재워졌을 때 깨울 길이 있어야 한다.
      this.hushed.delete(channel);
      this.buttInHushed.delete(channel);
    }
  }

  // ── DM ────────────────────────────────────────────────────────────────
  private async onDirectMessage(
    client: App['client'], user: string, channel: string, ts: string, text: string,
  ): Promise<void> {
    // 명단이 비면 아무도 아니다. 실제 워크스페이스에 사는 봇이라 기본값은 침묵이어야 한다.
    if (!(this.opts.allowUsers ?? []).includes(user)) {
      await this.bypassToManager(client, user, channel, text);
      return;
    }
    this.enqueue(user, { channel, text, ts, user });
    // 표시는 **턴이 시작할 때** 붙는다(`pump`) — 붙이는 곳과 떼는 곳이 갈려 있으면
    // 한쪽 길이 늘어날 때마다 안 떼지는 자리가 하나씩 생긴다.
    this.kick(client, user, channel, true);
  }

  /**
   * 명단에 없는 사람이 봇에게 DM 을 보냈다 — **모델을 거치지 않고 주인에게 그대로 넘긴다.**
   *
   * 예전에는 「아직 준비 중이에요」로 돌려보냈다. 그런데 이 봇은 커피챗을 **전해 주는**
   * 창구라, 받은 사람이 고맙다고 답하면 그 말에 「준비 중」이 돌아간다. 창구에 온 말은
   * 버릴 말이 아니다.
   *
   * **모델을 안 태운다.** 봇에게만 하려던 말이 외부 모델로 나갈 이유가 없고, 그대로
   * 옮기는 것이 이 봇의 본래 일이다.
   */
  private async bypassToManager(
    client: App['client'], user: string, channel: string, text: string,
  ): Promise<void> {
    const manager = this.opts.managerUserId;
    const name = await this.displayName(client, user);
    let passed = false;
    if (manager) {
      try {
        const im = await client.conversations.open({ users: manager });
        if (im.channel?.id) {
          await client.chat.postMessage({
            channel: im.channel.id,
            text: `:speech_balloon: *${name}* 님이 저에게 보낸 말이에요.\n\n`
              + `> ${text.replace(/\n/g, '\n> ')}\n\n`
              + `_<@${user}> 에게 바로 답하셔도 되고, 전할 말이 있으면 저에게 맡기셔도 돼요._`,
          });
          passed = true;
        }
      } catch (error) {
        this.logger.warn('DM 을 주인에게 넘기지 못했습니다', error);
      }
    }
    this.logger.info(`DM 넘김 ← ${name} (${text.length}자)${passed ? '' : ' — 못 넘김'}`);

    // **못 넘겼으면 그 사실을 말한다.** 넘긴 줄 알고 기다리는 것이 가장 나쁘다.
    if (!passed) {
      await this.say(client, channel, FAIL_TEXT);
      return;
    }
    // 넘겼다는 말은 **이어 치는 줄마다 되풀이하지 않는다.** 시간을 두고 다시 걸면 다시 답한다.
    const last = this.toldNotYet.get(user) ?? 0;
    if (Date.now() - last > NOT_YET_AGAIN_MS) {
      this.toldNotYet.set(user, Date.now());
      await this.say(client, channel, BYPASS_TEXT);
    }
  }

  /**
   * **허락하지 않은 방**에서 말이 들렸다 — 누가 이 봇을 그 방에 초대했다는 뜻이다.
   *
   * 막는 것은 위에서 이미 끝났다. 여기서 하는 일은 **두 가지를 안 비워 두는 것**이다.
   *   - 봇을 부른 사람은 아무 반응이 없으면 고장으로 본다 → **그 사람에게만** 한 줄.
   *     방에는 아무것도 안 남긴다(허락 안 한 방에 글을 남기는 것 자체가 활동이다).
   *   - 주인은 초대된 사실을 모른다 → 방마다 한 번 알린다. 「나 모르게」가 없어야 한다.
   */
  private async notInvitedHere(
    client: App['client'], user: string, channel: string, ts: string, text: string,
  ): Promise<void> {
    // `selfUserId` 가 빈 문자열일 수 있어 **불린으로 굳힌다** — 아래에서 이 값이 알릴지
    // 말지를 가르므로, 빈 문자열이 그대로 흐르면 기록에 `""` 가 찍히고 판정도 흐려진다.
    const called = this.isCalled(text);
    if (called) {
      try {
        await client.chat.postEphemeral({
          channel, user, thread_ts: ts,
          text: '저는 이 방에서는 활동하지 않아요. 실장님께 말씀해 주시면 열 수 있습니다 :coffee:',
        });
      } catch (error) {
        this.logger.debug('안 하는 방이라고 알리지 못했습니다', error);
      }
    }
    // 물러선 것은 슬랙에 아무 흔적이 안 남는다 — 길목으로는 안 잡히니 여기서 적는다.
    // **매번 적는다.** 아래 경고는 방마다 한 번뿐이라 그것만으로는 몇 번인지 모른다.
    //
    // ⚠️ **말 원문은 적지 않는다.** 허락 안 한 방은 우리 방이 아니고, 거기 오가는 것은
    // 남의 업무 대화다. 이벤트 구독을 켜면 그 방의 **모든 말**이 이리로 들어오므로,
    // 원문을 적으면 남의(때로는 고객사와 공유된 방의) 대화가 우리 디스크에 쌓인다.
    // 실측(2026-08-27): 앱 재설치로 구독이 살아난 뒤 90초 만에 무관한 업무 대화 5줄이
    // 그대로 적혔다. 진단에 필요한 것은 **몇 번·어디서·불렀는가**까지다.
    note(this.opts.name, '물러섬', {
      어디: channel, 누가: user, 부름: called, 글자수: text.length,
      왜: '허락하지 않은 방',
    });

    if (this.toldStranger.has(channel)) return;
    // **부르지도 않았는데 알리지 않는다.** 구독을 켜면 **안 들어간 방**의 말까지 오는데
    // 그때마다 알리면 알림이 통째로 소음이 된다 — 실측(2026-08-27) 그날 들어온 16건이
    // 전부 부른 것이 아니었고, 그래서 첫 알림이 헛알림이었다. 사람이 손 쓸 일이 생기는
    // 것은 **누가 이 봇을 부른 자리**뿐이다. 「나 모르게 불려서 활동하면 안 된다」의
    // 「불려서」가 여기다 — 남의 방에서 오가는 말은 알림거리가 아니다.
    if (!called) return;
    this.toldStranger.add(channel);
    this.logger.warn(`허락하지 않은 방에서 불렸습니다 (${channel}) — 아무것도 하지 않았습니다`);
    if (!this.opts.managerUserId) return;
    try {
      const im = await client.conversations.open({ users: this.opts.managerUserId });
      if (im.channel?.id) {
        await client.chat.postMessage({
          channel: im.channel.id,
          // **「들어가 있습니다」라고 적지 않는다.** 말이 들어온다고 그 방 멤버인 것이
          // 아니다 — 구독을 켜면 안 들어간 방의 말도 온다(실측 2026-08-27, 읽기를 걸면
          // `not_in_channel` 이 났다). 멤버라고 적으면 받는 사람이 있지도 않은 초대
          // 기록을 찾으러 간다. 본 것만 적는다.
          text: `<#${channel}> 방에서 누가 저를 불렀습니다. **그 방에서는 아무것도 하지 않았습니다.**\n`
            + '거기서도 답하게 하시려면 설정에 그 방을 넣어 주세요. 그대로 두셔도 되고요.',
        });
      }
    } catch (error) {
      this.logger.warn('초대된 사실을 알리지 못했습니다', error);
    }
  }

  // ── 채널 ──────────────────────────────────────────────────────────────
  private async onChannelMessage(
    client: App['client'], user: string, channel: string, ts: string,
    threadTs: string | undefined, text: string, fromSibling = false,
  ): Promise<void> {
    const called = this.isCalled(text);
    // **바로 반응할 자리에서만 담는다.** 나머지는 훑기가 채널에서 직접 읽어 온다 —
    // 여기서 다 쌓아 두면 재시작 한 번에 통째로 사라지고, 소켓이 흘린 말은 애초에
    // 담기지도 않는다. 둘 다 실제로 겪었다.
    //
    // **형제 봇의 말만은 여기서 안 버린다** — 그 말에는 **두 번째 기회가 없기 때문**이다.
    // 사람 말은 낱말이나 굴레에 걸려 빠져도 1분 뒤 훑기가 다시 집어 오지만, 훑기는
    // 봇 말을 「이야기가 지나간 자리」로 삼아 지운다. 여기서 한 번 빠지면 영영 없던 말이 된다.
    //
    // 실측(2026-08-19 15:44) — 커피콩이 자기 턴을 도는 16초 사이에 소인이 말을 걸었고,
    // 「도는 중」이라는 이유로 **담기지도 않고 버려졌다.** 도는 중이면 버릴 것이 아니라
    // 합쳐야 하는데(그러라고 대기열이 있다), 낄지 말지를 재는 자리가 그 둘을 안 갈랐다.
    //
    // **담는 것과 답하는 것은 다르다.** 담아 두되 아래에서 `forced` 를 안 준다 —
    // 낄 자리인지는 사람 말과 똑같이 모델이 정한다. 형제라고 무조건 받아치면 그건
    // 대화가 아니라 반사다. 봇끼리 주고받는 횟수는 `botTalkTurn` 이 따로 세서
    // 10마디에 맺으라 이르고 20마디에 끊는다.
    // **조용한 방에서는 부른 것만 받는다.** 형제 봇의 말도 여기서는 안 받는다 —
    // 그 방은 사람이 알림을 보러 오는 곳이라, 봇끼리 주고받기 시작하면 알림이 묻힌다.
    if (this.isQuiet(channel)) {
      if (!called) return;
    } else if (!called && !fromSibling && !this.shouldButtIn(channel, text)) return;

    const name = await this.displayName(client, user);
    // 방에서는 누가 한 말인지가 곧 맥락이다. 한 줄에 이름을 붙여 넘긴다.
    this.enqueue(channel, {
      channel, threadTs, ts,
      text: `${name || user}: ${text}`,
      // 부른 것이 아니면 **줄마다** 붙이지는 않는다 — 방 사람들의 모든 말에 표시가 달린다.
      // 그래도 답을 만드는 동안 아무 표시가 없으면 안 듣는 것과 구분이 안 되므로,
      // 그런 자리에서는 `pump` 가 **가장 새 글 하나에만** 붙인다.
      react: called,
      sibling: fromSibling,
      user,
    });

    if (called) {
      this.kick(client, channel, channel, true);
      return;
    }
    // 낱말이 걸린 자리 — 훑기를 기다리지 않고 그 자리에서 묻는다.
    this.kick(client, channel, channel, false);
  }

  /**
   * 먼저 말을 걸어도 되는 자리인가. 여기서 통과해야 모델에게 낄지 물어본다.
   *
   * **자기 얘기가 아니면 바로 빠진다** — 그 판단은 낱말로 하는 것이 싸고 확실하다.
   * 매번 모델에게 물으면 한 번에 10초씩 걸리고 쿼터도 금방 마른다.
   */
  /**
   * **부른 것만 받는 방**인가. 여기서는 낱말이 걸려도, 굴레가 남아 있어도 안 끼어든다.
   *
   * 대화를 아예 안 여는 것(`knownRooms`)과 다르다 — 그쪽은 불러도 「여기서는 활동하지
   * 않아요」만 돌려주고, 이쪽은 부르면 제대로 답한다. 식단 알림처럼 **사람이 보러 오는
   * 방**에 쓴다: 답이 없으면 고장으로 보이고, 끼어들면 알림 방이 잡담 방이 된다.
   */
  private isQuiet(channel: string): boolean {
    return (this.opts.quietRooms ?? []).includes(channel);
  }

  /** 나를 부른 글인가. **판정은 여기 한 곳** — 세 곳에 흩어져 있었고 하나는 조건이 달랐다. */
  private isCalled(text: string): boolean {
    return Boolean(this.selfUserId && text.includes(`<@${this.selfUserId}>`));
  }

  private shouldButtIn(channel: string, text: string): boolean {
    if (this.isQuiet(channel)) return false;
    // 부름말은 봇 설정과 무관하게 늘 걸린다 — 낱말 목록이 비어 있어도 마찬가지다.
    if (this.interest && !this.interest.test(text) && !CALL_WORDS.test(text)) return false;
    return this.withinLimits(channel);
  }

  /**
   * 낱말과 무관한 굴레만. 훑기도 같은 굴레를 쓴다 — 길이 둘이어도 한도는 하나다.
   *
   * **「그만」(부른 턴)도 여기서 문다.** 먼저 끼어드는 길이 둘(낱말·훑기)이라 한쪽에만
   * 걸면 다른 쪽으로 그대로 샌다. 부름(멘션)은 두 부르는 곳 모두 `called` 로 이 함수를
   * 건너뛰므로, 그만하라고 해도 **부르면 답한다** — 멈추는 것은 먼저 나서는 것뿐이다.
   */
  private withinLimits(channel: string): boolean {
    const rule = this.opts.buttIn;
    if (!rule || this.active.has(channel)) return false;
    if (this.buttInHushed.has(channel)) return false;
    const since = Date.now() - (this.lastSpoke.get(channel) ?? 0);
    if (since < rule.quietMinutes * 60 * 1000) return false;
    const day = new Date().toISOString().slice(0, 10);
    const seen = this.spokenToday.get(channel);
    const count = seen && seen.day === day ? seen.count : 0;
    return count < rule.dailyCap;
  }

  /**
   * 몇 분마다 한 번, **쌓인 말을 통째로 보고** 낄지 모델에게 묻는다.
   *
   * 새 말이 없으면 아무것도 하지 않는다 — 조용한 시간에는 모델을 안 부른다.
   * 모델이 안 끼기로 하면 쌓인 말은 그 턴에서 비워지므로, 같은 대화를 두고
   * 몇 분마다 되묻지 않는다.
   */
  private async sweep(): Promise<void> {
    const client = this.app?.client;
    if (!client) return;
    // **묻힌 대기열부터 깨운다.** 자리가 났는지 보는 일(`drain`)은 지금까지 **자기 턴이
    // 끝날 때만** 돌았다. 그런데 대기열이 막히는 흔한 이유는 자기 턴이 아니라 **다른
    // 봇이 동시 실행 자리를 다 쓴 것**이고, 그때는 깨워 줄 자기 턴이 아예 없다.
    // 반드시 답해야 하는 자리(부름·1:1·형제 봇 말)가 그대로 묻힌다 — 훑기는 봇 말을
    // 못 집으므로 형제 말에는 여기 말고 되집는 길이 없다.
    this.drain(client);
    for (const channel of this.opts.channels ?? []) {
      // **한도는 여기서 안 본다** — 읽는 것은 모델을 안 부르니 싸고, 부름(멘션)은 한도와
      // 무관하게 답해야 한다. 방을 읽어 본 뒤 `sweepChannel` 안에서 가른다.
      try {
        await this.sweepChannel(client, channel);
      } catch (error) {
        this.logger.warn(`훑어보다 넘어졌습니다 (${channel})`, error);
      }
    }
  }

  /**
   * 방을 **채널에서 직접 읽어** 훑는다. 메모리에 쌓아 둔 것을 보지 않는다.
   *
   * 쌓아 두면 **재시작 한 번에 방금 오간 대화를 통째로 잊는다** — 실제로 그렇게
   * 잊었고, 사람들이 「파업 ㅋㅋ」 하는 동안 봇은 볼 것이 없었다. 소켓이 이벤트를
   * 흘려도 마찬가지다(그것도 실제로 겪었다). 채널을 읽으면 둘 다 저절로 따라잡힌다.
   *
   * 어디부터 보나: **봇이 마지막으로 말한 뒤**의 사람 글만. 기준을 채널이 들고 있으니
   * 따로 기억할 것이 없고, 이미 답한 말을 다시 집지도 않는다.
   */
  private async sweepChannel(client: App['client'], channel: string): Promise<void> {
    let res;
    try {
      res = await client.conversations.history({
        channel,
        oldest: ((Date.now() - SWEEP_LOOKBACK_MS) / 1000).toFixed(6),
        limit: 60,
      });
    } catch (error) {
      // **아직 방에 초대되지 않았다** — 설정에 방을 적어 두고 초대는 나중에 하는 것이
      // 정상 순서다. 그동안 1분마다 실패를 찍으면 로그가 그것으로 덮인다. 한 번만
      // 알리고 조용히 기다린다(초대되면 저절로 풀린다).
      //
      // **오류 이름이 방 종류에 따라 다르다** — 공개 방이면 `not_in_channel`, 비공개 방이면
      // 아예 안 보여서 `channel_not_found` 다. 앞엣것만 보고 두었다가 실측에서 걸렸다.
      const code = String((error as { data?: { error?: string } })?.data?.error);
      if (code === 'not_in_channel' || code === 'channel_not_found') {
        if (!this.toldNotInChannel.has(channel)) {
          this.toldNotInChannel.add(channel);
          this.logger.info(`${channel} 에 아직 초대되지 않았습니다 — 초대되면 훑기가 시작됩니다`);
        }
        return;
      }
      // **권한이 모자라 못 읽는다.** 초대와 달리 기다린다고 풀리지 않는다 — 사람이 앱
      // 권한을 고쳐 다시 설치해야 한다. 그런데 1분마다 같은 경고를 쌓으면 정작 그
      // 사실이 자기 로그에 묻힌다(실측: 15시간 809건). 한 번만, **무엇이 필요한지
      // 이름을 대서** 알린다. 권한이 붙으면 다음 훑기가 성공해 저절로 풀린다.
      if (code === 'missing_scope') {
        if (!this.toldNotInChannel.has(channel)) {
          this.toldNotInChannel.add(channel);
          const needed = (error as { data?: { needed?: string } })?.data?.needed;
          this.logger.warn(
            `${channel} 을 읽을 권한이 없습니다 — 앱에 ${needed ?? '필요한 권한'} 을 더하고 다시 설치해야 합니다`,
          );
        }
        return;
      }
      throw error;
    }
    // **방금 초대됐다** — 못 읽던 방이 읽히기 시작한 순간이다. 들어오기 전에 오가던
    // 이야기는 30분치가 통째로 보이는데, 그걸 보고 첫마디를 떼면 남의 대화에 갑자기
    // 끼어드는 꼴이 된다. 이번 한 번은 읽기만 하고 넘어간다.
    if (this.toldNotInChannel.delete(channel)) {
      this.logger.info(`${channel} 에 들어왔습니다 — 들어오기 전 이야기에는 끼지 않습니다`);
      if (this.opts.greetOnJoin) void this.greet(client, channel);
      return;
    }
    const msgs = ((res.messages ?? []) as Record<string, unknown>[]).slice().reverse();

    let after: Record<string, unknown>[] = [];
    for (const m of msgs) {
      // 봇이 입을 연 자리에서 끊는다 — 그 앞은 이미 지나간 이야기다.
      if (m.bot_id || m.user === this.selfUserId) { after = []; continue; }
      if (m.subtype || !((m.text as string) ?? '').trim()) continue;
      after.push(m);
    }
    if (after.length === 0) return;

    // **새로 온 말이 없으면 묻지 않는다.** 위 경계는 봇이 입을 열어야만 앞으로 가므로,
    // 안 끼기로 한 자리에서는 같은 글이 계속 남는다. 그 글을 다시 물어도 답은 같고,
    // 물을 때마다 대화가 커져서 **답이 엉뚱한 이유로 흔들린다**(하루 한 대화가
    // 31,143 → 312,217 토큰까지 자란 것을 봤다).
    //
    // 잃는 것이 없다 — 아무도 말을 안 한 자리에서 봇이 먼저 입을 떼는 기능은 원래
    // 없다(바로 위 `after.length === 0` 에서 나간다). 새 말이 오면 그 즉시 다시 묻는다.
    const newest = Math.max(...after.map((m) => Number(m.ts) || 0));
    if (newest <= (this.sweptUpTo.get(channel) ?? 0)) return;

    // **훑기도 부름을 알아본다.** 앱에 `message` 이벤트 구독이 빠져 있으면 여기가
    // 유일한 길인데, 예전에는 훑기로 들어온 말이 전부 「먼저 말 걸까?」로만 처리돼서
    // **@로 불러도 모델이 「낄 자리 아님」 하면 조용히 넘어갔다**(2026-08-19 커피콩).
    // 부르는 것은 굴레를 건너뛴다는 규칙이 살아 있는 길과 훑는 길에서 달랐던 셈이다.
    const mine = (m: Record<string, unknown>) =>
      !!this.selfUserId && ((m.text as string) ?? '').includes(`<@${this.selfUserId}>`);
    const called = after.some(mine);

    // **조용한 방은 훑기에서도 부른 것만 집는다.** 살아 있는 길에만 굴레를 걸고 훑는
    // 길을 비워 두면, 이벤트가 안 오는 앱에서는 그 방이 그냥 열린 방이 된다.
    if (this.isQuiet(channel) && !called) return;

    // **부른 자리가 아니면 여기서 굴레를 본다.** 조용한 시간·하루 한도는 먼저 말 거는
    // 것에만 걸리는 굴레지, 사람이 직접 부른 말을 막으라고 둔 것이 아니다.
    if (!called && !this.withinLimits(channel)) return;

    // 살아 있는 이벤트가 한 번도 안 왔는데 **뜬 뒤에 올라온 글**이 훑기로 잡혔다 =
    // 그 사이 이벤트가 왔어야 하는데 안 왔다는 뜻이다. 뜨기 전 글은 원래 안 오므로
    // 그것만 골라 보면 헛경고가 안 난다.
    if (!this.sawLive && !this.toldNoEvents
        && newest * 1000 > this.startedAt + 60 * 1000) {
      this.toldNoEvents = true;
      this.logger.warn(
        '방의 말이 훑기로만 들어옵니다 — 슬랙 앱에 message 이벤트 구독이 빠졌을 수 있습니다'
        + ' (Event Subscriptions → Subscribe to bot events 에 message.channels·message.im).'
        + ' 권한(channels:history)과 이벤트 구독은 따로라, 읽기는 되는데 부름만 안 들립니다');
    }

    for (const m of after.slice(-MAX_MERGED_LINES)) {
      const user = m.user as string;
      const name = await this.displayName(client, user);
      this.enqueue(channel, {
        channel, ts: m.ts as string,
        text: `${name || user}: ${(m.text as string).trim()}`,
        user,
        react: mine(m),    // 부른 글에만 표시를 단다. 나머지는 `pump` 가 하나만 붙인다
      });
    }
    const waiting = this.pending.get(channel);
    // 줄이 하나도 안 남았다 = 방금 읽은 것이 **이미 도는 턴에 들어가 있다.** 그쪽이
    // 답하므로 여기서는 물어본 것으로 친다.
    if (!waiting || waiting.texts.length === 0) { this.sweptUpTo.set(channel, newest); return; }
    this.logger.info(
      `훑어보는 중 (${channel}, ${waiting.texts.length}줄${called ? ' · 부름 있음' : ''})`);
    this.kick(client, channel, channel, called);
    // **정말 집어 갔을 때만 물어본 것으로 친다.** 동시에 도는 턴이 한도에 차 있으면
    // `kick` 은 그냥 돌아가고 줄은 그대로 남는데, 그걸 물어봤다고 표시해 버리면
    // **아무도 안 집은 채로 영영 묻히기 때문이다**(훑기가 재시도 노릇도 겸한다).
    if (!this.pending.has(channel)) this.sweptUpTo.set(channel, newest);
  }

  private noteSpoke(key: string): void {
    this.lastSpoke.set(key, Date.now());
    const day = new Date().toISOString().slice(0, 10);
    const seen = this.spokenToday.get(key);
    this.spokenToday.set(key, {
      day, count: seen && seen.day === day ? seen.count + 1 : 1,
    });
  }

  // ── 공통 ──────────────────────────────────────────────────────────────
  /**
   * 대기열에 넣는다. **중간에 기다리는 구간이 없어야 한다** — 사람은 두 줄을 연달아
   * 보내는데, 읽고 쓰는 사이에 기다림이 끼면 두 번째 말이 첫 번째를 덮어써서
   * 첫 줄이 사라지고 그 메시지의 🤔 도 영영 남는다.
   */
  private enqueue(key: string, item: {
    channel: string; text: string; ts: string; threadTs?: string;
    react?: boolean; sibling?: boolean; user?: string;
  }): void {
    const seen = this.taken.get(key) ?? new Set<string>();
    if (seen.has(item.ts)) return;              // 훑기가 다시 읽어 온 같은 말
    seen.add(item.ts);
    // Set 은 넣은 순서를 지키므로 맨 앞이 가장 오래된 것이다.
    while (seen.size > TAKEN_MEMORY) seen.delete(seen.values().next().value as string);
    this.taken.set(key, seen);

    const waiting = this.pending.get(key)
      ?? { channel: item.channel, texts: [], reactTs: [], toldBusy: false };
    waiting.channel = item.channel;
    // 인사처럼 **슬랙에 없는 글**은 표시를 붙일 자리가 없다(`greet:` 는 지어낸 열쇠다).
    if (!item.ts.startsWith('greet:')) waiting.lastTs = item.ts;
    if (item.threadTs) waiting.threadTs = item.threadTs;
    // 답을 기다리는 동안 말이 계속 쌓일 수 있다. 최근 것만 남긴다 — 끝없이 합치면
    // agy 를 띄우는 명령줄 길이 한도에 걸려 답하는 대신 실패한다.
    if (waiting.texts.length >= MAX_MERGED_LINES) waiting.texts.shift();
    waiting.texts.push(item.text);
    if (item.react !== false) waiting.reactTs.push(item.ts);
    if (item.sibling) waiting.hasSibling = true;
    // **누가 말했는지 모아 둔다.** 설정을 말로 바꾸는 길이 실장만 열리는데, 방에서는
    // 한 턴이 여러 사람의 말을 합친 것일 수 있다. 그때 「실장도 끼어 있으니 실장」으로
    // 보면 **다른 분의 청이 실장 이름으로 먹는다.** 판단은 pump 에서 하고 여기서는 모으기만.
    (waiting.users ??= new Set<string>()).add(item.user || '');
    this.pending.set(key, waiting);
  }

  /**
   * 방에 들어와서 하는 첫 인사. **한 번만.**
   *
   * 인사말을 코드에 박지 않는다 — 인물처럼 굴어야 하는 봇이 붙박이 문장으로 등장하면
   * 첫 줄에서 다 들킨다. 대신 「지금 막 들어왔다」는 상황만 넘기고 말은 봇이 짓는다.
   * 이 턴이 그 방 대화의 첫 턴이라 성격·자세·자리가 전부 함께 실린다.
   */
  private greet(client: App['client'], channel: string): void {
    if (this.greeted.has(channel)) return;
    this.greeted.add(channel);
    this.enqueue(channel, {
      channel, ts: `greet:${channel}`, react: false,
      text: '(너는 방금 이 방에 초대되어 들어왔다. 방에 있는 사람들에게 처음 인사를'
        + ' 한마디 건네라. 네가 여기서 무엇을 하는 사람인지 짧게 곁들이되, 안내문처럼'
        + ' 늘어놓지 말고 두세 문장으로.)',
    });
    this.kick(client, channel, channel, true);   // 부른 셈 친다 — 낄지 말지를 묻지 않는다
  }

  private kick(client: App['client'], key: string, channel: string, forced: boolean): void {
    if (this.active.has(key)) return;   // 도는 중이면 합쳐진다
    if (globalRunning >= CONCURRENCY_CAP) {
      const waiting = this.pending.get(key);
      // 방에서는 "기다려 달라"고 하지 않는다. 부르지도 않았는데 시끄럽다.
      if (forced && this.isDmKey(key) && waiting && !waiting.toldBusy) {
        waiting.toldBusy = true;
        void this.say(client, channel, BUSY_TEXT);
      }
      return;
    }
    void this.pump(client, key, forced);
  }

  /** 한 열쇠에 대해 새 말이 없어질 때까지 턴을 돈다. */
  private async pump(client: App['client'], key: string, forced: boolean): Promise<void> {
    this.active.add(key);
    globalRunning += 1;
    try {
      for (;;) {
        const waiting = this.pending.get(key);
        if (!waiting || waiting.texts.length === 0) break;
        this.pending.delete(key);

        // **개인에게 갈 말이 방으로 나가는 일은 없어야 한다.** 지금 구조로는 답이 그 말이
        // 들어온 자리로만 가지만, 한 봇이 DM 과 채널을 같이 받게 된 이상 이건 지켜지길
        // 바라는 성질이 아니라 **못 어기게 막을 성질**이다. 앞으로 누가 이 언저리를
        // 고치다 어긋내면 새는 대신 여기서 걸린다.
        if (!this.canSay(key, waiting.channel)) {
          this.logger.warn(
            `자리가 어긋나 답을 버렸습니다 (열쇠 ${key} → ${waiting.channel})`);
          break;
        }

        const merged = waiting.texts.join('\n');
        // **여기서 붙이고 아래 `finally` 에서 뗀다.** 붙이는 곳이 한 군데뿐이라
        // 「붙었는데 안 떼진」 자리가 구조적으로 안 생긴다.
        //
        // 부르지 않은 자리는 줄마다 붙이지 않지만 **하나는 붙인다** — 답을 만드는 데
        // 10~20초가 걸리는데 그동안 아무것도 안 보이면 못 들은 것과 구분이 안 된다.
        if (waiting.reactTs.length === 0 && waiting.lastTs) waiting.reactTs.push(waiting.lastTs);
        // **표시를 여기서 한 번 정해 둔다.** 이 턴에서 말투가 바뀔 수 있는데, 뗄 때 다시
        // 고르면 붙인 것과 다른 이름을 떼려 해서 **붙은 표시가 그대로 남는다.**
        const mark = this.markFor(key);
        for (const ts of waiting.reactTs) {
          await this.react(client, 'add', waiting.channel, ts, mark);
        }
        let result: TurnResult;
        try {
          result = await this.runTurn(key, await this.displayName(client, key), merged, !forced,
                                      this.isManagerTurn(waiting.users));
        } catch (error) {
          this.logger.warn('Turn crashed', error);
          result = { reply: '', error: String(error) };
        } finally {
          for (const ts of waiting.reactTs) {
            await this.react(client, 'remove', waiting.channel, ts, mark);
          }
        }

        if (result.error) {
          this.logger.warn(`Turn failed for ${key}: ${result.error}`);
          if (forced) await this.say(client, waiting.channel, FAIL_TEXT, waiting.threadTs);
        } else if (result.speak === false || !result.reply) {
          // 먼저 말 걸 자리가 아니라고 스스로 판단했다. 조용히 넘어간다.
          //
          // **부른 자리는 다르다.** 사람이 직접 건 말에 빈 답이 나오면, 오류가 아니라는
          // 이유로 아무 말도 안 가서 먹통으로 보인다 — 조용히 실패하는 자리를 남기지 않는다.
          if (forced) {
            this.logger.warn(`빈 답이 왔습니다 (${key}) — 부른 자리라 그냥 넘어가지 않습니다`);
            await this.say(client, waiting.channel, FAIL_TEXT, waiting.threadTs);
          } else {
            this.logger.info(`Stayed quiet in ${key}`);
          }
        } else {
          this.logger.info(`Answered ${key} in ${result.elapsed_s ?? '?'}s`);
          await this.say(client, waiting.channel, result.reply, waiting.threadTs);
          this.noteSpoke(key);
        }
        // 먼저 말 거는 턴은 한 번만 돈다. 남은 말은 다음 조건이 찰 때 본다.
        if (!forced) break;
      }
    } finally {
      this.active.delete(key);
      globalRunning -= 1;
      this.drain(client);
    }
  }

  /** 자리가 났다 — 기다리던 사람을 집어 든다. */
  private drain(client: App['client']): void {
    for (const key of this.pending.keys()) {
      if (globalRunning >= CONCURRENCY_CAP) return;
      if (this.active.has(key)) continue;
      const waiting = this.pending.get(key);
      // 부른 자리(표시가 달렸다)와 기다리라고 한 자리는 **반드시 답해야 하는** 자리다.
      const forced = this.isDmKey(key) || !!waiting?.toldBusy || !!waiting?.reactTs.length;
      // 채널에서 조용히 쌓이던 것은 자리가 났다고 발화하지 않는다 — 훑기가 조건을 다시 본다.
      // **다만 형제 봇의 말은 훑기가 못 집는다**(봇 말을 경계로 삼아 지운다). 여기서
      // 안 집으면 사람이 입을 열 때까지 묻히므로 집어는 오되, **답할지는 모델이 정한다.**
      if (!forced && !waiting?.hasSibling) continue;
      void this.pump(client, key, forced);
    }
  }

  /** 슬랙이 이름을 안다 — 파이썬 쪽이 명단을 들고 있을 이유가 없다. */
  private async displayName(client: App['client'], user: string): Promise<string> {
    if (!user.startsWith('U')) return '';   // 채널 열쇠는 사람이 아니다
    const cached = this.names.get(user);
    if (cached !== undefined) return cached;
    let name = '';
    try {
      const res = await client.users.info({ user });
      const profile = res.user?.profile as { display_name?: string; real_name?: string } | undefined;
      name = profile?.display_name || profile?.real_name || res.user?.real_name || '';
    } catch (error) {
      this.logger.debug('users.info failed', error);
    }
    this.names.set(user, name);
    return name;
  }

  /**
   * 이 묶음을 **실장 본인이 한 말로 볼 수 있나.**
   *
   * 예전에는 `key === managerUserId` 로 봤는데, 그러면 **방에서는 영영 거짓**이다 —
   * 방의 열쇠는 채널 ID(`C…`)라 사람 ID 와 같을 수가 없다. 1:1 에서만 맞는 판정이었다.
   *
   * 방에서는 한 턴이 여러 사람의 말을 합친 것일 수 있으므로 **전원이 실장일 때만** 참이다.
   * 한 명이라도 다른 사람(또는 형제 봇)이 섞이면 거짓 — 그 청이 실장 이름으로 먹으면 안 된다.
   */
  private isManagerTurn(users?: Set<string>): boolean {
    const id = this.opts.managerUserId;
    if (!id || !users || users.size === 0) return false;
    return [...users].every((u) => u === id);
  }

  private runTurn(key: string, name: string, text: string, decide: boolean,
                  manager: boolean): Promise<TurnResult> {
    const payload = JSON.stringify({
      bot: this.opts.name,
      key,
      user: key.startsWith('U') ? key : '',
      user_name: name,
      role: manager ? 'manager' : 'member',
      // 같은 봇이 DM 과 채널을 다 받으므로 **어느 자리인지 알려준다.** 둘의 태도가
      // 달라야 하는데(DM 은 조심스럽게, 채널은 앞장서서) 프롬프트가 그걸 모르면
      // 한쪽에 맞춘 성격이 다른 쪽에서 어긋난다.
      where: this.isDmKey(key) ? 'dm' : 'channel',
      decide,
      text,
    });

    return new Promise<TurnResult>((resolve) => {
      const child = spawn(this.opts.python, ['-X', 'utf8', this.opts.script], {
        cwd: path.dirname(this.opts.script),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      const killTimer = setTimeout(() => child.kill(), TURN_TIMEOUT_MS);

      child.on('error', (error) => {
        clearTimeout(killTimer);
        resolve({ reply: '', error: `spawn 실패: ${error.message}` });
      });

      child.on('close', () => {
        clearTimeout(killTimer);
        // 종료 코드는 판정 근거가 아니다 — turn.py 는 실패도 JSON 안에 적어 내보낸다.
        const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
        try {
          resolve(JSON.parse(line) as TurnResult);
        } catch {
          resolve({ reply: '', error: `응답 파싱 실패: ${(line || stderr).slice(-300)}` });
        }
      });

      child.stdin.write(payload, 'utf-8');
      child.stdin.end();
    });
  }

  private async say(
    client: App['client'], channel: string, text: string, threadTs?: string,
  ): Promise<void> {
    try {
      await client.chat.postMessage({ channel, text, thread_ts: threadTs });
    } catch (error) {
      this.logger.warn('Failed to post a message', error);
    }
  }

  /**
   * 이 대화에 붙일 「생각 중」 표시. **지금 말투에 맞춘다.**
   *
   * 말투는 대화마다 다르므로(방에서 불러서 바꾼다) 봇 하나에 표시 하나로는 안 된다.
   * 지금 말투는 **파이썬 쪽이 쓰는 그 파일에서 그대로 읽는다** — 여기서 따로 셈하면
   * 두 쪽의 답이 갈리고, 갈렸다는 것을 알려 주는 것이 아무것도 없다.
   *
   * 그 파일이 없거나(첫 대화) 목록에 없는 말투(사람이 지어낸 지시문)면 봇 제 표시로 간다.
   */
  private markFor(key: string): string {
    const conv = this.readNear('bots', this.opts.name, 'data', 'conv', `${key}.json`);
    const cfg = this.readNear('bots', this.opts.name, 'config.json');
    // 대화에 저장된 말투 → 봇 기본 말투 → 뜰 때 읽어 둔 값 순으로 처음 잡히는 것.
    const tone = [conv?.tone, cfg?.tone, this.botTone]
      .find((t) => typeof t === 'string' && t.trim());
    return this.marksNow()[String(tone ?? '').trim()] || this.mark;
  }

  /**
   * 말투별 표시를 **그때그때 읽는다**(`chatbot/tone_marks.json`).
   *
   * 뜰 때 읽어 쥐고 있으면 표시를 고쳐도 재시작 전에는 안 따라오는데, 말투 자체는
   * 파이썬이 매 턴 파일을 다시 읽어 바로 바뀐다 — **얼굴만 바뀌고 표시가 옛것으로
   * 남는다.** 파일 하나 읽는 값은 10~15초짜리 턴에서 셀 것이 못 된다.
   *
   * 못 읽으면 뜰 때 읽어 둔 것을 그대로 쓴다 — 파일이 잠깐 없다고 표시를 잃을 이유가 없다.
   */
  private marksNow(): Record<string, string> {
    const raw = this.readNear('tone_marks.json');
    if (!raw) return this.toneMarks;
    const out: Record<string, string> = {};
    for (const [tone, mark] of Object.entries(raw)) {
      // `_` 로 시작하는 줄은 사람이 읽는 설명이지 말투가 아니다.
      if (!tone.startsWith('_') && typeof mark === 'string' && mark.trim()) {
        out[tone] = mark.replace(/:/g, '').trim();
      }
    }
    return Object.keys(out).length ? out : this.toneMarks;
  }

  /** 파이썬 쪽 폴더의 작은 JSON 하나. 없거나 깨졌으면 null — 표시는 장식이라 조용히 넘긴다. */
  private readNear(...parts: string[]): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(
        path.join(path.dirname(this.opts.script), ...parts), 'utf-8')) ?? null;
    } catch {
      return null;
    }
  }

  /** 이모지는 장식이다 — 여기서 실패해도 답이 가라앉으면 안 된다. */
  private async react(
    client: App['client'], op: 'add' | 'remove', channel: string, ts: string,
    mark = this.mark,
  ): Promise<void> {
    try {
      if (op === 'add') {
        await client.reactions.add({ channel, timestamp: ts, name: mark });
      } else {
        await client.reactions.remove({ channel, timestamp: ts, name: mark });
      }
    } catch (error) {
      // **이름이 틀린 것만은 크게 알린다.** 나머지(이미 붙음·글이 지워짐)는 흔한 일이라
      // 조용히 넘기지만, 이름이 없으면 표시가 **한 번도 안 뜨는데 아무 티가 안 난다** —
      // 그 상태를 debug 로 묻어 두면 「봇이 안 듣는다」로 잘못 읽히는 자리다.
      const code = String((error as { data?: { error?: string } })?.data?.error ?? '');
      if (code === 'invalid_name' && !this.toldBadMark) {
        this.toldBadMark = true;
        this.logger.warn(
          `:${mark}: 라는 이모지가 이 워크스페이스에 없습니다 — 생각 중 표시가 안 뜹니다.`
          + ` bots/${this.opts.name}/config.json 의 reaction 이나 chatbot/tone_marks.json 을 고쳐 주세요`);
        return;
      }
      this.logger.debug(`reactions.${op} failed`, error);
    }
  }
}
