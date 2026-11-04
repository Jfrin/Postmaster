import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AccessDeniedError } from './access.js';
import { initConsentFence, invalidateConsent } from './consent-fence.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
const COOKIE = '__Host-postmaster_gmail';
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

/** Browser- and user-bound, one-time Gmail consent state; distinct from identity sign-in. */
export class GmailConsentStateStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      initConsentFence(this.db);
      this.db.exec(`CREATE TABLE IF NOT EXISTS beta_gmail_consent_states (
        state_hash BLOB PRIMARY KEY, subject TEXT NOT NULL, verifier TEXT NOT NULL,
        nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT -1
      )`);
      const columns = this.db.prepare('PRAGMA table_info(beta_gmail_consent_states)').all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === 'generation'))
        this.db.exec(
          'ALTER TABLE beta_gmail_consent_states ADD COLUMN generation INTEGER NOT NULL DEFAULT -1',
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  start(
    subject: string,
    now: number,
    requireEligible = false,
  ): { state: string; nonce: string; challenge: string; cookie: string } {
    if (
      !subject ||
      subject.length > 255 ||
      subject.trim() !== subject ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(now + TTL_MS)
    )
      throw new Error('invalid consent parameters');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        requireEligible &&
        !this.db
          .prepare(
            `SELECT 1 FROM beta_access_requests WHERE subject = ?
        AND (status = 'pending' OR (status = 'approved' AND expires_at > ?))`,
          )
          .get(subject, now)
      )
        throw new AccessDeniedError('access not eligible for consent');
      const existing = this.db
        .prepare('SELECT revoking FROM beta_gmail_consent_fences WHERE subject = ?')
        .get(subject) as { revoking: number } | undefined;
      if (existing?.revoking) throw new AccessDeniedError('Gmail revocation in progress');
      invalidateConsent(this.db, subject);
      const fence = this.db
        .prepare('SELECT generation FROM beta_gmail_consent_fences WHERE subject = ?')
        .get(subject) as { generation: number };
      this.db.prepare('DELETE FROM beta_gmail_consent_states WHERE expires_at <= ?').run(now);
      const row = this.db
        .prepare('SELECT COUNT(*) AS count FROM beta_gmail_consent_states')
        .get() as { count: number };
      if (row.count >= 10_000) throw new Error('too many pending connections');
      this.db
        .prepare(
          `INSERT INTO beta_gmail_consent_states (state_hash, subject, verifier, nonce, expires_at, generation)
        VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(digest(state), subject, verifier, nonce, now + TTL_MS, fence.generation);
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

  consume(
    state: string,
    cookieHeader: string | undefined,
    subject: string,
    now: number,
  ): { verifier: string; nonce: string; generation: number } | null {
    if (
      !subject ||
      subject.length > 255 ||
      subject.trim() !== subject ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !/^[A-Za-z0-9_-]{43}$/.test(state)
    )
      return null;
    const cookie = cookieValue(cookieHeader);
    if (!cookie || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))) return null;
    return (
      (this.db
        .prepare(
          `DELETE FROM beta_gmail_consent_states WHERE state_hash = ? AND subject = ? AND expires_at > ?
      RETURNING verifier, nonce, generation`,
        )
        .get(digest(state), subject, now) as
        { verifier: string; nonce: string; generation: number } | undefined) ?? null
    );
  }

  static clearCookie(): string {
    return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
  }
}
