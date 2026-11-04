import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};

export const EXPIRED_TOKEN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_DENIED_TOKEN_RETENTION_MS = EXPIRED_TOKEN_RETENTION_MS;

/**
 * Remove expired encrypted records seven days after approval expiry, pending records seven days
 * after consent, and denied records seven days after denial. Pending records with an unknown save
 * time are retained rather than deleted early. Reapproval retains expired tokens for seven days.
 * Access and token tables MUST live in this same SQLite database so cleanup and reapproval
 * serialize. Tokens awaiting or undergoing revocation remain until revocation is resolved.
 * This does not revoke Google grants or remove records from backups or journals.
 * Only a trusted scheduler may invoke this function; it is not an HTTP operation.
 */
export function deleteStaleGmailTokens(databasePath: string, now: number): number {
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
      const expiredCutoff = now - EXPIRED_TOKEN_RETENTION_MS;
      const pendingDeniedCutoff = now - PENDING_DENIED_TOKEN_RETENTION_MS;
      const stale = db
        .prepare(
          `SELECT tokens.subject FROM beta_gmail_tokens AS tokens
        JOIN beta_access_requests AS requests ON requests.subject = tokens.subject
        LEFT JOIN beta_gmail_consent_fences AS fences ON fences.subject = tokens.subject
        WHERE COALESCE(fences.revoking, 0) = 0 AND (
          (requests.status = 'approved' AND requests.expires_at <= ?)
          OR (requests.status = 'pending' AND (
            (requests.expires_at IS NOT NULL AND requests.expires_at <= ?)
            OR ((requests.expires_at IS NULL OR requests.expires_at > ?)
              AND tokens.saved_at IS NOT NULL AND tokens.saved_at <= ?)
          ))
          OR (requests.status = 'denied' AND (
            SELECT MAX(audit.occurred_at) FROM beta_access_audit AS audit
            WHERE audit.target = tokens.subject AND audit.action = 'denied'
          ) <= ?)
        )`,
        )
        .all(expiredCutoff, expiredCutoff, now, pendingDeniedCutoff, pendingDeniedCutoff) as {
        subject: string;
      }[];
      const audit = db.prepare(`INSERT INTO beta_access_audit
        (actor, target, action, occurred_at, expires_at, daily_limit)
        VALUES ('system', ?, 'token_retention_removed', ?, NULL, NULL)`);
      const remove = db.prepare('DELETE FROM beta_gmail_tokens WHERE subject = ?');
      for (const row of stale) {
        remove.run(row.subject);
        audit.run(row.subject, now);
      }
      db.exec('COMMIT');
      return stale.length;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}
