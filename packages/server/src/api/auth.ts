import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Storage, User } from '../contracts/index.js';

export const SESSION_COOKIE = 'quorum_session';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Constant-time string comparison (both sides hashed so lengths never leak). */
export function verifyPassword(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Token sources, in order: Authorization Bearer, ?token=, cookie. */
export function tokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1]!.trim();
  }
  try {
    const t = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (t) return t;
  } catch {
    /* ignore malformed url */
  }
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export interface Auth {
  /** throws AuthError on bad credentials */
  login(password: unknown, displayName: unknown): { token: string; user: User };
  userFromRequest(req: IncomingMessage): { user: User; token: string } | null;
  logout(token: string): void;
  sessionCookie(token: string, secure: boolean): string;
  clearCookie(secure: boolean): string;
}

export function createAuth(deps: {
  storage: Pick<Storage, 'users' | 'sessions'>;
  config: { password: string | null };
}): Auth {
  const { storage, config } = deps;
  const attrs = (secure: boolean) => `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return {
    login(password, displayName) {
      if (
        typeof displayName !== 'string' ||
        !displayName.trim() ||
        displayName.trim().length > 40
      ) {
        throw new AuthError(400, 'invalid_display_name', 'displayName must be 1-40 characters');
      }
      if (config.password !== null) {
        if (typeof password !== 'string' || !verifyPassword(password, config.password)) {
          throw new AuthError(401, 'invalid_password', 'wrong password');
        }
      }
      const name = displayName.trim();
      const user = storage.users.findByDisplayName(name) ?? storage.users.create(name);
      const { token } = storage.sessions.create(user.id);
      return { token, user };
    },
    userFromRequest(req) {
      const token = tokenFromRequest(req);
      if (!token) return null;
      const userId = storage.sessions.resolve(token);
      if (!userId) return null;
      const user = storage.users.get(userId);
      return user ? { user, token } : null;
    },
    logout(token) {
      storage.sessions.revoke(token);
    },
    sessionCookie(token, secure) {
      return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attrs(secure)}; Max-Age=${SESSION_MAX_AGE_S}`;
    },
    clearCookie(secure) {
      return `${SESSION_COOKIE}=; ${attrs(secure)}; Max-Age=0`;
    },
  };
}
