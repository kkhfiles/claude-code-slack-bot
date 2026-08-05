export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  lastAssistantUuid?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}

export interface PendingDenial {
  sessionId: string;
  deniedTools: string[];
  channel: string;
  /** 게시 위치. `undefined` 는 스레드가 아니라 채널에 바로 — DM 이 그렇다. */
  threadTs: string | undefined;
  user: string;
  approvedTools?: Set<string>;
}