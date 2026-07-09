/**
 * Owns the three independent, continuously-running GameSessions — one per
 * bulb-count mode (5, 7, 10). Created once at server boot (see
 * server/index.ts) and never recreated for the life of the process: each
 * session keeps its own cycle progressing in real time regardless of how
 * many (or how few) clients are connected — that's the whole point of
 * "persistent, always-running sessions" (requirement 2).
 */
import type { BulbCount } from '../../src/index';
import { GameSession } from './GameSession';

const MODES: BulbCount[] = [5, 7, 10];

export class SessionManager {
  private readonly sessions = new Map<BulbCount, GameSession>();

  constructor() {
    for (const mode of MODES) {
      this.sessions.set(mode, new GameSession(mode));
    }
  }

  /** Starts every mode's first cycle. Sessions are independent, so a
   *  failure starting one mode doesn't prevent the others from booting. */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(MODES.map((mode) => this.get(mode).start()));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[sessionManager] mode=${MODES[i]} failed to start:`, result.reason);
      }
    });
  }

  get(mode: BulbCount): GameSession {
    const session = this.sessions.get(mode);
    if (!session) throw new Error(`No session for mode ${mode}`);
    return session;
  }

  all(): GameSession[] {
    return [...this.sessions.values()];
  }

  shutdown(): void {
    for (const session of this.sessions.values()) session.shutdown();
  }
}
