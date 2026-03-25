/**
 * Singleton error collector for the bot.
 * Components push errors here; the morning briefing reports and clears them.
 * Errors already communicated to the user (rate limit, token expiry Slack alerts) are excluded.
 */

export interface BotError {
  timestamp: string;
  source: string;
  message: string;
}

class ErrorCollector {
  private errors: BotError[] = [];
  private readonly MAX_ERRORS = 50;

  add(source: string, message: string): void {
    this.errors.push({ timestamp: new Date().toISOString(), source, message });
    if (this.errors.length > this.MAX_ERRORS) this.errors.shift();
  }

  getAndClear(): BotError[] {
    const result = [...this.errors];
    this.errors = [];
    return result;
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }
}

export const errorCollector = new ErrorCollector();
