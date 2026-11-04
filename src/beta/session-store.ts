import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { BetaSession } from './server.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

const COOKIE_NAME = '__Host-postmaster_session';
const MAX_SESSION_MS = 24 * 60 * 60 * 1000;

function hash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenFromCookie(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  const matches = header
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/**
 * Server-side opaque sessions. Only a verified OAuth callback may call issue(); this class
 * does not verify Google identities, authorize access, or handle OAuth/CSRF callbacks.
 */
export class BetaSessionStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS beta_sessions (
      token_hash BLOB PRIMARY KEY, subject TEXT NOT NULL, verified_email TEXT NOT NULL,
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
  }

  close(): void {
    this.db.close();
  }

  /** The caller must have verified subject and email using Google, not client input. */
  issue(subject: string, verifiedEmail: string, now: number, ttlMs: number): string {
    if (
      !subject ||
      subject.length > 255 ||
      subject.trim() !== subject ||
      !verifiedEmail ||
      verifiedEmail.length > 320 ||
      /[\r\n]/.test(verifiedEmail) ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1000 ||
      ttlMs > MAX_SESSION_MS ||
      !Number.isSafeInteger(now + ttlMs)
    ) {
      throw new Error('invalid session parameters');
    }
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO beta_sessions (token_hash, subject, verified_email, csrf_token, expires_at)
      VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hash(token), subject, verifiedEmail, csrf, now + ttlMs);
    return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; Secure; HttpOnly; SameSite=Lax`;
  }

  authenticate(cookieHeader: string | undefined, now: number): BetaSession | null {
    if (!Number.isSafeInteger(now) || now < 0) return null;
    const token = tokenFromCookie(cookieHeader);
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT subject, verified_email, csrf_token FROM beta_sessions
      WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(hash(token), now) as
      | {
          subject: string;
          verified_email: string;
          csrf_token: string;
        }
      | undefined;
    return row
      ? { subject: row.subject, verifiedEmail: row.verified_email, csrfToken: row.csrf_token }
      : null;
  }

  /** Invoke only after a CSRF-protected logout request. */
  revoke(cookieHeader: string | undefined): void {
    const token = tokenFromCookie(cookieHeader);
    if (token) this.db.prepare('DELETE FROM beta_sessions WHERE token_hash = ?').run(hash(token));
  }

  static clearCookie(): string {
    return `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
  }
}
