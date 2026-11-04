import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
const COOKIE = '__Host-postmaster_login';
const TTL_MS = 10 * 60 * 1000;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function cookieValue(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  const values = header
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/** One-time Google sign-in state, PKCE verifier and OIDC nonce; no Gmail scope or tokens. */
export class IdentityLoginStateStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS beta_identity_states (
      state_hash BLOB PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`);
  }

  close(): void {
    this.db.close();
  }

  start(now: number): { state: string; nonce: string; challenge: string; cookie: string } {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + TTL_MS))
      throw new Error('invalid timestamp');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM beta_identity_states WHERE expires_at <= ?').run(now);
      const row = this.db.prepare('SELECT COUNT(*) AS count FROM beta_identity_states').get() as {
        count: number;
      };
      if (row.count >= 10_000) throw new Error('too many pending sign-ins');
      this.db
        .prepare(
          'INSERT INTO beta_identity_states (state_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)',
        )
        .run(digest(state), verifier, nonce, now + TTL_MS);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      state,
      nonce,
      challenge: digest(verifier).toString('base64url'),
      cookie: `${COOKIE}=${state}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    };
  }

  /** Consume the browser-bound state exactly once before exchanging the code. */
  consume(
    state: string,
    cookieHeader: string | undefined,
    now: number,
  ): { verifier: string; nonce: string } | null {
    if (!Number.isSafeInteger(now) || now < 0 || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
    const cookie = cookieValue(cookieHeader);
    if (!cookie || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;
    return (
      (this.db
        .prepare(
          `DELETE FROM beta_identity_states WHERE state_hash = ? AND expires_at > ?
      RETURNING verifier, nonce`,
        )
        .get(digest(state), now) as { verifier: string; nonce: string } | undefined) ?? null
    );
  }

  static clearCookie(): string {
    return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
  }
}
