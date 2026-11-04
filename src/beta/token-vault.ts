import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { AccessDeniedError } from './access.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

function associatedData(subject: string): Buffer {
  if (!subject || subject.length > 255 || subject.trim() !== subject) {
    throw new Error('invalid verified subject');
  }
  return Buffer.from(
    JSON.stringify({ purpose: 'postmaster-gmail-refresh-token', version: 1, subject }),
  );
}

/**
 * Encrypted refresh-token storage only. The caller must authenticate and authorize every
 * operation and protect the 32-byte key separately from the database and its backups.
 * Google consent, revocation, retention, key rotation and session handling are not provided.
 */
export class GmailTokenVault {
  private readonly db: DatabaseSyncType;
  private readonly key: Buffer;

  constructor(path: string, key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('token vault key must be 32 bytes');
    this.key = Buffer.from(key);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    let inTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      this.db.exec(`CREATE TABLE IF NOT EXISTS beta_gmail_tokens (
        subject TEXT PRIMARY KEY, version INTEGER NOT NULL, nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL, tag BLOB NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
      )`);
      const columns = this.db.prepare('PRAGMA table_info(beta_gmail_tokens)').all() as {
        name: string;
      }[];
      if (!columns.some((column) => column.name === 'enabled')) {
        this.db.exec('ALTER TABLE beta_gmail_tokens ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      if (inTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      this.key.fill(0);
      throw error;
    }
  }

  close(): void {
    this.db.close();
    this.key.fill(0);
  }

  save(subject: string, refreshToken: string): void {
    const aad = associatedData(subject);
    if (!refreshToken || Buffer.byteLength(refreshToken) > 16_384) {
      throw new Error('invalid refresh token');
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db
      .prepare(
        `INSERT INTO beta_gmail_tokens (subject, version, nonce, ciphertext, tag, enabled)
      VALUES (?, 1, ?, ?, ?, 1) ON CONFLICT(subject) DO UPDATE SET version = excluded.version,
      nonce = excluded.nonce, ciphertext = excluded.ciphertext, tag = excluded.tag, enabled = 1`,
      )
      .run(subject, nonce, ciphertext, tag);
  }

  /** Access and token tables must share this SQLite database for atomic authorization. */
  private withActiveAccess<T>(subject: string, now: number, operation: () => T): T {
    associatedData(subject);
    if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) {
      throw new Error('invalid timestamp');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db
        .prepare(
          `SELECT 1 FROM beta_access_requests
        WHERE subject = ? AND status = 'approved' AND expires_at > ?`,
        )
        .get(subject, now);
      if (!active) throw new AccessDeniedError('access not active');
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Only use after verified Gmail consent; never trust a subject supplied by the browser. */
  saveIfActive(subject: string, refreshToken: string, now: number): void {
    this.withActiveAccess(subject, now, () => this.save(subject, refreshToken));
  }

  /** Token retrieval is denied once access expires or an administrator denies it. */
  loadIfActive(subject: string, now: number): string | null {
    return this.withActiveAccess(subject, now, () => {
      const enabled = this.db
        .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
        .get(subject);
      return enabled ? this.load(subject) : null;
    });
  }

  hasIfActive(subject: string, now: number): boolean {
    return this.withActiveAccess(
      subject,
      now,
      () =>
        !!this.db
          .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
          .get(subject),
    );
  }

  /** Caller must authenticate the owner, including when their testing access has expired. */
  has(subject: string): boolean {
    associatedData(subject);
    return !!this.db.prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ?').get(subject);
  }

  isEnabled(subject: string): boolean {
    associatedData(subject);
    return !!this.db
      .prepare('SELECT 1 FROM beta_gmail_tokens WHERE subject = ? AND enabled = 1')
      .get(subject);
  }

  /** Disable new Gmail attempts before contacting Google to revoke the token. */
  disableAndLoad(subject: string): string | null {
    associatedData(subject);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const token = this.load(subject);
      if (token)
        this.db.prepare('UPDATE beta_gmail_tokens SET enabled = 0 WHERE subject = ?').run(subject);
      this.db.exec('COMMIT');
      return token;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Do not delete a replacement connection saved while a revocation request was in flight. */
  deleteIfUnchanged(subject: string, expectedToken: string): boolean {
    associatedData(subject);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.load(subject);
      const left = Buffer.from(current ?? '');
      const right = Buffer.from(expectedToken);
      const same = current !== null && left.length === right.length && timingSafeEqual(left, right);
      if (same) this.delete(subject);
      this.db.exec('COMMIT');
      return same;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  load(subject: string): string | null {
    const aad = associatedData(subject);
    const row = this.db
      .prepare('SELECT version, nonce, ciphertext, tag FROM beta_gmail_tokens WHERE subject = ?')
      .get(subject) as
      { version: number; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array } | undefined;
    if (!row) return null;
    try {
      if (row.version !== 1 || row.nonce.byteLength !== 12 || row.tag.byteLength !== 16)
        throw new Error('invalid record');
      const cipher = createDecipheriv('aes-256-gcm', this.key, row.nonce);
      cipher.setAAD(aad);
      cipher.setAuthTag(row.tag);
      return Buffer.concat([cipher.update(row.ciphertext), cipher.final()]).toString('utf8');
    } catch {
      throw new Error('Gmail credential cannot be decrypted');
    }
  }

  /** Deletes the local encrypted record, not Google grants or encrypted backups. */
  delete(subject: string): void {
    associatedData(subject);
    this.db.prepare('DELETE FROM beta_gmail_tokens WHERE subject = ?').run(subject);
  }
}
