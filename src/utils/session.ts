import crypto from 'crypto';

const SESSION_TTL = 24 * 60 * 60 * 1000;

export class SessionStore {
  private sessions = new Map<string, { userId: string; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  private startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions.entries()) {
        if (now > session.expiresAt) {
          this.sessions.delete(sessionId);
        }
      }
    }, 60 * 60 * 1000);
  }

  createSession(userId: string): string {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL;
    this.sessions.set(sessionId, { userId, expiresAt });
    return sessionId;
  }

  validateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  getUserFromSession(sessionId: string): string | null {
    if (!this.validateSession(sessionId)) return null;
    return this.sessions.get(sessionId)?.userId || null;
  }

  destroySession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

export const sessionStore = new SessionStore();