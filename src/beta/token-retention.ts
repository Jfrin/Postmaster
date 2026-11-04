import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export const EXPIRED_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Remove expired encrypted records from the live database, seven days after approval expiry.
 * Access and token tables MUST live in this same SQLite database so cleanup and reapproval
 * serialize. This does not revoke Google grants or remove records from backups or journals.
 * Only a trusted scheduler may invoke this function; it is not an HTTP operation.
 */
export function deleteExpiredGmailTokens(databasePath: string, now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253_402_300_799_999) {
    throw new Error('invalid timestamp');
  }
  if (databasePath === ':memory:' || !existsSync(databasePath)) {
    throw new Error('existing shared database required');
  }
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA secure_delete = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      const cutoff = now - EXPIRED_TOKEN_RETENTION_MS;
      const expired = db
        .prepare(
          `SELECT tokens.subject FROM beta_gmail_tokens AS tokens
        JOIN beta_access_requests AS requests ON requests.subject = tokens.subject
        WHERE requests.expires_at IS NOT NULL AND requests.expires_at <= ?`,
        )
        .all(cutoff) as { subject: string }[];
      const audit = db.prepare(`INSERT INTO beta_access_audit
        (actor, target, action, occurred_at, expires_at, daily_limit)
        VALUES ('system', ?, 'token_retention_expired', ?, NULL, NULL)`);
      const remove = db.prepare('DELETE FROM beta_gmail_tokens WHERE subject = ?');
      for (const row of expired) {
        remove.run(row.subject);
        audit.run(row.subject, now);
      }
      db.exec('COMMIT');
      return expired.length;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
